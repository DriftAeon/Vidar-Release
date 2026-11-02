//! src-tauri\src\modules\ledger.rs — the pack ledger: per pack folder, a load floor (the highest
//! release this install has loaded), the current and previous release with their folder
//! digests, and kept copies of both under `packs-kept\<folder>\<release>\`.
//!
//! Shape: `{ version: 1, packs: { <folder>: { floor, current: {release, digest}, previous|null } } }`.
//! Keyed by pack folder name (unique on disk, and what the IPC receives).
//!
//! Every writer takes one process-wide mutex and re-reads the ledger inside it. An unreadable
//! ledger is never overwritten: callers get the error, log it and fail open (no floor).
//! The digest is a port of `sha256Asset` in `tools/release/pack-index.mjs`: SHA-256 over the
//! sorted lines `<rel with />\0<file sha256>\n` (a test pins both languages to one literal).
//! Every directory rename goes through `fsx::rename_retrying`; a failed Restore leaves the live
//! folder as it was. Callers pass the ledger paths (`LedgerPaths`), so tests use temp dirs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::compat::Semver;
use super::scan::{Broken, Scan};
use crate::fsx;

static LOCK: Mutex<()> = Mutex::new(());

/// Where the ledger file and the kept copies live.
#[derive(Clone, Debug)]
pub struct LedgerPaths {
    pub file: PathBuf,
    pub kept: PathBuf,
}

