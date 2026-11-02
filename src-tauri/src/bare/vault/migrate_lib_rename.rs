//! src-tauri\src\bare\vault\migrate_lib_rename.rs — the one-time startup rename of a retired library name
//! (`RENAMES`), run from `main.rs` right after the Rune Vault migration. Each step is decided from the files
//! on disk plus a journal kept in the run's backup folder (`runtime\migrations\library-<old>-to-<new>\`):
//!
//! - journal `done` → nothing (even when a folder with the old name turns up later; that name is refused).
//! - no journal, no `imports\<old>` and no unlocked vault naming `<old>` → nothing.
//! - no journal and `imports\<new>` already there → nothing written; a notice says why.
//! - otherwise: back up the old library, each other library file the run edits and each unlocked vault it
//!   rewrites, then the journal (`backed-up`), then the folder rename (a failure leaves a notice and is
//!   retried next start), journal `renamed`, then the files: sets `<old>*.md` → `<new>*.md` with their
//!   `name:`, every `scope:` header naming `<old>`, every `<old>/<id>` slot, and each unlocked vault's refs,
//!   snapshot copies and hash. Journal `done` last. Every file step is idempotent, so a run that stopped
//!   after the rename finishes on the next start.
//!
//! Locked vaults, and every `revs\<hash>\` folder, are never touched: they read the old name through the
//! alias in `layer::library_dir_named`. Recovery by hand: the backup folder holds `libraries\<name>\` and
//! `vaults\<id>\` as they were before the run, and `journal.json` lists every file copied.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{content_sha, vault_hash, SetSource, Vault};
use crate::bare::layer::slot_ref;

/// Retired library names and what they became. The old name is reserved (`retired`) and read as the new
/// one when no folder holds it (`renamed_to`).
pub(crate) const RENAMES: &[(&str, &str)] = &[("kit", "installed")];

/// The new name of a retired library name.
pub(crate) fn renamed_to(name: &str) -> Option<&'static str> {
    RENAMES.iter().find(|(old, _)| *old == name).map(|(_, new)| *new)
}

/// A retired library name: Add Runeset, the item import and the rules import refuse to make it.
pub(crate) fn retired(name: &str) -> bool {
    renamed_to(name).is_some()
}

static NOTICE: Mutex<Option<String>> = Mutex::new(None);

/// The last startup run's notice (a rename it held back or could not finish); `None` after a clean run.
/// `config::load` shows it beside the Rune Vault migration's notice.
pub fn notice() -> Option<String> {
    NOTICE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum State {
    BackedUp,
    Renamed,
    Done,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Journal {
    from: String,
    to: String,
    state: State,
    started_utc: String,
    /// Every file the backup holds, relative to the backup folder.
    backup: Vec<String>,
}

pub(crate) fn backup_dir(root: &Path, old: &str, new: &str) -> PathBuf {
    crate::paths::migrations_dir_in(root).join(format!("library-{old}-to-{new}"))
}

fn journal_file(dir: &Path) -> PathBuf {
    dir.join("journal.json")
}

fn save(dir: &Path, j: &Journal) -> Result<(), String> {
    crate::fsx::write_json_pretty(&journal_file(dir), j, true)
}

/// The library folders under `imports`, by name (hidden folders skipped).
fn libraries(imports: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(imports).into_iter().flatten().flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'))
        .collect();
    out.sort();
    out
}

/// Every `.md` under `dir`, hidden folders skipped.
fn md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut rd: Vec<_> = rd.flatten().collect();
    rd.sort_by_key(|e| e.file_name());
    for e in rd {
        let p = e.path();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            if !e.file_name().to_string_lossy().starts_with('.') {
                md_files(&p, out);
            }
        } else if p.extension().is_some_and(|x| x == "md") {
            out.push(p);
        }
    }
}

