//! Local web server on the phone (127.0.0.1 only) that the app's WebView loads the dashboard from.
//! Every request goes over the Iroh connection to the computer, one QUIC stream per request.
//!
//! Other apps and websites on the phone can also reach 127.0.0.1, so:
//! - `Host` must be exactly this server (a website that points its own name at 127.0.0.1 is refused),
//! - every request must carry the session cookie, which only the app's WebView gets: the app opens
//!   `/__wa/auth?k=<random per launch>`, which sets an HttpOnly, SameSite=Lax cookie (Lax: the first navigation comes from the app's own
//!   tauri:// page, a cross-site hop that drops Strict cookies; the WebView's cookie jar is the app's alone),
//! - the cookie is removed before the request leaves the phone.
//!
//! Internal endpoints (never forwarded): `/__wa/status`, `/__wa/retry`, `/__wa/unpair`.
use std::{sync::Arc, time::Duration};

use anyhow::{Result, bail};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::RwLock,
};

use crate::link::Link;

const MAX_HEAD: usize = 64 * 1024;
const COOKIE: &str = "wa_k";

pub struct Proxy {
    pub port: u16,
    token: String,
    pub link: RwLock<Option<Arc<Link>>>,
    on_unpair: Box<dyn Fn() + Send + Sync>,
}

