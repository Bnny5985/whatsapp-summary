//! The Iroh connection to the paired computer: one QUIC connection, reused for every request (one stream each),
//! reconnected in the background with backoff, re-checked when the app comes back to the foreground.
use std::{sync::Arc, time::Duration};

use anyhow::{Result, anyhow, bail};
use iroh::{
    Endpoint, EndpointAddr, RelayUrl, TransportAddr,
    endpoint::{Connection, ConnectionError, VarInt},
};
use serde_json::json;
use tokio::sync::{Mutex, Notify, watch};

use crate::store::Desktop;

pub const HTTP_ALPN: &[u8] = b"wa-summary/http/1";
pub const PAIR_ALPN: &[u8] = b"wa-summary/pair/1";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Connecting,
    Connected,
    /// The computer is asleep, offline or unreachable.
    Offline,
    /// The computer revoked this phone (or it was never paired).
    Revoked,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Connecting => "connecting",
            State::Connected => "connected",
            State::Offline => "offline",
            State::Revoked => "revoked",
        }
    }
}

pub fn desktop_addr(d: &Desktop) -> Result<EndpointAddr> {
    let mut addr = EndpointAddr::new(d.id()?);
    if let Some(r) = d.relay_url.as_deref().filter(|r| !r.is_empty()) {
        addr = addr.with_relay_url(r.parse::<RelayUrl>()?);
    }
    for a in &d.addrs {
        addr.addrs.insert(TransportAddr::Ip(*a));
    }
    Ok(addr)
}

fn is_revoked(err: &ConnectionError) -> bool {
    matches!(err, ConnectionError::ApplicationClosed(c) if c.error_code == VarInt::from_u32(403))
}

/// The pairing handshake. Returns the paired computer on success.
pub async fn pair(endpoint: &Endpoint, payload: &str, name: &str) -> Result<Desktop> {
    let qr: serde_json::Value = serde_json::from_str(payload.trim()).map_err(|_| anyhow!("זה לא קוד של התוכנה"))?;
    if qr["v"] != json!(1) {
        bail!("זה לא קוד של התוכנה, או שהגרסה לא נתמכת");
    }
    let desktop = Desktop {
        node_id: qr["nodeId"].as_str().unwrap_or_default().to_string(),
        relay_url: qr["relayUrl"].as_str().map(String::from),
        addrs: qr["addrs"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()?.parse().ok()).collect()).unwrap_or_default(),
        paired_at: crate::store::now(),
    };
    let token = qr["token"].as_str().unwrap_or_default();
    let addr = desktop_addr(&desktop).map_err(|_| anyhow!("הקוד פגום"))?;
    let conn = tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(addr, PAIR_ALPN))
        .await
        .map_err(|_| anyhow!("לא הצלחתי להגיע למחשב. ודא שהתוכנה פועלת במחשב ושהטלפון מחובר לאינטרנט"))?
        .map_err(|e| anyhow!("לא הצלחתי להתחבר למחשב: {e}"))?;
    let (mut send, mut recv) = conn.open_bi().await?;
    send.write_all(json!({ "token": token, "name": name }).to_string().as_bytes()).await?;
    send.finish()?;
    let reply: serde_json::Value = serde_json::from_slice(&tokio::time::timeout(CONNECT_TIMEOUT, recv.read_to_end(4096)).await??)?;
    conn.close(0u32.into(), b"paired");
    if reply["ok"] != json!(true) {
        let why = match reply["error"].as_str().unwrap_or("") {
            "pairing window expired" => "הקוד פג. לחץ במחשב שוב על \"צמד טלפון חדש\"",
            "wrong token" | "pairing is not open" => "הקוד כבר לא בתוקף. לחץ במחשב שוב על \"צמד טלפון חדש\"",
            other => return Err(anyhow!("המחשב סירב: {other}")),
        };
        bail!(why);
    }
    Ok(desktop)
}

pub struct Link {
    endpoint: Endpoint,
    addr: EndpointAddr,
    conn: Mutex<Option<Connection>>,
    state: watch::Sender<State>,
    /// "Try now" (manual retry, back in the foreground).
    wake: Notify,
    /// A request made a new connection while the background task was waiting to retry.
    fresh: Notify,
    stop: Notify,
}

