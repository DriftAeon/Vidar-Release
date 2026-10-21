//! src-tauri\src\flow_store.rs — Flow's graphs, templates and run history as
//! files: one file per
//! storage key under `<root>\state\flow\<key>.json`, each holding exactly the
//! string `src\flow\file-storage-core.ts` was given. Replaces WebView2
//! localStorage, which sits under %LOCALAPPDATA%, not the Vidar folder.
//!
//! - One writer per folder: `writer.lock` is opened with `share_mode(0)` and
//!   the handle kept for the life of the process. A second Vidar gets
//!   `writable:false` and every write from it is refused.
//! - The key regex is the trust boundary: a key becomes a file name.
//! - A batch is validated whole before any file is touched; a bad entry
//!   rejects the batch by name (`rejected <key>: ...`), which the TS pump drops
//!   instead of retrying.
//! - Batches carry the page id `flow_store_open` handed out and a sequence
//!   number; one no newer than the last applied *from the same page* is
//!   ignored, because a flush may overtake an in-flight batch and always
//!   carries a superset of its keys with newer values. Staleness never
//!   crosses pages: an old page's pagehide batch landing after a reload's open
//!   must not make the new page's batches look stale. Nothing resets; the
//!   open also returns the highest seq applied so far, and the page numbers
//!   its batches from there.
//! - A file is absent only on NotFound; any other read error (including
//!   invalid UTF-8) fails the whole open and names the file, so an unreadable
//!   key is never taken as absent and reseeded over.

use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

const MAX_VALUE_BYTES: usize = 16 * 1024 * 1024;
const LOCK_FILE: &str = "writer.lock";
const LOCK_RETRY: Duration = Duration::from_secs(3);
/// Win32 ERROR_SHARING_VIOLATION: another process holds `writer.lock`.
const SHARING_VIOLATION: i32 = 32;

/// `^vidar\.flow\.[A-Za-z0-9._-]{1,120}$`, no `..`, no trailing `.`.
/// `file-storage-core.ts` `isFlowKey` is the same rule.
pub fn valid_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("vidar.flow.") else { return false };
    !rest.is_empty()
        && rest.len() <= 120
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !key.contains("..")
        && !key.ends_with('.')
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenReply {
    writable: bool,
    entries: BTreeMap<String, String>,
    /// This page load's id; every write from it carries it back.
    page: u64,
    /// The highest seq applied so far in this process; the page numbers from here.
    seq: u64,
    /// Set when `writer.lock` failed for a reason other than another holder.
    lock_error: Option<String>,
}

struct FlowStore {
    dir: PathBuf,
    /// Held for the life of the process once acquired; its presence is what
    /// makes this process the writer.
    lock: Option<File>,
    /// Highest seq applied from any page; never reset.
    last_seq: u64,
    /// Last applied seq per page id; never reset, one small entry per page load.
    page_seq: HashMap<u64, u64>,
    next_page: u64,
}

impl FlowStore {
    fn at(dir: PathBuf) -> Self {
        Self { dir, lock: None, last_seq: 0, page_seq: HashMap::new(), next_page: 0 }
    }
}

