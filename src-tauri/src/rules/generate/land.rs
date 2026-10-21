//! src-tauri\src\rules\generate\land.rs — landing a prepared generation and toggling its runes (plan D2, D3, E1,
//! E2, E3). Everything that touches vidar.json runs inside `settings::store::with_config_root_at`, so the
//! process-wide `CONFIG_LOCK` covers each transition.
//! - `row_revision`: SHA-256 of the row's `sets` refs in vidar.json plus the bytes of every set file they name
//!   (a missing file hashes as a fixed marker). Taken at run start, recomputed inside `commit`.
//! - `commit`: writes the whole library `runtime\runes\gen-<rowKey>-<8 hex>\` into a temp sibling and renames it
//!   into place (nothing references it yet), then one transaction: revision mismatch refuses `stale:` and leaves the
//!   new folder unreferenced; otherwise one vidar.json write adds its ref and drops the row's previous generation
//!   ref and the import-library ref of every input file (`memory::import_library_of`, the import naming), then
//!   gen-index.json (flat `{ "<rowKey>": "<library>" }`) is written atomically in the same lock, after the config
//!   write (a failed write leaves the index untouched). No pruning (E1); `rules/` and
//!   `facts/` files are never rewritten after landing.
//! - `toggle`: the D3 transition for one rune: refuses On for a `locked` rune, rewrites the row set file through
//!   `render::set_text` (temp + rename), drops the library ref when nothing is On and re-adds it when something is.
//!   A library whose ref is absent counts as all Off (as Actives shows it). The library is accepted when the row
//!   references it or gen-index names it; dropping the ref first makes gen-index name it.
//! - Import Raw drops the row's generation ref in `assign::set_row_refs_in` via `is_generation_of`, so the
//!   revision changes and a running generation's commit refuses.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::render::{set_text, GenerateJson};
use super::{Input, Prepared};
use crate::rules::import::assign::set_row_refs_in;
use crate::rules::import::commands::Applied;
use crate::rules::import::memory::import_library_of;
use crate::rules::import::sources;
use crate::rules::rune::check_id;
use crate::settings::store::{with_config_root_at, with_config_root_then_at};

/// What landing reads and writes, explicit so tests run on temp roots.
pub struct LandEnv<'a> {
    pub config: &'a Path,
    /// The Vidar root (`rulesLibrary` is relative to it).
    pub root: &'a Path,
    /// `runtime\runes\`; gen-index.json sits in it.
    pub imports: &'a Path,
    /// gen-index.json (`paths::rune_gen_index`).
    pub index: &'a Path,
    pub home: Option<&'a Path>,
    /// The cwd import-library names derive from.
    pub cwd: Option<&'a Path>,
    pub primary: &'a str,
}

/// A generation that landed: its library and the refs its transaction dropped from the row.
#[derive(Debug, PartialEq)]
pub struct Landed {
    pub library: String,
    pub dropped: Vec<String>,
    /// Set layer sidecars of earlier generations that were not carried forward.
    pub warnings: Vec<String>,
}

const MISSING: &[u8] = b"\0missing\0";