/// The new id of a set of the renamed library: `<old>` and `<old>-*` take the new name; others keep theirs.
fn set_id(id: &str, old: &str, new: &str) -> String {
    if id == old {
        new.to_string()
    } else if let Some(rest) = id.strip_prefix(old).filter(|r| r.starts_with('-')) {
        format!("{new}{rest}")
    } else {
        id.to_string()
    }
}

/// `text` with each `<old>/<id>` slot line (`layer::slot_ref`) and each `old/<id>` token of a copy's
/// `slot-off:` header naming `new`; any other byte stays.
fn retarget(text: &str, old: &str, new: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_header = false;
    for (i, l) in text.split_inclusive('\n').enumerate() {
        let bare = l.trim_end_matches(['\n', '\r']);
        if i == 0 && crate::fsx::strip_bom(bare) == "---" {
            in_header = true;
        } else if in_header && bare == "---" {
            in_header = false;
        } else if in_header {
            if let Some(list) = bare.strip_prefix(super::store::SLOT_OFF).and_then(|r| r.strip_prefix(':')) {
                let inner = list.trim().strip_prefix('[').and_then(|s| s.strip_suffix(']'));
                if let Some(inner) = inner {
                    let toks: Vec<String> = inner.split(',').map(str::trim).filter(|t| !t.is_empty())
                        .map(|t| t.strip_prefix(old).and_then(|r| r.strip_prefix('/')).map_or(t.to_string(), |id| format!("{new}/{id}")))
                        .collect();
                    out.push_str(&format!("{}: [{}]{}", super::store::SLOT_OFF, toks.join(", "), &l[bare.len()..]));
                    continue;
                }
            }
        } else if matches!(slot_ref(bare.trim_start()), Some((Some(lib), _)) if lib == old) {
            out.push_str(&l.replacen(&format!("<?rune {old}/"), &format!("<?rune {new}/"), 1));
            continue;
        }
        out.push_str(l);
    }
    out
}

/// A library file's text after the rename: scope and slots retargeted, and a renamed set's `name:`.
fn library_text(text: &str, old: &str, new: &str, name: Option<&str>) -> String {
    let t = retarget(&rescope_header(text, old, new), old, new);
    match name {
        Some(n) => rename_header(&t, n),
        None => t,
    }
}

/// Each library file other than the old library's own whose text the run changes: (path, new text).
fn other_library_edits(imports: &Path, old: &str, new: &str) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    for lib in libraries(imports).into_iter().filter(|l| l != old) {
        let mut files = Vec::new();
        md_files(&imports.join(&lib), &mut files);
        for f in files {
            let Ok(text) = std::fs::read_to_string(&f) else { continue };
            let next = library_text(&text, old, new, None);
            if next != text {
                out.push((f, next));
            }
        }
    }
    out
}

/// An unlocked vault after the rename: the new `vault.json` and each snapshot as (old file, new file, bytes);
/// `None` when it names nothing of the old library, or is locked.
fn vault_edit(dir: &Path, v: &Vault, old: &str, new: &str) -> Result<Option<(Vault, Vec<(String, String, Vec<u8>)>)>, String> {
    if v.locked_utc.is_some() {
        return Ok(None);
    }
    let mut next = v.clone();
    let mut files = Vec::new();
    let mut changed = false;
    let mut hashed: Vec<(SetSource, String)> = Vec::new();
    let renamed = |s: &SetSource| if s.library == old { SetSource { library: new.to_string(), set: set_id(&s.set, old, new) } } else { s.clone() };
    for c in &mut next.runesets {
        let path = dir.join(&c.file);
        let bytes = std::fs::read(&path).map_err(|e| format!("vault {} copy {}: {e}", v.id, c.file))?;
        let text = String::from_utf8(bytes.clone()).map_err(|_| format!("vault {} copy {} is not UTF-8", v.id, c.file))?;
        let source = renamed(&c.source);
        let name = (source.set != c.source.set).then_some(source.set.as_str());
        let out = library_text(&text, old, new, name).into_bytes();
        let file = format!("sets/{}--{}.md", source.library, source.set);
        if out != bytes || file != c.file || source != c.source {
            changed = true;
            c.source_hash = content_sha(&out);
        }
        hashed.push((source.clone(), content_sha(&out)));
        files.push((c.file.clone(), file.clone(), out));
        c.file = file;
        c.source = source;
    }
    for r in next.runes.iter_mut().chain(next.off.iter_mut()) {
        if r.library == old {
            r.library = new.to_string();
            changed = true;
        }
    }
    for s in &mut next.off_sets {
        let n = renamed(s);
        if &n != s {
            *s = n;
            changed = true;
        }
    }
    if !changed {
        return Ok(None);
    }
    next.hash = vault_hash(&hashed, &next.runes);
    Ok(Some((next, files)))
}