/// `Ok(None)`: another holder kept it past `retry`. `Err`: any other failure.
fn acquire_lock(path: &Path, retry: Duration) -> Result<Option<File>, String> {
    let deadline = Instant::now() + retry;
    loop {
        match OpenOptions::new().read(true).write(true).create(true).truncate(false).share_mode(0).open(path) {
            Ok(f) => return Ok(Some(f)),
            Err(e) if e.raw_os_error() == Some(SHARING_VIOLATION) => {
                if Instant::now() >= deadline {
                    return Ok(None);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("can't open {LOCK_FILE}: {e}")),
        }
    }
}

fn read_entries(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut entries = BTreeMap::new();
    let listing = match std::fs::read_dir(dir) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    for item in listing {
        let item = item.map_err(|e| format!("{}: {e}", dir.display()))?;
        let name = item.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(key) = name.strip_suffix(".json") else { continue };
        if !valid_key(key) {
            continue;
        }
        let path = item.path();
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        entries.insert(key.to_string(), crate::settings::store::strip_bom(&text).to_string());
    }
    Ok(entries)
}

/// Idempotent within one process: a held lock stays held. Each call is a new
/// page load: a fresh page id, and no seq state is reset (see the module doc).
fn open_at(store: &mut FlowStore, retry: Duration) -> Result<OpenReply, String> {
    std::fs::create_dir_all(&store.dir).map_err(|e| format!("{}: {e}", store.dir.display()))?;
    let mut lock_error = None;
    if store.lock.is_none() {
        match acquire_lock(&store.dir.join(LOCK_FILE), retry) {
            Ok(lock) => store.lock = lock,
            Err(e) => lock_error = Some(e),
        }
    }
    let entries = read_entries(&store.dir)?;
    store.next_page += 1;
    let page = store.next_page;
    store.page_seq.insert(page, 0);
    Ok(OpenReply { writable: store.lock.is_some(), entries, page, seq: store.last_seq, lock_error })
}

/// `Ok(false)`: a stale batch from this page, ignored. Stops at the first I/O error.
fn write_at(store: &mut FlowStore, page: u64, seq: u64, entries: Vec<(String, Option<String>)>) -> Result<bool, String> {
    if store.lock.is_none() {
        return Err("Flow store is read-only in this process (no writer lock)".into());
    }
    for (key, value) in &entries {
        if !valid_key(key) {
            return Err(format!("rejected {key}: invalid key"));
        }
        if value.as_ref().is_some_and(|v| v.len() > MAX_VALUE_BYTES) {
            return Err(format!("rejected {key}: value over {MAX_VALUE_BYTES} bytes"));
        }
    }
    let page_last = store.page_seq.entry(page).or_insert(0);
    if seq <= *page_last {
        return Ok(false);
    }
    *page_last = seq;
    store.last_seq = store.last_seq.max(seq);
    for (key, value) in entries {
        let path = store.dir.join(format!("{key}.json"));
        match value {
            Some(v) => crate::fsx::atomic_write(&path, v.as_bytes()).map_err(|e| format!("{key}: {e}"))?,
            None => match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("{key}: {e}")),
            },
        }
    }
    Ok(true)
}

/// The process mutex: every open and write goes through it, so batches land
/// in the order they took it and an open never reads mid-batch.
fn store() -> &'static Mutex<FlowStore> {
    static STORE: OnceLock<Mutex<FlowStore>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(FlowStore::at(crate::paths::flow_store_dir())))
}

pub(crate) fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err(format!("Flow store refused for window \"{}\"", window.label()));
    }
    Ok(())
}

// Async so the file I/O (and the lock retry) runs off the main thread, the
// patch_state pattern (settings/state.rs).
#[tauri::command]
pub async fn flow_store_open(window: tauri::WebviewWindow) -> Result<OpenReply, String> {
    main_only(&window)?;
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    open_at(&mut s, LOCK_RETRY)
}

