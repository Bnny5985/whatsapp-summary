//! One QUIC stream = one HTTP request (or one WebSocket) to the local dashboard.
//!
//! The bridge reads the request head, rewrites it and then copies bytes both ways:
//! - every header a phone could use to impersonate the bridge or another proxy is dropped
//!   (`X-P2P-*`, `X-Remote-Peer-Id`, `Tailscale-*`, `X-Forwarded-*`, `Forwarded`, hop-by-hop headers),
//! - the phone's own `Host` must be a loopback address (the app's local proxy): anything else is refused,
//!   so a website that rebinds its DNS name to the phone's 127.0.0.1 gets nowhere,
//! - `Host` becomes `127.0.0.1:<port>`, and a loopback `Origin` becomes `http://127.0.0.1:<port>`, so the dashboard's
//!   own checks pass unchanged; a foreign `Origin` is passed on as it is, so the dashboard still refuses it,
//! - the bridge adds `X-Remote-Peer-Id` (the phone's NodeId, proven by the QUIC/TLS handshake)
//!   and `X-P2P-Proxy-Secret` (the per-session secret only the engine and the bridge know),
//! - `Connection: close` (or `Upgrade` for a WebSocket), so the dashboard serves exactly this one request.
use std::time::Duration;

use anyhow::{Context, Result, bail};
use iroh::endpoint::{RecvStream, SendStream};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

const MAX_HEAD: usize = 64 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);

/// `127.0.0.1`, `localhost` or `[::1]`, with or without a port.
fn is_loopback_host(host: &str) -> bool {
    let h = host.trim();
    let name = if let Some(rest) = h.strip_prefix('[') { rest.split(']').next().unwrap_or("") } else { h.rsplit_once(':').map(|(n, p)| if p.chars().all(|c| c.is_ascii_digit()) { n } else { h }).unwrap_or(h) };
    matches!(name.to_ascii_lowercase().as_str(), "127.0.0.1" | "localhost" | "::1")
}

fn is_loopback_origin(origin: &str) -> bool {
    origin.strip_prefix("http://").map(|rest| is_loopback_host(rest.trim_end_matches('/'))).unwrap_or(false)
}

fn dropped(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(n.as_str(), "host" | "origin" | "connection" | "keep-alive" | "upgrade" | "te" | "trailer" | "forwarded" | "x-remote-peer-id")
        || n.starts_with("x-p2p-")
        || n.starts_with("proxy-")
        || n.starts_with("tailscale-")
        || n.starts_with("x-forwarded-")
}

/// Rewrite a complete request head (everything up to and including the blank line).
pub fn rewrite_head(head: &[u8], port: u16, peer_id: &str, secret: &str) -> Result<Vec<u8>> {
    let mut headers = [httparse::EMPTY_HEADER; 96];
    let mut req = httparse::Request::new(&mut headers);
    match req.parse(head).context("bad request")? {
        httparse::Status::Complete(n) if n == head.len() => {}
        _ => bail!("incomplete request head"),
    }
    let method = req.method.context("no method")?;
    let path = req.path.context("no path")?;
    if !path.starts_with('/') {
        bail!("only origin-form paths are allowed");
    }
    let has = |name: &str| req.headers.iter().any(|h| h.name.eq_ignore_ascii_case(name));
    if has("content-length") && has("transfer-encoding") {
        bail!("ambiguous body length");
    }
    let value = |name: &str| {
        req.headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| String::from_utf8_lossy(h.value).to_ascii_lowercase())
            .unwrap_or_default()
    };
    if !is_loopback_host(&value("host")) {
        bail!("Host must be the phone's own loopback address");
    }
    let websocket = value("upgrade") == "websocket" && value("connection").split(',').any(|t| t.trim() == "upgrade");

    let mut out = Vec::with_capacity(head.len() + 256);
    out.extend_from_slice(format!("{method} {path} HTTP/1.1\r\n").as_bytes());
    out.extend_from_slice(format!("Host: 127.0.0.1:{port}\r\n").as_bytes());
    if let Some(o) = req.headers.iter().find(|h| h.name.eq_ignore_ascii_case("origin")) {
        let origin = String::from_utf8_lossy(o.value);
        if is_loopback_origin(&origin) {
            out.extend_from_slice(format!("Origin: http://127.0.0.1:{port}\r\n").as_bytes());
        } else {
            out.extend_from_slice(b"Origin: ");
            out.extend_from_slice(o.value);
            out.extend_from_slice(b"\r\n");
        }
    }
    for h in req.headers.iter() {
        if dropped(h.name) {
            continue;
        }
        out.extend_from_slice(h.name.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(h.value);
        out.extend_from_slice(b"\r\n");
    }
    if websocket {
        out.extend_from_slice(b"Connection: Upgrade\r\nUpgrade: websocket\r\n");
    } else {
        out.extend_from_slice(b"Connection: close\r\n");
    }
    out.extend_from_slice(format!("X-Remote-Peer-Id: {peer_id}\r\nX-P2P-Proxy-Secret: {secret}\r\n\r\n").as_bytes());
    Ok(out)
}