impl Proxy {
    /// Bind 127.0.0.1 (on the preferred port when it is free) and start serving.
    pub async fn start(preferred: Option<u16>, on_unpair: impl Fn() + Send + Sync + 'static) -> Result<Arc<Proxy>> {
        let listener = match preferred {
            Some(p) => match TcpListener::bind(("127.0.0.1", p)).await {
                Ok(l) => l,
                Err(_) => TcpListener::bind(("127.0.0.1", 0)).await?,
            },
            None => TcpListener::bind(("127.0.0.1", 0)).await?,
        };
        let proxy = Arc::new(Proxy {
            port: listener.local_addr()?.port(),
            token: hex::encode(rand::random::<[u8; 24]>()),
            link: RwLock::new(None),
            on_unpair: Box::new(on_unpair),
        });
        let p = proxy.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let p = p.clone();
                tokio::spawn(async move {
                    let _ = p.serve(sock).await;
                });
            }
        });
        Ok(proxy)
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// The address the app opens: sets the session cookie, then shows the dashboard.
    pub fn launch_url(&self) -> String {
        format!("{}/__wa/auth?k={}", self.origin(), self.token)
    }

    fn token_ok(&self, given: &str) -> bool {
        given.len() == self.token.len() && bool::from(given.as_bytes().ct_eq(self.token.as_bytes()))
    }

    async fn serve(&self, mut sock: TcpStream) -> Result<()> {
        sock.set_nodelay(true).ok();
        let (head, rest) = match tokio::time::timeout(Duration::from_secs(30), read_head(&mut sock)).await {
            Ok(Ok(v)) => v,
            _ => return Ok(()),
        };
        let req = match Head::parse(&head) {
            Ok(r) => r,
            Err(_) => return reply(&mut sock, 400, "text/plain", b"bad request", &[]).await,
        };
        let expected_hosts = [format!("127.0.0.1:{}", self.port), format!("localhost:{}", self.port)];
        if !expected_hosts.iter().any(|h| req.header("host").eq_ignore_ascii_case(h)) {
            return reply(&mut sock, 403, "text/plain", b"forbidden host", &[]).await;
        }

        if let Some(k) = req.path.strip_prefix("/__wa/auth?k=") {
            if !self.token_ok(k) {
                return reply(&mut sock, 403, "text/plain", b"forbidden", &[]).await;
            }
            let cookie = format!("Set-Cookie: {COOKIE}={}; Path=/; HttpOnly; SameSite=Lax", self.token);
            return reply(&mut sock, 302, "text/plain", b"", &["Location: /", &cookie]).await;
        }
        if !req.cookie(COOKIE).is_some_and(|k| self.token_ok(&k)) {
            return reply(&mut sock, 403, "text/plain", b"forbidden", &[]).await;
        }
        // Our own endpoints: a POST must come from this page (and the cookie is SameSite=Lax, never sent on cross-site POSTs).
        if req.path.starts_with("/__wa/") {
            let origin = req.header("origin");
            if req.method != "GET" && !origin.is_empty() && origin != self.origin() {
                return reply(&mut sock, 403, "text/plain", b"forbidden origin", &[]).await;
            }
            return self.internal(&mut sock, &req).await;
        }

        let link = self.link.read().await.clone();
        let conn = match &link {
            Some(l) => tokio::time::timeout(Duration::from_secs(15), l.connection()).await.ok().and_then(|r| r.ok()),
            None => None,
        };
        let Some(conn) = conn else {
            return self.unavailable(&mut sock, &req).await;
        };
        let (mut send, mut recv) = match conn.open_bi().await {
            Ok(s) => s,
            Err(_) => return self.unavailable(&mut sock, &req).await,
        };
        send.write_all(&req.without_cookie(COOKIE)).await?;
        send.write_all(&rest).await?;
        let (mut tcp_r, mut tcp_w) = sock.into_split();
        // WebView -> computer in the background; computer -> WebView until the computer ends the stream.
        let upload = tokio::spawn(async move {
            let _ = tokio::io::copy(&mut tcp_r, &mut send).await;
            let _ = send.finish();
        });
        let _ = tokio::io::copy(&mut recv, &mut tcp_w).await;
        let _ = tcp_w.shutdown().await;
        upload.abort();
        Ok(())
    }

    async fn internal(&self, sock: &mut TcpStream, req: &Head) -> Result<()> {
        let link = self.link.read().await.clone();
        match (req.method.as_str(), req.path.split('?').next().unwrap_or("")) {
            ("GET", "/__wa/status") => {
                let state = link.as_ref().map(|l| l.state().as_str()).unwrap_or("unpaired");
                let body = serde_json::json!({ "state": state }).to_string();
                reply(sock, 200, "application/json", body.as_bytes(), &[]).await
            }
            ("POST", "/__wa/retry") => {
                if let Some(l) = link {
                    l.retry();
                }
                reply(sock, 200, "application/json", b"{\"ok\":true}", &[]).await
            }
            ("POST", "/__wa/unpair") => {
                reply(sock, 200, "application/json", b"{\"ok\":true}", &[]).await?;
                (self.on_unpair)();
                Ok(())
            }
            _ => reply(sock, 404, "text/plain", b"not found", &[]).await,
        }
    }

    /// The computer can't be reached: a page navigation gets the Hebrew "not available" page, anything else a 503.
    async fn unavailable(&self, sock: &mut TcpStream, req: &Head) -> Result<()> {
        if req.method == "GET" && req.header("accept").contains("text/html") {
            reply(sock, 503, "text/html; charset=utf-8", OFFLINE_PAGE.as_bytes(), &["Cache-Control: no-store"]).await
        } else {
            reply(sock, 503, "application/json", b"{\"error\":\"computer unavailable\"}", &[]).await
        }
    }
}

