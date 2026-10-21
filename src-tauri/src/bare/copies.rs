//! src-tauri\src\bare\copies.rs — the home-wide skills and agents a Claude Bare spawn copies in
//! (docs/runs/2026-10-17-bare-runes-flow plan § Design, fold 4). vidar.json `bareSkills`
//! (`["<abs skill folder>"]`) and `bareAgents` (`["<abs agent .md>"]`), read raw per spawn, are
//! copied to `<CLAUDE_CONFIG_DIR>\skills\<name>\` and `<CLAUDE_CONFIG_DIR>\agents\<name>.md`.
//! - `plan` runs before the home lock: it reads every source and hashes it. A source that is not
//!   absolute, is a link or junction, holds one, sits inside the home, lacks `SKILL.md` (a skill),
//!   is not `.md` (an agent) or is over the cap (400 files, 4 MB) is skipped with a warning.
//! - `sync` runs under the caller's `HomeLock`. The ledger `<home>\layer\copies.json` names what
//!   Vidar placed, with each file's hash. A same-name folder or file the ledger does not hold is
//!   never touched (warning). A placed copy whose hashes match its source is skipped; a placed file
//!   whose bytes drifted from the ledger is skipped (warning), never overwritten. A new folder is
//!   built in a fresh temp sibling, then renamed in; a file goes through `fsx::atomic_write`. A
//!   name dropped from the list loses only the files whose bytes still match the ledger; a folder
//!   is removed only once empty. No write follows a link or junction under the config dir.
//! - A Codex Bare spawn (`plan_codex`/`sync_codex`, run 2026-10-17-bare-runes-flow C1) copies the
//!   same `bareSkills` (plus every Codex Bare row's rune-set skills, `set_layer`: the union is copied so one
//!   row's spawn never deletes another's, while the listing covers only the shared list and the row's own) into `<CODEX_HOME>\skills\<name>\` under the same rules, with its own ledger
//!   `<home>\layer\codex-copies.json`. `bareCodexAgents` (`["<abs role .toml>"]`, checked by
//!   `check_codex_agent`; absent or null is none) copies to `<CODEX_HOME>\agents\<file name>` under the
//!   agent rules above, and each `bareAgents` entry becomes a derived role `<name>.toml` there
//!   (`codex_roles::convert`): no model (inherited from the parent), read-only agents marked and held
//!   by prompt only, and an explicit `bareCodexAgents` file of the same name wins. `listing` turns the installed
//!   SKILL.md files that ledger vouches for into the lines its built instructions end with
//!   (`$name` and description); a skill without a usable name and description is not listed.
//! Copy problems are warnings: they never refuse the spawn.

use std::collections::BTreeMap;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::home::HomeLock;

/// Per skill folder: at most this many files.
pub const MAX_FILES: usize = 400;
/// Per skill folder (all files) or agent file: at most this many bytes.
pub const MAX_BYTES: u64 = 4 * 1024 * 1024;
const REPARSE: u32 = 0x0000_0400;
const LEDGER: &str = "copies.json";
/// A Codex spawn's own ledger: the Claude one is never read or written for Codex.
const CODEX_LEDGER: &str = "codex-copies.json";

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn is_reparse(md: &std::fs::Metadata) -> bool {
    md.file_attributes() & REPARSE != 0 || md.file_type().is_symlink()
}

/// A skill folder read whole: its name and each file (relative path with `\`, bytes, hash).
#[derive(Debug, Clone)]
pub struct SkillCopy {
    pub name: String,
    pub source: String,
    pub files: Vec<(String, Vec<u8>, String)>,
}

impl SkillCopy {
    fn hashes(&self) -> BTreeMap<String, String> {
        self.files.iter().map(|(r, _, h)| (r.clone(), h.clone())).collect()
    }
}

/// An agent file read whole.
#[derive(Debug, Clone)]
pub struct AgentCopy {
    pub name: String,
    pub source: String,
    pub bytes: Vec<u8>,
    pub sha: String,
}

/// What a spawn copies, read and hashed before the lock.
#[derive(Debug, Default)]
pub struct Plan {
    /// Every skill to copy. A Codex plan holds the union (shared plus every Codex Bare row's set skills).
    pub skills: Vec<SkillCopy>,
    /// A Codex plan's listing scope: the lowercased folders the spawning row lists (built-in, shared and
    /// its own set skills). `None` lists every skill in `skills`.
    pub list_only: Option<Vec<String>>,
    pub agents: Vec<AgentCopy>,
    pub warnings: Vec<String>,
}

/// A plain file or folder name a copy may take (no leading dot, no path or reserved characters).
pub(super) fn plain_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control())
}

/// `path` resolves inside `home` (both canonical; a path that does not resolve is not inside).
fn inside(path: &Path, home: Option<&Path>) -> bool {
    let Some(home) = home.and_then(|h| std::fs::canonicalize(h).ok()) else { return false };
    std::fs::canonicalize(path).is_ok_and(|p| p.starts_with(home))
}