impl LedgerPaths {
    /// The real paths, only in the friend layout (the dev checkout has no ledger).
    pub fn live() -> Option<LedgerPaths> {
        if !crate::paths::is_friend_layout() {
            return None;
        }
        Some(LedgerPaths { file: crate::paths::pack_ledger_path(), kept: crate::paths::packs_kept_dir() })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rel {
    pub release: String,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub floor: String,
    pub current: Rel,
    #[serde(default)]
    pub previous: Option<Rel>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ledger {
    pub version: u32,
    pub packs: BTreeMap<String, Entry>,
}

impl Default for Ledger {
    fn default() -> Self {
        Ledger { version: 1, packs: BTreeMap::new() }
    }
}

/// Reads the ledger; a missing file is an empty ledger, an unreadable or unknown one is an error.
pub fn load(file: &Path) -> Result<Ledger, String> {
    if !file.exists() {
        return Ok(Ledger::default());
    }
    let l: Ledger = fsx::read_json(file)?;
    if l.version != 1 {
        return Err(format!("{}: unknown ledger version {}", file.display(), l.version));
    }
    Ok(l)
}

pub fn save(file: &Path, ledger: &Ledger) -> Result<(), String> {
    fsx::write_json_pretty(file, ledger, true)
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let rd = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for e in rd {
        let e = e.map_err(|e| format!("{}: {e}", dir.display()))?;
        let path = e.path();
        let ft = e.file_type().map_err(|e| format!("{}: {e}", path.display()))?;
        if ft.is_dir() {
            walk(&path, base, out)?;
        } else {
            let rel = path.strip_prefix(base).map_err(|e| e.to_string())?;
            let rel = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
            out.push((rel, path));
        }
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The folder digest, byte-identical to `sha256Asset` for ASCII paths.
pub fn digest(dir: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    walk(dir, dir, &mut files)?;
    let mut lines: Vec<String> = Vec::with_capacity(files.len());
    for (rel, path) in files {
        let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        lines.push(format!("{rel}\0{}\n", hex(&Sha256::digest(&bytes))));
    }
    lines.sort();
    Ok(hex(&Sha256::digest(lines.concat().as_bytes())))
}

/// "Release {r} Is Older Than {floor}" when `release` is below the pack's floor. An absent entry
/// or an unparsable version fails open (None).
pub fn floor_reason(ledger: &Ledger, folder: &str, release: &str) -> Option<String> {
    let entry = ledger.packs.get(folder)?;
    let (r, f) = (Semver::parse(release)?, Semver::parse(&entry.floor)?);
    (r < f).then(|| format!("Release {release} Is Older Than {}", entry.floor))
}

/// Whether kept copies and Restore apply to this pack (packs that carry no compiled code).
pub fn keeps_copies(folder: &str) -> bool {
    crate::release_check::PACK_UPDATABLE.contains(&folder)
}

/// The load floor over a scan. A pack below its floor leaves `modules`/`pending` for `broken`
/// with `Release {r} Is Older Than {floor}` (its dependants read `Needs {id}`) and is recorded in
/// `older`. `interrupted` folders (a Restore that died between renames, `repair` could not undo)
/// read `Restore Interrupted`.
pub fn apply(out: &mut Scan, ledger: &Ledger, interrupted: &[String]) {
    let mut gone: BTreeMap<String, String> = BTreeMap::new();
    let mut older: BTreeMap<String, String> = BTreeMap::new();
    for m in out.modules.iter().chain(out.pending.iter().map(|(m, _)| m)) {
        let (Some(folder), Some(release)) = (m.folder.as_ref(), m.release.as_ref()) else { continue };
        if m.source != "pack" {
            continue;
        }
        if let Some(reason) = floor_reason(ledger, folder, release) {
            gone.insert(m.decl.id.clone(), reason);
            older.insert(folder.clone(), release.clone());
        }
    }
    // A gateway pack Changed Since Pinned is in `broken`/`changed`, not `modules`: floor it too.
    for (folder, (id, _, release)) in &out.changed {
        let Some(release) = release else { continue };
        if let Some(reason) = floor_reason(ledger, folder, release) {
            gone.insert(id.clone(), reason);
            older.insert(folder.clone(), release.clone());
        }
    }
    if !gone.is_empty() {
        out.drop_modules(gone);
        out.older = older;
    }
    for folder in interrupted {
        out.broken.retain(|b| &b.folder != folder);
        out.broken.push(Broken { folder: folder.clone(), reason: "Restore Interrupted".into() });
    }
    out.broken.sort_by(|a, b| a.folder.cmp(&b.folder));
}

/// Fills `Scan::restorable`: installed packs (listed or broken) that keep copies, have a previous
/// release, and whose kept copy is on disk.
pub fn mark_restorable(out: &mut Scan, ledger: &Ledger, kept: &Path) {
    out.restorable.clear();
    for (folder, e) in &ledger.packs {
        let Some(prev) = e.previous.as_ref() else { continue };
        let installed = out.modules.iter().any(|m| m.folder.as_ref() == Some(folder)) || out.broken.iter().any(|b| &b.folder == folder);
        if installed && keeps_copies(folder) && kept.join(folder).join(&prev.release).is_dir() {
            out.restorable.insert(folder.clone(), prev.release.clone());
        }
    }
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    let rd = std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))?;
    for e in rd {
        let e = e.map_err(|e| format!("{}: {e}", from.display()))?;
        let (src, dst) = (e.path(), to.join(e.file_name()));
        let ft = e.file_type().map_err(|e| format!("{}: {e}", src.display()))?;
        if ft.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
        }
    }
    Ok(())
}

/// Copies `dir` to `kept\<folder>\<release>` through a `.part` sibling, replacing any old copy.
fn keep_copy(paths: &LedgerPaths, folder: &str, release: &str, dir: &Path) -> Result<(), String> {
    let parent = paths.kept.join(folder);
    let (part, dest) = (parent.join(format!("{release}.part")), parent.join(release));
    let _ = std::fs::remove_dir_all(&part);
    copy_dir(dir, &part).inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&part);
    })?;
    let _ = std::fs::remove_dir_all(&dest);
    fsx::rename_retrying(&part, &dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&part);
        format!("{}: {e}", dest.display())
    })
}