/// Every vault folder with a `vault.json`, by id.
fn vaults(root: &Path) -> Result<Vec<(PathBuf, Vault)>, String> {
    let base = crate::paths::rune_vaults_dir_in(root);
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&base) else { return Ok(out) };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.join("vault.json").is_file()).collect();
    dirs.sort();
    for d in dirs {
        let v: Vault = crate::fsx::read_json(&d.join("vault.json"))?;
        out.push((d, v));
    }
    Ok(out)
}

/// The unlocked vaults the run rewrites.
fn vault_edits(root: &Path, old: &str, new: &str) -> Result<Vec<(PathBuf, Vault, Vec<(String, String, Vec<u8>)>)>, String> {
    let mut out = Vec::new();
    for (dir, v) in vaults(root)? {
        if let Some((next, files)) = vault_edit(&dir, &v, old, new)? {
            out.push((dir, next, files));
        }
    }
    Ok(out)
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    crate::fsx::atomic_write(path, bytes)
}

/// Copies the old library whole, each other library file the run edits and each vault it rewrites, then
/// writes the journal (`backed-up`). Nothing outside the backup folder is written.
fn back_up(root: &Path, dir: &Path, old: &str, new: &str) -> Result<(), String> {
    let imports = crate::paths::rune_imports_dir_in(root);
    std::fs::create_dir_all(dir).map_err(|e| format!("backup {}: {e}", dir.display()))?;
    let mut listed = Vec::new();
    copy_tree(dir, &imports.join(old), &PathBuf::from(format!("libraries/{old}")), &mut listed)?;
    for (f, _) in other_library_edits(&imports, old, new) {
        let rel = f.strip_prefix(&imports).map_err(|e| e.to_string())?;
        copy_into(dir, &f, &Path::new("libraries").join(rel), &mut listed)?;
    }
    for (vdir, v, _) in vault_edits(root, old, new)? {
        copy_tree(dir, &vdir, &PathBuf::from(format!("vaults/{}", v.id)), &mut listed)?;
    }
    save(dir, &Journal { from: old.into(), to: new.into(), state: State::BackedUp, started_utc: crate::runlog::utc_stamp(), backup: listed })
}

