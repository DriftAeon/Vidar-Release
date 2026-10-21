//! Size and metadata view of the files a Codex tab can load.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use super::{kb_file, skills_in, KbFile, SkillEntry};
use crate::codex_config::{self, CodexConfig, Home};

/// One role file of `<home>\agents`: its `name` (else the file stem), optional `model`, and whether it
/// opens with the read-only marker a role derived from a read-only Claude agent carries
/// (`bare::codex_roles::READ_ONLY_MARKER`; held by prompt, never sandboxed).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAgent {
    name: String,
    model: Option<String>,
    read_only_by_prompt: bool,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoadout {
    home: Option<String>,
    instructions: Vec<KbFile>,
    developer_instructions_chars: Option<usize>,
    skills: Vec<SkillEntry>,
    /// Always serialised, `[]` when none.
    agents: Vec<CodexAgent>,
    model: Option<String>,
    effort: Option<String>,
    sandbox: Option<String>,
    approval: Option<String>,
    reviewer: Option<String>,
    network: Option<bool>,
    notify: Vec<String>,
    rules_files: usize,
    notes: Vec<String>,
}

/// Async on a blocking thread: the walk stats every ancestor of `cwd` and reads skills and rules
/// folders, so a slow or unreachable share must not stall Tauri's main thread (as modules_list).
#[tauri::command]
pub async fn read_codex_loadout(
    app: AppHandle,
    tab: Option<String>,
    profile: Option<String>,
    cwd: String,
) -> Result<CodexLoadout, String> {
    tauri::async_runtime::spawn_blocking(move || read_codex_loadout_now(&app, tab, profile, cwd))
        .await
        .map_err(|e| e.to_string())
}

fn read_codex_loadout_now(app: &AppHandle, tab: Option<String>, profile: Option<String>, cwd: String) -> CodexLoadout {
    let home = match codex_config::home_for(app, tab.as_deref(), profile.as_deref()) {
        Home::Live(path) | Home::Profile(path) | Home::Default(Some(path)) => path,
        Home::NotRunning => {
            return CodexLoadout {
                notes: vec!["No Codex home for this profile".into()],
                ..Default::default()
            };
        }
        Home::Default(None) => {
            return CodexLoadout {
                notes: vec!["No user home found".into()],
                ..Default::default()
            };
        }
    };
    let (config, note) = match codex_config::read(&home) {
        Ok(Some(config)) => (Some(config), None),
        Ok(None) => (None, Some("No Codex config.toml".to_string())),
        Err(error) => (None, Some(error)),
    };
    let mut loadout = build(Some(home), config, Path::new(&cwd));
    if let Some(note) = note {
        loadout.notes.push(note);
    }
    loadout
}

/// Reconstructs Codex's instruction order from files and config. The load rules
/// are inferred here; this command does not observe a running Codex process.
fn build(home: Option<PathBuf>, cfg: Option<CodexConfig>, cwd: &Path) -> CodexLoadout {
    let Some(home) = home else {
        return CodexLoadout::default();
    };
    let mut out = CodexLoadout {
        home: Some(home.display().to_string()),
        ..Default::default()
    };

    if let Some(file) = instruction_in(&home) {
        out.instructions.push(file);
    }

    let max_bytes = cfg
        .as_ref()
        .and_then(|c| c.project_doc_max_bytes)
        .unwrap_or(32_768);
    // An empty or relative cwd would resolve against Vidar's own directory.
    let has_project = cwd.is_absolute();
    if has_project && max_bytes > 0 {
        let markers = cfg
            .as_ref()
            .and_then(|c| c.project_root_markers.as_ref())
            .cloned()
            .unwrap_or_else(|| vec![".git".into()]);
        let root = if markers.is_empty() {
            cwd
        } else {
            cwd.ancestors()
                .find(|dir| markers.iter().any(|marker| dir.join(marker).exists()))
                .unwrap_or(cwd)
        };
        let mut chain = Vec::new();
        for dir in cwd.ancestors() {
            chain.push(dir);
            if dir == root {
                break;
            }
        }
        chain.reverse();
        let mut bytes = 0_u64;
        for dir in chain {
            if let Some(path) = instruction_path(dir) {
                if let Some(file) = kb_file(&path, false) {
                    bytes = bytes.saturating_add(fs::metadata(&path).map(|m| m.len()).unwrap_or(0));
                    out.instructions.push(file);
                    if bytes >= max_bytes {
                        break;
                    }
                }
            }
        }
    }

    skills_in(&home.join("skills"), &mut out.skills);
    skills_in(&home.join("skills").join(".system"), &mut out.skills);
    if has_project {
        skills_in(&cwd.join(".agents").join("skills"), &mut out.skills);
    }
    agents_in(&home.join("agents"), &mut out.agents);
    out.rules_files = fs::read_dir(home.join("rules"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry.path().extension().and_then(|ext| ext.to_str()) == Some("rules")
                        && entry.path().is_file()
                })
                .count()
        })
        .unwrap_or(0);

    if let Some(cfg) = cfg {
        out.developer_instructions_chars = cfg.developer_instructions_len;
        out.model = cfg.model;
        out.effort = cfg.effort;
        out.sandbox = cfg.sandbox_mode;
        out.approval = cfg.approval_policy;
        out.reviewer = cfg.approvals_reviewer;
        out.network = cfg.network_access;
        out.notify = cfg.notify;
    }
    out
}

