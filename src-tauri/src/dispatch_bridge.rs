//! src-tauri\src\dispatch_bridge.rs — the file-dispatch mechanics that
//! review.rs and open.rs share. Each of those bridges keeps
//! its own request type, parsing rules and validation (open's kind/reason
//! allowlist, review's single-line text rule);
//! this module only moves files and writes records. It accepts nothing on its
//! own: a request reaches `pending.json` and the emit only if the bridge's
//! `accept` closure returned `Ok`.
//!
//! Layout, identical for all three bridges (root = bridge\review|launch|open):
//!   dispatch\<id>.json          request, published by the requester via rename
//!   dispatch\<id>.claimed       the same file after we took it (never re-read)
//!   dispatch\stale\<ms>-<name>  anything found at startup or rejected, plus
//!                               `<ms>-<stem>.reason.txt` with the reason
//!   <id>\pending.json           written right after the claim, before the emit
//!
//! Claim-by-rename before emit: a crash between the two loses the request
//! (the requester times out and says so) rather than acting on it twice after
//! a restart. Pending records and verdicts are written through
//! `fsx::atomic_write` (unique tmp in the same folder, fsync, rename over).

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::AppHandle;

use crate::fsx::{atomic_write, now_ms};

/// How often each bridge's poller scans its dispatch folder.
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The three folders of one bridge. Built from `crate::paths` by each bridge;
/// tests build one over a temp dir.
pub struct Bridge {
    pub root: PathBuf,
    pub dispatch: PathBuf,
    pub stale: PathBuf,
}

/// What a bridge's `accept` closure hands back for a request it validated:
/// the id the pending record is filed under, the record itself, and the
/// payload to emit.
pub struct Accepted<P> {
    pub id: String,
    pub pending: Value,
    pub payload: P,
}

/// Ids are 8 lowercase hex in every bridge; the requester scripts generate them.
pub fn valid_id(id: &str) -> bool {
    id.len() == 8 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Creates the parent folder, then `fsx::atomic_write`.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    atomic_write(path, text.as_bytes())
}

impl Bridge {
    pub fn ensure_dirs(&self) {
        let _ = fs::create_dir_all(&self.stale);
    }

    /// Anything sitting in dispatch\ when Vidar starts is from a previous
    /// life. Park it with `reason`; never act on it, never delete it (a wipe
    /// is not an acknowledgment).
    pub fn quarantine_stale(&self, reason: &str) {
        self.ensure_dirs();
        let Ok(rd) = fs::read_dir(&self.dispatch) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                continue;
            }
            self.park(&p, reason);
        }
    }

    /// Moves `p` into stale\ under a timestamped name and writes the reason
    /// beside it. A failed move leaves the file where it is.
    pub fn park(&self, p: &Path, reason: &str) {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("unnamed").to_owned();
        let dest = self.stale.join(format!("{}-{name}", now_ms()));
        if fs::rename(p, &dest).is_ok() {
            let _ = fs::write(dest.with_extension("reason.txt"), reason);
        }
    }

    /// Claims every `dispatch\*.json` by renaming it to `.claimed`, in sorted
    /// order. A file that fails to rename was taken by a concurrent pass (the
    /// rename is the lock) and is skipped. Returns (file stem, claimed path).
    pub fn claim_all(&self) -> Vec<(String, PathBuf)> {
        let Ok(rd) = fs::read_dir(&self.dispatch) else { return Vec::new() };
        let mut entries: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("json"))
            .collect();
        entries.sort();
        let mut claimed_all = Vec::new();
        for p in entries {
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_owned();
            let claimed = p.with_extension("claimed");
            if fs::rename(&p, &claimed).is_err() {
                continue;
            }
            claimed_all.push((stem, claimed));
        }
        claimed_all
    }

    /// Writes `<root>\<id>\pending.json`.
    pub fn write_pending(&self, id: &str, pending: &Value) -> Result<(), String> {
        write_atomic(&self.root.join(id).join("pending.json"), &pending.to_string())
    }

    /// One pass: claim, parse as `T`, hand to the bridge's `accept` (its own
    /// validation), write the pending record, then `emit`. A parse error, an
    /// `accept` refusal or a failed pending write parks the claimed file with
    /// the reason and nothing is emitted.
    pub fn scan<T, P>(
        &self,
        mut accept: impl FnMut(T, &str) -> Result<Accepted<P>, String>,
        mut emit: impl FnMut(P),
    ) where
        T: DeserializeOwned,
    {
        for (stem, claimed) in self.claim_all() {
            // Agent-dropped: bounded, an oversized file parks with the reason.
            let parsed: Result<T, String> = crate::fsx::read_text_capped(&claimed, crate::fsx::DROP_CAP)
                .map_err(|e| e.to_string())
                .and_then(|s| serde_json::from_str::<T>(&s).map_err(|e| e.to_string()));
            let accepted = match parsed.and_then(|d| accept(d, &stem)) {
                Ok(a) => a,
                Err(reason) => {
                    self.park(&claimed, &reason);
                    continue;
                }
            };
            if let Err(e) = self.write_pending(&accepted.id, &accepted.pending) {
                self.park(&claimed, &format!("could not write pending record: {e}"));
                continue;
            }
            emit(accepted.payload);
        }
    }

    /// The review/launch verdict: only an id this process claimed (it has a
    /// pending record) gets `<root>\<id>\dispatch-result.json`.
    pub fn record_verdict(&self, id: &str, verdict: &Value) -> Result<(), String> {
        if !valid_id(id) {
            return Err("bad id".into());
        }
        let dir = self.root.join(id);
        if !dir.join("pending.json").is_file() {
            return Err("no pending record for that id".into());
        }
        write_atomic(&dir.join("dispatch-result.json"), &verdict.to_string())
    }
}

