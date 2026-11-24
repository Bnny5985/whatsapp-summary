//! What the app keeps, all in its private app-data folder (sandboxed on iOS and Android; never world-readable):
//! - `phone_secret.key`: this phone's Iroh identity (hex).
//! - `desktop.json`: the paired computer `{ nodeId, relayUrl, pairedAt }`.
//! - `proxy_port`: the local port the dashboard is served on, kept so the page keeps its own saved preferences.
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use iroh::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub struct Store {
    dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Desktop {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "relayUrl", default)]
    pub relay_url: Option<String>,
    #[serde(rename = "pairedAt", default)]
    pub paired_at: u64,
    /// Optional direct addresses (a hint, like relayUrl; Iroh also finds the computer on its own).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub addrs: Vec<std::net::SocketAddr>,
}

impl Desktop {
    pub fn id(&self) -> Result<PublicKey> {
        self.node_id.parse().context("bad desktop NodeId")
    }
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn key(&self) -> Result<SecretKey> {
        let path = self.dir.join("phone_secret.key");
        if let Ok(text) = fs::read_to_string(&path) {
            let bytes: [u8; 32] = hex::decode(text.trim()).ok().and_then(|b| b.try_into().ok()).context("phone_secret.key is damaged")?;
            return Ok(SecretKey::from_bytes(&bytes));
        }
        let key = SecretKey::generate();
        write_private(&path, hex::encode(key.to_bytes()).as_bytes())?;
        Ok(key)
    }

    pub fn desktop(&self) -> Option<Desktop> {
        let d: Desktop = serde_json::from_slice(&fs::read(self.dir.join("desktop.json")).ok()?).ok()?;
        d.id().ok().map(|_| d)
    }

    pub fn save_desktop(&self, d: &Desktop) -> Result<()> {
        write_private(&self.dir.join("desktop.json"), &serde_json::to_vec_pretty(d)?)
    }

    pub fn forget_desktop(&self) -> Result<()> {
        match fs::remove_file(self.dir.join("desktop.json")) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    pub fn proxy_port(&self) -> Option<u16> {
        fs::read_to_string(self.dir.join("proxy_port")).ok()?.trim().parse().ok()
    }

    pub fn save_proxy_port(&self, port: u16) {
        let _ = write_private(&self.dir.join("proxy_port"), port.to_string().as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_desktop_roundtrip() {
        let dir = std::env::temp_dir().join(format!("wa-mobile-test-{}", rand::random::<u64>()));
        let s = Store::new(dir.clone());
        assert_eq!(s.key().unwrap().public(), s.key().unwrap().public());
        assert!(s.desktop().is_none());
        let d = Desktop { node_id: SecretKey::generate().public().to_string(), relay_url: Some("https://relay.example./".into()), paired_at: 1, addrs: vec![] };
        s.save_desktop(&d).unwrap();
        assert_eq!(s.desktop(), Some(d));
        s.forget_desktop().unwrap();
        assert!(s.desktop().is_none());
        s.forget_desktop().unwrap(); // forgetting twice is fine
        let _ = fs::remove_dir_all(dir);
    }
}
