//! p2p-bridge: lets your own paired phones open the local dashboard from anywhere, peer to peer.
//!
//! Iroh gives every device a key pair; connections are QUIC with TLS 1.3 to the exact key that was dialed,
//! go directly through NATs when possible and through an encrypted relay otherwise. The relay never sees content.
//!
//!   p2p-bridge --data-dir <per-user folder> --port <dashboard port>
//!   env P2P_PROXY_SECRET = per-session secret shared with the engine (not a CLI flag: flags are visible to other programs)
//!
//! Control: JSON lines on stdin (`{"id":1,"cmd":"status"}`), replies and events as JSON lines on stdout.
//! Logs go to stderr. When stdin closes (the engine went away) the bridge shuts down.
mod store;
mod tunnel;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use iroh::{
    Endpoint, PublicKey, RelayMode,
    endpoint::{Connection, VarInt, presets},
};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncBufReadExt, BufReader};

/// HTTP/WebSocket tunnel to the dashboard (paired phones only).
pub const HTTP_ALPN: &[u8] = b"wa-summary/http/1";
/// One-time pairing handshake (only while a pairing window is open).
pub const PAIR_ALPN: &[u8] = b"wa-summary/pair/1";

const DEFAULT_PAIR_SECS: u64 = 120;
const MAX_PAIR_SECS: u64 = 600;

struct Pairing {
    token: String,
    expires: Instant,
}

struct State {
    devices: store::Devices,
    pairing: Option<Pairing>,
    conns: HashMap<String, Vec<Connection>>,
}

type Shared = Arc<Mutex<State>>;

/// One JSON line on stdout (replies and events share the channel; the lock keeps lines whole).
fn emit(v: Value) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn log(msg: impl std::fmt::Display) {
    eprintln!("[p2p-bridge] {msg}");
}

struct Args {
    data_dir: PathBuf,
    port: u16,
    /// Tests only: no relay and no address publishing, reachable on this machine's own addresses.
    local_only: bool,
    /// Tests only (with --local-only): a fixed UDP port on 127.0.0.1, so a restarted bridge is found again.
    udp_port: u16,
}

fn parse_args() -> Result<Args> {
    let mut data_dir = None;
    let mut port = None;
    let mut local_only = false;
    let mut udp_port = 0;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--data-dir" => data_dir = it.next().map(PathBuf::from),
            "--port" => port = it.next().and_then(|p| p.parse().ok()),
            "--local-only" => local_only = true,
            "--udp-port" => udp_port = it.next().and_then(|p| p.parse().ok()).context("bad --udp-port")?,
            "--version" => {
                println!("p2p-bridge {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            other => bail!("unknown argument: {other}"),
        }
    }
    Ok(Args { data_dir: data_dir.context("--data-dir is required")?, port: port.context("--port is required")?, local_only, udp_port })
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;
    let secret = std::env::var("P2P_PROXY_SECRET").unwrap_or_default();
    if secret.len() < 32 || !secret.chars().all(|c| c.is_ascii_alphanumeric()) {
        bail!("P2P_PROXY_SECRET must be at least 32 letters/digits");
    }
    std::fs::create_dir_all(&args.data_dir)?;
    let key = store::load_or_create_key(&args.data_dir)?;
    let devices = store::Devices::load(&args.data_dir)?;

    let builder = if args.local_only {
        Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .clear_ip_transports()
            .bind_addr(format!("127.0.0.1:{}", args.udp_port).as_str())?
    } else {
        Endpoint::builder(presets::N0)
    };
    let endpoint = builder
        .secret_key(key)
        .alpns(vec![HTTP_ALPN.to_vec(), PAIR_ALPN.to_vec()])
        .bind()
        .await?;
    let state: Shared = Arc::new(Mutex::new(State { devices, pairing: None, conns: HashMap::new() }));
    let ports: Vec<u16> = endpoint.bound_sockets().iter().map(|a| a.port()).collect();
    emit(json!({ "event": "ready", "nodeId": endpoint.id().to_string(), "ports": ports }));
    log(format!("listening as {}", endpoint.id()));

    if !args.local_only {
        let endpoint = endpoint.clone();
        tokio::spawn(async move {
            if tokio::time::timeout(Duration::from_secs(30), endpoint.online()).await.is_ok() {
                emit(json!({ "event": "online", "relayUrl": relay_url(&endpoint) }));
            } else {
                emit(json!({ "event": "offline" }));
            }
        });
    }

    let accept = tokio::spawn(accept_loop(endpoint.clone(), state.clone(), args.port, secret));
    control_loop(&endpoint, &state).await;
    accept.abort();
    endpoint.close().await;
    Ok(())
}

