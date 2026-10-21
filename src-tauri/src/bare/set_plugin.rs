//! src-tauri\src\bare\set_plugin.rs — one Claude plugin per rune set of a Bare row (run 2026-10-20-rune-sets, W2).
//! A set's sidecar (`set_layer`) attaches skills, agents and guards. Each of the row's distinct set refs with
//! any of the three becomes a plugin folder `<home>\layer\plugins\<set>-<hash12>\`:
//! `.claude-plugin\plugin.json` (`name` = the set, so items surface as `<set>:<item>`), `skills\<folder>\`,
//! `agents\<file>.md`, `scripts\<guard file>` and `hooks\hooks.json`, whose commands run the copied scripts
//! through `${CLAUDE_PLUGIN_ROOT}` (the wiring `guards::copy` gives `bareGuards`: one group per guard, the
//! same event and matcher, `node "<script>" ...`). Claude Code has no shim for `open` guards, so a guard's
//! `open` files are dropped with a warning. The hash is over every file's relative path and bytes, so
//! identical inputs name the same folder and it is not rewritten; a new folder is staged beside it and renamed
//! in. Two refs of one set name get `-2`, `-3`... on the later plugin name. Nothing here refuses a spawn: a
//! bad path, a failed copy or an unreadable folder is a warning and the item (or plugin) is skipped.
//! Old plugin folders are never pruned: `layer\payload-<hash12>.md` files are not either, and a live tab
//! of another row may still be loading one. The caller passes `dirs` to `claude --plugin-dir` and adds
//! `guard_files` to the `carried` set that filters `enforced-by` rune claims.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::guards::{self, BareGuard};
use super::home::HomeLock;
use super::layer::{self, RowSets};
use super::set_layer;
use crate::rules::build;

/// One built set plugin.
#[derive(Debug, Clone, PartialEq)]
pub struct SetPlugin {
    /// plugin.json `name`: the set (suffixed when a set name repeats in the row).
    pub name: String,
    pub dir: PathBuf,
    /// False when the folder already held these inputs and was left as it was.
    pub created: bool,
}

/// What a row's sets built.
#[derive(Debug, Default)]
pub struct SetPlugins {
    pub plugins: Vec<SetPlugin>,
    /// Guard script file names the plugins carry (sorted, deduped), for the `carried` set.
    pub guard_files: Vec<String>,
    pub warnings: Vec<String>,
}

impl SetPlugins {
    /// The folders for `--plugin-dir`, in ref order.
    pub fn dirs(&self) -> Vec<PathBuf> {
        self.plugins.iter().map(|p| p.dir.clone()).collect()
    }
}

/// A plugin's files in memory: relative path (forward slashes) and bytes.
type Files = Vec<(String, Vec<u8>)>;

/// Builds the plugins for `row` (`None` = no sets = none). Takes the caller's `HomeLock` (not reentrant, so
/// this never locks). `root` and `user_home` resolve library folders and `~` as `set_layer::row_layer` does.
pub fn build(_lock: &HomeLock, root: &Path, home_dir: &Path, row: Option<&RowSets>, user_home: Option<&Path>) -> SetPlugins {
    let mut out = SetPlugins::default();
    let Some(row) = row else { return out };
    let mut done: Vec<&layer::SetRef> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for r in &row.sets {
        if done.contains(&r) {
            continue;
        }
        done.push(r);
        let dir = match layer::library_dir(root, row, r) {
            Ok(d) => d,
            Err(e) => {
                out.warnings.push(format!("Set {:?}: plugin not built ({e})", r.set));
                continue;
            }
        };
        let (l, w) = set_layer::read_set(&dir, &r.set, user_home);
        out.warnings.extend(w);
        let mut warnings = Vec::new();
        let Some((mut files, guard_files)) = collect(&l, &mut warnings) else {
            out.warnings.extend(warnings);
            continue;
        };
        out.warnings.extend(warnings.into_iter().map(|w| format!("Set {:?}: {w}", r.set)));
        let name = unique_name(&r.set, &names);
        names.push(name.clone());
        files.push((".claude-plugin/plugin.json".into(), plugin_json(&name, &r.set).into_bytes()));
        files.sort_by(|a, b| a.0.cmp(&b.0));
        let hash = build::hash12(&hash_input(&files));
        let dest = home_dir.join("layer").join("plugins").join(format!("{}-{hash}", dir_safe(&name)));
        match write_once(&dest, &files) {
            Ok(created) => {
                out.plugins.push(SetPlugin { name, dir: dest, created });
                out.guard_files.extend(guard_files);
            }
            Err(e) => out.warnings.push(format!("Set {:?}: plugin {} not written ({e}); skipped", r.set, dest.display())),
        }
    }
    out.guard_files.sort();
    out.guard_files.dedup();
    out
}

