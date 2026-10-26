// Loadout: "what this tab starts with" — computed from Claude Code's documented
// config-load rules, NOT observed. Vidar never opens the session's own process,
// so this reproduces the rule (home CLAUDE.md, ancestor CLAUDE.md chain, rules
// dir, memory/handoff slugs, skills, agents, hooks, permissions) against the
// files on disk. Optional inputs (instructions, memory, handoffs, skills,
// agents, the home settings file) are silently skipped when absent — that's
// normal, not a failure. Only a missing caller-supplied settings path or a
// settings file that fails to parse produces a note.
//
// Field shapes here mirror the loadout pin sheet's row list one-to-one.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

pub mod codex;

// home()/claude_dir() are one Option-returning pair in paths.rs
// (the status.rs registry_dir() pattern). No home directory means every
// home-rooted lookup below is skipped, not joined onto an empty PathBuf —
// that used to resolve to a path relative to Vidar's own cwd, which could
// silently pick up an unrelated file of the same name.
// The tab's launch profile picks the dir (bare/claude_dir.rs): None = the user's own; a Bare
// tab reads the config dir its session runs on (`home_of_session`, one combination home).
fn claude_dir(profile: Option<&str>, tab: Option<&str>, session: Option<&str>, row: Option<&str>) -> Option<PathBuf> {
    crate::bare::claude_dir::home_of_session(profile, tab, session, row)
}

fn kb(len: u64) -> f64 {
    ((len as f64 / 1024.0) * 10.0).round() / 10.0
}

