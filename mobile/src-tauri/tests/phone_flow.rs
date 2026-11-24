//! The app's network layer end to end, without a WebView: real p2p-bridge (`--local-only`), real pairing,
//! the local proxy (cookie + Host checks), going offline and coming back, revocation and unpairing.
//! Needs the bridge built first: `cargo build` in ../../p2p-bridge.
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use iroh::{Endpoint, RelayMode, SecretKey, endpoint::presets};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use wa_summary_mobile_lib::{link, proxy::Proxy};

const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

fn bridge_bin() -> PathBuf {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../p2p-bridge/target/debug/p2p-bridge");
    assert!(p.exists() || p.with_extension("exe").exists(), "build the bridge first: cargo build in p2p-bridge/");
    if p.exists() { p } else { p.with_extension("exe") }
}

struct Bridge {
    child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<Value>,
    node_id: String,
    addrs: Vec<String>,
    n: u64,
}

impl Bridge {
    fn start(dir: &Path, port: u16, udp: u16) -> Bridge {
        let mut child = Command::new(bridge_bin())
            .args(["--data-dir", dir.to_str().unwrap(), "--port", &port.to_string(), "--local-only", "--udp-port", &udp.to_string()])
            .env("P2P_PROXY_SECRET", SECRET)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let out = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for l in BufReader::new(out).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str(&l) {
                    let _ = tx.send(v);
                }
            }
        });
        let ready: Value = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        let addrs = ready["ports"].as_array().unwrap().iter().map(|p| format!("127.0.0.1:{}", p.as_u64().unwrap())).collect();
        Bridge { child, stdin, rx, node_id: ready["nodeId"].as_str().unwrap().into(), addrs, n: 0 }
    }
    fn cmd(&mut self, cmd: &str, extra: Value) -> Value {
        self.n += 1;
        let mut m = json!({ "id": self.n, "cmd": cmd });
        for (k, v) in extra.as_object().unwrap() {
            m[k] = v.clone();
        }
        writeln!(self.stdin, "{m}").unwrap();
        loop {
            let v = self.rx.recv_timeout(Duration::from_secs(20)).unwrap();
            if v["id"] == json!(self.n) {
                return v;
            }
        }
    }
    fn stop(mut self) {
        drop(self.stdin);
        let _ = self.child.wait();
    }
}

/// Fake dashboard: answers with the request head it received.
async fn dashboard() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut b = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if s.read(&mut b).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(b[0]);
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
                let body = String::from_utf8_lossy(&head).to_string();
                let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            });
        }
    });
    port
}

/// One raw HTTP request to the phone's proxy.
async fn http(port: u16, req: String) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(30), s.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).to_string()
}

fn req(method: &str, path: &str, port: u16, cookie: Option<&str>, extra: &str) -> String {
    let c = cookie.map(|c| format!("Cookie: theme=dark; wa_k={c}\r\n")).unwrap_or_default();
    let body = if method == "POST" { "Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}" } else { "\r\n" };
    format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/html\r\n{c}{extra}{body}")
}

