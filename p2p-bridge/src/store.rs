//! Everything the bridge keeps on disk, all inside the per-user data folder (`--data-dir`):
//! - `p2p_secret.key`: this computer's Iroh secret key (hex). It is the computer's identity: never in the repo.
//! - `paired_devices.json`: the phones that may connect (their Iroh NodeIds).
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use iroh::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};

const KEY_FILE: &str = "p2p_secret.key";
const DEVICES_FILE: &str = "paired_devices.json";

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Write via a temp file + rename, so a crash never leaves a half-written file behind.
fn write_atomic(path: &Path, data: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data).with_context(|| format!("writing {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

/// Load this computer's secret key, creating it on first run.
pub fn load_or_create_key(dir: &Path) -> Result<SecretKey> {
    let path = dir.join(KEY_FILE);
    if path.exists() {
        let text = fs::read_to_string(&path)?;
        let bytes: [u8; 32] = hex::decode(text.trim())
            .ok()
            .and_then(|b| b.try_into().ok())
            .context("p2p_secret.key is damaged")?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    let key = SecretKey::generate();
    write_atomic(&path, hex::encode(key.to_bytes()).as_bytes())?;
    Ok(key)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Device {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "pairedAt", default)]
    pub paired_at: u64,
    #[serde(rename = "lastSeen", default)]
    pub last_seen: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DevicesFile {
    devices: Vec<Device>,
}

/// The allowlist of paired phones.
pub struct Devices {
    path: PathBuf,
    list: Vec<Device>,
}

impl Devices {
    pub fn load(dir: &Path) -> Result<Self> {
        let path = dir.join(DEVICES_FILE);
        let list = if path.exists() {
            let f: DevicesFile = serde_json::from_slice(&fs::read(&path)?).context("paired_devices.json is damaged")?;
            // Keep only entries whose NodeId is a valid key, so a hand-edited file can't confuse the checks.
            f.devices.into_iter().filter(|d| d.node_id.parse::<PublicKey>().is_ok()).collect()
        } else {
            Vec::new()
        };
        Ok(Self { path, list })
    }

    fn save(&self) -> Result<()> {
        let f = DevicesFile { devices: self.list.clone() };
        write_atomic(&self.path, &serde_json::to_vec_pretty(&f)?)
    }

    pub fn list(&self) -> &[Device] {
        &self.list
    }

    pub fn contains(&self, id: &PublicKey) -> bool {
        let id = id.to_string();
        self.list.iter().any(|d| d.node_id == id)
    }

    /// Add (or rename) a device.
    pub fn add(&mut self, id: &PublicKey, name: &str) -> Result<()> {
        let id = id.to_string();
        let name: String = name.chars().filter(|c| !c.is_control()).take(60).collect();
        match self.list.iter_mut().find(|d| d.node_id == id) {
            Some(d) => d.name = name,
            None => self.list.push(Device { node_id: id, name, paired_at: now(), last_seen: now() }),
        }
        self.save()
    }

    /// Returns true when the device was in the list.
    pub fn remove(&mut self, id: &str) -> Result<bool> {
        let before = self.list.len();
        self.list.retain(|d| d.node_id != id);
        let removed = self.list.len() != before;
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    /// Remember when a device last connected (saved at most once a minute per device).
    pub fn touch(&mut self, id: &PublicKey) {
        let id = id.to_string();
        if let Some(d) = self.list.iter_mut().find(|d| d.node_id == id) {
            let t = now();
            if t.saturating_sub(d.last_seen) >= 60 {
                d.last_seen = t;
                let _ = self.save();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_created_once_and_reloaded() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_or_create_key(dir.path()).unwrap();
        let b = load_or_create_key(dir.path()).unwrap();
        assert_eq!(a.public(), b.public());
    }

    #[test]
    fn devices_add_remove_persist() {
        let dir = tempfile::tempdir().unwrap();
        let id = SecretKey::generate().public();
        let mut d = Devices::load(dir.path()).unwrap();
        assert!(!d.contains(&id));
        d.add(&id, "טלפון\u{0007} של דנה").unwrap();
        let d2 = Devices::load(dir.path()).unwrap();
        assert!(d2.contains(&id));
        assert_eq!(d2.list()[0].name, "טלפון של דנה"); // control characters dropped
        let mut d3 = d2;
        assert!(d3.remove(&id.to_string()).unwrap());
        assert!(!Devices::load(dir.path()).unwrap().contains(&id));
    }

    #[test]
    fn invalid_entries_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DEVICES_FILE), r#"{"devices":[{"nodeId":"not-a-key"}]}"#).unwrap();
        assert!(Devices::load(dir.path()).unwrap().list().is_empty());
    }
}
