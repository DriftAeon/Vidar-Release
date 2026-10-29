//! src-tauri\src\voice_slots\pins.rs — trust on first use for what an adapter runs:
//! `bridge\voice-slots\pins.json`, path -> {bytes, sha256}. A manifest that declares a model's or
//! file's sha256 is checked against that instead. The store only gains entries on first use
//! (`resolve`); an existing pin is overwritten only by Trust Current. Gateway module
//! declarations share the store under `module:<id>` keys (`modules::scan`, `verdict_bytes`).

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::probe::Target;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pin {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Store {
    #[serde(default)]
    pub pins: BTreeMap<String, Pin>,
}

pub enum Verdict {
    Match,
    /// No pin yet: this is what the file holds now, recorded on first use.
    Unpinned(Pin),
    Changed,
}

/// Serialises read-modify-write of the store across commands.
static STORE_LOCK: Mutex<()> = Mutex::new(());
/// path -> (len, mtime, sha256) of the last hash taken, so a status refresh does not rehash
/// a model whose size and timestamp are unchanged.
static HASHED: Mutex<Option<HashMap<PathBuf, (u64, SystemTime, String)>>> = Mutex::new(None);

fn key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// A missing store is empty; an unreadable or unparsable one is an error (fail closed: a
/// damaged store must not read as "nothing pinned" and re-trust everything).
pub fn load(path: &Path) -> Result<Store, String> {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(format!("pins.json: {e}")),
        Ok(text) => serde_json::from_str(crate::settings::store::strip_bom(&text)).map_err(|e| format!("pins.json: {e}")),
    }
}

/// The file's size and sha256 now, streamed; cached by (len, mtime).
pub fn digest(path: &Path) -> Result<Pin, String> {
    use sha2::{Digest, Sha256};
    let md = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mtime = md.modified().ok();
    if let Some(m) = mtime {
        let cache = HASHED.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((len, at, sha)) = cache.as_ref().and_then(|c| c.get(path)) {
            if *len == md.len() && *at == m {
                return Ok(Pin { bytes: *len, sha256: sha.clone() });
            }
        }
    }
    let mut f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut bytes = 0u64;
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("{}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        bytes += n as u64;
    }
    let sha256: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if let Some(m) = mtime {
        let mut cache = HASHED.lock().unwrap_or_else(|p| p.into_inner());
        cache.get_or_insert_with(HashMap::new).insert(path.to_path_buf(), (bytes, m, sha256.clone()));
    }
    Ok(Pin { bytes, sha256 })
}

/// The target against its declared hash, else against the store.
pub fn verdict(store: &Store, t: &Target) -> Result<Verdict, String> {
    let now = digest(&t.path)?;
    if t.bytes.is_some_and(|b| b != now.bytes) {
        return Ok(Verdict::Changed);
    }
    if let Some(sha) = &t.sha256 {
        return Ok(if *sha == now.sha256 { Verdict::Match } else { Verdict::Changed });
    }
    Ok(match store.pins.get(&key(&t.path)) {
        Some(p) if *p == now => Verdict::Match,
        Some(_) => Verdict::Changed,
        None => Verdict::Unpinned(now),
    })
}

/// Bytes held in memory (a module's gateway declaration, `modules::scan`) against the store
/// entry under `key`: same store, same verdicts as a file pin.
pub fn verdict_bytes(store: &Store, key: &Path, bytes: &[u8]) -> Verdict {
    use sha2::{Digest, Sha256};
    let sha256: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    let now = Pin { bytes: bytes.len() as u64, sha256 };
    match store.pins.get(&self::key(key)) {
        Some(p) if *p == now => Verdict::Match,
        Some(_) => Verdict::Changed,
        None => Verdict::Unpinned(now),
    }
}

/// Adds pins. `overwrite` false keeps any pin already there (first use, which may race another
/// resolve); true replaces it (Trust Current only). `Ok` means every stored pin now equals the
/// one passed in; a kept pin that differs is an `Err` naming its key, after the store is
/// written, so a caller never trusts a pin the store does not hold (`modules::scan` `settle`).
pub fn record(store_path: &Path, pins: Vec<(PathBuf, Pin)>, overwrite: bool) -> Result<(), String> {
    if pins.is_empty() {
        return Ok(());
    }
    let _g = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut store = load(store_path)?;
    let mut differs = Vec::new();
    for (path, pin) in pins {
        let k = key(&path);
        match store.pins.get(&k) {
            Some(old) if !overwrite && *old != pin => differs.push(k),
            Some(_) if !overwrite => {}
            _ => {
                store.pins.insert(k, pin);
            }
        }
    }
    if let Some(dir) = store_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?;
    crate::fsx::atomic_write(store_path, &json)?;
    if differs.is_empty() {
        Ok(())
    } else {
        Err(format!("pins.json holds a different pin for {}", differs.join(", ")))
    }
}