fn relay_url(endpoint: &Endpoint) -> Option<String> {
    endpoint.addr().relay_urls().next().map(|u| u.to_string())
}

async fn accept_loop(endpoint: Endpoint, state: Shared, port: u16, secret: String) {
    while let Some(incoming) = endpoint.accept().await {
        let state = state.clone();
        let secret = secret.clone();
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(c) => c,
                Err(e) => return log(format!("handshake failed: {e}")),
            };
            let peer = conn.remote_id();
            if conn.alpn() == PAIR_ALPN {
                if let Err(e) = handle_pairing(&conn, &state).await {
                    log(format!("pairing from {} refused: {e}", peer.fmt_short()));
                }
            } else if conn.alpn() == HTTP_ALPN {
                handle_http(conn, state, port, secret).await;
            } else {
                conn.close(VarInt::from_u32(1), b"unknown protocol");
            }
        });
    }
}

/// Phone sends one JSON line `{"token": "...", "name": "..."}`; we answer `{"ok": true}` or `{"ok": false, "error": "..."}`.
async fn handle_pairing(conn: &Connection, state: &Shared) -> Result<()> {
    let peer = conn.remote_id();
    let (mut send, mut recv) = tokio::time::timeout(Duration::from_secs(15), conn.accept_bi()).await??;
    let body = tokio::time::timeout(Duration::from_secs(15), recv.read_to_end(2048)).await??;
    let msg: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let token = msg["token"].as_str().unwrap_or("");
    let name = msg["name"].as_str().unwrap_or("");

    let result = {
        let mut st = state.lock().unwrap();
        match &st.pairing {
            Some(p) if p.expires > Instant::now() && bool::from(p.token.as_bytes().ct_eq(token.as_bytes())) => {
                st.pairing = None; // one-time token: used up now
                st.devices.add(&peer, name).map(|_| ())
            }
            Some(p) if p.expires <= Instant::now() => Err(anyhow::anyhow!("pairing window expired")),
            Some(_) => Err(anyhow::anyhow!("wrong token")),
            None => Err(anyhow::anyhow!("pairing is not open")),
        }
    };
    let reply = match &result {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    };
    send.write_all(reply.to_string().as_bytes()).await?;
    send.finish()?;
    // Give the reply time to arrive before the connection goes away.
    let _ = tokio::time::timeout(Duration::from_secs(5), conn.closed()).await;
    if result.is_ok() {
        log(format!("paired {}", peer.fmt_short()));
        emit(json!({ "event": "paired", "nodeId": peer.to_string(), "name": name }));
    }
    result
}

