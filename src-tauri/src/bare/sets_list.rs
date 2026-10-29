//! src-tauri\src\bare\sets_list.rs — `bare_sets_list`: every rune set the resolver can name, read-only.
//! The rules library (`rulesLibrary`, library omitted) first,
//! then each import library under `runtime\runes\` in name order, opened as `layer::library_dir` +
//! `Library::open` open them. Backups (`*.pre-split`, `*.deleted-*`) and folders that are not library names are skipped.

use serde::Serialize;
use serde_json::Value;
use std::path::Path;

use crate::rules::library::Library;
use crate::rules::rune;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SetEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library: Option<String>,
    pub set: String,
}

fn sets_of(dir: &Path, library: Option<&str>, out: &mut Vec<SetEntry>) {
    let Ok(lib) = Library::open(dir) else { return };
    let (runes, _) = lib.all_runes();
    let mut ids: Vec<String> = runes.into_iter().filter(|(r, _)| r.kind == "set").map(|(r, _)| r.id).collect();
    ids.sort();
    ids.dedup();
    out.extend(ids.into_iter().map(|set| SetEntry { library: library.map(str::to_string), set }));
}

/// Pure over `root` (the Vidar root): the rules library, then the import libraries.
pub fn sets_in(root: &Path) -> Vec<SetEntry> {
    let mut out = Vec::new();
    let config: Value = crate::fsx::read_json(&crate::paths::config_path_in(root)).unwrap_or(Value::Null);
    if let Some(rel) = config.get("rulesLibrary").and_then(Value::as_str) {
        sets_of(&root.join(rel), None, &mut out);
    }
    let base = crate::paths::rune_imports_dir_in(root);
    let mut names: Vec<String> = std::fs::read_dir(&base)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.contains(".pre-split") && !n.contains(".deleted-") && rune::check_id(n).is_ok())
        .collect();
    names.sort();
    for name in names {
        let dir = base.join(&name);
        // A junction pointing outside the import folder is not a library (as `library_dir` refuses it).
        if !dir.canonicalize().is_ok_and(|d| base.canonicalize().is_ok_and(|b| d.starts_with(b))) {
            continue;
        }
        let before = out.len();
        sets_of(&dir, Some(&name), &mut out);
        out[before..].sort_by(|a, b| a.set.cmp(&b.set));
    }
    out
}

#[tauri::command]
pub async fn bare_sets_list() -> Result<Vec<SetEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| sets_in(&crate::paths::root())).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(dir: &Path, id: &str) {
        let d = dir.join("sets");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("{id}.md")), format!("---\nname: {id}\nkind: set\nscope: [global]\n---\n# {id}\n")).unwrap();
    }

    #[test]
    fn lists_the_rules_library_then_each_import_library_and_skips_backups() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("vidar-setslist-{}-{nanos}", std::process::id()));
        let imports = crate::paths::rune_imports_dir_in(&root);
        std::fs::create_dir_all(&imports).unwrap();
        std::fs::write(crate::paths::config_path_in(&root), r#"{"rulesLibrary":"rules"}"#).unwrap();
        set(&root.join("rules"), "app-core");
        set(&imports.join("kit"), "workflow");
        set(&imports.join("kit"), "base");
        set(&imports.join("other"), "solo");
        set(&imports.join("kit.pre-split"), "old");
        set(&imports.join("kit.deleted-20261028-101500"), "gone");
        // A cook recipe lives in `recipes/`, a folder `Library::open` never reads: never listed.
        let rec = root.join("rules").join("recipes");
        std::fs::create_dir_all(&rec).unwrap();
        std::fs::write(rec.join("claude-md.md"), "---\nname: claude-md\nkind: set\nscope: [global]\n---\n# x\n").unwrap();
        let got = sets_in(&root);
        let _ = std::fs::remove_dir_all(&root);
        let pair = |l: Option<&str>, s: &str| SetEntry { library: l.map(str::to_string), set: s.to_string() };
        assert_eq!(got, vec![pair(None, "app-core"), pair(Some("kit"), "base"), pair(Some("kit"), "workflow"), pair(Some("other"), "solo")]);
    }
}