async fn read_head(sock: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(i + 4);
            return Ok((buf, rest));
        }
        if buf.len() > MAX_HEAD {
            bail!("head too large");
        }
        let n = sock.read(&mut chunk).await?;
        if n == 0 {
            bail!("closed");
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

async fn reply(sock: &mut TcpStream, status: u16, ctype: &str, body: &[u8], extra: &[&str]) -> Result<()> {
    let reason = match status {
        200 => "OK",
        302 => "Found",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Service Unavailable",
    };
    let mut head = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for h in extra {
        head.push_str(h);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    sock.write_all(head.as_bytes()).await?;
    sock.write_all(body).await?;
    sock.shutdown().await?;
    Ok(())
}

/// A parsed request head, keeping the raw header lines so they can be forwarded unchanged.
pub struct Head {
    pub method: String,
    pub path: String,
    headers: Vec<(String, Vec<u8>)>,
    first_line: String,
}

impl Head {
    pub fn parse(raw: &[u8]) -> Result<Head> {
        let mut headers = [httparse::EMPTY_HEADER; 96];
        let mut req = httparse::Request::new(&mut headers);
        if !matches!(req.parse(raw)?, httparse::Status::Complete(_)) {
            bail!("incomplete");
        }
        let method = req.method.unwrap_or_default().to_string();
        let path = req.path.unwrap_or_default().to_string();
        if !path.starts_with('/') {
            bail!("origin-form only");
        }
        Ok(Head {
            first_line: format!("{method} {path} HTTP/1.1"),
            method,
            path,
            headers: req.headers.iter().map(|h| (h.name.to_string(), h.value.to_vec())).collect(),
        })
    }

    pub fn header(&self, name: &str) -> String {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| String::from_utf8_lossy(v).to_string()).unwrap_or_default()
    }

    pub fn cookie(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case("cookie"))
            .flat_map(|(_, v)| String::from_utf8_lossy(v).split(';').map(|p| p.trim().to_string()).collect::<Vec<_>>())
            .find_map(|p| p.strip_prefix(&format!("{name}=")).map(String::from))
    }

    /// The head as it goes to the computer: identical, except that our session cookie is removed.
    pub fn without_cookie(&self, name: &str) -> Vec<u8> {
        let mut out = format!("{}\r\n", self.first_line).into_bytes();
        for (n, v) in &self.headers {
            if n.eq_ignore_ascii_case("cookie") {
                let kept: Vec<String> = String::from_utf8_lossy(v)
                    .split(';')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty() && !p.starts_with(&format!("{name}=")))
                    .collect();
                if kept.is_empty() {
                    continue;
                }
                out.extend_from_slice(format!("Cookie: {}\r\n", kept.join("; ")).as_bytes());
                continue;
            }
            out.extend_from_slice(n.as_bytes());
            out.extend_from_slice(b": ");
            out.extend_from_slice(v);
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"\r\n");
        out
    }
}

/// Shown when the computer can't be reached and the dashboard has not loaded yet.
/// The banner with "נסה שוב" / "החלף מחשב" comes from the overlay script injected into every page.
const OFFLINE_PAGE: &str = r#"<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>סיכומי וואטסאפ</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f1115;color:#e8eaed;text-align:center;padding:24px;box-sizing:border-box}
.big{font-size:64px}</style></head>
<body data-wa-offline><div><div class="big">💻</div><h2>המחשב לא זמין כרגע</h2>
<p>ודא שהמחשב דלוק ושהתוכנה פועלת בו. ננסה להתחבר שוב לבד.</p></div>
<script>setInterval(async()=>{try{const s=await (await fetch('/__wa/status')).json();if(s.state==='connected')location.replace('/');}catch(e){}},3000);</script>
</body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_is_found_and_removed() {
        let h = Head::parse(b"GET /api/x HTTP/1.1\r\nHost: 127.0.0.1:5\r\nCookie: a=1; wa_k=SECRET; b=2\r\nAccept: */*\r\n\r\n").unwrap();
        assert_eq!(h.cookie("wa_k").as_deref(), Some("SECRET"));
        let out = String::from_utf8(h.without_cookie("wa_k")).unwrap();
        assert!(out.starts_with("GET /api/x HTTP/1.1\r\n"));
        assert!(out.contains("Cookie: a=1; b=2\r\n"));
        assert!(!out.contains("SECRET"));
        assert!(out.contains("Accept: */*\r\n"));
    }

    #[test]
    fn only_cookie_header_is_dropped_when_empty() {
        let h = Head::parse(b"GET / HTTP/1.1\r\nHost: x\r\nCookie: wa_k=S\r\n\r\n").unwrap();
        let out = String::from_utf8(h.without_cookie("wa_k")).unwrap();
        assert!(!out.to_lowercase().contains("cookie"));
    }

    #[test]
    fn absolute_form_is_refused() {
        assert!(Head::parse(b"GET http://evil/ HTTP/1.1\r\nHost: x\r\n\r\n").is_err());
    }
}