/// The file steps after the folder rename; each is a no-op when already done.
fn rewrite(root: &Path, old: &str, new: &str, lines: &mut Vec<String>) -> Result<(), String> {
    let imports = crate::paths::rune_imports_dir_in(root);
    let lib = imports.join(new);
    // sets <old>*.md -> <new>*.md, then every file of the library
    let sets = lib.join("sets");
    let mut stems: Vec<String> = std::fs::read_dir(&sets).into_iter().flatten().flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|n| n.strip_suffix(".md").map(str::to_string))
        .collect();
    stems.sort();
    let mut renamed_sets = Vec::new();
    for stem in stems {
        let to = set_id(&stem, old, new);
        if to == stem {
            continue;
        }
        let (from_p, to_p) = (sets.join(format!("{stem}.md")), sets.join(format!("{to}.md")));
        if to_p.exists() {
            return Err(format!("both {} and {} exist; manual review required", from_p.display(), to_p.display()));
        }
        std::fs::rename(&from_p, &to_p).map_err(|e| format!("rename {}: {e}", from_p.display()))?;
        lines.push(format!("set {stem} -> {to}"));
        renamed_sets.push(to);
    }
    let mut files = Vec::new();
    md_files(&lib, &mut files);
    let mut edited = 0;
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        // a renamed set's `name:` follows its file (also on a resumed run, where the file already moved)
        let stem = f.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        let in_sets = f.parent() == Some(sets.as_path());
        let name = (in_sets && (stem == new || stem.starts_with(&format!("{new}-")))).then_some(stem.as_str());
        let next = library_text(&text, old, new, name);
        if next != text {
            write(&f, next.as_bytes())?;
            edited += 1;
        }
    }
    for (f, next) in other_library_edits(&imports, old, new) {
        write(&f, next.as_bytes())?;
        edited += 1;
    }
    if edited > 0 {
        lines.push(format!("{edited} library files retargeted"));
    }
    for (dir, v, files) in vault_edits(root, old, new)? {
        for (_, to, bytes) in &files {
            write(&dir.join(to), bytes)?;
        }
        let json = crate::fsx::json_pretty_bytes(&v, true)?;
        write(&dir.join("vault.json"), &json)?;
        for (from, to, _) in &files {
            if from != to {
                let p = dir.join(from);
                if p.exists() {
                    std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
                }
            }
        }
        lines.push(format!("vault {} rewritten (hash {})", v.id, v.hash));
    }
    Ok(())
}

/// One rename. `Ok` lines say what changed (none: nothing to do); `Err` is the notice. `fail_at` names a
/// step to fail (tests): `rename` refuses the folder rename, `after-rename` stops right after it.
pub(crate) fn run_with(root: &Path, old: &str, new: &str, fail_at: Option<&str>) -> Result<Vec<String>, String> {
    let imports = crate::paths::rune_imports_dir_in(root);
    let (src, dst) = (imports.join(old), imports.join(new));
    let dir = backup_dir(root, old, new);
    let journal: Option<Journal> = if journal_file(&dir).is_file() {
        Some(crate::fsx::read_json(&journal_file(&dir)).map_err(|e| format!("Library {old} rename journal unreadable: {e}; nothing changed"))?)
    } else {
        None
    };
    let mut lines = Vec::new();
    let state = match &journal {
        Some(j) if j.state == State::Done => return Ok(lines),
        Some(j) => j.state,
        None => {
            if !src.exists() && vault_edits(root, old, new)?.is_empty() {
                return Ok(lines);
            }
            if dst.exists() {
                return Err(format!("Library {new} already exists, so library {old} was not renamed; nothing changed"));
            }
            back_up(root, &dir, old, new)?;
            lines.push(format!("backup {}", dir.display()));
            State::BackedUp
        }
    };
    if state == State::BackedUp {
        if src.exists() && dst.exists() {
            return Err(format!("Both libraries {old} and {new} exist mid-rename; manual review required (see {})", dir.display()));
        }
        if src.exists() {
            let moved = if fail_at == Some("rename") { Err("refused (test)".to_string()) } else { std::fs::rename(&src, &dst).map_err(|e| e.to_string()) };
            moved.map_err(|e| format!("Library {old} could not be renamed to {new} ({e}); retried next start"))?;
            lines.push(format!("library {old} -> {new}"));
        }
    }
    // the journal back_up wrote, or the one an earlier run left
    let mut j: Journal = crate::fsx::read_json(&journal_file(&dir))?;
    if j.state == State::BackedUp {
        j.state = State::Renamed;
        save(&dir, &j)?;
        if fail_at == Some("after-rename") {
            return Err("interrupted after the folder rename (test)".into());
        }
    }
    rewrite(root, old, new, &mut lines).map_err(|e| format!("Library {old} -> {new} rename stopped: {e}; resumed next start (backup {})", dir.display()))?;
    j.state = State::Done;
    save(&dir, &j)?;
    Ok(lines)
}

