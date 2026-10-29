//! src-tauri\src\bare\library_delete.rs — `bare_library_delete`: remove one rune, or a whole import library,
//! from the store. Only libraries under the rune imports dir are
//! deletable; the stock library, templates and the rules library refuse. Nothing is hard-deleted: a
//! library folder is renamed to `<library>.deleted-<yyyyMMdd-HHmmss>` (UTC; `sets_list` skips `.deleted-` as it
//! skips the migration's `.pre-split`), a rune file and every set file it was slotted in move into that same
//! backup folder under their library-relative path.
//! Unlocked vaults drop the refs (through `vault::store::Store::edit`); locked vaults and their `revs/` are
//! never touched, since a session keeps its own copy.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::rules::library::Library;
use crate::rules::rune;

use super::vault::store::{EditMode, Op, Store};

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct Deleted {
    /// Names of the unlocked vaults that dropped a ref in this call.
    pub vaults: Vec<String>,
}

/// `yyyyMMdd-HHmmss` (UTC) of `secs` since the epoch.
fn stamp(secs: u64) -> String {
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3_600, rem % 3_600 / 60, rem % 60)
}

/// The backup folder `<library>.deleted-<stamp>`. A whole-library move needs a free one (`-2`, `-3` when
/// taken); a rune move reuses the call's folder, so runes deleted in the same second share it.
fn backup_root(imports: &Path, library: &str, fresh: bool) -> PathBuf {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let first = imports.join(format!("{library}.deleted-{}", stamp(secs)));
    if !fresh || !first.exists() {
        return first;
    }
    (2..1000).map(|n| imports.join(format!("{library}.deleted-{}-{n}", stamp(secs)))).find(|p| !p.exists()).unwrap_or(first)
}

/// `dir/rel` free of a clash: `name.md` then `name.2.md`, ...
fn free_path(p: PathBuf) -> PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    (2..1000).map(|n| p.with_file_name(format!("{stem}.{n}{ext}"))).find(|q| !q.exists()).unwrap_or(p)
}

fn move_into(from: &Path, backup: &Path, rel: &Path) -> Result<(), String> {
    let to = free_path(backup.join(rel));
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create the library backup: {e}"))?;
    }
    std::fs::rename(from, &to).map_err(|e| format!("Cannot move {} to the library backup: {e}", from.display()))
}

/// A set line `<?rune id?>` (behind `- `, `* ` or `N. `) naming `id`, bare or as `library/id`.
fn is_slot_of(line: &str, library: &str, id: &str) -> bool {
    let line = line.trim_end_matches(['\r', '\n']);
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    let rest = if let Some(r) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
        r
    } else if digits > 0 && line[digits..].starts_with(". ") {
        &line[digits + 2..]
    } else {
        line
    };
    let Some(name) = rest.strip_prefix("<?rune ").and_then(|r| r.strip_suffix("?>")) else { return false };
    name == id || name == format!("{library}/{id}")
}

fn unslot(text: &str, library: &str, id: &str) -> Option<String> {
    let kept: Vec<&str> = text.split_inclusive('\n').filter(|l| !is_slot_of(l, library, id)).collect();
    (kept.len() != text.split_inclusive('\n').count()).then(|| kept.concat())
}

fn drop_from_vaults(root: &Path, ops_for: impl Fn(&super::vault::Vault) -> Vec<Op>) -> Vec<String> {
    let store = Store::open(root);
    let mut changed = Vec::new();
    for listed in store.list().unwrap_or_default().into_iter().filter(|l| !l.template) {
        let Ok(v) = store.get(&listed.id) else { continue };
        if v.locked_utc.is_some() {
            continue;
        }
        let ops = ops_for(&v);
        if !ops.is_empty() && store.edit(&v.id, &ops, EditMode::Unlocked).is_ok() {
            changed.push(v.name.clone());
        }
    }
    changed
}

fn delete_rune(root: &Path, imports: &Path, library: &str, id: &str) -> Result<Deleted, String> {
    rune::check_id(id).map_err(|_| format!("{id:?} is not a rune name"))?;
    let dir = super::kit::library_dir(imports, library)?;
    let lib = Library::open(&dir)?;
    let entry = lib.entry(id)?.ok_or_else(|| format!("Rune {id} is not in library {library}"))?;
    let backup = backup_root(imports, library, false);
    let rel_of = |p: &Path| -> PathBuf { p.strip_prefix(&lib.root).unwrap_or(p).to_path_buf() };
    // Slots first: a set rewritten here keeps its original bytes in the backup.
    let (sets, _) = lib.all_runes();
    for (_, path) in sets.iter().filter(|(r, p)| r.kind == "set" && *p != entry.path) {
        let Ok(text) = crate::fsx::read_text(path) else { continue };
        let Some(next) = unslot(&text, library, id) else { continue };
        let keep = free_path(backup.join(rel_of(path)));
        if let Some(parent) = keep.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create the library backup: {e}"))?;
        }
        std::fs::write(&keep, &text).map_err(|e| format!("Cannot write the library backup: {e}"))?;
        crate::fsx::atomic_write(path, next.as_bytes())?;
    }
    move_into(&entry.path, &backup, &rel_of(&entry.path))?;
    let is_set = entry.kind == "set";
    let vaults = drop_from_vaults(root, |v| {
        let mut ops: Vec<Op> = v.runes.iter().filter(|r| r.library == library && r.id == id).cloned().map(Op::RemoveRune).collect();
        if is_set {
            ops.extend(v.runesets.iter().filter(|c| c.source.library == library && c.source.set == id).map(|c| Op::RemoveRuneset(c.source.clone())));
        }
        ops
    });
    // what the vaults kept as off bookkeeping for it goes too (locked vaults included; their loaded text stays)
    let _ = Store::open(root).prune_off(library, Some(id));
    Ok(Deleted { vaults })
}

fn delete_library(root: &Path, imports: &Path, library: &str) -> Result<Deleted, String> {
    let dir = super::kit::library_dir(imports, library)?;
    let backup = backup_root(imports, library, true);
    std::fs::rename(&dir, &backup).map_err(|e| format!("Cannot move library {library} to the library backup: {e}"))?;
    let vaults = drop_from_vaults(root, |v| {
        let mut ops: Vec<Op> = v.runes.iter().filter(|r| r.library == library).cloned().map(Op::RemoveRune).collect();
        ops.extend(v.runesets.iter().filter(|c| c.source.library == library).map(|c| Op::RemoveRuneset(c.source.clone())));
        ops
    });
    let _ = Store::open(root).prune_off(library, None);
    Ok(Deleted { vaults })
}

/// Pure over `root` (the Vidar root). Only a library under the imports dir is deletable.
pub fn delete_in(root: &Path, library: &str, rune: Option<&str>) -> Result<Deleted, String> {
    let imports = crate::paths::rune_imports_dir_in(root);
    if library.contains(".pre-split") || library.contains(".deleted-") || super::kit::library_dir(&imports, library).is_err() {
        return Err(format!("Library {library} is not an imported library, so it cannot be deleted here"));
    }
    match rune {
        Some(id) => delete_rune(root, &imports, library, id),
        None => delete_library(root, &imports, library),
    }
}

#[tauri::command]
pub async fn bare_library_delete(library: String, rune: Option<String>) -> Result<Deleted, String> {
    tauri::async_runtime::spawn_blocking(move || delete_in(&crate::paths::root(), &library, rune.as_deref())).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "library_delete_tests.rs"]
mod tests;