/// Reads and checks one `bareSkills` entry. `home` (the Bare home) refuses a source inside it.
pub fn check_skill(path: &str, home: Option<&Path>) -> Result<SkillCopy, String> {
    let src = PathBuf::from(path);
    if !src.is_absolute() {
        return Err(format!("Bare skill {path:?} is not an absolute path"));
    }
    let md = std::fs::symlink_metadata(&src).map_err(|_| format!("Bare skill {path} is missing"))?;
    if is_reparse(&md) {
        return Err(format!("Bare skill {path} is a link or junction"));
    }
    if !md.is_dir() {
        return Err(format!("Bare skill {path} is not a folder"));
    }
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !plain_name(&name) {
        return Err(format!("Bare skill {path} has no plain folder name"));
    }
    if inside(&src, home) {
        return Err(format!("Bare skill {path} sits inside the Bare home"));
    }
    let skill_md = std::fs::symlink_metadata(src.join("SKILL.md"));
    if !skill_md.as_ref().is_ok_and(|m| m.is_file() && !is_reparse(m)) {
        return Err(format!("Bare skill {path} has no SKILL.md"));
    }
    let (mut files, mut total) = (Vec::new(), 0u64);
    let mut stack: Vec<(PathBuf, String)> = vec![(src.clone(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let rd = std::fs::read_dir(&dir).map_err(|e| format!("Bare skill {path}: {} is unreadable ({e})", dir.display()))?;
        for entry in rd {
            let entry = entry.map_err(|e| format!("Bare skill {path}: {e}"))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}\\{name}") };
            let md = std::fs::symlink_metadata(entry.path()).map_err(|e| format!("Bare skill {path}: {child_rel}: {e}"))?;
            if is_reparse(&md) {
                return Err(format!("Bare skill {path} holds a link or junction ({child_rel})"));
            }
            if md.is_dir() {
                stack.push((entry.path(), child_rel));
                continue;
            }
            total += md.len();
            if files.len() + 1 > MAX_FILES || total > MAX_BYTES {
                return Err(format!("Bare skill {path} is over the cap ({MAX_FILES} files, {} MB)", MAX_BYTES / (1024 * 1024)));
            }
            let bytes = std::fs::read(entry.path()).map_err(|e| format!("Bare skill {path}: {child_rel}: {e}"))?;
            let h = sha(&bytes);
            files.push((child_rel, bytes, h));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(SkillCopy { name, source: path.to_string(), files })
}

/// Reads and checks one `bareAgents` entry.
pub fn check_agent(path: &str, home: Option<&Path>) -> Result<AgentCopy, String> {
    let src = PathBuf::from(path);
    if !src.is_absolute() {
        return Err(format!("Bare agent {path:?} is not an absolute path"));
    }
    if !src.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) {
        return Err(format!("Bare agent {path} is not a .md file"));
    }
    let md = std::fs::symlink_metadata(&src).map_err(|_| format!("Bare agent {path} is missing"))?;
    if is_reparse(&md) {
        return Err(format!("Bare agent {path} is a link or junction"));
    }
    if !md.is_file() {
        return Err(format!("Bare agent {path} is not a file"));
    }
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !plain_name(&name) {
        return Err(format!("Bare agent {path} has no plain file name"));
    }
    if inside(&src, home) {
        return Err(format!("Bare agent {path} sits inside the Bare home"));
    }
    if md.len() > MAX_BYTES {
        return Err(format!("Bare agent {path} is over the cap ({} MB)", MAX_BYTES / (1024 * 1024)));
    }
    let bytes = std::fs::read(&src).map_err(|e| format!("Bare agent {path}: {e}"))?;
    let h = sha(&bytes);
    Ok(AgentCopy { name, source: path.to_string(), bytes, sha: h })
}

/// Reads and checks one `bareCodexAgents` entry: an absolute, plain `.toml` file that parses and holds a
/// non-empty `name` and `developer_instructions` (what Codex needs to load a role). The bytes are copied
/// as they are; Vidar never rewrites a role file.
pub fn check_codex_agent(path: &str, home: Option<&Path>) -> Result<AgentCopy, String> {
    let src = PathBuf::from(path);
    if !src.is_absolute() {
        return Err(format!("Bare Codex agent {path:?} is not an absolute path"));
    }
    if !src.extension().is_some_and(|e| e.eq_ignore_ascii_case("toml")) {
        return Err(format!("Bare Codex agent {path} is not a .toml file"));
    }
    let md = std::fs::symlink_metadata(&src).map_err(|_| format!("Bare Codex agent {path} is missing"))?;
    if is_reparse(&md) {
        return Err(format!("Bare Codex agent {path} is a link or junction"));
    }
    if !md.is_file() {
        return Err(format!("Bare Codex agent {path} is not a file"));
    }
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !plain_name(&name) {
        return Err(format!("Bare Codex agent {path} has no plain file name"));
    }
    if inside(&src, home) {
        return Err(format!("Bare Codex agent {path} sits inside the Bare home"));
    }
    if md.len() > MAX_BYTES {
        return Err(format!("Bare Codex agent {path} is over the cap ({} MB)", MAX_BYTES / (1024 * 1024)));
    }
    let bytes = std::fs::read(&src).map_err(|e| format!("Bare Codex agent {path}: {e}"))?;
    let text = std::str::from_utf8(&bytes).map_err(|_| format!("Bare Codex agent {path} is not valid TOML"))?;
    let table: toml::Table = crate::fsx::strip_bom(text).parse().map_err(|_| format!("Bare Codex agent {path} is not valid TOML"))?;
    for key in ["name", "developer_instructions"] {
        if !table.get(key).and_then(|v| v.as_str()).is_some_and(|s| !s.trim().is_empty()) {
            return Err(format!("Bare Codex agent {path} has no `{key}`"));
        }
    }
    let h = sha(&bytes);
    Ok(AgentCopy { name, source: path.to_string(), bytes, sha: h })
}

/// `bareSkills` and `bareAgents` of vidar.json at `config`, raw. A missing file or key is an empty
/// list; anything unreadable is a warning and an empty list.
pub fn lists(config: &Path) -> (Vec<String>, Vec<String>, Vec<String>) {
    let (skills, agents, _, warnings) = lists_of(config, false);
    (skills, agents, warnings)
}

/// `lists`, plus the Claude agents a Codex spawn derives roles from. `codex` reads the skill list from
/// `bareCodexSkills` when that key is present, else `bareSkills`, the agent list from `bareCodexAgents`
/// (absent or null is none) and the derived list from `bareAgents`; otherwise the agent list is
/// `bareAgents` and the derived list is empty.
fn lists_of(config: &Path, codex: bool) -> (Vec<String>, Vec<String>, Vec<String>, Vec<String>) {
    let mut warnings = Vec::new();
    let root: Value = match crate::fsx::read_text(config) {
        Ok(t) => match serde_json::from_str(crate::fsx::strip_bom(&t)) {
            Ok(v) => v,
            Err(e) => {
                warnings.push(format!("vidar.json is unreadable ({e}); skills and agents not copied"));
                Value::Null
            }
        },
        Err(_) => Value::Null,
    };
    let mut list = |key: &str| -> Vec<String> {
        match root.get(key) {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(|v| {
                    let s = v.as_str();
                    if s.is_none() {
                        warnings.push(format!("vidar.json `{key}` holds a non-path entry; skipped"));
                    }
                    s.map(str::to_string)
                })
                .collect(),
            Some(_) => {
                warnings.push(format!("vidar.json `{key}` is not a list of paths; nothing copied for it"));
                Vec::new()
            }
        }
    };
    // A Codex spawn reads `bareCodexSkills` when the key is present (even `[]`), else `bareSkills`.
    let skills_key = if codex && matches!(root.get("bareCodexSkills"), Some(v) if !v.is_null()) { "bareCodexSkills" } else { "bareSkills" };
    let skills = list(skills_key);
    let (agents, derived) = if codex { (list("bareCodexAgents"), list("bareAgents")) } else { (list("bareAgents"), Vec::new()) };
    (skills, agents, derived, warnings)
}

/// Reads and hashes every source `config` names (run before the home lock).
pub fn plan(config: &Path, home: &Path) -> Plan {
    let (skills, agents, warnings) = lists(config);
    plan_from(&skills, &agents, Some(home), warnings)
}

/// A Codex spawn's plan: the built-in skill, then `bareCodexSkills` (else `bareSkills`), read and hashed before the lock.
pub fn plan_codex(config: &Path, home: &Path, row_key: Option<&str>) -> Plan {
    plan_codex_row(config, home, &crate::paths::root(), row_key)
}

/// The keys of the Codex Bare rows in vidar.json that carry `sets` (the admission test of a spawn).
fn codex_set_rows(config: &Path) -> Vec<String> {
    let Some(root) = crate::fsx::read_text(config).ok().and_then(|t| serde_json::from_str::<Value>(crate::fsx::strip_bom(&t)).ok()) else { return Vec::new() };
    let mut keys: Vec<String> = Vec::new();
    for e in root.get("agents").and_then(Value::as_array).into_iter().flatten() {
        let Some(k) = e.get("key").and_then(Value::as_str).map(str::trim).filter(|k| !k.is_empty()) else { continue };
        if e.get("sets").is_some() && !keys.iter().any(|o| o == k) && super::admit_row_key(Some(k.to_string()), Some("bare"), Some(config)).is_ok() {
            keys.push(k.to_string());
        }
    }
    keys
}

/// `plan_codex` with the install root given: `<root>\profiles\bare\codex-skills\vidar-control` goes ahead of the user's
/// list when that folder exists, so a same-name user skill is dropped with the duplicate warning. The
/// `bareCodexAgents` role files come first, then a role derived from each `bareAgents` entry (`derive_roles`).
#[cfg(test)]
pub fn plan_codex_in(config: &Path, home: &Path, root: &Path) -> Plan {
    plan_codex_row(config, home, root, None)
}

/// `plan_codex_in` for the spawn of `row_key`. Copies the UNION of the shared list and every Codex Bare row's
/// set skills (`set_layer`, each set's `codexSkills`/`skills`): `sync_skills` deletes any name dropped from the
/// wanted list, so a per-row copy would let row B's spawn delete row A's skill while A runs. `list_only` scopes
/// the `$name` listing to the built-in, the shared list and `row_key`'s own set skills.
pub fn plan_codex_row(config: &Path, home: &Path, root: &Path, row_key: Option<&str>) -> Plan {
    let (mut skills, agents, derived, mut warnings) = lists_of(config, true);
    let builtin = root.join("profiles").join("bare").join("codex-skills").join("vidar-control");
    if builtin.is_dir() {
        skills.insert(0, builtin.to_string_lossy().into_owned());
    }
    let same = |a: &str, b: &str| a.replace('/', "\\").eq_ignore_ascii_case(&b.replace('/', "\\"));
    let mut listed: Vec<String> = skills.clone();
    let row_key = row_key.map(str::trim).filter(|k| !k.is_empty());
    let user_home = super::set_layer::user_home();
    for key in codex_set_rows(config) {
        let row = match super::layer::row_sets(config, &key) {
            Ok(r) => r,
            Err(e) => {
                warnings.push(e);
                continue;
            }
        };
        let (layer, w) = super::set_layer::row_layer(root, &row, user_home.as_deref());
        for w in w {
            if !warnings.contains(&w) {
                warnings.push(w);
            }
        }
        for p in layer.codex_skills {
            if Some(key.as_str()) == row_key && !listed.iter().any(|o| same(o, &p)) {
                listed.push(p.clone());
            }
            if !skills.iter().any(|o| same(o, &p)) {
                skills.push(p);
            }
        }
    }
    let mut plan = plan_with(&skills, &agents, Some(home), warnings, check_codex_agent);
    plan.list_only = Some(plan.skills.iter().filter(|s| listed.iter().any(|l| same(l, &s.source))).map(|s| s.name.to_lowercase()).collect());
    derive_roles(&mut plan, &derived, Some(home));
    plan
}

/// Each `bareAgents` entry, through `check_agent` and `codex_roles::convert`, joins `plan.agents` as a
/// role file (source the `.md`, bytes and sha the TOML). A role file name already in the plan wins: an
/// explicit `bareCodexAgents` file, or an earlier derived role. Every skip is a warning.
fn derive_roles(plan: &mut Plan, derived: &[String], home: Option<&Path>) {
    let explicit = plan.agents.len();
    for a in derived {
        let src = match check_agent(a, home) {
            Ok(c) => c,
            Err(e) => {
                plan.warnings.push(format!("{e}; no Codex role derived"));
                continue;
            }
        };
        let Ok(text) = std::str::from_utf8(&src.bytes) else {
            plan.warnings.push(format!("Bare agent {a} is not UTF-8 text; no Codex role derived"));
            continue;
        };
        let role = match super::codex_roles::convert(text) {
            Ok(r) => r,
            Err(e) => {
                plan.warnings.push(format!("Bare agent {a} {e}; no Codex role derived"));
                continue;
            }
        };
        if let Some(i) = plan.agents.iter().position(|o| o.name.eq_ignore_ascii_case(&role.file_name)) {
            let by = if i < explicit { "a bareCodexAgents file" } else { "another derived role" };
            plan.warnings.push(format!("Bare agent {a}: derived role {} skipped; {by} takes that name", role.file_name));
            continue;
        }
        let h = sha(&role.bytes);
        plan.agents.push(AgentCopy { name: role.file_name, source: a.clone(), bytes: role.bytes, sha: h });
    }
}

pub fn plan_from(skills: &[String], agents: &[String], home: Option<&Path>, warnings: Vec<String>) -> Plan {
    plan_with(skills, agents, home, warnings, check_agent)
}

type AgentCheck = fn(&str, Option<&Path>) -> Result<AgentCopy, String>;

fn plan_with(skills: &[String], agents: &[String], home: Option<&Path>, mut warnings: Vec<String>, check_agent: AgentCheck) -> Plan {
    let mut out = Plan::default();
    for s in skills {
        match check_skill(s, home) {
            Ok(c) if out.skills.iter().any(|o| o.name.eq_ignore_ascii_case(&c.name)) => {
                warnings.push(format!("Bare skill {s}: another skill named {} comes first; not copied", c.name))
            }
            Ok(c) => out.skills.push(c),
            Err(e) => warnings.push(format!("{e}; not copied")),
        }
    }
    for a in agents {
        match check_agent(a, home) {
            Ok(c) if out.agents.iter().any(|o| o.name.eq_ignore_ascii_case(&c.name)) => {
                warnings.push(format!("Bare agent {a}: another agent named {} comes first; not copied", c.name))
            }
            Ok(c) => out.agents.push(c),
            Err(e) => warnings.push(format!("{e}; not copied")),
        }
    }
    out.warnings = warnings;
    out
}

/// One name Vidar placed: its name as written, the source, and each file's hash (an agent holds
/// one entry, keyed by its file name).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
struct Placed {
    name: String,
    source: String,
    files: BTreeMap<String, String>,
}

/// `<home>\layer\copies.json`, keyed by lowercase name.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
struct Ledger {
    #[serde(default)]
    skills: BTreeMap<String, Placed>,
    #[serde(default)]
    agents: BTreeMap<String, Placed>,
}

fn read_ledger(path: &Path) -> Result<Ledger, String> {
    match crate::fsx::read_text(path) {
        Ok(t) => serde_json::from_str(crate::fsx::strip_bom(&t)).map_err(|e| format!("Bare copies ledger {} is unreadable ({e}); skills and agents not copied", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Ledger::default()),
        Err(e) => Err(format!("Bare copies ledger {} is unreadable ({e}); skills and agents not copied", path.display())),
    }
}

/// `base` joined with `rel`, or `None` when any part from `base` down is a link or junction.
fn plain_target(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut p = base.to_path_buf();
    if std::fs::symlink_metadata(&p).is_ok_and(|m| is_reparse(&m)) {
        return None;
    }
    for part in rel.split('\\').filter(|s| !s.is_empty()) {
        if part == ".." || part == "." {
            return None;
        }
        p = p.join(part);
        if std::fs::symlink_metadata(&p).is_ok_and(|m| is_reparse(&m)) {
            return None;
        }
    }
    Some(p)
}

fn hash_of(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| sha(&b))
}

fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Builds `s` in a fresh temp sibling of `dest`, then renames it in. The temp folder is this
/// call's own, so a failure removes it.
fn place_folder(dir: &Path, dest: &Path, s: &SkillCopy) -> Result<(), String> {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let tmp = dir.join(format!(".{}.vidar-{}-{nanos}", s.name, std::process::id()));
    std::fs::create_dir(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let built = (|| -> Result<(), String> {
        for (rel, bytes, _) in &s.files {
            let target = rel.split('\\').fold(tmp.clone(), |p, part| p.join(part));
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            std::fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))?;
        }
        std::fs::rename(&tmp, dest).map_err(|e| format!("{}: {e}", dest.display()))
    })();
    if built.is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    built
}

/// Removes the empty folders under `dir`, deepest first, then `dir` itself when empty. Never
/// descends a link or junction; `remove_dir` only ever removes an empty folder.
fn prune_empty(dir: &Path) {
    let mut dirs = vec![dir.to_path_buf()];
    let mut i = 0;
    while i < dirs.len() {
        if let Ok(rd) = std::fs::read_dir(&dirs[i]) {
            for e in rd.flatten() {
                if std::fs::symlink_metadata(e.path()).is_ok_and(|m| m.is_dir() && !is_reparse(&m)) {
                    dirs.push(e.path());
                }
            }
        }
        i += 1;
    }
    for d in dirs.iter().rev() {
        let _ = std::fs::remove_dir(d);
    }
}

fn sync_skills(dir: &Path, wanted: &[SkillCopy], ledger: &mut BTreeMap<String, Placed>, warnings: &mut Vec<String>) {
    if wanted.is_empty() && ledger.is_empty() {
        return;
    }
    if std::fs::symlink_metadata(dir).is_ok_and(|m| is_reparse(&m)) {
        warnings.push(format!("Bare skills folder {} is a link or junction; skills not copied", dir.display()));
        return;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        warnings.push(format!("Bare skills folder {}: {e}; skills not copied", dir.display()));
        return;
    }
    for s in wanted {
        let key = s.name.to_lowercase();
        let dest = dir.join(&s.name);
        let fresh = Placed { name: s.name.clone(), source: s.source.clone(), files: s.hashes() };
        let placed = ledger.get(&key).cloned();
        if !exists(&dest) {
            match place_folder(dir, &dest, s) {
                Ok(()) => {
                    ledger.insert(key, fresh);
                }
                Err(e) => warnings.push(format!("Bare skill {} not copied ({e})", s.name)),
            }
            continue;
        }
        let Some(placed) = placed else {
            warnings.push(format!("Bare skill {}: {} was not placed by Vidar; left as it is", s.name, dest.display()));
            continue;
        };
        if placed.files == fresh.files && placed.source == fresh.source {
            continue;
        }
        if plain_target(dir, &s.name).is_none() {
            warnings.push(format!("Bare skill {}: {} is a link or junction; left as it is", s.name, dest.display()));
            ledger.remove(&key);
            continue;
        }
        let mut files = BTreeMap::new();
        for (rel, bytes, h) in &s.files {
            let Some(target) = plain_target(&dest, rel) else {
                warnings.push(format!("Bare skill {}: {rel} sits under a link or junction; skipped", s.name));
                continue;
            };
            match hash_of(&target) {
                Some(cur) if cur == *h => {
                    files.insert(rel.clone(), h.clone());
                }
                Some(cur) if placed.files.get(rel) != Some(&cur) => {
                    warnings.push(format!("Bare skill {}: {rel} changed since Vidar copied it; skipped", s.name));
                }
                _ => {
                    if let Some(parent) = target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    match crate::fsx::atomic_write(&target, bytes) {
                        Ok(()) => {
                            files.insert(rel.clone(), h.clone());
                        }
                        Err(e) => warnings.push(format!("Bare skill {}: {rel} not copied ({e})", s.name)),
                    }
                }
            }
        }
        for (rel, h) in &placed.files {
            if s.files.iter().any(|(r, _, _)| r == rel) {
                continue;
            }
            if let Some(target) = plain_target(&dest, rel) {
                if hash_of(&target).as_ref() == Some(h) {
                    let _ = std::fs::remove_file(&target);
                }
            }
        }
        ledger.insert(key, Placed { files, ..fresh });
    }
    let gone: Vec<String> = ledger.keys().filter(|k| !wanted.iter().any(|s| s.name.to_lowercase() == **k)).cloned().collect();
    for key in gone {
        let Some(placed) = ledger.remove(&key) else { continue };
        let dest = dir.join(&placed.name);
        if !exists(&dest) {
            continue;
        }
        if plain_target(dir, &placed.name).is_none() {
            warnings.push(format!("Bare skill {}: {} is a link or junction; left as it is", placed.name, dest.display()));
            continue;
        }
        for (rel, h) in &placed.files {
            if let Some(target) = plain_target(&dest, rel) {
                if hash_of(&target).as_ref() == Some(h) {
                    let _ = std::fs::remove_file(&target);
                }
            }
        }
        prune_empty(&dest);
        if exists(&dest) {
            warnings.push(format!("Bare skill {}: {} keeps files Vidar did not place; left as they are", placed.name, dest.display()));
        }
    }
}

fn sync_agents(dir: &Path, wanted: &[AgentCopy], ledger: &mut BTreeMap<String, Placed>, warnings: &mut Vec<String>) {
    if wanted.is_empty() && ledger.is_empty() {
        return;
    }
    if std::fs::symlink_metadata(dir).is_ok_and(|m| is_reparse(&m)) {
        warnings.push(format!("Bare agents folder {} is a link or junction; agents not copied", dir.display()));
        return;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        warnings.push(format!("Bare agents folder {}: {e}; agents not copied", dir.display()));
        return;
    }
    for a in wanted {
        let key = a.name.to_lowercase();
        let dest = dir.join(&a.name);
        let fresh = Placed { name: a.name.clone(), source: a.source.clone(), files: BTreeMap::from([(a.name.clone(), a.sha.clone())]) };
        let placed = ledger.get(&key).cloned();
        if exists(&dest) {
            let Some(placed) = placed else {
                warnings.push(format!("Bare agent {}: {} was not placed by Vidar; left as it is", a.name, dest.display()));
                continue;
            };
            if std::fs::symlink_metadata(&dest).is_ok_and(|m| is_reparse(&m) || !m.is_file()) {
                warnings.push(format!("Bare agent {}: {} is not a plain file; left as it is", a.name, dest.display()));
                ledger.remove(&key);
                continue;
            }
            let cur = hash_of(&dest);
            if cur.as_ref() != placed.files.values().next() {
                warnings.push(format!("Bare agent {}: {} changed since Vidar copied it; skipped", a.name, dest.display()));
                ledger.remove(&key);
                continue;
            }
            if placed.files == fresh.files && placed.source == fresh.source {
                continue;
            }
        }
        match crate::fsx::atomic_write(&dest, &a.bytes) {
            Ok(()) => {
                ledger.insert(key, fresh);
            }
            Err(e) => warnings.push(format!("Bare agent {} not copied ({e})", a.name)),
        }
    }
    let gone: Vec<String> = ledger.keys().filter(|k| !wanted.iter().any(|a| a.name.to_lowercase() == **k)).cloned().collect();
    for key in gone {
        let Some(placed) = ledger.remove(&key) else { continue };
        let dest = dir.join(&placed.name);
        if !exists(&dest) {
            continue;
        }
        let plain = std::fs::symlink_metadata(&dest).is_ok_and(|m| m.is_file() && !is_reparse(&m));
        if plain && hash_of(&dest).as_ref() == placed.files.values().next() {
            let _ = std::fs::remove_file(&dest);
        } else {
            warnings.push(format!("Bare agent {}: {} changed since Vidar copied it; left as it is", placed.name, dest.display()));
        }
    }
}

/// Syncs `plan` into `config_dir` (the home's `CLAUDE_CONFIG_DIR`) under the caller's lock and
/// returns the skill folders the ledger holds after it, in `bareSkills` order (the skills the
/// launch carries, which the manifest records; one left unplaced is not named), and the warnings
/// (the plan's first). `config_dir` `None`: nothing is copied.
pub fn sync_named(_lock: &HomeLock, home_dir: &Path, config_dir: Option<&Path>, plan: Plan) -> (Vec<String>, Vec<String>) {
    let Some(config_dir) = config_dir else {
        let mut warnings = plan.warnings;
        if !plan.skills.is_empty() || !plan.agents.is_empty() {
            warnings.push("The Bare profile sets no CLAUDE_CONFIG_DIR; skills and agents not copied".into());
        }
        return (Vec::new(), warnings);
    };
    let order: Vec<String> = plan.skills.iter().map(|s| s.name.clone()).collect();
    let (ledger, warnings) = sync_into(&home_dir.join("layer").join(LEDGER), home_dir, &config_dir.join("skills"), Some(&config_dir.join("agents")), plan);
    let names = order.iter().filter_map(|n| ledger.skills.get(&n.to_lowercase()).map(|p| p.name.clone())).collect();
    (names, warnings)
}

/// One skill a Codex spawn lists in its instructions: the `$name` it is called by and its
/// description, both read from the installed SKILL.md frontmatter (never the folder name).
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub name: String,
    pub description: String,
}