/// The set name as a plugin name: the first free of `<set>`, `<set>-2`, `<set>-3`...
fn unique_name(set: &str, taken: &[String]) -> String {
    let mut name = set.to_string();
    let mut n = 2;
    while taken.iter().any(|t| t.eq_ignore_ascii_case(&name)) {
        name = format!("{set}-{n}");
        n += 1;
    }
    name
}

/// A folder-name-safe form of a plugin name.
fn dir_safe(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' }).collect()
}

fn plugin_json(name: &str, set: &str) -> String {
    let v = json!({ "name": name, "description": format!("Vidar rune set {set}: skills, agents and guards attached to it.") });
    serde_json::to_string_pretty(&v).unwrap_or_default() + "\n"
}

/// The bytes the folder hash covers: each file's path, length and content, in path order.
fn hash_input(files: &Files) -> Vec<u8> {
    let mut buf = Vec::new();
    for (path, bytes) in files {
        buf.extend_from_slice(format!("{path}\0{}\0", bytes.len()).as_bytes());
        buf.extend_from_slice(bytes);
        buf.push(0);
    }
    buf
}

/// Writes `files` to `dest` unless it exists: staged in a sibling folder and renamed in, so a folder named
/// by its hash is always whole. Returns whether it was created.
fn write_once(dest: &Path, files: &Files) -> Result<bool, String> {
    if dest.join(".claude-plugin").join("plugin.json").is_file() {
        return Ok(false);
    }
    let parent = dest.parent().ok_or("no parent folder")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stage = parent.join(format!(".stage-{}-{}", std::process::id(), dest.file_name().unwrap_or_default().to_string_lossy()));
    let _ = std::fs::remove_dir_all(&stage);
    let staged = (|| -> Result<(), String> {
        for (rel, bytes) in files {
            let p = stage.join(rel);
            std::fs::create_dir_all(p.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
            std::fs::write(&p, bytes).map_err(|e| format!("{rel}: {e}"))?;
        }
        Ok(())
    })();
    if let Err(e) = staged {
        let _ = std::fs::remove_dir_all(&stage);
        return Err(e);
    }
    if dest.exists() {
        // An earlier crash left a folder without plugin.json: replace it.
        let _ = std::fs::remove_dir_all(dest);
    }
    match std::fs::rename(&stage, dest) {
        Ok(()) => Ok(true),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&stage);
            // A concurrent spawn may have renamed the same content in first.
            if dest.join(".claude-plugin").join("plugin.json").is_file() { Ok(false) } else { Err(e.to_string()) }
        }
    }
}

/// Reads every attachment of `l` into plugin files (without plugin.json); `None` when nothing usable is left.
/// The second value is the guard script file names.
fn collect(l: &set_layer::SetLayer, warnings: &mut Vec<String>) -> Option<(Files, Vec<String>)> {
    let mut files: Files = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for s in &l.skills {
        let src = Path::new(s);
        let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !src.join("SKILL.md").is_file() {
            warnings.push(format!("skill {s} has no SKILL.md; skipped"));
            continue;
        }
        if seen.iter().any(|n| n.eq_ignore_ascii_case(&format!("skills/{name}"))) {
            warnings.push(format!("skill {s} repeats the name {name}; skipped"));
            continue;
        }
        seen.push(format!("skills/{name}"));
        if let Err(e) = read_tree(src, &format!("skills/{name}"), &mut files) {
            warnings.push(format!("skill {s} unreadable ({e}); skipped"));
            files.retain(|(p, _)| !p.starts_with(&format!("skills/{name}/")));
        }
    }
    for a in &l.agents {
        let src = Path::new(a);
        let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !src.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) || !src.is_file() {
            warnings.push(format!("agent {a} is not an existing .md file; skipped"));
            continue;
        }
        if seen.iter().any(|n| n.eq_ignore_ascii_case(&format!("agents/{name}"))) {
            warnings.push(format!("agent {a} repeats the name {name}; skipped"));
            continue;
        }
        match std::fs::read(src) {
            Ok(b) => {
                seen.push(format!("agents/{name}"));
                files.push((format!("agents/{name}"), b));
            }
            Err(e) => warnings.push(format!("agent {a} unreadable ({e}); skipped")),
        }
    }
    let (hooks, scripts) = guard_hooks(&l.guards, &mut files, warnings);
    if !hooks.as_object().is_some_and(|o| o.is_empty()) {
        let text = serde_json::to_string_pretty(&json!({ "hooks": hooks })).unwrap_or_default() + "\n";
        files.push(("hooks/hooks.json".into(), text.into_bytes()));
    }
    if files.is_empty() {
        return None;
    }
    Some((files, scripts))
}

