//! src-tauri\src\characters\pin.rs — trust on first use for a pack's model: take a pin from
//! a file Rust read itself, and compare a pack's pin with the file today for the Settings
//! status. The load path (`bridge::read_character_model`) re-checks size and sha256 on every
//! read and does not use the cache below; the cache only spares re-hashing for the list.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Serialize;

use super::pack::{ModelPin, Pack};

#[derive(Clone, Copy, Serialize, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Missing,
    Changed,
    Invalid,
}

/// path -> (len, mtime, sha256) of the last hash taken for the list.
static HASHED: Mutex<Option<HashMap<String, (u64, SystemTime, String)>>> = Mutex::new(None);

/// Reads the file (path guard, 64 MiB cap, no leaf link) and pins what was read.
pub fn take(path: &str) -> Result<ModelPin, String> {
    let bytes = crate::bridge::read_character_glb(path)?;
    let pin = ModelPin { path: path.to_string(), bytes: bytes.len() as u64, sha256: crate::bridge::character_digest(&bytes) };
    if let Ok(md) = std::fs::metadata(path) {
        if let Ok(mtime) = md.modified() {
            let mut cache = HASHED.lock().unwrap_or_else(|p| p.into_inner());
            cache.get_or_insert_with(HashMap::new).insert(path.to_string(), (pin.bytes, mtime, pin.sha256.clone()));
        }
    }
    Ok(pin)
}

/// The pack's model today against its pin: status, a reason for anything but ok, and the
/// file's current size when it could be read. `fresh` (an explicit refresh: Settings ›
/// Characters opening) skips the len+mtime cache and rehashes, so a file rewritten with its
/// timestamp preserved still shows Changed there; background lists keep the cache.
pub fn check(pack: &Pack, fresh: bool) -> (Status, Option<String>, Option<u64>) {
    let path = &pack.model.path;
    let md = match std::fs::metadata(path) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (Status::Missing, Some(format!("{path} was not found")), None)
        }
        Err(e) => return (Status::Missing, Some(format!("{path}: {e}")), None),
    };
    let len = md.len();
    if len != pack.model.bytes {
        return (Status::Changed, Some("the file size differs from the pin".into()), Some(len));
    }
    if let (false, Ok(mtime)) = (fresh, md.modified()) {
        let cache = HASHED.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((l, m, sha)) = cache.as_ref().and_then(|c| c.get(path)) {
            if *l == len && *m == mtime {
                return verdict(sha == &pack.model.sha256, len);
            }
        }
    }
    match take(path) {
        Ok(now) => verdict(now.sha256 == pack.model.sha256 && now.bytes == pack.model.bytes, len),
        Err(e) => (Status::Invalid, Some(e), Some(len)),
    }
}

fn verdict(same: bool, len: u64) -> (Status, Option<String>, Option<u64>) {
    if same {
        (Status::Ok, None, Some(len))
    } else {
        (Status::Changed, Some("the file content differs from the pin".into()), Some(len))
    }
}
