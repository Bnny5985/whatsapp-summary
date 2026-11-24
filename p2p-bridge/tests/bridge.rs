//! Runs the real p2p-bridge binary (`--local-only`: no relay, no internet) against a fake dashboard
//! and a stand-in phone on a loopback Iroh connection.
use std::{
    io::{BufRead, BufReader, Write},
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

use iroh::{
    Endpoint, EndpointAddr, PublicKey, RelayMode, SecretKey, TransportAddr,
    endpoint::{Connection, presets},
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

struct Bridge {
    child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<Value>,
    addr: EndpointAddr,
    next: u64,
}

impl Bridge {
    fn start(dir: &Path, port: u16) -> Bridge {
        let mut child = Command::new(env!("CARGO_BIN_EXE_p2p-bridge"))
            .args(["--data-dir", dir.to_str().unwrap(), "--port", &port.to_string(), "--local-only"])
            .env("P2P_PROXY_SECRET", SECRET)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let _ = tx.send(v);
                }
            }
        });
        let ready = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        assert_eq!(ready["event"], "ready");
        let id: PublicKey = ready["nodeId"].as_str().unwrap().parse().unwrap();
        let addrs = ready["ports"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| TransportAddr::Ip(SocketAddr::from((Ipv4Addr::LOCALHOST, p.as_u64().unwrap() as u16))));
        Bridge { child, stdin, rx, addr: EndpointAddr::from_parts(id, addrs), next: 0 }
    }

    fn cmd(&mut self, cmd: &str, extra: Value) -> Value {
        self.next += 1;
        let mut msg = json!({ "id": self.next, "cmd": cmd });
        for (k, v) in extra.as_object().unwrap() {
            msg[k] = v.clone();
        }
        writeln!(self.stdin, "{msg}").unwrap();
        loop {
            let v = self.rx.recv_timeout(Duration::from_secs(20)).unwrap();
            if v["id"] == json!(self.next) {
                return v;
            }
        }
    }

    fn stop(mut self) {
        drop(self.stdin);
        let _ = self.child.wait();
    }
}

/// Fake dashboard: echoes the request head it received as the response body; for a WebSocket upgrade it answers
/// 101 and then echoes every byte in upper case.
async fn fake_dashboard() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut b = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if s.read(&mut b).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(b[0]);
                }
                let text = String::from_utf8_lossy(&head).to_string();
                if text.contains("Upgrade: websocket") {
                    s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n").await.unwrap();
                    let mut buf = [0u8; 1024];
                    loop {
                        let n = s.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        let up = buf[..n].to_ascii_uppercase();
                        if s.write_all(&up).await.is_err() {
                            return;
                        }
                    }
                }
                // Answer slowly, like an async route, to prove the request survives the phone finishing its send side.
                tokio::time::sleep(Duration::from_millis(200)).await;
                let resp = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
                let _ = s.write_all(resp.as_bytes()).await;
            });
        }
    });
    port
}

async fn phone(key: SecretKey) -> Endpoint {
    Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled).secret_key(key).bind().await.unwrap()
}

async fn pair(ep: &Endpoint, addr: &EndpointAddr, token: &str) -> Value {
    let conn = ep.connect(addr.clone(), b"wa-summary/pair/1").await.unwrap();
    let (mut s, mut r) = conn.open_bi().await.unwrap();
    s.write_all(json!({ "token": token, "name": "טלפון בדיקה" }).to_string().as_bytes()).await.unwrap();
    s.finish().unwrap();
    let v = serde_json::from_slice(&r.read_to_end(2048).await.unwrap()).unwrap();
    conn.close(0u32.into(), b"bye");
    v
}

/// One HTTP request over a fresh stream. Err = the bridge refused the connection.
async fn get(conn: &Connection, req: &str) -> Result<String, String> {
    let (mut s, mut r) = conn.open_bi().await.map_err(|e| e.to_string())?;
    s.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
    s.finish().map_err(|e| e.to_string())?;
    r.read_to_end(1 << 20).await.map(|b| String::from_utf8_lossy(&b).to_string()).map_err(|e| e.to_string())
}

async fn http(ep: &Endpoint, addr: &EndpointAddr) -> Result<String, String> {
    let conn = ep.connect(addr.clone(), b"wa-summary/http/1").await.map_err(|e| e.to_string())?;
    get(&conn, "GET /api/x HTTP/1.1\r\nHost: 127.0.0.1:41234\r\nOrigin: http://127.0.0.1:41234\r\nX-P2P-Proxy-Secret: forged\r\n\r\n").await
}