/// Deletes kept copies other than the entry's current and previous release.
fn prune(paths: &LedgerPaths, folder: &str, entry: &Entry) {
    let keep: Vec<&str> = std::iter::once(entry.current.release.as_str())
        .chain(entry.previous.iter().map(|p| p.release.as_str()))
        .collect();
    let Ok(rd) = std::fs::read_dir(paths.kept.join(folder)) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        if !keep.contains(&e.file_name().to_string_lossy().as_ref()) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// Records a pack that loaded: `folder` at `release` in `dir`. Absent entry: floor = release.
/// Higher release than current: current becomes previous and the floor rises. Anything else
/// changes nothing and writes nothing. `keep` makes kept copies (PACK_UPDATABLE packs only).
/// An unreadable ledger is returned as an error and left untouched.
pub fn record(paths: &LedgerPaths, folder: &str, dir: &Path, release: &str, keep: bool) -> Result<(), String> {
    let Some(new) = Semver::parse(release) else { return Ok(()) };
    let _g = lock();
    // The caller scanned without the lock; a Restore may have swapped the folder since. Record
    // only what is on disk now.
    if read_release(dir).ok().as_deref() != Some(release) {
        return Ok(());
    }
    let mut ledger = load(&paths.file)?;
    let entry = match ledger.packs.get(folder) {
        None => {
            let digest = digest(dir)?;
            if keep {
                keep_copy(paths, folder, release, dir)?;
            }
            Entry { floor: release.into(), current: Rel { release: release.into(), digest }, previous: None }
        }
        Some(old) => {
            match Semver::parse(&old.current.release) {
                Some(cur) if new > cur => {}
                Some(_) => return Ok(()),
                None => {} // a damaged current release is replaced
            }
            let digest = digest(dir)?;
            if keep {
                keep_copy(paths, folder, release, dir)?;
            }
            Entry {
                floor: release.into(),
                current: Rel { release: release.into(), digest },
                previous: Some(old.current.clone()),
            }
        }
    };
    ledger.packs.insert(folder.into(), entry.clone());
    save(&paths.file, &ledger)?;
    if keep {
        prune(paths, folder, &entry);
    }
    Ok(())
}

fn read_release(dir: &Path) -> Result<String, String> {
    let v: serde_json::Value = fsx::read_json(&dir.join("pack.json"))?;
    v.get("release").and_then(|r| r.as_str()).map(str::to_string).ok_or_else(|| "pack.json has no release".to_string())
}

/// Renames a leftover `_aside-<folder>` back when `<folder>` is missing and the aside's digest
/// is the ledger's `current` or `previous` for it (a Restore that died between its two
/// renames). A stale aside that matches neither is left alone, with no row. Returns the folders
/// whose matching aside could not be put back. An unreadable ledger repairs nothing.
pub fn repair(packs: &Path, ledger_file: &Path) -> Vec<String> {
    // Under the ledger lock, so a Restore in flight (live folder briefly missing) is never "repaired".
    let _g = lock();
    match load(ledger_file) {
        Ok(l) => repair_locked(packs, &l),
        Err(_) => Vec::new(),
    }
}

fn repair_locked(packs: &Path, ledger: &Ledger) -> Vec<String> {
    let mut failed = Vec::new();
    let Ok(rd) = std::fs::read_dir(packs) else { return failed };
    for e in rd.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(folder) = name.strip_prefix("_aside-") else { continue };
        let live = packs.join(folder);
        if live.exists() {
            continue;
        }
        let Some(entry) = ledger.packs.get(folder) else { continue };
        let Ok(d) = digest(&e.path()) else { continue };
        if d != entry.current.digest && entry.previous.as_ref().is_none_or(|p| p.digest != d) {
            continue;
        }
        if fsx::rename_retrying(&e.path(), &live).is_err() {
            failed.push(folder.to_string());
        }
    }
    failed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vidar-ledger-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn paths(root: &Path) -> LedgerPaths {
        LedgerPaths { file: root.join("pack-ledger.json"), kept: root.join("packs-kept") }
    }

    /// A pack folder with a release and one payload file named after it.
    fn put(packs: &Path, folder: &str, release: &str) -> PathBuf {
        let dir = packs.join(folder);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("art")).unwrap();
        std::fs::write(dir.join("pack.json"), format!("{{\"id\":\"{folder}\",\"release\":\"{release}\"}}")).unwrap();
        std::fs::write(dir.join("art").join("r.txt"), release).unwrap();
        dir
    }

    #[test]
    fn digest_matches_the_javascript_literal() {
        let root = tmp("digest");
        std::fs::create_dir_all(root.join("art")).unwrap();
        std::fs::write(root.join("pack.json"), b"{\"id\":\"x\"}\r\n").unwrap();
        std::fs::write(root.join("art").join("a.png"), [0u8, 1, 2, 255]).unwrap();
        std::fs::write(root.join("b.txt"), b"z").unwrap();
        // The same fixture and literal sit in tools/release/pack-index.test.mjs.
        assert_eq!(digest(&root).unwrap(), "aaf45a39719449b1a412a2099423a16c00797ef47682b10e230b1b2a336af4cc");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn floor_refuses_below_and_allows_equal() {
        let mut l = Ledger::default();
        let rel = |r: &str| Rel { release: r.into(), digest: "d".into() };
        l.packs.insert("p".into(), Entry { floor: "1.2.0".into(), current: rel("1.2.0"), previous: None });
        assert_eq!(floor_reason(&l, "p", "1.1.9").as_deref(), Some("Release 1.1.9 Is Older Than 1.2.0"));
        assert_eq!(floor_reason(&l, "p", "1.2.0"), None);
        assert_eq!(floor_reason(&l, "p", "1.3.0"), None);
        assert_eq!(floor_reason(&l, "other", "0.0.1"), None);
        assert_eq!(floor_reason(&l, "p", "garbage"), None);
    }

    #[test]
    fn record_rotates_and_prunes_to_two() {
        let root = tmp("record");
        let (lp, packs) = (paths(&root), root.join("packs"));
        for r in ["1.0.0", "1.1.0", "1.2.0"] {
            let dir = put(&packs, "p", r);
            record(&lp, "p", &dir, r, true).unwrap();
        }
        let l = load(&lp.file).unwrap();
        let e = &l.packs["p"];
        assert_eq!((e.floor.as_str(), e.current.release.as_str()), ("1.2.0", "1.2.0"));
        assert_eq!(e.previous.as_ref().unwrap().release, "1.1.0");
        let mut kept: Vec<String> =
            std::fs::read_dir(lp.kept.join("p")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        kept.sort();
        assert_eq!(kept, ["1.1.0", "1.2.0"]);
        // Same release with new bytes, and a lower release: no change.
        let before = std::fs::read(&lp.file).unwrap();
        std::fs::write(packs.join("p").join("art").join("r.txt"), "edited").unwrap();
        record(&lp, "p", &packs.join("p"), "1.2.0", true).unwrap();
        let dir = put(&packs, "p", "1.0.0");
        record(&lp, "p", &dir, "1.0.0", true).unwrap();
        assert_eq!(std::fs::read(&lp.file).unwrap(), before);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn record_without_keep_makes_no_copies() {
        let root = tmp("nokeep");
        let (lp, packs) = (paths(&root), root.join("packs"));
        let dir = put(&packs, "p", "1.0.0");
        record(&lp, "p", &dir, "1.0.0", false).unwrap();
        assert!(!lp.kept.exists());
        assert_eq!(load(&lp.file).unwrap().packs["p"].floor, "1.0.0");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unreadable_ledger_is_never_overwritten() {
        let root = tmp("bad");
        let (lp, packs) = (paths(&root), root.join("packs"));
        std::fs::write(&lp.file, "not json").unwrap();
        let dir = put(&packs, "p", "1.0.0");
        assert!(record(&lp, "p", &dir, "1.0.0", false).is_err());
        assert_eq!(std::fs::read_to_string(&lp.file).unwrap(), "not json");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn record_skips_a_stale_scan() {
        let root = tmp("stale");
        let (lp, packs) = (paths(&root), root.join("packs"));
        let dir = put(&packs, "p", "1.0.0");
        record(&lp, "p", &dir, "1.0.0", true).unwrap();
        let before = std::fs::read(&lp.file).unwrap();
        // The scan saw 1.1.0, then a Restore put 1.0.0 back on disk.
        record(&lp, "p", &dir, "1.1.0", true).unwrap();
        assert_eq!(std::fs::read(&lp.file).unwrap(), before);
        assert_eq!(std::fs::read_to_string(lp.kept.join("p").join("1.0.0").join("art").join("r.txt")).unwrap(), "1.0.0");
        assert!(!lp.kept.join("p").join("1.1.0").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn repair_puts_back_only_a_matching_aside() {
        let root = tmp("repair");
        let (lp, packs) = (paths(&root), root.join("packs"));
        // p: a real interrupted Restore (aside holds the recorded current).
        let dir = put(&packs, "p", "1.0.0");
        record(&lp, "p", &dir, "1.0.0", false).unwrap();
        std::fs::rename(&dir, packs.join("_aside-p")).unwrap();
        // r: a stale aside that matches neither entry, live folder missing.
        let dir = put(&packs, "r", "1.0.0");
        record(&lp, "r", &dir, "1.0.0", false).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        put(&packs, "_aside-r", "0.9.0");
        // q: live folder present, aside left alone.
        put(&packs, "_aside-q", "1.0.0");
        std::fs::create_dir_all(packs.join("q")).unwrap();
        assert!(repair(&packs, &lp.file).is_empty());
        assert!(packs.join("p").join("pack.json").is_file());
        assert!(!packs.join("_aside-p").exists());
        assert!(!packs.join("r").exists() && packs.join("_aside-r").is_dir());
        assert!(packs.join("q").is_dir() && packs.join("_aside-q").is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }
}