/// The production run over this install's root, each rename in turn; lines go to the release log.
pub fn run_at_startup() {
    let root = crate::paths::root();
    let mut notes = Vec::new();
    for (old, new) in RENAMES {
        match run_with(&root, old, new, None) {
            Ok(lines) => lines.iter().for_each(|l| eprintln!("library rename: {l}")),
            Err(e) => {
                eprintln!("library rename: {e}");
                notes.push(e);
            }
        }
    }
    *NOTICE.lock().unwrap_or_else(|e| e.into_inner()) = (!notes.is_empty()).then(|| notes.join("; "));
}

fn copy_into(backup: &Path, src: &Path, rel: &Path, listed: &mut Vec<String>) -> Result<(), String> {
    if !src.is_file() {
        return Ok(());
    }
    let dst = backup.join(rel);
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("backup {}: {e}", parent.display()))?;
    }
    std::fs::copy(src, &dst).map_err(|e| format!("backup {} -> {}: {e}", src.display(), dst.display()))?;
    listed.push(rel.to_string_lossy().replace('\\', "/"));
    Ok(())
}

fn copy_tree(backup: &Path, src: &Path, rel: &Path, listed: &mut Vec<String>) -> Result<(), String> {
    let rd = match std::fs::read_dir(src) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("backup {}: {e}", src.display())),
    };
    for e in rd {
        let e = e.map_err(|e| format!("backup {}: {e}", src.display()))?;
        let p = e.path();
        let r = rel.join(e.file_name());
        let ty = e.file_type().map_err(|e| format!("backup {}: {e}", p.display()))?;
        if ty.is_symlink() || (!ty.is_file() && !ty.is_dir()) {
            return Err(format!("backup {}: unsupported file type", p.display()));
        }
        if ty.is_dir() {
            copy_tree(backup, &p, &r, listed)?;
        } else {
            copy_into(backup, &p, &r, listed)?;
        }
    }
    Ok(())
}

/// `text` with `old` in its header `scope: [..]` list replaced by `new` (a renamed generation
/// library's sets name the library in their scope); any other text stays byte for byte.
fn rescope_header(text: &str, old: &str, new: &str) -> String {
    let mut out = String::new();
    let mut in_header = false;
    for (i, l) in text.split_inclusive('\n').enumerate() {
        let bare = l.trim_end();
        if i == 0 && bare == "---" {
            in_header = true;
        } else if in_header && bare == "---" {
            in_header = false;
        } else if in_header {
            let list = bare.strip_prefix("scope:").map(str::trim).and_then(|v| v.strip_prefix('[')).and_then(|v| v.strip_suffix(']'));
            if let Some(list) = list {
                let items: Vec<&str> = list.split(',').map(str::trim).collect();
                if items.contains(&old) {
                    let items: Vec<&str> = items.into_iter().map(|s| if s == old { new } else { s }).collect();
                    out.push_str(&format!("scope: [{}]{}", items.join(", "), &l[bare.len()..]));
                    continue;
                }
            }
        }
        out.push_str(l);
    }
    out
}

/// `text` with its header `name:` set to `name`.
fn rename_header(text: &str, name: &str) -> String {
    let mut out = String::new();
    let mut in_header = false;
    let mut done = false;
    for (i, l) in text.split_inclusive('\n').enumerate() {
        let bare = l.trim_end();
        if i == 0 && bare == "---" {
            in_header = true;
        } else if in_header && bare == "---" {
            in_header = false;
        } else if in_header && !done && bare.starts_with("name:") {
            out.push_str(&format!("name: {name}{}", &l[bare.len()..]));
            done = true;
            continue;
        }
        out.push_str(l);
    }
    out
}

#[cfg(test)]
#[path = "migrate_lib_rename_tests.rs"]
mod tests;