/// Every file under `dir` into `files` as `<prefix>/<relative path>`; symlinks and junctions are not followed.
fn read_tree(dir: &Path, prefix: &str, files: &mut Files) -> Result<(), String> {
    let mut entries: Vec<_> = std::fs::read_dir(dir).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let ft = e.file_type().map_err(|e| e.to_string())?;
        let rel = format!("{prefix}/{name}");
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            read_tree(&e.path(), &rel, files)?;
        } else if ft.is_file() {
            files.push((rel, std::fs::read(e.path()).map_err(|e| e.to_string())?));
        }
    }
    Ok(())
}

/// The hooks object (`{ event: [group] }`) for the valid guards, their scripts pushed into `files` under
/// `scripts/`; the script file names. A guard failing `guards::validate` (alone or beside the accepted ones)
/// is dropped with a warning.
fn guard_hooks(raw: &[Value], files: &mut Files, warnings: &mut Vec<String>) -> (Value, Vec<String>) {
    let mut hooks = serde_json::Map::new();
    let mut accepted: Vec<BareGuard> = Vec::new();
    for g in raw {
        if g.get("open").and_then(Value::as_array).is_some_and(|o| !o.is_empty()) {
            warnings.push(format!("guard for {} has `open` files, which Claude Code has no shim for; they were dropped", g["event"].as_str().unwrap_or("?")));
        }
        let mut plain = g.clone();
        if let Some(o) = plain.as_object_mut() {
            o.remove("open");
        }
        let guard: BareGuard = match serde_json::from_value(plain) {
            Ok(b) => b,
            Err(e) => {
                warnings.push(format!("guard {g} is not an event, matcher? and run list ({e}); skipped"));
                continue;
            }
        };
        let mut trial = accepted.clone();
        trial.push(guard.clone());
        if let Err(e) = guards::validate(&trial) {
            warnings.push(format!("guard for {}: {e}; skipped", guard.event));
            continue;
        }
        accepted.push(guard);
    }
    let mut scripts: Vec<String> = Vec::new();
    for g in &accepted {
        let mut cmd = Vec::new();
        for f in &g.run {
            let name = Path::new(f).file_name().unwrap_or_default().to_string_lossy().into_owned();
            if !scripts.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                match std::fs::read(f) {
                    Ok(b) => {
                        files.push((format!("scripts/{name}"), b));
                        scripts.push(name.clone());
                    }
                    Err(e) => {
                        warnings.push(format!("guard script {f} unreadable ({e}); guard for {} skipped", g.event));
                        cmd.clear();
                        break;
                    }
                }
            }
            cmd.push(format!("\"${{CLAUDE_PLUGIN_ROOT}}/scripts/{name}\""));
        }
        if cmd.is_empty() {
            continue;
        }
        let mut group = json!({ "hooks": [{ "type": "command", "command": format!("node {}", cmd.join(" ")) }] });
        if let Some(m) = &g.matcher {
            group["matcher"] = json!(m);
        }
        hooks.entry(g.event.clone()).or_insert_with(|| json!([])).as_array_mut().map(|a| a.push(group));
    }
    scripts.sort();
    (Value::Object(hooks), scripts)
}
