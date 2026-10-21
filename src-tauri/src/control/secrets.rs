//! src-tauri\src\control\secrets.rs — the per-session control-bus secret store:
//! `{ "<falcon session>": "<32 hex>" }` at contract id `ctlSecrets`. Vidar mints
//! a secret per Falcon spawn (`falcon/session_commands.rs`), Falcon exports it
//! to the hosted child as `VIDAR_CTL_SECRET`, and `policy::resolve` accepts a
//! `falcon_session` identity only with the matching `secret`.
//!
//! The public fns use the real file; the `*_at` fns take the path so tests
//! never touch the runtime folder. A missing or corrupt file reads as empty.
//!
//! The file holds `sha256(secret)` (64 lowercase hex), never the secret: an
//! agent that reads it cannot present a value that resolves. `policy::resolve`
//! hashes the given secret and compares digests. Migration: a value that is not
//! a 64-hex digest is a pre-hash plaintext entry; it is hashed in place on the
//! first read, so a live session keeps working while the plaintext leaves the
//! disk (an empty value is dropped: it never matched).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

/// `sha256(secret)` as 64 lowercase hex: the stored form.
pub(crate) fn digest(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(secret.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Serialises read-modify-write so two concurrent spawns never lose an entry.
static LOCK: Mutex<()> = Mutex::new(());

/// 32 lowercase hex from the OS CSPRNG (`getrandom`, 128 bits).
pub fn mint() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("ctl secret: no OS randomness: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn load() -> HashMap<String, String> {
    load_at(&crate::paths::ctl_secrets_path())
}

/// The stored digest for `session`, never the secret itself.
pub fn get(session: &str) -> Option<String> {
    load().remove(session)
}

/// Stores `sha256(secret)` for `session`.
pub fn put(session: &str, secret: &str) -> Result<(), String> {
    put_at(&crate::paths::ctl_secrets_path(), session, secret)
}

pub fn remove(session: &str) -> Result<(), String> {
    remove_at(&crate::paths::ctl_secrets_path(), session)
}

/// session -> digest; migrates plaintext entries on the way (see the module doc).
pub(crate) fn load_at(path: &Path) -> HashMap<String, String> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    read_migrated(path)
}

pub(crate) fn put_at(path: &Path, session: &str, secret: &str) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = read_migrated(path);
    map.insert(session.to_string(), digest(secret));
    write_unlocked(path, &map)
}

pub(crate) fn remove_at(path: &Path, session: &str) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = read_migrated(path);
    if map.remove(session).is_none() {
        return Ok(());
    }
    write_unlocked(path, &map)
}

/// Reads the map and rewrites any plaintext entry as its digest (empty ones
/// dropped). A failed rewrite still returns the migrated map, so a plaintext
/// value never resolves as itself either way.
fn read_migrated(path: &Path) -> HashMap<String, String> {
    let mut map = read_unlocked(path);
    if map.values().all(|v| is_digest(v)) {
        return map;
    }
    map.retain(|_, v| !v.is_empty());
    for v in map.values_mut() {
        if !is_digest(v) {
            *v = digest(v);
        }
    }
    if let Err(e) = write_unlocked(path, &map) {
        eprintln!("[ctl-secrets] migrate {}: {e}", path.display());
    }
    map
}

fn read_unlocked(path: &Path) -> HashMap<String, String> {
    let text = match crate::fsx::read_text(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return HashMap::new(),
        Err(e) => {
            eprintln!("[ctl-secrets] read {}: {e}; treating as empty", path.display());
            return HashMap::new();
        }
    };
    match serde_json::from_str(&text) {
        Ok(map) => map,
        Err(e) => {
            eprintln!("[ctl-secrets] {} is not a string map ({e}); treating as empty", path.display());
            HashMap::new()
        }
    }
}

fn write_unlocked(path: &Path, map: &HashMap<String, String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("ctl secrets dir: {e}"))?;
    }
    let text = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    // serde_json writes UTF-8 and no BOM; fsx renames a synced sibling tmp over the file.
    crate::fsx::atomic_write(path, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(std::path::PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp(tag: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!("vidar-ctl-secrets-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        TempDir(dir)
    }

    #[test]
    fn secrets_round_trip_through_the_file() {
        let dir = temp("roundtrip");
        let path = dir.0.join("ctl-secrets.json");
        assert!(load_at(&path).is_empty(), "a missing file reads as empty");
        put_at(&path, "s-1", "aa").unwrap();
        put_at(&path, "s-2", "bb").unwrap();
        let map = load_at(&path);
        assert_eq!(map.get("s-1"), Some(&digest("aa")));
        assert_eq!(map.get("s-2"), Some(&digest("bb")));
        remove_at(&path, "s-1").unwrap();
        assert_eq!(load_at(&path).len(), 1);
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.starts_with(&[0xEF, 0xBB, 0xBF]), "no BOM");
    }

    #[test]
    fn the_file_never_holds_the_secret() {
        let dir = temp("hashed");
        let path = dir.0.join("ctl-secrets.json");
        let secret = mint().unwrap();
        put_at(&path, "s-1", &secret).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&secret), "plaintext on disk: {text}");
        assert!(text.contains(&digest(&secret)));
        assert_eq!(
            digest("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_plaintext_file_is_hashed_in_place_on_load() {
        let dir = temp("migrate");
        std::fs::create_dir_all(&dir.0).unwrap();
        let path = dir.0.join("ctl-secrets.json");
        let old = "0123456789abcdef0123456789abcdef";
        std::fs::write(&path, format!(r#"{{"s-1": "{old}", "s-2": ""}}"#)).unwrap();
        let map = load_at(&path);
        assert_eq!(map.get("s-1"), Some(&digest(old)), "plaintext becomes its digest");
        assert!(!map.contains_key("s-2"), "an empty entry is dropped");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(old), "plaintext rewritten on disk: {text}");
        // already-migrated values are left alone (no double hashing)
        assert_eq!(load_at(&path).get("s-1"), Some(&digest(old)));
    }

    #[test]
    fn a_corrupt_secrets_file_reads_as_empty() {
        let dir = temp("corrupt");
        std::fs::create_dir_all(&dir.0).unwrap();
        let path = dir.0.join("ctl-secrets.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert!(load_at(&path).is_empty());
        std::fs::write(&path, br#"{"s-1": 7}"#).unwrap();
        assert!(load_at(&path).is_empty(), "a non-string value is corrupt too");
        put_at(&path, "s-1", "cc").unwrap();
        assert_eq!(load_at(&path).get("s-1"), Some(&digest("cc")));
    }

    #[test]
    fn mint_is_32_lowercase_hex_and_varies() {
        let a = mint().unwrap();
        let b = mint().unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)), "{a}");
        assert_ne!(a, b);
    }
}