/// Runs `pass` every `POLL_INTERVAL` once `ready` says the frontend listener
/// is attached; before that a request just waits on disk.
pub fn start_poller(app: AppHandle, ready: fn(&AppHandle) -> bool, pass: fn(&AppHandle)) {
    thread::spawn(move || loop {
        if ready(&app) {
            pass(&app);
        }
        thread::sleep(POLL_INTERVAL);
    });
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// A fresh bridge layout under the temp dir; never the live bridge\.
    pub(crate) fn temp_bridge(tag: &str) -> Bridge {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("vidar-dispatch-{tag}-{}-{}-{n}", std::process::id(), now_ms()));
        let dispatch = root.join("dispatch");
        let stale = dispatch.join("stale");
        let b = Bridge { root, dispatch, stale };
        b.ensure_dirs();
        b
    }

    pub(crate) fn stale_reasons(b: &Bridge) -> Vec<String> {
        fs::read_dir(&b.stale)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.to_string_lossy().ends_with(".reason.txt"))
            .map(|p| fs::read_to_string(p).unwrap())
            .collect()
    }

    #[derive(serde::Deserialize)]
    struct Req {
        id: String,
    }

    fn accept_valid(d: Req, stem: &str) -> Result<Accepted<String>, String> {
        if !valid_id(&d.id) || d.id != stem {
            return Err("rejected".into());
        }
        Ok(Accepted { pending: serde_json::json!({ "id": d.id }), payload: d.id.clone(), id: d.id })
    }

    #[test]
    fn claim_renames_json_only_and_in_order() {
        let b = temp_bridge("claim");
        fs::write(b.dispatch.join("bbbbbbbb.json"), "{}").unwrap();
        fs::write(b.dispatch.join("aaaaaaaa.json"), "{}").unwrap();
        fs::write(b.dispatch.join("cccccccc.json.tmp"), "{}").unwrap();
        let claimed = b.claim_all();
        let stems: Vec<_> = claimed.iter().map(|(s, _)| s.as_str()).collect();
        assert_eq!(stems, ["aaaaaaaa", "bbbbbbbb"]);
        assert!(b.dispatch.join("aaaaaaaa.claimed").is_file());
        assert!(!b.dispatch.join("aaaaaaaa.json").exists());
        assert!(b.dispatch.join("cccccccc.json.tmp").is_file(), "non-.json left alone");
        assert!(b.claim_all().is_empty(), "a claimed file is never re-read");
        let _ = fs::remove_dir_all(&b.root);
    }

    #[test]
    fn park_moves_into_stale_with_reason() {
        let b = temp_bridge("park");
        let p = b.dispatch.join("0123abcd.claimed");
        fs::write(&p, "{}").unwrap();
        b.park(&p, "because");
        assert!(!p.exists());
        let parked: Vec<String> = fs::read_dir(&b.stale)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(parked.iter().any(|n| n.ends_with("-0123abcd.claimed")), "{parked:?}");
        assert_eq!(stale_reasons(&b), ["because"]);
        let _ = fs::remove_dir_all(&b.root);
    }

    #[test]
    fn quarantine_parks_everything_at_startup() {
        let b = temp_bridge("quarantine");
        fs::write(b.dispatch.join("0123abcd.json"), "{}").unwrap();
        b.quarantine_stale("found at startup");
        assert!(!b.dispatch.join("0123abcd.json").exists());
        assert_eq!(stale_reasons(&b), ["found at startup"]);
        assert!(b.stale.is_dir(), "stale\\ itself is not parked");
        let _ = fs::remove_dir_all(&b.root);
    }

    #[test]
    fn scan_writes_pending_then_emits_accepted() {
        let b = temp_bridge("accept");
        fs::write(b.dispatch.join("0123abcd.json"), r#"{"id":"0123abcd"}"#).unwrap();
        let mut emitted = Vec::new();
        b.scan(accept_valid, |p| emitted.push(p));
        assert_eq!(emitted, ["0123abcd"]);
        let pending = fs::read_to_string(b.root.join("0123abcd").join("pending.json")).unwrap();
        assert_eq!(pending, r#"{"id":"0123abcd"}"#);
        assert!(stale_reasons(&b).is_empty());
        let _ = fs::remove_dir_all(&b.root);
    }

    #[test]
    fn scan_accepts_a_request_written_with_a_bom() {
        let b = temp_bridge("bom");
        fs::write(b.dispatch.join("0123abcd.json"), "\u{FEFF}{\"id\":\"0123abcd\"}").unwrap();
        let mut emitted = Vec::new();
        b.scan(accept_valid, |p| emitted.push(p));
        assert_eq!(emitted, ["0123abcd"]);
        let _ = fs::remove_dir_all(&b.root);
    }

    #[test]
    fn scan_parks_an_oversized_drop_unread() {
        let b = temp_bridge("oversized");
        let pad = " ".repeat(crate::fsx::DROP_CAP as usize);
        fs::write(b.dispatch.join("0123abcd.json"), format!("{{\"id\":\"0123abcd\"}}{pad}")).unwrap();
        let mut emitted: Vec<String> = Vec::new();
        b.scan(accept_valid, |p| emitted.push(p));
        assert!(emitted.is_empty());
        assert!(!b.root.join("0123abcd").exists());
        let reasons = stale_reasons(&b);
        assert!(reasons.len() == 1 && reasons[0].contains("larger than"), "{reasons:?}");
        let _ = fs::remove_dir_all(&b.root);
    }

    #[test]
    fn scan_parks_rejected_and_unparseable_without_pending_or_emit() {
        let b = temp_bridge("reject");
        fs::write(b.dispatch.join("0123abcd.json"), r#"{"id":"ffffffff"}"#).unwrap();
        fs::write(b.dispatch.join("11111111.json"), "not json").unwrap();
        let mut emitted: Vec<String> = Vec::new();
        b.scan(accept_valid, |p| emitted.push(p));
        assert!(emitted.is_empty());
        assert!(!b.root.join("0123abcd").exists());
        assert!(!b.root.join("ffffffff").exists());
        assert_eq!(stale_reasons(&b).len(), 2);
        let _ = fs::remove_dir_all(&b.root);
    }

    #[test]
    fn verdict_needs_a_valid_id_and_a_pending_record() {
        let b = temp_bridge("verdict");
        let v = serde_json::json!({ "ok": true });
        assert_eq!(b.record_verdict("NOTHEX00", &v).unwrap_err(), "bad id");
        assert_eq!(b.record_verdict("0123abcd", &v).unwrap_err(), "no pending record for that id");
        b.write_pending("0123abcd", &serde_json::json!({})).unwrap();
        b.record_verdict("0123abcd", &v).unwrap();
        let written = fs::read_to_string(b.root.join("0123abcd").join("dispatch-result.json")).unwrap();
        assert_eq!(written, r#"{"ok":true}"#);
        let _ = fs::remove_dir_all(&b.root);
    }
}
