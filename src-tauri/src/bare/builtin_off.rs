//! src-tauri\src\bare\builtin_off.rs — the writers that switch an agent's own skills and plugins off.
//! A `built-in:` rune in the Vidar library stands for one of them; a vault that does not place it
//! leaves it off (`set_loadout::BuiltIns`). The agent spec picks the writer (`Carries.builtin_off`).
//!
//! - Claude (2.1.316, probed 2026-11-02): `skillOverrides[<name>] = "off"` hides one skill,
//!   `disableBundledSkills: true` hides the whole bundled set (and a `skillOverrides` "on" does not bring one
//!   back, so it is true only when no built-in skill is placed), `enabledPlugins["<plugin>@builtin"] = false`
//!   drops a built-in plugin with its skills. The values land in the setting rune's own keys.
//! - Codex writes its bundled skills into CODEX_HOME itself (a fingerprint marker in `.system` restores
//!   them), so the folders are never removed. Each `[[skills.config]]` entry with `name` and
//!   `enabled = false` hides one skill, and `[skills.bundled] enabled = false` stops the install and hides
//!   all. That block is appended to `config.toml` last: every regeneration of the file drops it.

use std::path::Path;

use serde_json::{json, Map, Value};

use super::set_loadout::BuiltIns;

const MARKER: &str = "# Vidar: Codex built-in skills";

/// What a writer adds: top-level settings keys with their values (JSON agents), or a config block
/// appended to the file (TOML agents). Both empty = nothing to write.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct BuiltInWrite {
    pub json: Vec<(&'static str, Value)>,
    pub toml: String,
}

/// Claude's keys. Nothing for a launch without a vault (`managed` false): the setting rune's defaults stand.
pub(crate) fn settings_keys(b: &BuiltIns) -> BuiltInWrite {
    if !b.managed {
        return BuiltInWrite::default();
    }
    let off = |names: &[String], v: Value| Value::Object(names.iter().map(|n| (n.clone(), v.clone())).collect::<Map<_, _>>());
    BuiltInWrite {
        json: vec![
            ("skillOverrides", off(&b.off_skills, json!("off"))),
            ("disableBundledSkills", json!(!b.skills_placed)),
            ("enabledPlugins", off(&b.off_plugins, json!(false))),
        ],
        toml: String::new(),
    }
}

/// Claude's keys ignore repo skills: its project skills are not switched off here.
pub(crate) fn settings_keys_for(b: &BuiltIns, _repo_skills: &[String]) -> BuiltInWrite {
    settings_keys(b)
}

