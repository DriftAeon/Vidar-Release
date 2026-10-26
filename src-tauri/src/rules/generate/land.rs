//! src-tauri\src\rules\generate\land.rs — landing a prepared generation (model R5, R6). `commit_at` writes the
//! whole library `runtime\runes\gen-<runId>\` into a temp sibling and renames it into place; that is the only
//! write. No vidar.json write, no gen-index entry, no ref swap or add-back, no launcher row: the result card's
//! Add to Vault puts the set in a vault on the user's click (`rune_vault_edit`).
//! - `is_generation_of` names an older row-bound generation (`gen-<rowKey>-<8 hex>`) for `rules/import/assign.rs`;
//!   nothing here writes that shape or gen-index.json any more.

use std::path::{Path, PathBuf};

use super::Prepared;

/// What landing reads and writes, explicit so tests run on temp roots.
pub struct LandEnv<'a> {
    /// vidar.json; read for the Codex skills listing, never written.
    pub config: &'a Path,
    /// `runtime\runes\`; generated libraries land in it.
    pub imports: &'a Path,
    pub home: Option<&'a Path>,
    /// The tab's cwd (local discovery for ticked items).
    pub cwd: Option<&'a Path>,
}

/// A generation that landed: its library and set.
#[derive(Debug, PartialEq)]
pub struct Landed {
    pub library: String,
    pub set: String,
}

/// Whether `library` is `gen-<8 lowercase hex>`, the name a generation lands under.
pub fn is_generated_library(library: &str) -> bool {
    library.strip_prefix("gen-").is_some_and(|h| h.len() == 8 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Whether `library` is `gen-<row_key>-<8 lowercase hex>` (an older, row-bound generation).
pub fn is_generation_of(library: &str, row_key: &str) -> bool {
    library
        .strip_prefix("gen-")
        .and_then(|r| r.strip_prefix(row_key))
        .and_then(|r| r.strip_prefix('-'))
        .is_some_and(|h| h.len() == 8 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Writes `files` (paths relative to the library, `/` separators) as `imports\<library>\` through a temp sibling
/// and a rename; an existing library is never replaced. The rename retries briefly: Windows refuses to move a
/// folder while a scanner still holds a file just written into it (`Access is denied`, os error 5).
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
        crate::fsx::rename_retrying(&tmp, &dest)
    })();
    match wrote {
        Ok(()) => Ok(dest),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            Err(format!("invalid: library `{library}` not written ({e})"))
        }
    }
}

/// The set a prepared generation writes: the stem of its one `sets/<set>.md` file.
fn written_set(files: &[(String, String)]) -> Option<String> {
    files.iter().find_map(|(p, _)| p.strip_prefix("sets/")?.strip_suffix(".md").filter(|s| !s.contains('/')).map(str::to_string))
}

/// Lands `prepared`: writes its library and nothing else.
pub fn commit_at(env: &LandEnv, prepared: &Prepared) -> Result<Landed, String> {
    let library = prepared.manifest.library.clone();
    if !is_generated_library(&library) {
        return Err(format!("invalid: `{library}` is not a generation library name"));
    }
    let set = written_set(&prepared.files).ok_or_else(|| format!("invalid: generation `{library}` writes no set"))?;
    std::fs::create_dir_all(env.imports).map_err(|e| format!("invalid: {} not writable ({e})", env.imports.display()))?;
    write_library(env.imports, &library, &prepared.files)?;
    Ok(Landed { library, set })
}

#[cfg(test)]
#[path = "land_tests.rs"]
mod tests;
