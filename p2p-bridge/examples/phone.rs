//! A stand-in for the phone, for testing the bridge end to end.
//!
//!   cargo run --example phone -- <key-file> <desktop-node-id> pair <token> [name]
//!   cargo run --example phone -- <key-file> <desktop-node-id> get <path>
use std::path::Path;

use anyhow::{Context, Result};
use iroh::{Endpoint, EndpointAddr, PublicKey, SecretKey, endpoint::presets};

fn key(path: &Path) -> Result<SecretKey> {
    if let Ok(t) = std::fs::read_to_string(path) {
        let b: [u8; 32] = hex::decode(t.trim())?.try_into().ok().context("bad key")?;
        return Ok(SecretKey::from_bytes(&b));
    }
    let k = SecretKey::generate();
    std::fs::write(path, hex::encode(k.to_bytes()))?;
    Ok(k)
}

#[tokio::main]
async fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (key_file, desktop, mode, arg) = (&a[0], a[1].parse::<PublicKey>()?, a[2].as_str(), a.get(3).cloned().unwrap_or_default());
    let ep = Endpoint::builder(presets::N0).secret_key(key(Path::new(key_file))?).bind().await?;
    let mut addr = EndpointAddr::new(desktop);
    if let Ok(r) = std::env::var("RELAY") {
        if !r.is_empty() {
            addr = addr.with_relay_url(r.parse()?);
        }
    }
    match mode {
        "pair" => {
            let conn = ep.connect(addr, b"wa-summary/pair/1").await?;
            let (mut s, mut r) = conn.open_bi().await?;
            let name = a.get(4).cloned().unwrap_or_else(|| "test phone".into());
            s.write_all(serde_json::json!({ "token": arg, "name": name }).to_string().as_bytes()).await?;
            s.finish()?;
            println!("{}", String::from_utf8_lossy(&r.read_to_end(2048).await?));
            conn.close(0u32.into(), b"bye");
        }
        _ => {
            let conn = ep.connect(addr, b"wa-summary/http/1").await?;
            let (mut s, mut r) = conn.open_bi().await?;
            s.write_all(format!("GET {arg} HTTP/1.1\r\nHost: 127.0.0.1:9\r\nX-P2P-Proxy-Secret: forged\r\n\r\n").as_bytes()).await?;
            s.finish()?;
            match r.read_to_end(1 << 20).await {
                Ok(b) => println!("{}", String::from_utf8_lossy(&b)),
                Err(e) => println!("ERROR: {e} / {:?}", conn.close_reason()),
            }
            conn.close(0u32.into(), b"bye");
        }
    }
    ep.close().await;
    Ok(())
}