/// The names of the skills in `launch_dir`'s repo folders (`.agents/skills/*/SKILL.md`, the launch
/// folder and each parent up to the git root), deduped and sorted. The name is the frontmatter `name`,
/// else the skill's folder name.
pub(crate) fn repo_skill_names(launch_dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for dir in super::codex_hosted::folders_to_git_root(launch_dir) {
        let Ok(rd) = std::fs::read_dir(dir.join(".agents").join("skills")) else { continue };
        for entry in rd.flatten() {
            let Ok(text) = crate::fsx::read_text(&entry.path().join("SKILL.md")) else { continue };
            let from_folder = entry.file_name().to_string_lossy().into_owned();
            let name = super::copies::frontmatter(crate::fsx::strip_bom(&text)).0.unwrap_or(from_folder);
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names.sort();
    names
}

/// The repo skills `config_block` switches off: not placed by the vault and not already off as a built-in.
pub(crate) fn repo_off(b: &BuiltIns, repo_skills: &[String]) -> Vec<String> {
    if !b.managed {
        return Vec::new();
    }
    // `config_block` writes per-name built-in entries only when some built-in skill is placed.
    let listed: &[String] = if b.skills_placed { &b.off_skills } else { &[] };
    repo_skills.iter().filter(|n| !b.placed_skills.contains(n) && !listed.contains(n)).cloned().collect()
}

/// Codex's config block: empty when unmanaged or every built-in is placed and no repo skill is left to
/// turn off. `repo_skills` are the names found under the launch folder (`repo_skill_names`).
pub(crate) fn config_block(b: &BuiltIns, repo_skills: &[String]) -> BuiltInWrite {
    if !b.managed {
        return BuiltInWrite::default();
    }
    let mut out = String::new();
    if !b.skills_placed {
        out.push_str("[skills.bundled]\nenabled = false\n\n");
    } else {
        for name in &b.off_skills {
            out.push_str(&format!("[[skills.config]]\nname = \"{name}\"\nenabled = false\n\n"));
        }
    }
    for name in repo_off(b, repo_skills) {
        let quoted = serde_json::to_string(&name).unwrap_or_else(|_| "\"\"".into());
        out.push_str(&format!("[[skills.config]]\nname = {quoted}\nenabled = false\n\n"));
    }
    let toml = match out.is_empty() {
        true => out,
        false => format!("{MARKER}\n{}\n", out.trim_end()),
    };
    BuiltInWrite { json: Vec::new(), toml }
}

/// Appends `block` to the Codex `config.toml` (written last). A block from an earlier call is replaced.
pub(crate) fn apply_toml(config: &Path, block: &str, managed: bool) -> Result<(), String> {
    if !managed {
        return Ok(());
    }
    let text = crate::fsx::read_text(config).map_err(|e| format!("Codex config {}: {e}; Bare spawn refused", config.display()))?;
    let text = crate::fsx::strip_bom(&text);
    let base = text.split(MARKER).next().unwrap_or("").trim_end();
    let next = match block.is_empty() {
        true => format!("{base}\n"),
        false => format!("{base}\n\n{block}"),
    };
    if next == text {
        return Ok(());
    }
    crate::fsx::atomic_write(config, next.as_bytes()).map_err(|e| format!("Codex config {}: {e}; Bare spawn refused", config.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(off: &[&str], placed: bool) -> BuiltIns {
        BuiltIns { managed: true, off_skills: off.iter().map(|s| s.to_string()).collect(), off_plugins: vec!["p@builtin".into()], skills_placed: placed, placed_skills: Vec::new() }
    }

    struct Tmp(std::path::PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let p = std::env::temp_dir().join(format!("vidar-repo-skills-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
        fn skill(&self, folder: &str, body: &str) {
            let d = self.0.join(".agents").join("skills").join(folder);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), body).unwrap();
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn skill_md(name: &str) -> String {
        format!("---\nname: {name}\ndescription: d\n---\nbody\n")
    }

    #[test]
    fn a_repo_skill_in_the_launch_folder_is_written_off() {
        let t = Tmp::new("here");
        t.skill("x", &skill_md("x"));
        let names = repo_skill_names(&t.0);
        assert_eq!(names, vec!["x".to_string()]);
        let toml = config_block(&b(&[], true), &names).toml;
        assert!(toml.contains("name = \"x\"\nenabled = false"), "{toml}");
        assert!(toml.starts_with(MARKER), "{toml}");
    }

    #[test]
    fn the_frontmatter_name_beats_the_folder_name() {
        let t = Tmp::new("fm");
        t.skill("folder-name", &skill_md("real-name"));
        t.skill("bare", "no frontmatter\n");
        assert_eq!(repo_skill_names(&t.0), vec!["bare".to_string(), "real-name".to_string()]);
    }

    #[test]
    fn a_placed_repo_skill_name_is_not_written() {
        let t = Tmp::new("placed");
        t.skill("x", &skill_md("x"));
        let mut built = b(&[], true);
        built.placed_skills = vec!["x".into()];
        assert_eq!(config_block(&built, &repo_skill_names(&t.0)).toml, "");
    }

    #[test]
    fn a_subfolder_of_a_git_root_finds_the_roots_skills() {
        let t = Tmp::new("git");
        std::fs::create_dir_all(t.0.join(".git")).unwrap();
        t.skill("y", &skill_md("y"));
        let deep = t.0.join("sub").join("deep");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(repo_skill_names(&deep), vec!["y".to_string()]);
    }

    #[test]
    fn without_a_git_root_a_parents_skills_are_not_found() {
        let t = Tmp::new("nogit");
        t.skill("y", &skill_md("y"));
        let deep = t.0.join("sub");
        std::fs::create_dir_all(&deep).unwrap();
        // Another test's .git above the temp folder would make this walk longer; the temp root holds none.
        assert!(repo_skill_names(&deep).is_empty());
    }

    #[test]
    fn unmanaged_writes_no_repo_skills() {
        let names = vec!["x".to_string()];
        assert_eq!(config_block(&BuiltIns::default(), &names), BuiltInWrite::default());
        assert!(repo_off(&BuiltIns::default(), &names).is_empty());
    }

    #[test]
    fn a_repo_skill_matching_an_off_built_in_is_written_once() {
        let names = vec!["imagegen".to_string(), "x".to_string()];
        let toml = config_block(&b(&["imagegen"], true), &names).toml;
        assert_eq!(toml.matches("name = \"imagegen\"").count(), 1, "{toml}");
        assert_eq!(toml.matches("name = \"x\"").count(), 1, "{toml}");
        assert_eq!(repo_off(&b(&["imagegen"], true), &names), vec!["x".to_string()]);
        let none_placed = config_block(&b(&[], false), &names).toml;
        assert!(none_placed.contains("[skills.bundled]\nenabled = false") && none_placed.contains("name = \"x\""), "{none_placed}");
    }

    #[test]
    fn with_no_built_in_placed_a_same_named_repo_skill_still_gets_its_entry() {
        let names = vec!["skill-creator".to_string()];
        let built = b(&["skill-creator"], false);
        assert_eq!(repo_off(&built, &names), names);
        let toml = config_block(&built, &names).toml;
        assert!(toml.contains("[[skills.config]]\nname = \"skill-creator\"\nenabled = false"), "{toml}");
    }

    #[test]
    fn claude_writes_off_skills_off_plugins_and_the_bundled_flag() {
        let w = settings_keys(&b(&["simplify", "doctor"], false));
        assert_eq!(w.json[0], ("skillOverrides", json!({ "simplify": "off", "doctor": "off" })));
        assert_eq!(w.json[1], ("disableBundledSkills", json!(true)));
        assert_eq!(w.json[2], ("enabledPlugins", json!({ "p@builtin": false })));
        let placed = settings_keys(&b(&["doctor"], true));
        assert_eq!(placed.json[0].1, json!({ "doctor": "off" }));
        assert_eq!(placed.json[1], ("disableBundledSkills", json!(false)));
        assert_eq!(settings_keys(&BuiltIns::default()), BuiltInWrite::default());
    }

    #[test]
    fn codex_off_names_hide_one_each_and_none_placed_turns_bundled_off() {
        let t = config_block(&b(&["openai-docs", "review-agent", "skill-installer"], true), &[]).toml;
        assert!(t.contains("name = \"openai-docs\"") && t.contains("name = \"review-agent\"") && t.contains("name = \"skill-installer\""), "{t}");
        assert!(!t.contains("\"imagegen\"") && !t.contains("\"skill-creator\""), "{t}");
        assert_eq!(t.matches("enabled = false").count(), 3);
        assert_eq!(config_block(&b(&[], true), &[]).toml, "");
        assert!(config_block(&b(&["imagegen"], false), &[]).toml.contains("[skills.bundled]\nenabled = false"));
        assert_eq!(config_block(&BuiltIns::default(), &[]).toml, "");
    }

    #[test]
    fn apply_replaces_its_own_block_and_leaves_the_rest() {
        let dir = std::env::temp_dir().join(format!("vidar-builtin-off-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config.toml");
        std::fs::write(&cfg, "[skills]\ninclude_instructions = false\n").unwrap();
        let off = config_block(&b(&[], false), &[]).toml;
        apply_toml(&cfg, &off, true).unwrap();
        apply_toml(&cfg, &off, true).unwrap();
        let text = std::fs::read_to_string(&cfg).unwrap();
        assert_eq!(text.matches("[skills.bundled]").count(), 1, "{text}");
        assert!(text.starts_with("[skills]\ninclude_instructions = false\n"));
        apply_toml(&cfg, "", true).unwrap();
        assert_eq!(std::fs::read_to_string(&cfg).unwrap(), "[skills]\ninclude_instructions = false\n");
        apply_toml(&dir.join("missing.toml"), "x", false).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