#[tauri::command]
pub async fn flow_store_write(
    window: tauri::WebviewWindow,
    page: u64,
    seq: u64,
    entries: Vec<(String, Option<String>)>,
) -> Result<bool, String> {
    main_only(&window)?;
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    write_at(&mut s, page, seq, entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let t = std::env::temp_dir().join(format!("vidar-flow-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        t
    }

    // The key rule is the trust boundary, and one bad entry refuses the
    // whole batch before any file is written.
    #[test]
    fn key_validation_refuses_the_batch_before_writing() {
        for good in ["vidar.flow.graphs.v1", "vidar.flow.graphs.v1.bak-2026-09-25T11-19-46-434Z", "vidar.flow.a_b-c"] {
            assert!(valid_key(good), "{good}");
        }
        let long = format!("vidar.flow.{}", "a".repeat(121));
        for bad in ["vidar.flow.", "vidar.flow..x", "vidar.flow.x.", "vidar.flow.a/b", "vidar.flow.a\\b", "other.x", long.as_str()] {
            assert!(!valid_key(bad), "{bad}");
        }
        let dir = scratch("r1");
        let mut s = FlowStore::at(dir.clone());
        let p = open_at(&mut s, Duration::ZERO).unwrap().page;
        let err = write_at(
            &mut s,
            p,
            1,
            vec![("vidar.flow.ok".into(), Some("1".into())), ("vidar.flow..\\evil".into(), Some("2".into()))],
        )
        .unwrap_err();
        assert!(err.starts_with("rejected vidar.flow..\\evil"), "{err}");
        assert!(!dir.join("vidar.flow.ok.json").exists(), "nothing lands from a rejected batch");
        // A valid batch round-trips, a leading BOM is stripped on read, None deletes.
        assert!(write_at(&mut s, p, 2, vec![("vidar.flow.ok".into(), Some("1".into()))]).unwrap());
        // A batch older than the last applied one is ignored, not written.
        assert!(!write_at(&mut s, p, 1, vec![("vidar.flow.ok".into(), Some("old".into()))]).unwrap());
        std::fs::write(dir.join("vidar.flow.bom.json"), "\u{feff}x").unwrap();
        let read = open_at(&mut s, Duration::ZERO).unwrap();
        assert_eq!(read.entries.get("vidar.flow.ok").map(String::as_str), Some("1"));
        assert_eq!(read.entries.get("vidar.flow.bom").map(String::as_str), Some("x"));
        drop(s);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // A second store on the same folder (another process in the app) does
    // not get the lock, reads anyway, and every write from it is refused.
    #[test]
    fn second_lock_acquire_fails_and_goes_read_only() {
        let dir = scratch("r2");
        let mut first = FlowStore::at(dir.clone());
        let r = open_at(&mut first, Duration::ZERO).unwrap();
        assert!(r.writable && r.lock_error.is_none());
        assert!(write_at(&mut first, r.page, 1, vec![("vidar.flow.k".into(), Some("v".into()))]).unwrap());
        let mut second = FlowStore::at(dir.clone());
        let reply = open_at(&mut second, Duration::from_millis(200)).unwrap();
        assert!(!reply.writable);
        assert!(reply.lock_error.is_none(), "a sharing violation is 'another Vidar', not a lock error");
        assert_eq!(reply.entries.get("vidar.flow.k").map(String::as_str), Some("v"));
        assert!(write_at(&mut second, reply.page, 1, vec![("vidar.flow.k".into(), Some("w".into()))]).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("vidar.flow.k.json")).unwrap(), "v");
        drop(first);
        drop(second);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // A reload. The old page's pagehide batch (high seq) is held on the
    // mutex while the new page opens, then lands. The new page's batches,
    // numbered from the seq its open returned, must still apply; the old
    // page's own ordering still holds.
    #[test]
    fn old_page_batch_after_reload_open_does_not_hide_new_writes() {
        let dir = scratch("r3");
        let mut s = FlowStore::at(dir.clone());
        let old = open_at(&mut s, Duration::ZERO).unwrap();
        for seq in 1..=3 {
            assert!(write_at(&mut s, old.page, seq, vec![("vidar.flow.g".into(), Some(format!("old{seq}")))]).unwrap());
        }
        // Reload: the new page opens before the old page's seq-9 flush gets the mutex.
        let new = open_at(&mut s, Duration::ZERO).unwrap();
        assert_ne!(new.page, old.page);
        assert_eq!(new.seq, 3, "open returns the highest applied seq, never resets");
        assert!(write_at(&mut s, old.page, 9, vec![("vidar.flow.g".into(), Some("old9".into()))]).unwrap());
        // The new page numbers from 3: 4 and 5 are below the old page's 9 and still land.
        assert!(write_at(&mut s, new.page, new.seq + 1, vec![("vidar.flow.g".into(), Some("new4".into()))]).unwrap());
        assert_eq!(std::fs::read_to_string(dir.join("vidar.flow.g.json")).unwrap(), "new4");
        assert!(write_at(&mut s, new.page, new.seq + 2, vec![("vidar.flow.h".into(), Some("new5".into()))]).unwrap());
        assert!(dir.join("vidar.flow.h.json").exists());
        // Within a page a stale batch is still dropped, for either page.
        assert!(!write_at(&mut s, new.page, new.seq + 1, vec![("vidar.flow.g".into(), Some("stale".into()))]).unwrap());
        assert!(!write_at(&mut s, old.page, 8, vec![("vidar.flow.g".into(), Some("stale".into()))]).unwrap());
        assert_eq!(std::fs::read_to_string(dir.join("vidar.flow.g.json")).unwrap(), "new4");
        // A third load numbers above everything applied.
        assert_eq!(open_at(&mut s, Duration::ZERO).unwrap().seq, 9);
        drop(s);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
