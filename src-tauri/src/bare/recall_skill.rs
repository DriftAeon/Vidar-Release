//! Materialize Bare's on-demand rune bodies as one content-addressed skill per loadout.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::rules::rune::Rune;

use super::{home, layer::SetRef};

pub(super) const GUARD_REFUSAL_MARKER: &str = "VIDAR_RUNE_GUARD_REFUSAL:";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuneGuardRefusal<'a> {
    reason: &'a str,
    id: &'a str,
    library: Option<&'a str>,
    set: &'a str,
}

#[derive(Clone, Debug)]
struct Entry {
    rune: Rune,
    source: SetRef,
}

#[derive(Clone, Debug, Default)]
pub(super) struct Draft {
    entries: Vec<Entry>,
    conflict: Option<String>,
}

impl PartialEq for Draft {
    fn eq(&self, other: &Self) -> bool {
        self.conflict == other.conflict && self.files() == other.files()
            && self.entries.iter().map(|e| &e.source).eq(other.entries.iter().map(|e| &e.source))
    }
}

impl Draft {
    pub(super) fn push(&mut self, rune: &Rune, source: &SetRef) {
        if let Some(first) = self.entries.iter().find(|e| e.rune.id == rune.id) {
            let first = &first.rune;
            if first.body != rune.body || first.description != rune.description || first.paths != rune.paths {
                self.conflict.get_or_insert_with(|| rune.id.clone());
            }
        } else {
            self.entries.push(Entry { rune: rune.clone(), source: source.clone() });
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn files(&self) -> Vec<(String, String)> {
        let mut index = String::from("---\nname: vidar-runes\ndescription: Holds this set's on-demand rules.\n---\n\n# On-Demand Runes\n\nRead the named rune file when a Bare set points to it.\n\n");
        for entry in &self.entries {
            let rune = &entry.rune;
            let globs = if rune.paths.is_empty() { String::new() } else { format!("; globs: {}", rune.paths.join(", ")) };
            index.push_str(&format!("- {} — {}{globs}. Read `{}.md` in this folder.\n", rune.id, rune.description, rune.id));
        }
        let mut files = vec![("SKILL.md".into(), index)];
        files.extend(self.entries.iter().map(|e| (format!("{}.md", e.rune.id), e.rune.body.clone())));
        files
    }
}

/// Publish a complete folder under the install's runeSkills path, leaving a matching folder intact.
pub(super) fn write(root: &Path, home_dir: &Path, guard: &home::Guard, draft: &Draft) -> Result<Option<PathBuf>, String> {
    if let Some(id) = &draft.conflict {
        return Err(format!("Bare rune skill: `{id}` has different bodies or metadata across libraries; spawn refused"));
    }
    if draft.is_empty() { return Ok(None); }
    let files = draft.files();
    let root_text = root.to_string_lossy();
    let home_text = home_dir.to_string_lossy();
    for (entry, (name, body)) in draft.entries.iter().zip(files.iter().skip(1)) {
        let fields: Vec<&str> = std::iter::once(name.as_str())
            .chain(std::iter::once(entry.rune.description.as_str()))
            .chain(entry.rune.paths.iter().map(String::as_str))
            .chain(std::iter::once(body.as_str()))
            .collect();
        if let Err(reason) = home::guard_strings(&fields, &root_text, &home_text, guard, "Bare rune skill") {
            let refusal = RuneGuardRefusal {
                reason: &reason, id: &entry.rune.id,
                library: entry.source.library.as_deref(), set: &entry.source.set,
            };
            let json = serde_json::to_string(&refusal).expect("rune guard refusal is serializable");
            return Err(format!("{reason}\n{GUARD_REFUSAL_MARKER}{json}"));
        }
    }
    home::guard_strings(&[files[0].0.as_str(), files[0].1.as_str()], &root_text, &home_text, guard, "Bare rune skill")?;

    let mut canonical = Vec::new();
    for (name, body) in &files {
        for part in [name.as_bytes(), body.as_bytes()] {
            canonical.extend_from_slice(&(part.len() as u64).to_le_bytes());
            canonical.extend_from_slice(part);
        }
    }
    let hash = crate::rules::build::hash12(&canonical);
    let base = crate::paths::rune_skills_dir_in(root);
    let dest = base.join(&hash).join("vidar-runes");
    if dest.is_dir() { return Ok(Some(dest)); }
    std::fs::create_dir_all(&base).map_err(|e| format!("Bare rune skill {}: {e}", base.display()))?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let staging = base.join(format!(".{hash}-{}-{stamp}", std::process::id()));
    let staged_skill = staging.join("vidar-runes");
    let publish = (|| -> Result<(), String> {
        std::fs::create_dir(&staging).map_err(|e| format!("Bare rune skill {}: {e}", staging.display()))?;
        std::fs::create_dir(&staged_skill).map_err(|e| format!("Bare rune skill {}: {e}", staged_skill.display()))?;
        for (name, body) in &files {
            let path = staged_skill.join(name);
            std::fs::write(&path, body).map_err(|e| format!("Bare rune skill {}: {e}", path.display()))?;
        }
        std::fs::rename(&staging, base.join(&hash)).or_else(|e| if dest.is_dir() { Ok(()) } else { Err(e) })
            .map_err(|e| format!("Bare rune skill {}: {e}", dest.display()))
    })();
    if staging.is_dir() { let _ = std::fs::remove_dir_all(&staging); }
    publish.map(|()| Some(dest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bare::{layer::SetRef, set_loadout::{self, ResolveEnv}};
    use crate::falcon::Agent;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    fn temp(tag: &str) -> Tmp {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        Tmp(std::env::temp_dir().join(format!("vidar-recall-skill-{tag}-{}-{stamp}", std::process::id())))
    }

    fn put(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn fixture(root: &Path) {
        put(&crate::paths::config_path_in(root), r#"{"rulesLibrary":"lib"}"#);
        put(&root.join("contracts/module-bundles.json"), r#"{"version":1,"bundles":{}}"#);
        put(&root.join("lib/facts/memory.md"), "---\nname: memory\nkind: fact\nscope: [s]\ndescription: Remember this\n---\nMemory body.\n");
        put(&root.join("lib/rules/path-rule.md"), "---\nname: path-rule\nkind: rule\nscope: [s]\nactivate: paths\npaths: [src/**/*.rs]\ndescription: For Rust files\n---\nPath body.\n");
        put(&root.join("lib/rules/plain.md"), "---\nname: plain\nkind: rule\nscope: [s]\ndescription: Always\n---\nAlways body.\n");
        put(&root.join("lib/sets/main.md"), "---\nname: main\nkind: set\nscope: [s]\n---\n- <?rune path-rule?>\n- <?rune plain?>\n<?recall?>\n");
    }

    fn resolved(root: &Path, enabled: bool) -> set_loadout::Loadout {
        let config = crate::paths::config_path_in(root);
        let home = root.join("home");
        let env = ResolveEnv { root, config: &config, home: &home, user_home: None };
        let set = SetRef { library: None, set: "main".into() };
        let (loadout, warnings) = set_loadout::resolve_with_delivery(&env, Agent::Claude, &[set], enabled);
        assert!(warnings.is_empty(), "{warnings:?}");
        loadout
    }

    #[test]
    fn paths_and_recall_become_on_demand_without_resolver_writes() {
        let t = temp("resolve");
        fixture(&t.0);
        let loadout = resolved(&t.0, true);
        assert_eq!(loadout.rules.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["plain"]);
        assert_eq!(loadout.on_demand.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["path-rule", "memory"]);
        assert!(!loadout.recall_skill.is_empty());
        assert!(!crate::paths::rune_skills_dir_in(&t.0).exists());
        let inline = resolved(&t.0, false);
        assert_eq!(inline.rules.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["path-rule", "plain"]);
        assert!(inline.recall_skill.is_empty());
    }

    #[test]
    fn skill_content_is_guarded_and_reuses_the_same_hash_folder() {
        let t = temp("write");
        fixture(&t.0);
        let draft = resolved(&t.0, true).recall_skill;
        let guard = home::Guard { user_profile: Some("C:\\Users\\person".into()), username: None };
        let home_dir = t.0.join("home");
        let folder = write(&t.0, &home_dir, &guard, &draft).unwrap().unwrap();
        assert!(folder.starts_with(crate::paths::rune_skills_dir_in(&t.0)));
        assert_eq!(folder.file_name().unwrap(), "vidar-runes");
        assert_eq!(folder.parent().unwrap().file_name().unwrap().to_string_lossy().len(), 12);
        let index = std::fs::read_to_string(folder.join("SKILL.md")).unwrap();
        assert!(index.contains("name: vidar-runes"));
        assert!(index.contains("description: Holds this set's on-demand rules."));
        assert!(index.contains("path-rule — For Rust files; globs: src/**/*.rs. Read `path-rule.md` in this folder."));
        assert!(!index.contains("C:\\Users\\person"));
        assert_eq!(std::fs::read_to_string(folder.join("path-rule.md")).unwrap(), "Path body.\n");
        assert_eq!(std::fs::read_to_string(folder.join("memory.md")).unwrap(), "Memory body.\n");
        let before = std::fs::metadata(folder.join("SKILL.md")).unwrap().modified().unwrap();
        assert_eq!(write(&t.0, &home_dir, &guard, &draft).unwrap(), Some(folder.clone()));
        assert_eq!(std::fs::metadata(folder.join("SKILL.md")).unwrap().modified().unwrap(), before);

        let mut bad = draft.clone();
        bad.entries[0].rune.body = "C:\\Users\\person\\secret".into();
        assert!(write(&t.0, &home_dir, &guard, &bad).unwrap_err().contains("user-profile path"));

        let mut duplicate = draft.clone();
        let mut changed = duplicate.entries[0].rune.clone();
        changed.body = "Different body.\n".into();
        duplicate.push(&changed, &SetRef { library: None, set: "main".into() });
        assert!(write(&t.0, &home_dir, &guard, &duplicate).unwrap_err().contains("different bodies"));
    }

    #[test]
    fn guarded_rune_refusal_names_id_library_set_and_reason() {
        let t = temp("refusal");
        fixture(&t.0);
        let lib = crate::paths::rune_imports_dir_in(&t.0).join("kit");
        put(&lib.join("facts/memory.md"), "---\nname: memory\nkind: fact\nscope: [s]\nactivate: recall\ndescription: Remember this\n---\nThe account path /person/secret must not appear here.\n");
        put(&lib.join("sets/workflow.md"), "---\nname: workflow\nkind: set\nscope: [s]\n---\n<?recall?>\n");
        let config = crate::paths::config_path_in(&t.0);
        let home_dir = t.0.join("home");
        let env = ResolveEnv { root: &t.0, config: &config, home: &home_dir, user_home: None };
        let source = SetRef { library: Some("kit".into()), set: "workflow".into() };
        let (loadout, warnings) = set_loadout::resolve_with_delivery(&env, Agent::Claude, &[source], true);
        assert!(warnings.is_empty(), "{warnings:?}");
        let draft = loadout.recall_skill;
        assert_eq!(draft.entries.len(), 1);
        let guard = home::Guard { user_profile: None, username: Some("person".into()) };
        let error = write(&t.0, &home_dir, &guard, &draft).unwrap_err();
        let (reason, payload) = error.split_once(GUARD_REFUSAL_MARKER).unwrap();
        assert!(reason.contains("holds the account name"), "{reason}");
        let payload: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(payload, serde_json::json!({
            "reason": "Bare rune skill: holds the account name",
            "id": "memory", "library": "kit", "set": "workflow"
        }));
        assert!(!crate::paths::rune_skills_dir_in(&t.0).exists());
    }
}