/// Syncs a Codex plan's skills into `<codex_home>\skills` under the caller's lock, with its own
/// ledger `<home>\layer\codex-copies.json` (never the Claude one; the same rules as `sync`).
/// Returns the listing read from the installed copies (`installed_listing`), in `bareSkills`
/// order, and the warnings.
pub fn sync_codex(_lock: &HomeLock, home_dir: &Path, codex_home: &Path, plan: Plan) -> (Vec<Listed>, Vec<String>) {
    let order = listed_order(&plan);
    let skills_dir = codex_home.join("skills");
    let agents_dir = codex_home.join("agents");
    let (ledger, mut warnings) = sync_into(&home_dir.join("layer").join(CODEX_LEDGER), home_dir, &skills_dir, Some(&agents_dir), plan);
    let listed = installed_listing(&skills_dir, &order, &ledger, &mut warnings);
    (listed, warnings)
}

/// The skill folders a plan's listing covers, in plan order: all of them, or the `list_only` scope.
fn listed_order(plan: &Plan) -> Vec<String> {
    plan.skills
        .iter()
        .filter(|s| plan.list_only.as_ref().is_none_or(|l| l.contains(&s.name.to_lowercase())))
        .map(|s| s.name.clone())
        .collect()
}

/// The listing built from the SKILL.md Vidar holds in `skills_dir\<folder>\` after the sync
/// (review d13bc628), never the source: a folder the ledger does not hold is not listed; one whose
/// installed SKILL.md is missing, unreadable, under a link, or differs from the hash the ledger
/// says Vidar placed is omitted with a warning, as is one without a usable name and description.
fn installed_listing(skills_dir: &Path, order: &[String], ledger: &Ledger, warnings: &mut Vec<String>) -> Vec<Listed> {
    let mut out = Vec::new();
    for folder in order {
        let Some(placed) = ledger.skills.get(&folder.to_lowercase()) else { continue };
        let bytes = placed.files.iter().find(|(rel, _)| rel.eq_ignore_ascii_case("SKILL.md")).and_then(|(rel, h)| {
            let target = plain_target(skills_dir, &format!("{}\\{rel}", placed.name))?;
            let bytes = std::fs::read(&target).ok()?;
            (sha(&bytes) == *h).then_some(bytes)
        });
        let Some(bytes) = bytes else {
            warnings.push(format!("Skill {:?}: its installed SKILL.md is missing or not what Vidar placed; not listed", placed.name));
            continue;
        };
        let text = std::str::from_utf8(&bytes).map(|t| t.strip_prefix('\u{feff}').unwrap_or(t)).unwrap_or("");
        match frontmatter(text) {
            (Some(name), Some(description)) if plain_name(&name) && !name.contains(char::is_whitespace) => out.push(Listed { name, description }),
            _ => warnings.push(format!("Skill {:?} has no usable name or description; not listed", placed.name)),
        }
    }
    out
}

