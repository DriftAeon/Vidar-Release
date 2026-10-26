//! Copy one imported set under a new rune id (a retired `.layer.json` sidecar stays behind).
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use super::{library::Library, rune};
use crate::bare::set_layer;

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)
        .map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
    if let Err(e) = file.write_all(bytes) {
        let _ = fs::remove_file(path);
        return Err(format!("Cannot write {}: {e}", path.display()));
    }
    Ok(())
}

/// The source and destination both live in an imported library under `imports`.
pub fn fork_at(imports: &Path, library: &str, set: &str, name: &str) -> Result<(), String> {
    rune::check_id(library)?;
    rune::check_id(set)?;
    rune::check_id(name)?;
    if set == name { return Err("The fork needs a different name".into()); }
    let base = imports.canonicalize().map_err(|e| format!("Rune imports unavailable: {e}"))?;
    let dir = imports.join(library).canonicalize().map_err(|e| format!("Library {library} unavailable: {e}"))?;
    if !dir.starts_with(&base) || !dir.is_dir() { return Err("Library leaves rune imports".into()); }
    let lib = Library::open(&dir)?;
    let source = lib.entry(set)?.ok_or_else(|| format!("Set {set} does not exist"))?;
    if source.kind != "set" { return Err(format!("{set} is not a set")); }
    lib.load(&source)?;
    if lib.entry(name)?.is_some() { return Err(format!("{name} already exists")); }
    let sets_dir = dir.join("sets").canonicalize().map_err(|e| format!("Sets folder unavailable: {e}"))?;
    if !sets_dir.starts_with(&dir) { return Err("Sets folder leaves library".into()); }
    let target = sets_dir.join(format!("{name}.md"));
    let target_layer = set_layer::sidecar_path(&sets_dir.parent().unwrap_or(&dir), name);
    if target.exists() || target_layer.exists() { return Err(format!("{name} already exists")); }
    let source_text = crate::fsx::read_text(&source.path).map_err(|e| format!("Set {set} unreadable: {e}"))?;
    let mut lines = source_text.lines();
    if lines.next() != Some("---") { return Err("Set header is invalid".into()); }
    let name_line = source_text.lines().skip(1).take_while(|line| *line != "---")
        .find(|line| line.starts_with("name:"))
        .ok_or("Set header has no name")?;
    let forked = source_text.replacen(name_line, &format!("name: {name}"), 1);
    let parsed = rune::parse(&forked)?;
    if parsed.id != name || parsed.kind != "set" { return Err("Forked set header is invalid".into()); }
    // A set's items are runes in its body now; a retired `.layer.json` sidecar is never copied.
    write_new(&target, forked.as_bytes())
}

#[tauri::command]
pub fn bare_set_fork(library: String, set: String, name: String) -> Result<(), String> {
    fork_at(&crate::paths::rune_imports_dir(), &library, &set, &name)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copies_the_set_but_never_its_sidecar_and_refuses_collision_or_escape() {
        let root = std::env::temp_dir().join(format!("vidar-set-fork-{}", std::process::id()));
        let imports = root.join("imports");
        let sets = imports.join("kit").join("sets");
        fs::create_dir_all(&sets).unwrap();
        let source = "---\nname: base\nkind: set\nscope: [global]\n---\n\n# Base\n";
        fs::write(sets.join("base.md"), source).unwrap();
        fs::write(sets.join("base.layer.json"), b"{\"modules\":{\"jira\":{\"off\":[]}}}\n").unwrap();
        fork_at(&imports, "kit", "base", "base-unreal").unwrap();
        assert!(fs::read_to_string(sets.join("base-unreal.md")).unwrap().contains("name: base-unreal"));
        assert!(!sets.join("base-unreal.layer.json").exists(), "a fork writes no sidecar");
        assert!(fork_at(&imports, "kit", "base", "base-unreal").is_err());
        assert!(fork_at(&imports, "kit", "base", "../escape").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