async fn handle_http(conn: Connection, state: Shared, port: u16, secret: String) {
    let peer: PublicKey = conn.remote_id();
    let id = peer.to_string();
    {
        let mut st = state.lock().unwrap();
        if !st.devices.contains(&peer) {
            drop(st);
            log(format!("refused unpaired device {}", peer.fmt_short()));
            conn.close(VarInt::from_u32(403), b"not paired");
            return;
        }
        st.devices.touch(&peer);
        st.conns.entry(id.clone()).or_default().push(conn.clone());
    }
    emit(json!({ "event": "connected", "nodeId": id }));

    loop {
        let (send, recv) = match conn.accept_bi().await {
            Ok(s) => s,
            Err(_) => break,
        };
        // Revoked while connected: stop serving at once.
        if !state.lock().unwrap().devices.contains(&peer) {
            conn.close(VarInt::from_u32(403), b"revoked");
            break;
        }
        let (id, secret) = (id.clone(), secret.clone());
        tokio::spawn(async move {
            if let Err(e) = tunnel::proxy_stream(send, recv, port, id, secret).await {
                log(format!("stream error: {e}"));
            }
        });
    }

    let mut st = state.lock().unwrap();
    if let Some(list) = st.conns.get_mut(&id) {
        list.retain(|c| c.stable_id() != conn.stable_id());
        if list.is_empty() {
            st.conns.remove(&id);
        }
    }
    drop(st);
    emit(json!({ "event": "disconnected", "nodeId": id }));
}

async fn control_loop(endpoint: &Endpoint, state: &Shared) {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                emit(json!({ "ok": false, "error": "bad json" }));
                continue;
            }
        };
        let id = msg["id"].clone();
        let cmd = msg["cmd"].as_str().unwrap_or("");
        if cmd == "shutdown" {
            emit(json!({ "id": id, "ok": true }));
            break;
        }
        let mut reply = match command(endpoint, state, cmd, &msg).await {
            Ok(v) => v,
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        };
        reply["id"] = id;
        emit(reply);
    }
}

fn devices_json(st: &State) -> Value {
    Value::Array(
        st.devices
            .list()
            .iter()
            .map(|d| {
                let mut v = serde_json::to_value(d).unwrap_or(Value::Null);
                v["connected"] = json!(st.conns.contains_key(&d.node_id));
                v
            })
            .collect(),
    )
}

async fn command(endpoint: &Endpoint, state: &Shared, cmd: &str, msg: &Value) -> Result<Value> {
    match cmd {
        "status" => {
            let st = state.lock().unwrap();
            let pairing = st.pairing.as_ref().filter(|p| p.expires > Instant::now()).map(|p| p.expires.duration_since(Instant::now()).as_secs());
            Ok(json!({
                "ok": true,
                "nodeId": endpoint.id().to_string(),
                "relayUrl": relay_url(endpoint),
                "pairing": pairing.map(|s| json!({ "expiresIn": s })),
                "devices": devices_json(&st),
            }))
        }
        "pair_start" => {
            let secs = msg["ttl"].as_u64().unwrap_or(DEFAULT_PAIR_SECS).clamp(1, MAX_PAIR_SECS);
            // Wait (briefly) for a relay, so the QR code includes a way to reach us from outside the home network.
            if relay_url(endpoint).is_none() {
                let _ = tokio::time::timeout(Duration::from_secs(10), endpoint.online()).await;
            }
            let token = hex::encode(rand::random::<[u8; 16]>());
            state.lock().unwrap().pairing = Some(Pairing { token: token.clone(), expires: Instant::now() + Duration::from_secs(secs) });
            log("pairing window open");
            Ok(json!({
                "ok": true,
                "expiresIn": secs,
                "qr": { "v": 1, "nodeId": endpoint.id().to_string(), "relayUrl": relay_url(endpoint), "token": token },
            }))
        }
        "pair_stop" => {
            state.lock().unwrap().pairing = None;
            Ok(json!({ "ok": true }))
        }
        "list" => Ok(json!({ "ok": true, "devices": devices_json(&state.lock().unwrap()) })),
        "revoke" => {
            let node = msg["nodeId"].as_str().context("nodeId is required")?.to_string();
            let mut st = state.lock().unwrap();
            let removed = st.devices.remove(&node)?;
            for c in st.conns.remove(&node).unwrap_or_default() {
                c.close(VarInt::from_u32(403), b"revoked");
            }
            if removed {
                log(format!("revoked {node}"));
            }
            Ok(json!({ "ok": true, "removed": removed }))
        }
        _ => bail!("unknown command"),
    }
}