#[tokio::test(flavor = "multi_thread")]
async fn pairing_token_rules() {
    let dir = tempfile::tempdir().unwrap();
    let port = fake_dashboard().await;
    let mut b = Bridge::start(dir.path(), port);
    let phone_a = phone(SecretKey::generate()).await;

    // Unpaired phone: refused. Pairing closed: refused.
    assert!(http(&phone_a, &b.addr).await.is_err());
    assert_eq!(pair(&phone_a, &b.addr, "00").await["ok"], false);

    // Wrong token: refused.
    let token = b.cmd("pair_start", json!({ "ttl": 60 }))["qr"]["token"].as_str().unwrap().to_string();
    assert_eq!(pair(&phone_a, &b.addr, &"f".repeat(32)).await["error"], "wrong token");

    // Expired token: refused.
    b.cmd("pair_stop", json!({}));
    let short = b.cmd("pair_start", json!({ "ttl": 1 }))["qr"]["token"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(pair(&phone_a, &b.addr, &short).await["error"], "pairing window expired");
    assert_ne!(token, short);

    // Valid token: paired once; replaying it from another phone fails.
    let token = b.cmd("pair_start", json!({ "ttl": 60 }))["qr"]["token"].as_str().unwrap().to_string();
    assert_eq!(pair(&phone_a, &b.addr, &token).await["ok"], true);
    let phone_b = phone(SecretKey::generate()).await;
    assert_eq!(pair(&phone_b, &b.addr, &token).await["ok"], false);
    assert!(http(&phone_b, &b.addr).await.is_err());
    assert!(http(&phone_a, &b.addr).await.is_ok());
    b.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn tunnel_persistence_and_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let port = fake_dashboard().await;
    let mut b = Bridge::start(dir.path(), port);
    let key = SecretKey::generate();
    let me = key.public().to_string();
    let ph = phone(key).await;
    let token = b.cmd("pair_start", json!({}))["qr"]["token"].as_str().unwrap().to_string();
    assert_eq!(pair(&ph, &b.addr, &token).await["ok"], true);

    // Headers seen by the dashboard.
    let resp = http(&ph, &b.addr).await.unwrap();
    assert!(resp.starts_with("HTTP/1.1 200 OK"), "{resp}");
    assert!(resp.contains(&format!("Host: 127.0.0.1:{port}\r\n")));
    assert!(resp.contains(&format!("Origin: http://127.0.0.1:{port}\r\n")));
    assert!(resp.contains(&format!("X-Remote-Peer-Id: {me}\r\n")));
    assert!(resp.contains(&format!("X-P2P-Proxy-Secret: {SECRET}\r\n")));
    assert!(!resp.contains("forged"));

    // Survives a restart (same identity, same allowlist).
    let id_before = b.addr.id;
    b.stop();
    let mut b = Bridge::start(dir.path(), port);
    assert_eq!(b.addr.id, id_before);
    assert!(http(&ph, &b.addr).await.is_ok());
    let list = b.cmd("list", json!({}));
    assert_eq!(list["devices"][0]["nodeId"], me.as_str());
    assert_eq!(list["devices"][0]["name"], "טלפון בדיקה");

    // Revoke: an open connection is closed and new ones are refused; the file no longer lists the phone.
    let conn = ph.connect(b.addr.clone(), b"wa-summary/http/1").await.unwrap();
    assert!(get(&conn, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n").await.is_ok());
    assert_eq!(b.cmd("revoke", json!({ "nodeId": me }))["removed"], true);
    assert!(get(&conn, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n").await.is_err());
    assert!(http(&ph, &b.addr).await.is_err());
    let file = std::fs::read_to_string(dir.path().join("paired_devices.json")).unwrap();
    assert!(!file.contains(&me));
    b.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn websocket_and_rebinding() {
    let dir = tempfile::tempdir().unwrap();
    let port = fake_dashboard().await;
    let mut b = Bridge::start(dir.path(), port);
    let ph = phone(SecretKey::generate()).await;
    let token = b.cmd("pair_start", json!({}))["qr"]["token"].as_str().unwrap().to_string();
    assert_eq!(pair(&ph, &b.addr, &token).await["ok"], true);
    let conn = ph.connect(b.addr.clone(), b"wa-summary/http/1").await.unwrap();

    // WebSocket: upgrade, then bytes flow both ways on the same stream.
    let (mut s, mut r) = conn.open_bi().await.unwrap();
    s.write_all(b"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\n\r\n").await.unwrap();
    let mut buf = vec![0u8; 4096];
    let mut got = Vec::new();
    while !got.ends_with(b"\r\n\r\n") {
        let n = r.read(&mut buf).await.unwrap().unwrap();
        got.extend_from_slice(&buf[..n]);
    }
    assert!(String::from_utf8_lossy(&got).starts_with("HTTP/1.1 101"));
    for word in ["hello", "שלום"] {
        s.write_all(word.as_bytes()).await.unwrap();
        let n = r.read(&mut buf).await.unwrap().unwrap();
        assert_eq!(&buf[..n], word.to_uppercase().as_bytes());
    }

    // A request whose Host is not the phone's loopback (DNS rebinding) never reaches the dashboard.
    let resp = get(&conn, "GET / HTTP/1.1\r\nHost: evil.example:8080\r\n\r\n").await.unwrap();
    assert!(resp.starts_with("HTTP/1.1 400"), "{resp}");
    b.stop();
}