/// Whether `library` is `gen-<row_key>-<8 lowercase hex>`.
pub fn is_generation_of(library: &str, row_key: &str) -> bool {
    library
        .strip_prefix("gen-")
        .and_then(|r| r.strip_prefix(row_key))
        .and_then(|r| r.strip_prefix('-'))
        .is_some_and(|h| h.len() == 8 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// gen-index.json: row key -> its current generated library; missing or unreadable reads as empty.
pub fn read_index(index: &Path) -> BTreeMap<String, String> {
    crate::fsx::read_json(index).unwrap_or_default()
}

fn agents_of(obj: &Map<String, Value>) -> &[Value] {
    obj.get("agents").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// The row's effective refs (the last entry with that key holding `sets`, as `bare/layer.rs` reads them):
/// `(library or None for rulesLibrary, set)`.
fn refs_of(obj: &Map<String, Value>, row_key: &str) -> Vec<(Option<String>, String)> {
    let sets = agents_of(obj)
        .iter()
        .rev()
        .find(|a| a.get("key").and_then(Value::as_str) == Some(row_key) && a.get("sets").is_some())
        .and_then(|a| a.get("sets"))
        .and_then(Value::as_array);
    sets.into_iter()
        .flatten()
        .filter_map(|r| Some((r.get("library").and_then(Value::as_str).map(str::to_string), r.get("set")?.as_str()?.to_string())))
        .collect()
}

fn row_libraries(obj: &Map<String, Value>, row_key: &str) -> Vec<String> {
    refs_of(obj, row_key).into_iter().filter_map(|(l, _)| l).collect()
}

fn revision_of(env: &LandEnv, obj: &Map<String, Value>, row_key: &str) -> String {
    let rules_library = obj.get("rulesLibrary").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let mut h = Sha256::new();
    for (library, set) in refs_of(obj, row_key) {
        h.update(format!("ref {}:{set}\n", library.as_deref().unwrap_or("")));
        let dir = match library.as_deref() {
            Some(l) if check_id(l).is_ok() => Some(env.imports.join(l)),
            Some(_) => None,
            None => rules_library.map(|r| env.root.join(r)),
        };
        let bytes = dir.filter(|_| check_id(&set).is_ok()).and_then(|d| std::fs::read(d.join("sets").join(format!("{set}.md"))).ok());
        match bytes {
            Some(b) => {
                h.update((b.len() as u64).to_le_bytes());
                h.update(b);
            }
            None => h.update(MISSING),
        }
    }
    format!("{:x}", h.finalize())
}

fn read_config_obj(config: &Path) -> Result<Map<String, Value>, String> {
    match crate::fsx::read_text(config) {
        Ok(t) => match serde_json::from_str(&t) {
            Ok(Value::Object(o)) => Ok(o),
            Ok(_) => Err("vidar.json root is not an object".into()),
            Err(e) => Err(format!("vidar.json {} is unreadable ({e})", config.display())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(format!("vidar.json {} is unreadable ({e})", config.display())),
    }
}

/// The row's revision now (E2).
pub fn row_revision_at(env: &LandEnv, row_key: &str) -> Result<String, String> {
    Ok(revision_of(env, &read_config_obj(env.config)?, row_key))
}

/// Writes `files` (paths relative to the library, `/` separators) as `imports\<library>\` through a temp sibling
/// and a rename; an existing library is never replaced.
pub fn write_library(imports: &Path, library: &str, files: &[(String, String)]) -> Result<PathBuf, String> {
    let dest = imports.join(library);
    if dest.exists() {
        return Err(format!("invalid: library `{library}` already exists"));
    }
    let tmp = imports.join(format!(".tmp-{library}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let wrote = (|| -> std::io::Result<()> {
        for (rel, text) in files {
            let path = rel.split('/').fold(tmp.clone(), |p, part| p.join(part));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, text)?;
        }
        std::fs::rename(&tmp, &dest)
    })();
    match wrote {
        Ok(()) => Ok(dest),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            Err(format!("invalid: library `{library}` not written ({e})"))
        }
    }
}

fn drop_ref(obj: &mut Map<String, Value>, row_key: &str, library: &str) -> Result<(), String> {
    set_row_refs_in(obj, library, &[(row_key.to_string(), Vec::new())]).map(|_| ())
}

fn add_ref(obj: &mut Map<String, Value>, row_key: &str, library: &str) -> Result<Vec<String>, String> {
    set_row_refs_in(obj, library, &[(row_key.to_string(), vec![library.to_string()])])
}

/// Lands `prepared` for `row_key`; `start_revision` is `row_revision` taken when the run began.
pub fn commit_at(env: &LandEnv, prepared: &Prepared, row_key: &str, start_revision: &str, inputs: &[Input]) -> Result<Landed, String> {
    let library = prepared.manifest.library.clone();
    if !is_generation_of(&library, row_key) || prepared.manifest.row_key != row_key {
        return Err(format!("invalid: `{library}` is not a generation library of row `{row_key}`"));
    }
    std::fs::create_dir_all(env.imports).map_err(|e| format!("invalid: {} not writable ({e})", env.imports.display()))?;
    write_library(env.imports, &library, &prepared.files)?;
    let input_libs = input_libraries(env, inputs);
    let mut dropped: Vec<String> = Vec::new();
    let indexed_before = read_index(env.index).get(row_key).cloned();
    // vidar.json first, gen-index after it inside the same lock: a failed config write leaves the index untouched.
    with_config_root_then_at(
        env.config,
        |obj| {
            if revision_of(env, obj, row_key) != start_revision {
                return Err("stale: Row Changed While Generating".into());
            }
            for lib in row_libraries(obj, row_key) {
                if lib != library && (is_generation_of(&lib, row_key) || input_libs.contains(&lib)) && !dropped.contains(&lib) {
                    drop_ref(obj, row_key, &lib)?;
                    dropped.push(lib);
                }
            }
            add_ref(obj, row_key, &library).map(|_| ())
        },
        || name_in_index(env.index, row_key, &library),
    )?;
    // The row's earlier generations: the refs the transaction dropped, plus the one gen-index named (a library
    // whose runes were all Off has no ref).
    let mut olds: Vec<String> = dropped.iter().filter(|l| is_generation_of(l, row_key)).cloned().collect();
    if let Some(prev) = indexed_before.filter(|p| p != &library && is_generation_of(p, row_key) && !olds.contains(p)) {
        olds.push(prev);
    }
    let mut warnings = Vec::new();
    for old in &olds {
        warnings.extend(carry_layers(env.imports, old, &library));
    }
    Ok(Landed { library, dropped, warnings })
}

/// Copies each `sets\*.layer.json` of library `old` into `new` for sets that still exist there by name
/// (`sets\<set>.md`), keeping any sidecar `new` already holds. Skipped or failed copies come back as warnings;
/// the landing never fails on them.
fn carry_layers(imports: &Path, old: &str, new: &str) -> Vec<String> {
    let mut warnings = Vec::new();
    let (old_sets, new_sets) = (imports.join(old).join("sets"), imports.join(new).join("sets"));
    let Ok(entries) = std::fs::read_dir(&old_sets) else { return warnings };
    let mut names: Vec<String> = entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    for name in names {
        let Some(set) = name.strip_suffix(".layer.json") else { continue };
        if !new_sets.join(format!("{set}.md")).is_file() {
            warnings.push(format!("Set layer of `{set}` in {old} not carried to {new}: the set no longer exists"));
            continue;
        }
        let dest = new_sets.join(&name);
        if dest.exists() {
            continue;
        }
        if let Err(e) = std::fs::copy(old_sets.join(&name), &dest) {
            warnings.push(format!("Set layer of `{set}` in {old} not carried to {new} ({e})"));
        }
    }
    warnings
}

/// The import library of every input, named as import names it (`memory::import_library_of`), without repeats.
pub fn input_libraries(env: &LandEnv, inputs: &[Input]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for i in inputs {
        let lib = import_library_of(env.imports, &sources::expand(&i.path, env.home), env.home, env.cwd, env.primary);
        if !out.contains(&lib) {
            out.push(lib);
        }
    }
    out
}

/// gen-index.json names `library` for `row_key` (atomic write; nothing is written when it already does).
fn name_in_index(index_path: &Path, row_key: &str, library: &str) -> Result<(), String> {
    let mut index = read_index(index_path);
    if index.get(row_key).map(String::as_str) == Some(library) {
        return Ok(());
    }
    index.insert(row_key.to_string(), library.to_string());
    let text = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())? + "\n";
    crate::fsx::atomic_write(index_path, text.as_bytes())
}

fn slot_ids(text: &str) -> Vec<String> {
    text.split("<?rune ").skip(1).filter_map(|t| t.split_once("?>")).map(|(id, _)| id.trim().to_string()).collect()
}

/// One rune On or Off in the row's generated `library` (D3).
pub fn toggle_at(env: &LandEnv, library: &str, row_key: &str, id: &str, on: bool) -> Result<Applied, String> {
    if check_id(library).is_err() || !is_generation_of(library, row_key) {
        return Err(format!("invalid: `{library}` is not a generation library of row `{row_key}`"));
    }
    let mut applied = Applied { library: library.to_string(), written: 0, rows: Vec::new() };
    with_config_root_at(env.config, |obj| {
        // The row references the library or gen-index names it for the row; either suffices.
        let referenced = row_libraries(obj, row_key).iter().any(|l| l == library);
        if !referenced && read_index(env.index).get(row_key).map(String::as_str) != Some(library) {
            return Err(format!("invalid: `{library}` is not the generated library of row `{row_key}`"));
        }
        let dir = env.imports.join(library);
        let manifest: GenerateJson = crate::fsx::read_json(&dir.join("generate.json")).map_err(|e| format!("invalid: {e}"))?;
        let Some(rune) = manifest.runes.iter().find(|r| r.id == id) else {
            return Err(format!("invalid: `{id}` is not a rune of {library}"));
        };
        if on && rune.locked {
            return Err(format!("invalid: `{id}` is locked draft (profile path or placeholder)"));
        }
        let set_path = dir.join("sets").join(format!("row-{row_key}.md"));
        let text = crate::fsx::read_text(&set_path).map_err(|e| format!("invalid: {}: {e}", set_path.display()))?;
        let mut now: Vec<String> = if referenced { slot_ids(&text) } else { Vec::new() };
        if on {
            if !now.iter().any(|n| n == id) {
                now.push(id.to_string());
            }
        } else {
            now.retain(|n| n != id);
        }
        let new_text = set_text(library, row_key, &manifest.sections, &now);
        if new_text != text {
            crate::fsx::atomic_write(&set_path, new_text.as_bytes())?;
            applied.written = 1;
        }
        if now.is_empty() {
            // The ref goes, so the index keeps the library discoverable: index write first, then vidar.json's.
            name_in_index(env.index, row_key, library)?;
            drop_ref(obj, row_key, library)?;
        } else {
            applied.rows = add_ref(obj, row_key, library)?;
        }
        Ok(())
    })?;
    Ok(applied)
}

/// Runs `f` over the live paths (vidar.json, the install root, `runtime\runes\`), with the cwd and primary agent
/// import-library names derive from, as `rules/import/commands.rs` `live` reads them.
#[allow(dead_code)] // the generator's commands (W2) are the callers
fn live<R>(f: impl FnOnce(&LandEnv) -> R) -> R {
    let (config, root, imports, index, home) =
        (crate::paths::config_path(), crate::paths::root(), crate::paths::rune_imports_dir(), crate::paths::rune_gen_index(), crate::paths::home());
    let cfg: Value = crate::fsx::read_text(&config).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let text = |k: &str| cfg.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let cwd = text("defaultCwd").map(PathBuf::from).filter(|p| p.is_dir());
    let primary = text("primaryAgent").unwrap_or_default();
    f(&LandEnv { config: &config, root: &root, imports: &imports, index: &index, home: home.as_deref(), cwd: cwd.as_deref(), primary: &primary })
}

#[allow(dead_code)] // the generator's commands (W2) are the callers
pub fn row_revision(row_key: &str) -> String {
    live(|env| row_revision_at(env, row_key)).unwrap_or_default()
}

#[allow(dead_code)] // the generator's commands (W2) are the callers
pub fn commit(prepared: &Prepared, row_key: &str, start_revision: &str, inputs: &[Input]) -> Result<Landed, String> {
    live(|env| commit_at(env, prepared, row_key, start_revision, inputs))
}

#[allow(dead_code)] // the generator's commands (W2) are the callers
pub fn toggle(library: &str, row_key: &str, id: &str, on: bool) -> Result<Applied, String> {
    live(|env| toggle_at(env, library, row_key, id, on))
}

#[cfg(test)]
#[path = "land_tests.rs"]
mod tests;