async fn wait_state(port: u16, cookie: &str, want: &str) {
    let mut last = String::new();
    for _ in 0..120 {
        let r = http(port, req("GET", "/__wa/status", port, Some(cookie), "")).await;
        if r.contains(&format!("\"state\":\"{want}\"")) {
            return;
        }
        last = r;
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("state never became {want}; last reply: {last}");
}

#[tokio::test(flavor = "multi_thread")]
async fn phone_app_network_layer() {
    let desk_dir = tempfile::tempdir().unwrap();
    let dash = dashboard().await;
    // A fixed UDP port: with no relay in this test, a restarted bridge must come back on the same address.
    let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let mut b = Bridge::start(desk_dir.path(), dash, udp);
    let key = SecretKey::generate();
    let my_id = key.public().to_string();
    let ep = Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled).secret_key(key).bind().await.unwrap();

    // Pairing: a code that is not ours, then the real one (with direct addresses, as there is no relay here).
    assert!(link::pair(&ep, "hello", "x").await.is_err());
    let token = b.cmd("pair_start", json!({}))["qr"]["token"].as_str().unwrap().to_string();
    let payload = json!({ "v": 1, "nodeId": b.node_id, "token": token, "addrs": b.addrs }).to_string();
    let desktop = link::pair(&ep, &payload, "טלפון בדיקה").await.unwrap();
    let again = link::pair(&ep, &payload, "x").await.unwrap_err().to_string();
    assert!(again.contains("לא בתוקף"), "{again}");

    let unpaired = Arc::new(AtomicBool::new(false));
    let flag = unpaired.clone();
    let proxy = Proxy::start(None, move || flag.store(true, Ordering::SeqCst)).await.unwrap();
    let port = proxy.port;
    *proxy.link.write().await = Some(link::Link::start(ep.clone(), &desktop).unwrap());

    // Session cookie: needed for everything; only the launch URL hands it out.
    assert!(http(port, req("GET", "/", port, None, "")).await.starts_with("HTTP/1.1 403"));
    assert!(http(port, req("GET", "/__wa/auth?k=wrong", port, None, "")).await.starts_with("HTTP/1.1 403"));
    let launch = proxy.launch_url();
    let path = launch.trim_start_matches(&proxy.origin());
    let r = http(port, req("GET", path, port, None, "")).await;
    assert!(r.starts_with("HTTP/1.1 302"), "{r}");
    let cookie = r.split("wa_k=").nth(1).unwrap().split(';').next().unwrap().to_string();
    assert!(r.contains("HttpOnly") && r.contains("SameSite=Lax"));

    // Another site pointing its name at 127.0.0.1 (DNS rebinding) is refused even with the cookie.
    let evil = format!("GET / HTTP/1.1\r\nHost: evil.example:{port}\r\nCookie: wa_k={cookie}\r\n\r\n");
    assert!(http(port, evil).await.starts_with("HTTP/1.1 403"));

    // Through to the computer: identity added by the bridge, our cookie removed, others kept, Origin rewritten.
    wait_state(port, &cookie, "connected").await;
    let r = http(port, req("POST", "/api/x", port, Some(&cookie), &format!("Origin: http://127.0.0.1:{port}\r\n"))).await;
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert!(r.contains(&format!("X-Remote-Peer-Id: {my_id}")));
    assert!(r.contains(&format!("Host: 127.0.0.1:{dash}")));
    assert!(r.contains(&format!("Origin: http://127.0.0.1:{dash}")));
    assert!(r.contains("Cookie: theme=dark\r\n"));
    assert!(!r.contains(&cookie));

    // The computer goes away: the page shows the Hebrew "not available" screen; it comes back: works again.
    b.stop();
    wait_state(port, &cookie, "offline").await;
    let r = http(port, req("GET", "/", port, Some(&cookie), "")).await;
    assert!(r.starts_with("HTTP/1.1 503") && r.contains("המחשב לא זמין כרגע"), "{r}");
    let mut b = Bridge::start(desk_dir.path(), dash, udp);
    http(port, req("POST", "/__wa/retry", port, Some(&cookie), "")).await;
    wait_state(port, &cookie, "connected").await;
    assert!(http(port, req("GET", "/", port, Some(&cookie), "")).await.starts_with("HTTP/1.1 200"));

    // Revoked on the computer: the app says so.
    b.cmd("revoke", json!({ "nodeId": my_id }));
    wait_state(port, &cookie, "revoked").await;

    // Unpair: only from our own page.
    let foreign = http(port, req("POST", "/__wa/unpair", port, Some(&cookie), "Origin: https://evil.example\r\n")).await;
    assert!(foreign.starts_with("HTTP/1.1 403"));
    assert!(!unpaired.load(Ordering::SeqCst));
    let ok = http(port, req("POST", "/__wa/unpair", port, Some(&cookie), &format!("Origin: http://127.0.0.1:{port}\r\n"))).await;
    assert!(ok.starts_with("HTTP/1.1 200"));
    assert!(unpaired.load(Ordering::SeqCst));
    b.stop();
}