/// A SKILL.md frontmatter's `name` and `description`, each `None` when absent, empty or not a
/// value `scalar` accepts; the description may also be a folded `>`/`|` block. No closing `---`
/// is no frontmatter.
fn frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines().map(|l| l.trim_end_matches('\r'));
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let rest: Vec<&str> = lines.collect();
    let Some(end) = rest.iter().position(|l| l.trim() == "---") else { return (None, None) };
    let block = &rest[..end];
    (scalar(block, "name", false), scalar(block, "description", true))
}

/// One frontmatter value joined onto one line: a plain scalar (a trailing ` # comment` stripped),
/// a single-quoted one (`''` decoded), a double-quoted one (only `\"` and `\\` decoded), or, when
/// `block` allows, a folded `>`/`|` block. Anything else, or an empty value, is `None`.
pub(super) fn scalar(lines: &[&str], key: &str, block: bool) -> Option<String> {
    let at = lines.iter().position(|l| l.strip_prefix(key).is_some_and(|r| r.starts_with(':')))?;
    let raw = lines[at][key.len() + 1..].trim();
    // After a closing quote only blanks or a ` # comment` may follow.
    let tail_ok = |t: &str| t.trim().is_empty() || (t.starts_with([' ', '\t']) && t.trim_start().starts_with('#'));
    let value = if let Some(rest) = raw.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = rest.chars();
        loop {
            match chars.next()? {
                '"' => break,
                '\\' => match chars.next()? {
                    c @ ('"' | '\\') => out.push(c),
                    _ => return None,
                },
                c => out.push(c),
            }
        }
        tail_ok(chars.as_str()).then_some(out)?
    } else if let Some(rest) = raw.strip_prefix('\'') {
        let mut out = String::new();
        let mut chars = rest.char_indices().peekable();
        let tail = loop {
            match chars.next()? {
                (_, '\'') if chars.peek().map(|(_, c)| *c) == Some('\'') => {
                    chars.next();
                    out.push('\'');
                }
                (i, '\'') => break &rest[i + 1..],
                (_, c) => out.push(c),
            }
        };
        tail_ok(tail).then_some(out)?
    } else if matches!(raw.chars().next(), Some('>' | '|')) {
        if !block {
            return None;
        }
        let mut parts = Vec::new();
        for l in &lines[at + 1..] {
            if !l.starts_with([' ', '\t']) && !l.trim().is_empty() {
                break;
            }
            parts.push(l.trim());
        }
        parts.join(" ")
    } else {
        let cut = raw.char_indices().find(|&(i, c)| c == '#' && (i == 0 || raw[..i].ends_with([' ', '\t']))).map_or(raw.len(), |(i, _)| i);
        let v = raw[..cut].trim_end();
        let indicator = v.starts_with(['[', ']', '{', '}', ',', '&', '*', '!', '%', '@', '`']) || v.starts_with("- ") || v.starts_with("? ");
        if indicator || v.contains(": ") || v.ends_with(':') {
            return None;
        }
        v.to_string()
    };
    let one = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!one.is_empty()).then_some(one)
}

/// The skills listing a Codex Bare payload ends with (before its marker); empty for no skills.
pub fn listing(skills: &[Listed]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut out = String::from("Skills Vidar copied in (call by $name):\n");
    for s in skills {
        out.push_str(&format!("- ${}: {}\n", s.name, s.description));
    }
    out
}

/// The listing a Codex spawn would carry now, read-only (no lock, no sync, no ledger write): `bareCodexSkills` (else `bareSkills`) in
/// order, each skill listed only when the installed copy still matches the ledger, as after a sync.
pub fn listing_now(config: &Path, home_dir: &Path, codex_home: &Path, row_key: Option<&str>) -> String {
    let order = listed_order(&plan_codex(config, home_dir, row_key));
    let ledger = read_ledger(&home_dir.join("layer").join(CODEX_LEDGER)).unwrap_or_default();
    listing(&installed_listing(&codex_home.join("skills"), &order, &ledger, &mut Vec::new()))
}

