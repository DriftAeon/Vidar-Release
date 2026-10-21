//! src-tauri\src\rules\parity.rs — R12: Rust renders `vidar-recall` (the only tab-only set the launcher wires) from the
//! real library and must match the rendered hash `manifest.json` records (Node `hash12` of the LF text).

#[cfg(test)]
mod tests {
    use crate::rules::{build::hash12, library::Library, set};

    #[test]
    fn real_library_sets_match_manifest_hashes() {
        let rel = crate::paths::rel("runes");
        let dir = crate::paths::root().join(&rel);
        if !dir.join("manifest.json").exists() {
            eprintln!("skipped: {}/manifest.json is not in this tree (the rune library is not shipped)", rel.display());
            return;
        }
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        let lib = Library::open(&dir).unwrap();
        for id in ["vidar-recall"] {
            let entry = lib.entry(id).unwrap().unwrap_or_else(|| panic!("{id} missing"));
            let rendered = set::render(&lib, &lib.load(&entry).unwrap()).unwrap_or_else(|e| panic!("{id}: {e:?}"));
            let want = manifest["sets"][id]["hash"].as_str().unwrap_or_else(|| panic!("{id} not in manifest"));
            assert_eq!(hash12(rendered.text.as_bytes()), want, "{id}");
        }
    }
}