/// The `*.toml` role files of `dir`, sorted by name. A file that does not parse lists its stem with no
/// model; a parsed one without a usable `name` falls back to the stem too.
fn agents_in(dir: &Path, out: &mut Vec<CodexAgent>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()).is_none_or(|ext| !ext.eq_ignore_ascii_case("toml")) {
            continue;
        }
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let text = crate::fsx::read_text_capped(&path, 1 << 20).ok();
        let read_only_by_prompt = text.as_deref().is_some_and(crate::bare::codex_roles::read_only_by_prompt);
        let table = text.and_then(|text| crate::fsx::strip_bom(&text).parse::<toml::Table>().ok());
        let field = |key: &str| {
            table.as_ref().and_then(|t| t.get(key)).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
        };
        found.push(CodexAgent { name: field("name").unwrap_or(stem), model: field("model"), read_only_by_prompt });
    }
    found.sort_by_key(|a| a.name.to_lowercase());
    out.extend(found);
}

fn instruction_path(dir: &Path) -> Option<PathBuf> {
    let override_path = dir.join("AGENTS.override.md");
    if override_path.exists() {
        return Some(override_path);
    }
    let ordinary_path = dir.join("AGENTS.md");
    ordinary_path.exists().then_some(ordinary_path)
}

fn instruction_in(dir: &Path) -> Option<KbFile> {
    instruction_path(dir).and_then(|path| kb_file(&path, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("vidar-codex-loadout-{}-{id}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self, path: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn names(loadout: &CodexLoadout) -> Vec<String> {
        loadout
            .instructions
            .iter()
            .map(|file| {
                Path::new(&file.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }

    #[test]
    fn override_wins_in_home_and_project() {
        let fixture = Fixture::new();
        let home = fixture.0.join("home");
        let cwd = fixture.0.join("project");
        fixture.file("home/AGENTS.md", b"ordinary");
        fixture.file("home/AGENTS.override.md", b"override");
        fixture.file("project/.git", b"");
        fixture.file("project/AGENTS.md", b"ordinary");
        fixture.file("project/AGENTS.override.md", b"override");
        assert_eq!(
            names(&build(Some(home), None, &cwd)),
            ["AGENTS.override.md", "AGENTS.override.md"]
        );
    }

    #[test]
    fn chain_starts_at_nearest_git_root_and_runs_to_cwd() {
        let fixture = Fixture::new();
        let home = fixture.0.join("home");
        let cwd = fixture.0.join("outer/project/deep/leaf");
        fixture.file("outer/AGENTS.md", b"outside");
        fixture.file("outer/project/.git", b"");
        fixture.file("outer/project/AGENTS.md", b"root");
        fixture.file("outer/project/deep/AGENTS.override.md", b"middle");
        fixture.file("outer/project/deep/leaf/AGENTS.md", b"leaf");
        let paths: Vec<_> = build(Some(home), None, &cwd)
            .instructions
            .into_iter()
            .map(|f| PathBuf::from(f.path))
            .collect();
        assert_eq!(
            paths,
            [
                fixture.0.join("outer/project/AGENTS.md"),
                fixture.0.join("outer/project/deep/AGENTS.override.md"),
                fixture.0.join("outer/project/deep/leaf/AGENTS.md"),
            ]
        );
    }

    #[test]
    fn agents_come_from_the_home_only_named_sorted_and_tolerant() {
        let fixture = Fixture::new();
        let home = fixture.0.join("home");
        let cwd = fixture.0.join("project");
        fixture.file("home/agents/zed.toml", b"name = \"Zed\"\ndeveloper_instructions = \"x\"\nmodel = \"gpt-5\"\n");
        fixture.file("home/agents/alpha.toml", b"name = \"alpha\"\ndeveloper_instructions = \"x\"\n");
        fixture.file("home/agents/unnamed.toml", b"developer_instructions = \"x\"\n");
        fixture.file("home/agents/broken.toml", b"this = = not toml");
        fixture.file("home/agents/readme.md", b"skipped");
        fixture.file("project/.git", b"");
        fixture.file("project/.codex/agents/projectonly.toml", b"name = \"projectonly\"\n");
        let agent = |name: &str, model: Option<&str>| CodexAgent { name: name.into(), model: model.map(str::to_string), read_only_by_prompt: false };
        assert_eq!(
            build(Some(home.clone()), None, &cwd).agents,
            vec![agent("alpha", None), agent("broken", None), agent("unnamed", None), agent("Zed", Some("gpt-5"))]
        );
        // No folder: an empty list, always serialised.
        let bare = build(Some(fixture.0.join("elsewhere")), None, &cwd);
        assert!(bare.agents.is_empty());
        assert_eq!(serde_json::to_value(&bare).unwrap()["agents"], serde_json::json!([]));
    }

    #[test]
    fn a_role_opening_with_the_marker_is_read_only_by_prompt() {
        let fixture = Fixture::new();
        let home = fixture.0.join("home");
        let marked = format!("\u{feff}{}\nname = \"orion\"\ndescription = \"d\"\ndeveloper_instructions = \"x\"\n", crate::bare::codex_roles::READ_ONLY_MARKER);
        fixture.file("home/agents/orion.toml", marked.as_bytes());
        fixture.file("home/agents/late.toml", b"name = \"late\"\n# Vidar: read-only by prompt\ndeveloper_instructions = \"x\"\n");
        let agents = build(Some(home), None, &fixture.0.join("project")).agents;
        assert_eq!(agents.iter().map(|a| (a.name.as_str(), a.read_only_by_prompt)).collect::<Vec<_>>(), vec![("late", false), ("orion", true)]);
        let json = serde_json::to_value(&agents[1]).unwrap();
        assert_eq!(json, serde_json::json!({ "name": "orion", "model": null, "readOnlyByPrompt": true }));
    }

    #[test]
    fn zero_cap_keeps_only_home_layer() {
        let fixture = Fixture::new();
        fixture.file("home/AGENTS.md", b"home");
        fixture.file("project/.git", b"");
        fixture.file("project/AGENTS.md", b"project");
        let cfg = CodexConfig {
            project_doc_max_bytes: Some(0),
            ..Default::default()
        };
        assert_eq!(
            names(&build(
                Some(fixture.0.join("home")),
                Some(cfg),
                &fixture.0.join("project")
            )),
            ["AGENTS.md"]
        );
    }

    #[test]
    fn crossing_file_is_listed_then_chain_stops() {
        let fixture = Fixture::new();
        fixture.file("project/.git", b"");
        fixture.file("project/AGENTS.md", b"1234");
        fixture.file("project/deep/AGENTS.md", b"1234");
        fixture.file("project/deep/leaf/AGENTS.md", b"1234");
        let cfg = CodexConfig {
            project_doc_max_bytes: Some(5),
            ..Default::default()
        };
        let out = build(
            Some(fixture.0.join("home")),
            Some(cfg),
            &fixture.0.join("project/deep/leaf"),
        );
        assert_eq!(out.instructions.len(), 2);
        assert!(
            out.instructions[1].path.ends_with("deep\\AGENTS.md")
                || out.instructions[1].path.ends_with("deep/AGENTS.md")
        );
    }

    #[test]
    fn total_landing_exactly_on_the_cap_stops_the_chain() {
        let fixture = Fixture::new();
        fixture.file("project/.git", b"");
        fixture.file("project/AGENTS.md", b"1234");
        fixture.file("project/deep/AGENTS.md", b"1234");
        fixture.file("project/deep/leaf/AGENTS.md", b"1234");
        let cfg = CodexConfig {
            project_doc_max_bytes: Some(8),
            ..Default::default()
        };
        let out = build(
            Some(fixture.0.join("home")),
            Some(cfg),
            &fixture.0.join("project/deep/leaf"),
        );
        assert_eq!(out.instructions.len(), 2);
    }

    #[test]
    fn empty_cwd_skips_project_chain_and_skills() {
        let fixture = Fixture::new();
        fixture.file("home/AGENTS.md", b"home");
        let out = build(Some(fixture.0.join("home")), None, Path::new(""));
        assert_eq!(names(&out), ["AGENTS.md"]);
        assert!(out.skills.is_empty());
        assert!(out.notes.is_empty());
    }

    #[test]
    fn relative_cwd_does_not_resolve_against_the_process_directory() {
        let fixture = Fixture::new();
        // Tests run in src-tauri, so ".." is the repo root, which has an AGENTS.md.
        let out = build(Some(fixture.0.join("home")), None, Path::new(".."));
        assert!(out.instructions.is_empty());
        assert!(out.skills.is_empty());
        assert!(out.notes.is_empty());
    }

    #[test]
    fn explicit_empty_markers_restrict_to_cwd() {
        let fixture = Fixture::new();
        fixture.file("project/AGENTS.md", b"root");
        fixture.file("project/deep/AGENTS.md", b"cwd");
        let cfg = CodexConfig {
            project_root_markers: Some(vec![]),
            ..Default::default()
        };
        let out = build(
            Some(fixture.0.join("home")),
            Some(cfg),
            &fixture.0.join("project/deep"),
        );
        assert_eq!(out.instructions.len(), 1);
        assert!(
            out.instructions[0].path.ends_with("deep\\AGENTS.md")
                || out.instructions[0].path.ends_with("deep/AGENTS.md")
        );
    }

    #[test]
    fn skills_and_rules_use_only_the_requested_directories() {
        let fixture = Fixture::new();
        fixture.file(
            "home/skills/one/SKILL.md",
            b"---\ndescription: Home skill\n---\n",
        );
        fixture.file(
            "home/skills/.system/two/SKILL.md",
            b"---\ndescription: System skill\n---\n",
        );
        fixture.file(
            "project/.agents/skills/three/SKILL.md",
            b"---\ndescription: Project skill\n---\n",
        );
        fixture.file("home/rules/first.rules", b"");
        fixture.file("home/rules/second.rules", b"");
        fixture.file("home/rules/not-a-rule.txt", b"");
        let out = build(
            Some(fixture.0.join("home")),
            None,
            &fixture.0.join("project"),
        );
        assert_eq!(
            out.skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            ["one", "two", "three"]
        );
        assert_eq!(out.rules_files, 2);
    }

    #[test]
    fn serialized_contract_has_exact_keys() {
        let fixture = Fixture::new();
        let value =
            serde_json::to_value(build(Some(fixture.0.join("home")), None, &fixture.0)).unwrap();
        let mut keys: Vec<_> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "agents",
                "approval",
                "developerInstructionsChars",
                "effort",
                "home",
                "instructions",
                "model",
                "network",
                "notes",
                "notify",
                "reviewer",
                "rulesFiles",
                "sandbox",
                "skills"
            ]
        );
    }
}