fn kb_of(path: &Path) -> Option<f64> {
    fs::metadata(path).ok().map(|m| kb(m.len()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFile {
    pub(super) path: String,
    pub(super) kb: f64,
    /// true for a rules file (`.claude/rules/*.md`) whose frontmatter carries
    /// a `paths:` key, so it only loads when a matching file is touched —
    /// false for anything that loads unconditionally at session start
    pub(super) on_touch: bool,
}

pub(super) fn kb_file(path: &Path, on_touch: bool) -> Option<KbFile> {
    kb_of(path).map(|kb| KbFile { path: path.display().to_string(), kb, on_touch })
}

// Loadout row 1 (Launch) is built client-side and never waits on read_loadout;
// this is a separate, lazy command so row 1 can fetch role-file size on expand
// without adding a param to read_loadout's signature. Size-only, no content
// read — same trust boundary as every other invoke this module makes.
#[tauri::command]
pub fn file_kb(path: String) -> Option<f64> {
    kb_of(Path::new(&path))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub(super) name: String,
    pub(super) description: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEntry {
    name: String,
    model: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsHooks {
    path: String,
    /// (event name, script basenames) — Vec not a map, so event order in the
    /// file survives into the row
    events: Vec<(String, Vec<String>)>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPermissions {
    path: String,
    allow: usize,
    deny: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loadout {
    /// home CLAUDE.md, then each ancestor CLAUDE.md root-to-cwd, then
    /// `<cwd>/.claude/rules/*.md` — only entries that exist
    instructions: Vec<KbFile>,
    memory_path: String,
    memory_entries: usize,
    handoff_path: String,
    handoff_newest: Option<String>,
    skills: Vec<SkillEntry>,
    agents: Vec<AgentEntry>,
    hooks: Vec<SettingsHooks>,
    permissions: Vec<SettingsPermissions>,
    notes: Vec<String>,
}

// mirrors status.rs::project_slug (memory) — kept local: pulling it in as a
// shared helper would touch status.rs, out of this brief's one-file scope
fn memory_slug(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

// handoffs collapse a run of non-alnum separators into one '-' (":\" -> one
// dash), where memory maps each character 1:1 (":\" -> two dashes) — the two
// slugs are deliberately different strings for the same cwd (plan §1 row 3)
fn handoff_slug(cwd: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in cwd.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    out
}

fn instructions_chain(cwd: &str, home: Option<&Path>) -> Vec<KbFile> {
    let mut out = Vec::new();

    if let Some(dir) = home {
        if let Some(f) = kb_file(&dir.join("CLAUDE.md"), false) {
            out.push(f);
        }
    }

    let cwd_path = PathBuf::from(cwd);
    // ancestors() walks leaf-to-root; reverse so the chain reads root-to-cwd
    let mut ancestors: Vec<PathBuf> = cwd_path.ancestors().map(Path::to_path_buf).collect();
    ancestors.reverse();
    for dir in &ancestors {
        if let Some(f) = kb_file(&dir.join("CLAUDE.md"), false) {
            out.push(f);
        }
    }

    let rules_dir = cwd_path.join(".claude").join("rules");
    match fs::read_dir(&rules_dir) {
        Ok(rd) => {
            let mut files: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
                .collect();
            files.sort();
            for f in files {
                // a rules file with a `paths:` frontmatter key only loads
                // when a matching file is touched;
                // one without it loads unconditionally like the CLAUDE.md chain
                let on_touch = fs::read_to_string(&f)
                    .map(|t| t.trim_start().starts_with("---") && frontmatter_field(&t, "paths").is_some())
                    .unwrap_or(false);
                if let Some(kf) = kb_file(&f, on_touch) {
                    out.push(kf);
                }
            }
        }
        Err(_) => {} // no rules dir is normal, not a note — most projects have none
    }

    out
}

fn memory_and_handoff(cwd: &str, home: Option<&Path>) -> (String, usize, String, Option<String>) {
    let Some(dir) = home else {
        // No home directory: nothing to look up rather than a path relative
        // to Vidar's own cwd.
        return (String::new(), 0, String::new(), None);
    };
    let mem_path = dir.join("projects").join(memory_slug(cwd)).join("memory").join("MEMORY.md");
    let mem_entries = match fs::read_to_string(&mem_path) {
        Ok(text) => text.lines().filter(|l| l.trim_start().starts_with("- [")).count(),
        Err(_) => 0, // no memory file yet is the common case, not a note
    };

    let handoff_dir = dir.join("handoffs").join(handoff_slug(cwd));
    let newest = match fs::read_dir(&handoff_dir) {
        Ok(rd) => {
            let mut files: Vec<(PathBuf, std::time::SystemTime)> = rd
                .flatten()
                .filter_map(|e| {
                    let md = e.metadata().ok()?;
                    if !md.is_file() {
                        return None;
                    }
                    Some((e.path(), md.modified().ok()?))
                })
                .collect();
            files.sort_by(|a, b| b.1.cmp(&a.1));
            files.first().map(|(p, _)| p.display().to_string())
        }
        Err(_) => None,
    };
    (mem_path.display().to_string(), mem_entries, handoff_dir.display().to_string(), newest)
}

// frontmatter is `---\nkey: value\n...\n---`; only the two keys this module
// needs are pulled, line by line — a full YAML parse is not worth a new
// dependency for two scalar fields
pub(super) fn frontmatter_field(text: &str, key: &str) -> Option<String> {
    let mut in_fm = false;
    for line in text.lines() {
        if line.trim() == "---" {
            if in_fm {
                break;
            }
            in_fm = true;
            continue;
        }
        if !in_fm {
            continue;
        }
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(rest) = rest.trim_start().strip_prefix(':') {
                return Some(rest.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('\u{2026}');
    out
}

pub(super) fn skills_in(dir: &Path, out: &mut Vec<SkillEntry>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let skill_dir = entry.path();
        if !skill_dir.is_dir() {
            continue;
        }
        let Some(name) = skill_dir.file_name().and_then(|n| n.to_str()) else { continue };
        let Ok(text) = fs::read_to_string(skill_dir.join("SKILL.md")) else { continue };
        let description = frontmatter_field(&text, "description").unwrap_or_default();
        out.push(SkillEntry { name: name.to_string(), description: truncate(&description, 90) });
    }
}

fn agents_in(dir: &Path, out: &mut Vec<AgentEntry>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let name = frontmatter_field(&text, "name").unwrap_or_else(|| {
            path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string()
        });
        let model = frontmatter_field(&text, "model").unwrap_or_default();
        out.push(AgentEntry { name, model });
    }
}

const SCRIPT_EXT: &[&str] = &[".mjs", ".cjs", ".js", ".ps1", ".py"];

// commands are shell one-liners (`node "...\hooks\x.mjs"`, `pwsh.exe ... -File
// "...\x.ps1" -Session`) — every quoted segment that looks like a script path
// is kept, in order, so a hook with more than one script still shows all of them
fn script_basenames(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (i, part) in command.split('"').enumerate() {
        if i % 2 != 1 {
            continue; // even segments sit outside quotes
        }
        let trimmed = part.trim();
        if let Some(name) = Path::new(trimmed).file_name().and_then(|f| f.to_str()) {
            if SCRIPT_EXT.iter().any(|ext| name.ends_with(ext)) {
                out.push(name.to_string());
            }
        }
    }
    out
}

fn hooks_from(root: &Value) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    let Some(obj) = root.get("hooks").and_then(Value::as_object) else { return out };
    for (event, matchers) in obj {
        let mut scripts = Vec::new();
        if let Some(arr) = matchers.as_array() {
            for m in arr {
                let Some(hook_list) = m.get("hooks").and_then(Value::as_array) else { continue };
                for h in hook_list {
                    if let Some(cmd) = h.get("command").and_then(Value::as_str) {
                        scripts.extend(script_basenames(cmd));
                    }
                }
            }
        }
        out.push((event.clone(), scripts));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn permissions_from(root: &Value) -> (usize, Vec<String>) {
    let Some(perms) = root.get("permissions") else { return (0, Vec::new()) };
    let allow = perms.get("allow").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    let deny = perms
        .get("deny")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    (allow, deny)
}

/// Async on a blocking thread: the walk stats every ancestor of `cwd` and reads skills, memory and
/// instruction files, so a slow or unreachable share must not stall Tauri's main thread (as
/// read_codex_loadout).
#[tauri::command]
pub async fn read_loadout(
    app: tauri::AppHandle,
    cwd: String,
    settings_paths: Vec<String>,
    plugin_dir: Option<String>,
    profile: Option<String>,
    tab: Option<String>,
    row: Option<String>,
) -> Result<Loadout, String> {
    let session = crate::bare::claude_dir::hosted_session_of(&app, tab.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        let home = claude_dir(profile.as_deref(), tab.as_deref(), session.as_deref(), row.as_deref());
        read_loadout_now(cwd, settings_paths, plugin_dir, home)
    })
    .await
    .map_err(|e| e.to_string())
}

fn read_loadout_now(cwd: String, settings_paths: Vec<String>, plugin_dir: Option<String>, home_dir: Option<PathBuf>) -> Loadout {
    let mut notes = Vec::new();

    let instructions = instructions_chain(&cwd, home_dir.as_deref());
    let (memory_path, memory_entries, handoff_path, handoff_newest) = memory_and_handoff(&cwd, home_dir.as_deref());

    let mut skills = Vec::new();
    if let Some(dir) = &home_dir {
        skills_in(&dir.join("skills"), &mut skills);
    }
    if let Some(pd) = &plugin_dir {
        skills_in(&PathBuf::from(pd).join("skills"), &mut skills);
    }

    let mut agents = Vec::new();
    if let Some(dir) = &home_dir {
        agents_in(&dir.join("agents"), &mut agents);
    }

    // the home settings.json is a fixed default the caller doesn't need to know
    // the path of (TS has no home-dir lookup); it's prepended here unless the
    // caller already passed it, so it never appears twice. No home directory
    // means no such default to prepend.
    let home_settings = home_dir.map(|dir| dir.join("settings.json").display().to_string());
    let mut all_paths = home_settings.clone().into_iter().collect::<Vec<_>>();
    for p in &settings_paths {
        if !all_paths.iter().any(|existing| existing.eq_ignore_ascii_case(p)) {
            all_paths.push(p.clone());
        }
    }

    let mut hooks = Vec::new();
    let mut permissions = Vec::new();
    for path in &all_paths {
        let text = match fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                // every settings file here is optional (a project without
                // .claude\settings.json is normal): absence is silent, only a
                // file that exists but can't be read gets a note
                if e.kind() != std::io::ErrorKind::NotFound {
                    notes.push(format!("{path}: {e}"));
                }
                continue;
            }
        };
        let root: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                notes.push(format!("{path}: {e}"));
                continue;
            }
        };
        hooks.push(SettingsHooks { path: path.clone(), events: hooks_from(&root) });
        let (allow, deny) = permissions_from(&root);
        permissions.push(SettingsPermissions { path: path.clone(), allow, deny });
    }

    Loadout {
        instructions,
        memory_path,
        memory_entries,
        handoff_path,
        handoff_newest,
        skills,
        agents,
        hooks,
        permissions,
        notes,
    }
}