impl Link {
    pub fn start(endpoint: Endpoint, desktop: &Desktop) -> Result<Arc<Link>> {
        let link = Arc::new(Link {
            endpoint,
            addr: desktop_addr(desktop)?,
            conn: Mutex::new(None),
            state: watch::channel(State::Connecting).0,
            wake: Notify::new(),
            fresh: Notify::new(),
            stop: Notify::new(),
        });
        tokio::spawn(link.clone().keep_connected());
        Ok(link)
    }

    pub fn state(&self) -> State {
        *self.state.borrow()
    }

    /// The live connection, connecting first when needed.
    pub async fn connection(&self) -> Result<Connection> {
        let mut slot = self.conn.lock().await;
        if let Some(c) = slot.as_ref() {
            if c.close_reason().is_none() {
                return Ok(c.clone());
            }
        }
        *slot = None;
        self.state.send_replace(State::Connecting);
        match tokio::time::timeout(CONNECT_TIMEOUT, self.endpoint.connect(self.addr.clone(), HTTP_ALPN)).await {
            Ok(Ok(c)) => {
                *slot = Some(c.clone());
                self.state.send_replace(State::Connected);
                self.fresh.notify_one(); // let the background task follow this connection
                Ok(c)
            }
            Ok(Err(e)) => {
                self.state.send_replace(State::Offline);
                Err(anyhow!("connect failed: {e}"))
            }
            Err(_) => {
                self.state.send_replace(State::Offline);
                Err(anyhow!("connect timed out"))
            }
        }
    }

    /// Background: keep a connection open; when it drops, reconnect with growing pauses (1s .. 30s).
    async fn keep_connected(self: Arc<Self>) {
        let mut pause = Duration::from_secs(1);
        loop {
            let conn = match self.connection().await {
                Ok(c) => c,
                Err(_) => {
                    tokio::select! {
                        _ = tokio::time::sleep(pause) => {}
                        _ = self.wake.notified() => {}
                        _ = self.fresh.notified() => {}
                        _ = self.stop.notified() => return,
                    }
                    pause = (pause * 2).min(Duration::from_secs(30));
                    continue;
                }
            };
            pause = Duration::from_secs(1);
            let err = tokio::select! {
                e = conn.closed() => e,
                _ = self.stop.notified() => return,
            };
            if is_revoked(&err) {
                self.state.send_replace(State::Revoked);
                // Keep checking now and then, in case the computer pairs us again; a manual retry also wakes this.
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                    _ = self.wake.notified() => {}
                    _ = self.stop.notified() => return,
                }
            } else {
                self.state.send_replace(State::Offline);
            }
        }
    }

    /// "נסה שוב": reconnect right away.
    pub fn retry(&self) {
        self.wake.notify_one();
    }

    /// Back in the foreground: the network may have changed while asleep. Send a tiny request; if it does not
    /// come back quickly, drop the connection so the background task makes a fresh one.
    #[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
    pub async fn probe(&self) {
        let conn = self.conn.lock().await.clone();
        let Some(conn) = conn.filter(|c| c.close_reason().is_none()) else {
            self.retry();
            return;
        };
        let ok = tokio::time::timeout(Duration::from_secs(4), async {
            let (mut s, mut r) = conn.open_bi().await?;
            s.write_all(b"HEAD /public/manifest.webmanifest HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await?;
            s.finish()?;
            let mut b = [0u8; 12];
            r.read_exact(&mut b).await?;
            anyhow::Ok(b.starts_with(b"HTTP/1.1"))
        })
        .await;
        if !matches!(ok, Ok(Ok(true))) {
            conn.close(0u32.into(), b"stale");
            self.retry();
        }
    }

    pub async fn shutdown(&self) {
        self.stop.notify_waiters();
        self.stop.notify_one();
        if let Some(c) = self.conn.lock().await.take() {
            c.close(0u32.into(), b"unpaired");
        }
    }
}