/// The shared sync: skills into `skills_dir`, agents into `agents_dir` (none: agents are not
/// copied), the ledger at `ledger_path`. Returns the ledger as left and the warnings.
fn sync_into(ledger_path: &Path, home_dir: &Path, skills_dir: &Path, agents_dir: Option<&Path>, plan: Plan) -> (Ledger, Vec<String>) {
    let mut warnings = plan.warnings;
    let mut ledger = match read_ledger(ledger_path) {
        Ok(l) => l,
        Err(e) => {
            warnings.push(e);
            return (Ledger::default(), warnings);
        }
    };
    let before = ledger.clone();
    sync_skills(skills_dir, &plan.skills, &mut ledger.skills, &mut warnings);
    if let Some(agents_dir) = agents_dir {
        sync_agents(agents_dir, &plan.agents, &mut ledger.agents, &mut warnings);
    }
    if ledger != before {
        let written = std::fs::create_dir_all(ledger_path.parent().unwrap_or(home_dir))
            .map_err(|e| e.to_string())
            .and_then(|_| serde_json::to_string_pretty(&ledger).map_err(|e| e.to_string()))
            .and_then(|json| crate::fsx::atomic_write(ledger_path, json.as_bytes()));
        if let Err(e) = written {
            warnings.push(format!("Bare copies ledger {} not saved ({e})", ledger_path.display()));
        }
    }
    (ledger, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bare::home;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> TempDir {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("vidar-copies-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn junction(link: &Path, target: &Path) {
        std::fs::create_dir_all(target).unwrap();
        let ok = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
        assert!(ok.status.success(), "mklink /J failed");
    }

    /// A source skill `<src>\<name>\` with SKILL.md and a nested file.
    fn skill(src: &Path, name: &str, body: &str) -> String {
        let d = src.join(name);
        std::fs::create_dir_all(d.join("refs")).unwrap();
        std::fs::write(d.join("SKILL.md"), format!("---\nname: {name}\n---\n{body}\n")).unwrap();
        std::fs::write(d.join("refs").join("notes.md"), "notes\n").unwrap();
        d.to_string_lossy().into_owned()
    }

    fn agent(src: &Path, name: &str, body: &str) -> String {
        std::fs::create_dir_all(src.join("agents")).unwrap();
        let p = src.join("agents").join(format!("{name}.md"));
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }

    struct Fx {
        _t: TempDir,
        src: PathBuf,
        home: PathBuf,
        config_dir: PathBuf,
    }

    fn fx(tag: &str) -> Fx {
        let t = TempDir::new(tag);
        let (src, home) = (t.0.join("src"), t.0.join("home"));
        let config_dir = home.join("claude-config");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        Fx { _t: t, src, home, config_dir }
    }

    fn run(f: &Fx, skills: &[String], agents: &[String]) -> Vec<String> {
        let plan = plan_from(skills, agents, Some(&f.home), Vec::new());
        let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();
        sync_named(&lock, &f.home, Some(&f.config_dir), plan).1
    }

    #[test]
    fn sync_names_the_placed_skills_in_order() {
        let f = fx("named");
        let (b, a) = (skill(&f.src, "beta", "B."), skill(&f.src, "alpha", "A."));
        let plan = plan_from(&[b, a], &[], Some(&f.home), Vec::new());
        let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();
        let (names, warnings) = sync_named(&lock, &f.home, Some(&f.config_dir), plan);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(names, vec!["beta".to_string(), "alpha".to_string()]);
        let none = sync_named(&lock, &f.home, None, plan_from(&[], &[], Some(&f.home), Vec::new()));
        assert!(none.0.is_empty());
    }

    #[test]
    fn a_skill_and_an_agent_copy_in_and_a_dropped_one_leaves() {
        let f = fx("roundtrip");
        let (s, a) = (skill(&f.src, "tidy", "Keep it tidy."), agent(&f.src, "reviewer", "Review it."));
        assert!(run(&f, &[s.clone()], &[a.clone()]).is_empty());
        let dest = f.config_dir.join("skills").join("tidy");
        assert_eq!(std::fs::read_to_string(dest.join("refs").join("notes.md")).unwrap(), "notes\n");
        assert_eq!(std::fs::read_to_string(f.config_dir.join("agents").join("reviewer.md")).unwrap(), "Review it.");
        assert!(f.home.join("layer").join(LEDGER).is_file());
        // No temp sibling left behind.
        let names: Vec<String> = std::fs::read_dir(f.config_dir.join("skills")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["tidy".to_string()]);
        // An edited source rewrites the copy.
        std::fs::write(PathBuf::from(&s).join("SKILL.md"), "changed\n").unwrap();
        assert!(run(&f, &[s.clone()], &[a.clone()]).is_empty());
        assert_eq!(std::fs::read_to_string(dest.join("SKILL.md")).unwrap(), "changed\n");
        // Dropped from the lists: the placed copies leave.
        assert!(run(&f, &[], &[]).is_empty());
        assert!(!dest.exists() && !f.config_dir.join("agents").join("reviewer.md").exists());
    }

    #[test]
    fn sync_never_deletes_or_overwrites_what_it_did_not_place() {
        let f = fx("foreign");
        let s = skill(&f.src, "tidy", "Mine.");
        let a = agent(&f.src, "reviewer", "Mine.");
        // Same-name folder and file already in the home, not in the ledger.
        let theirs = f.config_dir.join("skills").join("tidy");
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(theirs.join("SKILL.md"), "theirs").unwrap();
        std::fs::create_dir_all(f.config_dir.join("agents")).unwrap();
        std::fs::write(f.config_dir.join("agents").join("reviewer.md"), "theirs").unwrap();
        let w = run(&f, &[s], &[a]);
        assert_eq!(w.iter().filter(|w| w.contains("was not placed by Vidar")).count(), 2, "{w:?}");
        assert_eq!(std::fs::read_to_string(theirs.join("SKILL.md")).unwrap(), "theirs");
        assert_eq!(std::fs::read_to_string(f.config_dir.join("agents").join("reviewer.md")).unwrap(), "theirs");
        // Dropping them from the lists removes nothing either: the ledger never held them.
        assert!(run(&f, &[], &[]).is_empty());
        assert!(theirs.join("SKILL.md").exists() && f.config_dir.join("agents").join("reviewer.md").exists());
    }

    #[test]
    fn a_drifted_copy_is_skipped_not_overwritten_and_survives_removal() {
        let f = fx("drift");
        let s = skill(&f.src, "tidy", "One.");
        let a = agent(&f.src, "reviewer", "One.");
        assert!(run(&f, &[s.clone()], &[a.clone()]).is_empty());
        let dest = f.config_dir.join("skills").join("tidy");
        std::fs::write(dest.join("SKILL.md"), "hand edit").unwrap();
        std::fs::write(dest.join("extra.md"), "user file").unwrap();
        std::fs::write(f.config_dir.join("agents").join("reviewer.md"), "hand edit").unwrap();
        std::fs::write(PathBuf::from(&s).join("SKILL.md"), "Two.").unwrap();
        std::fs::write(&a, "Two.").unwrap();
        let w = run(&f, &[s], &[a]);
        assert_eq!(w.iter().filter(|w| w.contains("changed since Vidar copied it")).count(), 2, "{w:?}");
        assert_eq!(std::fs::read_to_string(dest.join("SKILL.md")).unwrap(), "hand edit");
        assert_eq!(std::fs::read_to_string(f.config_dir.join("agents").join("reviewer.md")).unwrap(), "hand edit");
        // Dropped: only files still matching the ledger go; the hand edit and the user file stay.
        let w = run(&f, &[], &[]);
        assert!(w.iter().any(|w| w.contains("keeps files Vidar did not place")), "{w:?}");
        assert!(dest.join("SKILL.md").exists() && dest.join("extra.md").exists());
        assert!(!dest.join("refs").exists(), "the untouched placed file and its empty folder go");
    }

    #[test]
    fn an_unchanged_source_is_skipped() {
        let f = fx("skip");
        let s = skill(&f.src, "tidy", "Same.");
        assert!(run(&f, &[s.clone()], &[]).is_empty());
        let ledger = f.home.join("layer").join(LEDGER);
        let stamp = std::fs::metadata(&ledger).unwrap().modified().unwrap();
        let copy = f.config_dir.join("skills").join("tidy").join("SKILL.md");
        let copy_stamp = std::fs::metadata(&copy).unwrap().modified().unwrap();
        assert!(run(&f, &[s], &[]).is_empty());
        assert_eq!(std::fs::metadata(&ledger).unwrap().modified().unwrap(), stamp, "the ledger is not rewritten");
        assert_eq!(std::fs::metadata(&copy).unwrap().modified().unwrap(), copy_stamp, "the copy is not rewritten");
    }

    #[test]
    fn the_validation_table() {
        let f = fx("table");
        let ok = skill(&f.src, "tidy", "Ok.");
        let no_skill_md = f.src.join("bare-folder");
        std::fs::create_dir_all(&no_skill_md).unwrap();
        let big = skill(&f.src, "big", "Big.");
        for i in 0..MAX_FILES {
            std::fs::write(PathBuf::from(&big).join(format!("f{i}.md")), "x").unwrap();
        }
        let heavy = skill(&f.src, "heavy", "Heavy.");
        std::fs::write(PathBuf::from(&heavy).join("blob.bin"), vec![0u8; MAX_BYTES as usize + 1]).unwrap();
        let inner = skill(&f.src, "linked", "Linked.");
        junction(&PathBuf::from(&inner).join("out"), &f.src.join("elsewhere"));
        let whole = f.src.join("whole-link");
        junction(&whole, &PathBuf::from(&ok));
        let in_home = skill(&f.home, "inside", "Inside.");
        let cases: Vec<(String, &str)> = vec![
            (r"skills\tidy".to_string(), "not an absolute path"),
            (f.src.join("nope").to_string_lossy().into_owned(), "is missing"),
            (no_skill_md.to_string_lossy().into_owned(), "has no SKILL.md"),
            (big, "over the cap"),
            (heavy, "over the cap"),
            (inner, "holds a link or junction"),
            (whole.to_string_lossy().into_owned(), "is a link or junction"),
            (in_home, "sits inside the Bare home"),
        ];
        for (path, want) in &cases {
            let e = check_skill(path, Some(&f.home)).unwrap_err();
            assert!(e.contains(want), "{path}: {e}");
        }
        assert!(check_skill(&ok, Some(&f.home)).is_ok());
        let e = check_agent(&f.src.join("x.txt").to_string_lossy(), Some(&f.home)).unwrap_err();
        assert!(e.contains("not a .md file"), "{e}");
        // A refused source is a warning, never a copy.
        let w = run(&f, &cases.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>(), &[]);
        assert_eq!(w.len(), cases.len(), "{w:?}");
        assert!(!f.config_dir.join("skills").exists() || std::fs::read_dir(f.config_dir.join("skills")).unwrap().next().is_none());
    }

    #[test]
    fn a_junction_inside_a_placed_copy_is_never_written_through() {
        let f = fx("through");
        let s = skill(&f.src, "tidy", "One.");
        assert!(run(&f, &[s.clone()], &[]).is_empty());
        let dest = f.config_dir.join("skills").join("tidy");
        let outside = f.src.join("outside");
        std::fs::remove_dir_all(dest.join("refs")).unwrap();
        junction(&dest.join("refs"), &outside);
        std::fs::write(PathBuf::from(&s).join("refs").join("notes.md"), "changed\n").unwrap();
        let w = run(&f, &[s], &[]);
        assert!(w.iter().any(|w| w.contains("under a link or junction")), "{w:?}");
        assert!(!outside.join("notes.md").exists(), "nothing written outside the home");
        let w = run(&f, &[], &[]);
        assert!(w.iter().any(|w| w.contains("keeps files")), "{w:?}");
        assert!(outside.exists());
    }

    #[test]
    fn lists_read_raw_and_a_bad_value_is_a_warning() {
        let f = fx("lists");
        let config = f.src.join("config.json");
        std::fs::write(&config, r#"{ "bareSkills": ["D:\\Work\\skills\\tidy", 3], "bareAgents": "nope" }"#).unwrap();
        let (s, a, w) = lists(&config);
        assert_eq!(s, vec![r"D:\Work\skills\tidy".to_string()]);
        assert!(a.is_empty());
        assert_eq!(w.len(), 2, "{w:?}");
        let (s, a, w) = lists(&f.src.join("missing.json"));
        assert!(s.is_empty() && a.is_empty() && w.is_empty());
        // A Codex plan derives roles from bareAgents, so a bad value warns there too.
        let p = plan_codex_in(&config, &f.home, &f.src);
        assert!(p.agents.is_empty());
        assert!(p.warnings.iter().any(|w| w.contains("`bareAgents` is not a list")), "{:?}", p.warnings);
    }

    #[test]
    fn codex_plan_reads_bare_codex_skills_and_falls_back_to_bare_skills() {
        let f = fx("codexlist");
        let (a, b) = (skill(&f.src, "alpha", "A."), skill(&f.src, "beta", "B."));
        let config = f.src.join("config.json");
        let names = |p: &Plan| p.skills.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        let write = |v: serde_json::Value| std::fs::write(&config, v.to_string()).unwrap();

        // Present list wins over bareSkills.
        write(serde_json::json!({ "bareSkills": [a], "bareCodexSkills": [b] }));
        assert_eq!(names(&plan_codex_in(&config, &f.home, &f.src)), vec!["beta".to_string()]);
        // Present but empty copies nothing.
        write(serde_json::json!({ "bareSkills": [a], "bareCodexSkills": [] }));
        assert!(plan_codex_in(&config, &f.home, &f.src).skills.is_empty());
        // Absent key falls back to bareSkills.
        write(serde_json::json!({ "bareSkills": [a] }));
        assert_eq!(names(&plan_codex_in(&config, &f.home, &f.src)), vec!["alpha".to_string()]);
        // Claude's plan ignores the key.
        write(serde_json::json!({ "bareSkills": [a], "bareCodexSkills": [b] }));
        assert_eq!(names(&plan(&config, &f.home)), vec!["alpha".to_string()]);
        write(serde_json::json!({ "bareCodexSkills": [b] }));
        assert!(plan(&config, &f.home).skills.is_empty());
    }

    #[test]
    fn codex_plan_puts_the_built_in_skill_first_and_drops_a_same_name_user_skill() {
        let f = fx("builtin");
        let root = f.src.join("root");
        skill(&root.join("profiles").join("bare").join("codex-skills"), "vidar-control", "Built in.");
        let other = skill(&f.src, "beta", "B.");
        let dup = skill(&f.src.join("mine"), "vidar-control", "Mine.");
        let config = f.src.join("config.json");
        std::fs::write(&config, serde_json::json!({ "bareCodexSkills": [other, dup] }).to_string()).unwrap();

        let p = plan_codex_in(&config, &f.home, &root);
        let names: Vec<_> = p.skills.iter().map(|s| s.name.clone()).collect();
        assert_eq!(names, vec!["vidar-control".to_string(), "beta".to_string()]);
        assert!(p.skills[0].source.contains("codex-skills"), "{}", p.skills[0].source);
        assert!(p.warnings.iter().any(|w| w.contains("another skill named vidar-control comes first")), "{:?}", p.warnings);

        // An empty user list still leaves the built-in skill.
        std::fs::write(&config, r#"{ "bareCodexSkills": [] }"#).unwrap();
        assert_eq!(plan_codex_in(&config, &f.home, &root).skills.len(), 1);
        // No built-in folder: today's behaviour.
        assert!(plan_codex_in(&config, &f.home, &f.src.join("nowhere")).skills.is_empty());
    }

    fn codex_agent(src: &Path, name: &str, body: &str) -> String {
        std::fs::create_dir_all(src.join("cagents")).unwrap();
        let p = src.join("cagents").join(format!("{name}.toml"));
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }

    const ROLE: &str = "name = \"reviewer\"\ndeveloper_instructions = \"Review it.\"\nmodel = \"gpt-5\"\n";

    #[test]
    fn check_codex_agent_wants_toml_with_a_name_and_instructions() {
        let f = fx("cagentcheck");
        let ok = codex_agent(&f.src, "reviewer", ROLE);
        assert_eq!(check_codex_agent(&ok, Some(&f.home)).unwrap().name, "reviewer.toml");
        let missing = codex_agent(&f.src, "noinstr", "name = \"x\"\n");
        let e = check_codex_agent(&missing, None).unwrap_err();
        assert!(e.contains("developer_instructions"), "{e}");
        let empty = codex_agent(&f.src, "emptyname", "name = \" \"\ndeveloper_instructions = \"x\"\n");
        assert!(check_codex_agent(&empty, None).unwrap_err().contains("`name`"));
        let bad = codex_agent(&f.src, "bad", "this is = = not toml");
        assert!(check_codex_agent(&bad, None).unwrap_err().contains("not valid TOML"));
        let md = agent(&f.src, "claude", "Review it.");
        assert!(check_codex_agent(&md, None).unwrap_err().contains("not a .toml file"));
        assert!(check_codex_agent(&f.src.join("nope.toml").to_string_lossy(), None).unwrap_err().contains("is missing"));
        assert!(check_codex_agent(r"cagents\x.toml", None).unwrap_err().contains("not an absolute path"));
    }

    #[test]
    fn codex_plan_reads_bare_codex_agents_only_when_the_key_is_present() {
        let f = fx("cagentplan");
        let a = codex_agent(&f.src, "reviewer", ROLE);
        // No frontmatter: no role is derived from it (a warning), so only bareCodexAgents shows.
        let claude = agent(&f.src, "claude", "Review it.");
        let config = f.src.join("config.json");
        let names = |p: &Plan| p.agents.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        let write = |v: serde_json::Value| std::fs::write(&config, v.to_string()).unwrap();

        write(serde_json::json!({ "bareCodexAgents": [a], "bareAgents": [claude] }));
        assert_eq!(names(&plan_codex_in(&config, &f.home, &f.src)), vec!["reviewer.toml".to_string()]);
        write(serde_json::json!({ "bareCodexAgents": [] , "bareAgents": [claude] }));
        assert!(plan_codex_in(&config, &f.home, &f.src).agents.is_empty());
        write(serde_json::json!({ "bareCodexAgents": null, "bareAgents": [claude] }));
        assert!(plan_codex_in(&config, &f.home, &f.src).agents.is_empty());
        write(serde_json::json!({ "bareAgents": [claude] }));
        let p = plan_codex_in(&config, &f.home, &f.src);
        assert!(p.agents.is_empty(), "{:?}", names(&p));
        assert!(p.warnings.iter().any(|w| w.contains("has no frontmatter; no Codex role derived")), "{:?}", p.warnings);
        // Claude's plan ignores the key.
        write(serde_json::json!({ "bareCodexAgents": [a] }));
        assert!(plan(&config, &f.home).agents.is_empty());
    }

    const CLAUDE_AGENT: &str = "---\nname: reviewer\ndescription: Reviews a diff.\nmodel: opus\ntools: Read, Grep\n---\nReview the diff.\n";

    #[test]
    fn a_bare_agent_becomes_a_codex_role_in_the_codex_home_and_claude_keeps_the_md() {
        let f = fx("derived");
        let codex_home = f.home.join("codex");
        let md = agent(&f.src, "reviewer", CLAUDE_AGENT);
        let config = f.src.join("config.json");
        std::fs::write(&config, serde_json::json!({ "bareAgents": [md] }).to_string()).unwrap();

        let p = plan_codex_in(&config, &f.home, &f.src);
        assert!(p.warnings.is_empty(), "{:?}", p.warnings);
        assert_eq!(p.agents.len(), 1);
        assert_eq!(p.agents[0].name, "reviewer.toml");
        assert_eq!(p.agents[0].source, md);
        assert_eq!(p.agents[0].sha, sha(&p.agents[0].bytes));
        let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();
        assert!(sync_codex(&lock, &f.home, &codex_home, p).1.is_empty());
        let placed = std::fs::read_to_string(codex_home.join("agents").join("reviewer.toml")).unwrap();
        assert!(super::super::codex_roles::read_only_by_prompt(&placed), "{placed}");
        let t: toml::Table = placed.parse().unwrap();
        assert_eq!(t["name"].as_str(), Some("reviewer"));
        let keys: Vec<&str> = t.keys().map(String::as_str).collect();
        assert_eq!(keys, ["description", "developer_instructions", "name", "nickname_candidates"], "{placed}");
        drop(lock);

        // Claude's plan still copies the .md as it is.
        let c = plan(&config, &f.home);
        assert_eq!(c.agents.len(), 1);
        assert_eq!(c.agents[0].name, "reviewer.md");
        assert_eq!(c.agents[0].bytes, CLAUDE_AGENT.as_bytes());
    }

    #[test]
    fn an_explicit_codex_role_file_wins_over_a_derived_one() {
        let f = fx("derivedclash");
        let explicit = codex_agent(&f.src, "reviewer", ROLE);
        let md = agent(&f.src, "reviewer", CLAUDE_AGENT);
        let other = agent(&f.src.join("again"), "reviewer", CLAUDE_AGENT);
        let config = f.src.join("config.json");
        std::fs::write(&config, serde_json::json!({ "bareCodexAgents": [explicit], "bareAgents": [md] }).to_string()).unwrap();
        let p = plan_codex_in(&config, &f.home, &f.src);
        assert_eq!(p.agents.len(), 1);
        assert_eq!(p.agents[0].bytes, ROLE.as_bytes());
        assert!(p.warnings.iter().any(|w| w.contains("derived role reviewer.toml skipped; a bareCodexAgents file takes that name")), "{:?}", p.warnings);
        // Two derived roles of one name: the first stays.
        std::fs::write(&config, serde_json::json!({ "bareAgents": [md, other] }).to_string()).unwrap();
        let p = plan_codex_in(&config, &f.home, &f.src);
        assert_eq!(p.agents.len(), 1);
        assert_eq!(p.agents[0].source, md);
        assert!(p.warnings.iter().any(|w| w.contains("another derived role takes that name")), "{:?}", p.warnings);
    }

    #[test]
    fn codex_agents_copy_into_the_codex_home_prune_and_keep_a_users_own_file() {
        let f = fx("cagentsync");
        let codex_home = f.home.join("codex");
        let (mine, theirs) = (codex_agent(&f.src, "reviewer", ROLE), codex_agent(&f.src, "planner", ROLE.replace("reviewer", "planner").as_str()));
        std::fs::create_dir_all(codex_home.join("agents")).unwrap();
        std::fs::write(codex_home.join("agents").join("planner.toml"), "user's own").unwrap();
        let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();
        let go = |list: Vec<String>| {
            let plan = plan_with(&[], &list, Some(&f.home), Vec::new(), check_codex_agent);
            sync_codex(&lock, &f.home, &codex_home, plan).1
        };
        let w = go(vec![mine.clone(), theirs.clone()]);
        assert_eq!(w.iter().filter(|w| w.contains("was not placed by Vidar")).count(), 1, "{w:?}");
        assert_eq!(std::fs::read_to_string(codex_home.join("agents").join("reviewer.toml")).unwrap(), ROLE);
        assert_eq!(std::fs::read_to_string(codex_home.join("agents").join("planner.toml")).unwrap(), "user's own");
        let ledger = std::fs::read_to_string(f.home.join("layer").join(CODEX_LEDGER)).unwrap();
        assert!(ledger.contains("reviewer.toml") && !ledger.contains("planner.toml"), "{ledger}");
        // Dropped: the placed copy leaves, the user's file stays.
        assert!(go(vec![]).is_empty());
        assert!(!codex_home.join("agents").join("reviewer.toml").exists());
        assert!(codex_home.join("agents").join("planner.toml").exists());
    }

    #[test]
    fn the_shipped_built_in_skill_checks_and_lists_with_a_short_description() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let dir = root.join("profiles").join("bare").join("codex-skills").join("vidar-control");
        let c = check_skill(&dir.to_string_lossy(), None).unwrap();
        assert_eq!(c.name, "vidar-control");
        let md = c.files.iter().find(|f| f.0 == "SKILL.md").unwrap();
        let (name, desc) = frontmatter(&String::from_utf8_lossy(&md.1));
        assert_eq!(name.as_deref(), Some("vidar-control"));
        let n = desc.expect("description parses").chars().count();
        assert!((1..=160).contains(&n), "{n}");
    }

    #[test]
    fn frontmatter_reads_plain_quoted_and_folded_values() {
        assert_eq!(frontmatter("---\nname: tidy\ndescription: Keep it tidy.\n---\nbody"), (Some("tidy".into()), Some("Keep it tidy.".into())));
        assert_eq!(frontmatter("---\r\nname: \"q\"\r\ndescription: 'Say: hi'\r\n---\r\n"), (Some("q".into()), Some("Say: hi".into())));
        assert_eq!(frontmatter("---\nname: f\ndescription: >\n  One line\n  and more.\nother: x\n---\n"), (Some("f".into()), Some("One line and more.".into())));
        assert_eq!(frontmatter("---\nname: n\n---\n"), (Some("n".into()), None));
        assert_eq!(frontmatter("no frontmatter\ndescription: x\n"), (None, None));
        assert_eq!(frontmatter("---\nname: n\ndescription: x\n"), (None, None), "no closing ---");
        let l = listing(&[Listed { name: "a".into(), description: "A.".into() }, Listed { name: "b".into(), description: "B.".into() }]);
        assert_eq!(l, "Skills Vidar copied in (call by $name):\n- $a: A.\n- $b: B.\n");
        assert_eq!(listing(&[]), "");
    }

    #[test]
    fn frontmatter_strips_comments_decodes_quotes_and_refuses_the_rest() {
        let fm = |body: &str| frontmatter(&format!("---\n{body}\n---\n"));
        assert_eq!(fm("name: tidy # a comment\ndescription: Keep it#tidy. # note"), (Some("tidy".into()), Some("Keep it#tidy.".into())));
        assert_eq!(fm(r#"name: "ti\"dy"
description: "a \\ b" # c"#), (Some("ti\"dy".into()), Some(r"a \ b".into())));
        assert_eq!(fm("name: 'it''s'\ndescription: 'x'"), (Some("it's".into()), Some("x".into())));
        // Other escapes, an unclosed quote, junk after a quote, a block name, YAML indicators.
        assert_eq!(fm(r#"name: "a\nb""#).0, None);
        assert_eq!(fm("name: \"open").0, None);
        assert_eq!(fm("name: \"a\" b").0, None);
        assert_eq!(fm("name: >\n  folded").0, None);
        assert_eq!(fm("name: [a, b]").0, None);
        assert_eq!(fm("description: Use when: always").1, None);
        assert_eq!(fm("name: # only a comment").0, None);
    }

    #[test]
    fn the_listing_reads_the_installed_skill_md_against_the_ledger() {
        let t = TempDir::new("installed");
        let dir = t.0.join("skills");
        std::fs::create_dir_all(dir.join("tidy")).unwrap();
        // Installed bytes differ from any source; the ledger records exactly them: listed from them.
        let installed = "---\nname: tidy-installed\ndescription: From the installed copy.\n---\n";
        std::fs::write(dir.join("tidy").join("SKILL.md"), installed).unwrap();
        let mut ledger = Ledger::default();
        let placed = Placed { name: "tidy".into(), source: r"D:\Work\skills\tidy".into(), files: BTreeMap::from([("SKILL.md".to_string(), sha(installed.as_bytes()))]) };
        ledger.skills.insert("tidy".into(), placed);
        let mut w = Vec::new();
        let l = installed_listing(&dir, &["tidy".to_string(), "absent".to_string()], &ledger, &mut w);
        assert_eq!(l, vec![Listed { name: "tidy-installed".into(), description: "From the installed copy.".into() }]);
        assert!(w.is_empty(), "{w:?}");
        // The ledger holding another hash: omitted with a warning.
        ledger.skills.get_mut("tidy").unwrap().files.insert("SKILL.md".into(), sha(b"other"));
        let l = installed_listing(&dir, &["tidy".to_string()], &ledger, &mut w);
        assert!(l.is_empty());
        assert_eq!(w, vec!["Skill \"tidy\": its installed SKILL.md is missing or not what Vidar placed; not listed".to_string()]);
    }

    #[test]
    fn a_skill_without_usable_metadata_or_a_user_edited_skill_md_is_unlisted() {
        let f = fx("unlisted");
        let codex_home = f.home.join("codex-home");
        let write = |name: &str, md: &str| {
            let d = f.src.join(name);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), md).unwrap();
            d.to_string_lossy().into_owned()
        };
        let good = write("good", "---\nname: good # plain, commented\ndescription: Works.\n---\n");
        let bare = write("bare", "No frontmatter at all.\n");
        let nameless = write("nameless", "---\ndescription: No name.\n---\n");
        let terse = write("terse", "---\nname: terse\n---\n");
        let all = vec![good.clone(), bare, nameless, terse];
        let run_codex = |skills: &[String]| {
            let plan = plan_from(skills, &[], Some(&f.home), Vec::new());
            let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();
            sync_codex(&lock, &f.home, &codex_home, plan)
        };
        let (listed, w) = run_codex(&all);
        assert_eq!(listed, vec![Listed { name: "good".into(), description: "Works.".into() }]);
        for folder in ["bare", "nameless", "terse"] {
            assert!(w.contains(&format!("Skill {folder:?} has no usable name or description; not listed")), "{w:?}");
            assert!(codex_home.join("skills").join(folder).join("SKILL.md").is_file(), "still copied");
        }
        assert_eq!(w.len(), 3, "{w:?}");
        // A user edit to the installed SKILL.md: the sync leaves it, the listing drops it.
        std::fs::write(codex_home.join("skills").join("good").join("SKILL.md"), "---\nname: good\ndescription: Hand edit.\n---\n").unwrap();
        let (listed, w) = run_codex(&[good]);
        assert!(listed.is_empty(), "{listed:?}");
        assert!(w.contains(&"Skill \"good\": its installed SKILL.md is missing or not what Vidar placed; not listed".to_string()), "{w:?}");
    }

    #[test]
    fn a_codex_sync_keeps_its_own_ledger_and_lists_only_what_it_placed() {
        let f = fx("codex");
        let codex_home = f.home.join("codex-home");
        let (tidy, other) = (skill(&f.src, "tidy", "Keep it tidy."), skill(&f.src, "taken", "Theirs."));
        std::fs::write(PathBuf::from(&tidy).join("SKILL.md"), "---\nname: tidy\ndescription: Keep it tidy.\n---\n").unwrap();
        // A same-name folder Vidar did not place: left alone and not listed.
        std::fs::create_dir_all(codex_home.join("skills").join("taken")).unwrap();
        let run_codex = |skills: &[String]| {
            let plan = plan_from(skills, &[], Some(&f.home), Vec::new());
            let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();
            sync_codex(&lock, &f.home, &codex_home, plan)
        };
        let (listed, w) = run_codex(&[tidy.clone(), other.clone()]);
        assert_eq!(listed, vec![Listed { name: "tidy".into(), description: "Keep it tidy.".into() }]);
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(codex_home.join("skills").join("tidy").join("refs").join("notes.md").is_file());
        assert!(f.home.join("layer").join(CODEX_LEDGER).is_file());
        assert!(!f.home.join("layer").join(LEDGER).exists(), "a Codex sync wrote the Claude ledger");
        assert!(!f.config_dir.join("skills").exists(), "a Codex sync wrote the Claude config dir");
        let (listed, _) = run_codex(&[]);
        assert!(listed.is_empty());
        assert!(!codex_home.join("skills").join("tidy").exists());
        assert!(codex_home.join("skills").join("taken").is_dir());
    }

    /// A source skill with a usable name and description (so the listing carries it).
    fn described(src: &Path, name: &str) -> String {
        let d = src.join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), format!("---\nname: {name}\ndescription: Does {name}.\n---\nBody.\n")).unwrap();
        d.to_string_lossy().into_owned()
    }

    /// Two Codex Bare rows (`codex-rendered-bare`, `codex-bare`) with one set each in `<src>\lib`, a shared
    /// skill, and a sidecar per set. Returns the config path.
    fn two_rows(f: &Fx, shared: &str, a: &str, b: &str) -> PathBuf {
        let lib = f.src.join("lib").join("sets");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("set-a.layer.json"), serde_json::json!({ "codexSkills": [a] }).to_string()).unwrap();
        std::fs::write(lib.join("set-b.layer.json"), serde_json::json!({ "skills": [b] }).to_string()).unwrap();
        let config = f.src.join("config.json");
        let row = |key: &str, set: &str| serde_json::json!({ "key": key, "sets": [{ "set": set }] });
        let cfg = serde_json::json!({
            // Absolute, so `root.join` lands here for `listing_now` too (it reads the checkout's root).
            "rulesLibrary": f.src.join("lib"),
            "bareCodexSkills": [shared],
            "agents": [row("codex-rendered-bare", "set-a"), row("codex-bare", "set-b")],
        });
        std::fs::write(&config, cfg.to_string()).unwrap();
        config
    }

    #[test]
    fn a_rows_spawn_keeps_the_other_rows_set_skill_on_disk_and_lists_only_its_own() {
        let f = fx("union");
        let codex_home = f.home.join("codex");
        let (shared, a, b) = (described(&f.src, "shared"), described(&f.src, "only-a"), described(&f.src, "only-b"));
        let config = two_rows(&f, &shared, &a, &b);
        let skills = codex_home.join("skills");
        let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();

        let plan_a = plan_codex_row(&config, &f.home, &f.src, Some("codex-rendered-bare"));
        assert!(plan_a.warnings.is_empty(), "{:?}", plan_a.warnings);
        let (listed_a, w) = sync_codex(&lock, &f.home, &codex_home, plan_a);
        assert!(w.is_empty(), "{w:?}");
        let names = |l: &[Listed]| l.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&listed_a), ["shared", "only-a"], "row A lists shared plus its own");
        assert!(skills.join("only-b").is_dir(), "the union is copied: B's skill is on disk for A's session too");

        // Row B spawns while A runs: A's copy stays.
        let plan_b = plan_codex_row(&config, &f.home, &f.src, Some("codex-bare"));
        let (listed_b, w) = sync_codex(&lock, &f.home, &codex_home, plan_b);
        assert!(w.is_empty(), "{w:?}");
        assert!(skills.join("only-a").join("SKILL.md").is_file(), "B's spawn must not delete A's set skill");
        assert_eq!(names(&listed_b), ["shared", "only-b"], "row B lists shared plus its own, never A's");
        let text = listing(&listed_b);
        assert!(text.contains("$only-b") && text.contains("$shared") && !text.contains("only-a"), "{text}");

        // A row-less plan lists the shared list alone; the read-only listing agrees.
        drop(lock);
        let bare = listing_now(&config, &f.home, &codex_home, None);
        assert!(bare.contains("$shared") && !bare.contains("only-"), "{bare}");
        let a_now = listing_now(&config, &f.home, &codex_home, Some("codex-rendered-bare"));
        assert!(a_now.contains("$only-a") && !a_now.contains("only-b"), "{a_now}");

        // Control: a per-row copy (a plan without A's skill) is exactly what deletes it.
        let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();
        let narrow = plan_from(&[shared.clone(), b.clone()], &[], Some(&f.home), Vec::new());
        sync_codex(&lock, &f.home, &codex_home, narrow);
        assert!(!skills.join("only-a").exists(), "sync deletes a dropped name, which is why the copy is the union");
    }

    #[test]
    fn a_bad_sidecar_path_warns_and_the_plan_still_builds() {
        let f = fx("badsidecar");
        let (shared, a, b) = (described(&f.src, "shared"), described(&f.src, "only-a"), described(&f.src, "only-b"));
        let config = two_rows(&f, &shared, &a, &b);
        std::fs::write(f.src.join("lib").join("sets").join("set-a.layer.json"), serde_json::json!({ "codexSkills": ["relative\\skill", f.src.join("missing"), a] }).to_string()).unwrap();
        let plan = plan_codex_row(&config, &f.home, &f.src, Some("codex-rendered-bare"));
        let w = plan.warnings.join("\n");
        assert!(w.contains("relative") && w.contains("missing"), "{w}");
        let names: Vec<&str> = plan.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["shared", "only-a", "only-b"], "the good entries still copy");
        std::fs::write(f.src.join("lib").join("sets").join("set-a.layer.json"), "{ not json").unwrap();
        let plan = plan_codex_row(&config, &f.home, &f.src, Some("codex-rendered-bare"));
        assert!(plan.warnings.join("\n").contains("not valid JSON"));
        assert_eq!(plan.skills.len(), 2, "shared and B's");
    }
}
