//! src-tauri\src\rules\build.rs — concatenate a tab's modules in list order into one built file,
//! content-addressed (`built\<hash12>.md`, hash12 = first 12 hex of SHA-256 over the bytes), and
//! keep the last-good map (`last-good.json`, `{ "<key>": "<hash12>" }`). A failed build writes
//! neither a built file nor the map.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::check::check_in;
use super::context::RenderCtx;
use super::library::Library;
use super::rune::State;
use super::set::render_in;

pub struct Built {
    /// Empty when every listed module was skipped.
    pub bytes: Vec<u8>,
    pub warnings: Vec<String>,
}

pub struct BuildFail {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn build(lib: &Library, ids: &[String]) -> Result<Built, BuildFail> {
    build_in(lib, ids, &RenderCtx::default())
}

/// `build` in a caller's context. A Bare build skips the backtick path-on-disk check: the kept `refs\` pointers
/// name files the Bare home does not have, so every spawn would warn.
pub fn build_in(lib: &Library, ids: &[String], ctx: &RenderCtx) -> Result<Built, BuildFail> {
    let (mut errors, mut warnings, mut parts) = (Vec::new(), Vec::new(), Vec::<String>::new());
    let mut seen: Vec<&str> = Vec::new();
    for id in ids.iter().map(String::as_str) {
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        if let Some(note) = lib.tombstone(id) {
            let by = if note.is_empty() { String::new() } else { format!(": {note}") };
            errors.push(format!("`{id}` is tombstoned (retired){by}"));
            continue;
        }
        let entry = match lib.entry(id) {
            Ok(Some(e)) => e,
            Ok(None) => {
                errors.push(format!("`{id}` is not in the rules library"));
                continue;
            }
            Err(e) => {
                errors.push(e);
                continue;
            }
        };
        let rune = match lib.load(&entry) {
            Ok(r) => r,
            Err(e) => {
                errors.push(e);
                continue;
            }
        };
        if rune.kind == "procedure" {
            errors.push(format!("`{id}` is a procedure (skill); skills are not injected as rules"));
            continue;
        }
        match rune.state {
            State::Draft => continue,
            State::Disabled => {
                warnings.push(format!("`{id}` is disabled and was skipped"));
                continue;
            }
            State::Active => {}
        }
        if !ctx.keeps(&rune) {
            warnings.extend(ctx.drop_warning(&rune));
            continue;
        }
        let text = if rune.kind == "set" {
            match render_in(lib, &rune, ctx) {
                Ok(r) => {
                    warnings.extend(r.warnings);
                    r.text
                }
                Err(es) => {
                    errors.extend(es);
                    continue;
                }
            }
        } else {
            rune.body.clone()
        };
        match check_in(lib, &entry, &text, !ctx.bare) {
            Ok(w) => warnings.extend(w),
            Err(e) => {
                errors.push(e);
                continue;
            }
        }
        let text = text.trim();
        if !text.is_empty() {
            parts.push(text.to_string());
        }
    }
    if !errors.is_empty() {
        return Err(BuildFail { errors, warnings });
    }
    let bytes = if parts.is_empty() { Vec::new() } else { (parts.join("\n\n") + "\n").into_bytes() };
    Ok(Built { bytes, warnings })
}

pub fn hash12(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(6).map(|b| format!("{b:02x}")).collect()
}

pub fn built_dir(rules_dir: &Path) -> PathBuf {
    rules_dir.join("built")
}

fn map_path(rules_dir: &Path) -> PathBuf {
    rules_dir.join("last-good.json")
}

/// A missing map is empty; one that exists but does not parse is an error (never overwritten).
fn read_map(rules_dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let path = map_path(rules_dir);
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    crate::fsx::read_json(&path)
}

pub fn is_hash12(s: &str) -> bool {
    s.len() == 12 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Write the built file (skipped when the same hash is already there), then point `key` at it.
/// A corrupt `last-good.json` is left as it is and reported as the warning in the second slot.
pub fn store(rules_dir: &Path, key: &str, bytes: &[u8]) -> Result<(PathBuf, Option<String>), String> {
    let hash = hash12(bytes);
    let dir = built_dir(rules_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("rules folder is not writable: {e}"))?;
    let file = dir.join(format!("{hash}.md"));
    if !file.is_file() {
        crate::fsx::atomic_write(&file, bytes)?;
    }
    let mut map = match read_map(rules_dir) {
        Ok(m) => m,
        Err(e) => {
            let warning = format!(
                "Rules history file is unreadable and was left as it is, so this build is not tracked as last good: {e}"
            );
            return Ok((file, Some(warning)));
        }
    };
    map.insert(key.to_string(), hash);
    let json = serde_json::to_vec_pretty(&map).map_err(|e| e.to_string())?;
    crate::fsx::atomic_write(&map_path(rules_dir), &json)?;
    Ok((file, None))
}

pub enum LastGood {
    Found(PathBuf),
    /// The map names a build whose file is gone.
    Missing,
    None,
}

/// The built file `key` last built successfully, if it is still on disk.
pub fn last_good(rules_dir: &Path, key: &str) -> LastGood {
    let Some(hash) = read_map(rules_dir).ok().and_then(|mut m| m.remove(key)) else {
        return LastGood::None;
    };
    if !is_hash12(&hash) {
        return LastGood::None;
    }
    let file = built_dir(rules_dir).join(format!("{hash}.md"));
    if file.is_file() {
        LastGood::Found(file)
    } else {
        LastGood::Missing
    }
}
