//! src-tauri\src\rules\check.rs — the dangling-reference rules for one module
//! (`docs/explore/per-launch-rule-injection-2026-10-06.md` § Dangling-reference check).
//! Fail: an `@path` import that does not exist (`paths` globs are the Node lint's, not checked here).
//! Warn only: a backtick path missing on disk (prose may name files on purpose).

use std::path::Path;

use super::library::{Entry, Library};

/// Prose with fenced code blocks removed, so examples never count as references.
fn prose(body: &str) -> String {
    let mut fenced = false;
    let mut out = String::new();
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        } else if !fenced {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn exists_near(lib: &Library, dir: &Path, rel: &str) -> bool {
    let p = Path::new(rel);
    if p.is_absolute() {
        return p.exists();
    }
    // Rune bodies name repo paths, and the library folder sits in the repo: its parent resolves them too.
    dir.join(p).exists() || lib.root.join(p).exists() || lib.root.parent().is_some_and(|up| up.join(p).exists())
}

fn import_paths(prose: &str) -> Vec<String> {
    prose
        .split_whitespace()
        .filter_map(|tok| tok.strip_prefix('@'))
        .map(|t| t.trim_end_matches(|c: char| ",.;:)\"'".contains(c)).to_string())
        .filter(|p| p.contains('/') || p.contains('\\') || p.contains('.'))
        .collect()
}

fn looks_like_path(span: &str) -> bool {
    !span.is_empty()
        && !span.contains(char::is_whitespace)
        && !span.starts_with('-')
        && !span.contains("://")
        && !span.contains(|c| "*?<>{}$|".contains(c))
        && (span.contains('/') || span.contains('\\'))
        && span.rsplit(['/', '\\']).next().is_some_and(|leaf| leaf.contains('.'))
}

/// An `@` token is an import only if it ends `.md`, starts `./` `../` `~/`, or names an existing file;
/// anything else (an npm scope like `@scope/pkg`, a handle) is prose.
fn is_import(lib: &Library, dir: &Path, p: &str) -> bool {
    let norm = p.replace('\\', "/");
    norm.to_ascii_lowercase().ends_with(".md")
        || norm.starts_with("./")
        || norm.starts_with("../")
        || norm.starts_with("~/")
        || exists_near(lib, dir, p)
}

/// Errors fail the build; the Ok value is the warnings. `text` is the body (a set: its rendered text).
/// `check`, with the backtick path-on-disk warning switched by `path_warnings` (off for a Bare build).
pub fn check_in(lib: &Library, entry: &Entry, text: &str, path_warnings: bool) -> Result<Vec<String>, String> {
    let dir = entry.path.parent().unwrap_or(&lib.root);
    let body = prose(text);
    let mut errors = Vec::new();
    for import in import_paths(&body).into_iter().filter(|p| is_import(lib, dir, p)) {
        if !exists_near(lib, dir, &import) {
            errors.push(format!("`{}` imports @{import}, which does not exist", entry.id));
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }

    let mut warnings: Vec<String> = Vec::new();
    let mut warn = |w: String| {
        if !warnings.contains(&w) {
            warnings.push(w);
        }
    };
    let parts: Vec<&str> = if path_warnings { body.split('`').collect() } else { Vec::new() };
    for i in (1..parts.len().saturating_sub(1)).step_by(2) {
        let span = parts[i].trim();
        if looks_like_path(span) {
            if !exists_near(lib, dir, span) {
                warn(format!("`{}` mentions `{span}`, which is not on disk", entry.id));
            }
        }
    }
    Ok(warnings)
}