/// Read until the end of the request head. Returns (head, bytes already read past it).
async fn read_head(recv: &mut RecvStream) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(i + 4);
            return Ok((buf, rest));
        }
        if buf.len() > MAX_HEAD {
            bail!("request head too large");
        }
        let n = recv.read(&mut chunk).await?.unwrap_or(0);
        if n == 0 {
            bail!("stream ended before the request head");
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

async fn bad_request(send: &mut SendStream) {
    let _ = send.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
    let _ = send.finish();
}

/// Serve one stream from an already-authorized phone.
pub async fn proxy_stream(mut send: SendStream, mut recv: RecvStream, port: u16, peer_id: String, secret: String) -> Result<()> {
    let (head, rest) = match tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut recv)).await {
        Ok(Ok(v)) => v,
        _ => {
            bad_request(&mut send).await;
            return Ok(());
        }
    };
    let head = match rewrite_head(&head, port, &peer_id, &secret) {
        Ok(h) => h,
        Err(_) => {
            bad_request(&mut send).await;
            return Ok(());
        }
    };
    let tcp = TcpStream::connect(("127.0.0.1", port)).await.context("dashboard is not reachable")?;
    tcp.set_nodelay(true).ok();
    let (mut tcp_r, mut tcp_w) = tcp.into_split();
    tcp_w.write_all(&head).await?;
    tcp_w.write_all(&rest).await?;

    // phone -> dashboard runs in the background; the stream is done when the dashboard closes its side.
    // The write half is kept open after the phone finishes sending: Node's HTTP server drops a request
    // whose client half-closes before an (async) response is ready.
    let upload = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut recv, &mut tcp_w).await;
        std::future::pending::<()>().await;
        drop(tcp_w);
    });
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        let n = tcp_r.read(&mut buf).await.unwrap_or(0);
        if n == 0 {
            break;
        }
        if send.write_all(&buf[..n]).await.is_err() {
            break;
        }
    }
    upload.abort();
    let _ = send.finish();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rw(head: &str) -> Result<String> {
        rewrite_head(head.as_bytes(), 3000, "PEER", "SECRET").map(|v| String::from_utf8(v).unwrap())
    }

    #[test]
    fn injects_identity_and_forces_close() {
        let out = rw("GET /api/x?y=1 HTTP/1.1\r\nHost: 127.0.0.1:5555\r\nAccept: */*\r\n\r\n").unwrap();
        assert!(out.starts_with("GET /api/x?y=1 HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n"));
        assert!(out.contains("Accept: */*\r\n"));
        assert!(out.contains("Connection: close\r\n"));
        assert!(out.ends_with("X-Remote-Peer-Id: PEER\r\nX-P2P-Proxy-Secret: SECRET\r\n\r\n"));
        assert!(!out.contains("5555"));
    }

    #[test]
    fn strips_spoofed_headers() {
        let out = rw("POST / HTTP/1.1\r\nHost: 127.0.0.1:1\r\nX-P2P-Proxy-Secret: guess\r\nx-remote-peer-id: someone\r\nTailscale-User-Login: a@b\r\nX-Forwarded-For: 1.2.3.4\r\nForwarded: for=x\r\nProxy-Authorization: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n").unwrap();
        assert!(!out.contains("guess"));
        assert!(!out.contains("someone"));
        assert!(!out.to_lowercase().contains("tailscale"));
        assert!(!out.to_lowercase().contains("forwarded"));
        assert!(!out.to_lowercase().contains("proxy-authorization"));
        assert_eq!(out.matches("X-P2P-Proxy-Secret").count(), 1);
        assert!(out.contains("Content-Length: 2\r\n"));
    }

    #[test]
    fn keeps_websocket_upgrade() {
        let out = rw("GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Key: abc\r\n\r\n").unwrap();
        assert!(out.contains("Connection: Upgrade\r\nUpgrade: websocket\r\n"));
        assert!(!out.contains("Connection: close"));
        assert!(out.contains("Sec-WebSocket-Key: abc"));
    }

    #[test]
    fn rewrites_loopback_origin_but_keeps_foreign_origin() {
        let out = rw("POST /api/x HTTP/1.1\r\nHost: 127.0.0.1:5555\r\nOrigin: http://127.0.0.1:5555\r\n\r\n").unwrap();
        assert!(out.contains("Origin: http://127.0.0.1:3000\r\n"));
        let out = rw("POST /api/x HTTP/1.1\r\nHost: localhost:5555\r\nOrigin: https://evil.example\r\n\r\n").unwrap();
        assert!(out.contains("Origin: https://evil.example\r\n"));
        assert_eq!(out.matches("Origin:").count(), 1);
    }

    #[test]
    fn refuses_non_loopback_host() {
        // DNS rebinding on the phone: evil.example resolved to 127.0.0.1.
        assert!(rw("GET / HTTP/1.1\r\nHost: evil.example:5555\r\n\r\n").is_err());
        assert!(rw("GET / HTTP/1.1\r\n\r\n").is_err());
        assert!(rw("GET / HTTP/1.1\r\nHost: [::1]:80\r\n\r\n").is_ok());
        assert!(rw("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n").is_ok());
    }

    #[test]
    fn rejects_bad_requests() {
        assert!(rw("GET http://evil.com/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").is_err());
        assert!(rw("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n").is_err());
        assert!(rw("garbage\r\n\r\n").is_err());
    }
}
