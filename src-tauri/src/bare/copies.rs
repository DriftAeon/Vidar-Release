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
//! - Per agent home (fold W2 L2b): `plan_for` and `sync_home` take named lists (a launch's loadout,
//!   `set_loadout::resolve`) into one agent home with that home's own ledger `<dir>\.vidar-copies.json`.
//!   A Codex spawn (`sync_codex`) copies the built-in skill and its loadout's skills into
//!   `<CODEX_HOME>\skills\<name>\`; `.toml` role files (checked by `check_codex_agent`) copy to
//!   `<CODEX_HOME>\agents\<file name>`, and each `.md` agent becomes a derived role `<name>.toml` there
//!   (`codex_roles::convert`): no model (inherited from the parent), read-only agents marked and held
//!   by prompt only, and an explicit role file of the same name wins. `listing` turns the installed
//!   SKILL.md files that ledger vouches for into the lines its built instructions end with
//!   (`$name` and description); a skill without a usable name and description is not listed.
//! Copy problems are warnings: they never refuse the spawn.

use std::collections::BTreeMap;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::home::HomeLock;
use super::set_loadout::ResolveEnv;
use crate::falcon::Agent;

/// Per skill folder: at most this many files.
pub const MAX_FILES: usize = 400;
/// Per skill folder (all files) or agent file: at most this many bytes.
pub const MAX_BYTES: u64 = 4 * 1024 * 1024;
const REPARSE: u32 = 0x0000_0400;
const LEDGER: &str = "copies.json";
/// The pre-W2 Codex ledger, `<home>\layer\codex-copies.json`: read once to seed a Codex home's own
/// ledger, never moved or written (plan F6).
const CODEX_LEDGER: &str = "codex-copies.json";
/// A Codex home's own ledger, `<codex_home>\.vidar-copies.json` (one per set-combination home).
const HOME_LEDGER: &str = ".vidar-copies.json";

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
    /// Every skill to copy (a Codex plan: the built-in, then its loadout's skills; all listed).
    pub skills: Vec<SkillCopy>,
    pub agents: Vec<AgentCopy>,
    pub warnings: Vec<String>,
}

impl Plan {
    /// The source paths of the skills and agents this plan takes, for the launch record.
    pub fn item_sources(&self) -> (Vec<String>, Vec<String>) {
        (self.skills.iter().map(|s| s.source.clone()).collect(), self.agents.iter().map(|a| a.source.clone()).collect())
    }
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
/// list; anything unreadable is a warning and an empty list. Test-only since fold W2 L2a: a Claude
/// launch takes its skills and agents from its sets (`plan_for`).
#[cfg(test)]
pub fn lists(config: &Path) -> (Vec<String>, Vec<String>, Vec<String>) {
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
    let skills = list("bareSkills");
    let agents = list("bareAgents");
    (skills, agents, warnings)
}

/// Reads and hashes every source `config` names (run before the home lock).
#[cfg(test)]
pub fn plan(config: &Path, home: &Path) -> Plan {
    let (skills, agents, warnings) = lists(config);
    plan_from(&skills, &agents, Some(home), warnings)
}

/// A Codex launch copies exactly the skill sources resolved from its Rune Vault.
/// The stock vidar-control source is one of those only when its skill rune is present.
pub(crate) fn codex_skills_in(_root: &Path, skills: &[String]) -> Vec<String> {
    skills.to_vec()
}

/// Reads and hashes named skill folders and agent files for one agent's home (run before the home
/// lock; every rule of the module header applies). Claude agents are `.md` files (`check_agent`).
/// Codex agents are `.toml` role files (`check_codex_agent`) taken first, then a role derived from
/// each `.md` agent (`derive_roles`; an explicit role of the same file name wins).
pub(crate) fn plan_for(agent: Agent, skills: &[String], agents: &[String], home: Option<&Path>) -> Plan {
    match agent {
        Agent::Claude => plan_with(skills, agents, home, Vec::new(), check_agent),
        Agent::Codex => {
            let is_md = |a: &&String| Path::new(a.as_str()).extension().is_some_and(|e| e.eq_ignore_ascii_case("md"));
            let (derived, roles): (Vec<String>, Vec<String>) = agents.iter().cloned().partition(|a| is_md(&a));
            let mut plan = plan_with(skills, &roles, home, Vec::new(), check_codex_agent);
            derive_roles(&mut plan, &derived, home);
            plan
        }
    }
}

/// Each `.md` agent, through `check_agent` and `codex_roles::convert`, joins `plan.agents` as a
/// role file (source the `.md`, bytes and sha the TOML). A role file name already in the plan wins: an
/// explicit `.toml` role, or an earlier derived role. Every skip is a warning.
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
            let by = if i < explicit { "a Codex role file" } else { "another derived role" };
            plan.warnings.push(format!("Bare agent {a}: derived role {} skipped; {by} takes that name", role.file_name));
            continue;
        }
        let h = sha(&role.bytes);
        plan.agents.push(AgentCopy { name: role.file_name, source: a.clone(), bytes: role.bytes, sha: h });
    }
}

#[cfg(test)]
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

fn sync_skills(dir: &Path, wanted: &[SkillCopy], ledger: &mut BTreeMap<String, Placed>, warnings: &mut Vec<String>, delete_gone: bool) {
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
    if !delete_gone {
        return;
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

fn sync_agents(dir: &Path, wanted: &[AgentCopy], ledger: &mut BTreeMap<String, Placed>, warnings: &mut Vec<String>, delete_gone: bool) {
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
    if !delete_gone {
        return;
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
/// (the plan's first). `config_dir` `None`: nothing is copied. Test-only since fold W2 L2a (Claude
/// launches sync through `sync_home`); its tests still cover `sync_into`.
#[cfg(test)]
pub fn sync_named(_lock: &HomeLock, home_dir: &Path, config_dir: Option<&Path>, plan: Plan) -> (Vec<String>, Vec<String>) {
    let Some(config_dir) = config_dir else {
        let mut warnings = plan.warnings;
        if !plan.skills.is_empty() || !plan.agents.is_empty() {
            warnings.push("The Bare profile sets no CLAUDE_CONFIG_DIR; skills and agents not copied".into());
        }
        return (Vec::new(), warnings);
    };
    let order: Vec<String> = plan.skills.iter().map(|s| s.name.clone()).collect();
    let (ledger, warnings) = sync_into(&home_dir.join("layer").join(LEDGER), home_dir, &config_dir.join("skills"), Some(&config_dir.join("agents")), plan, true);
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

/// Syncs `plan` into one agent home `dir` (a `CLAUDE_CONFIG_DIR` or a `CODEX_HOME`) under the caller's
/// lock: skills to `<dir>\skills\<name>\`, agents to `<dir>\agents\<file>`, with the home's own ledger
/// `<dir>\.vidar-copies.json`. A home without one first takes the pre-fold ledger's entries it still
/// holds as placed (`<home>\layer\copies.json` for Claude, `codex-copies.json` for Codex; read, never
/// moved or written). `delete_gone` false (the home has a live or unknown owner, plan F2): an item the
/// plan dropped stays on disk and in the ledger until an ownerless spawn. Returns the skill folders the
/// ledger holds after it, in plan order, and the warnings (the plan's first).
pub(crate) fn sync_home(agent: Agent, _lock: &HomeLock, home_dir: &Path, dir: &Path, plan: Plan, delete_gone: bool) -> (Vec<String>, Vec<String>) {
    let order: Vec<String> = plan.skills.iter().map(|s| s.name.clone()).collect();
    let (ledger, warnings) = sync_dir(agent, home_dir, dir, plan, delete_gone);
    (order.iter().filter_map(|n| ledger.skills.get(&n.to_lowercase()).map(|p| p.name.clone())).collect(), warnings)
}

/// `sync_home`'s body: the ledger as left and the warnings.
fn sync_dir(agent: Agent, home_dir: &Path, dir: &Path, plan: Plan, delete_gone: bool) -> (Ledger, Vec<String>) {
    let ledger_path = dir.join(HOME_LEDGER);
    let mut seed_warnings = Vec::new();
    if !exists(&ledger_path) {
        if let Err(e) = seed_home_ledger(agent, home_dir, dir) {
            seed_warnings.push(e);
        }
    }
    let (ledger, mut warnings) = sync_into(&ledger_path, home_dir, &dir.join("skills"), Some(&dir.join("agents")), plan, delete_gone);
    warnings.extend(seed_warnings);
    (ledger, warnings)
}

/// A Codex home's sync (`sync_home`), returning the listing read from the installed copies
/// (`installed_listing`) in plan order instead of the folder names.
pub fn sync_codex(_lock: &HomeLock, home_dir: &Path, codex_home: &Path, plan: Plan, delete_gone: bool) -> (Vec<Listed>, Vec<String>) {
    let order = listed_order(&plan);
    let (ledger, mut warnings) = sync_dir(Agent::Codex, home_dir, codex_home, plan, delete_gone);
    let listed = installed_listing(&codex_home.join("skills"), &order, &ledger, &mut warnings);
    (listed, warnings)
}

/// The agent's pre-fold, home-wide ledger under `<home>\layer\`.
fn legacy_ledger(agent: Agent, home_dir: &Path) -> PathBuf {
    home_dir.join("layer").join(match agent {
        Agent::Claude => LEDGER,
        Agent::Codex => CODEX_LEDGER,
    })
}

/// The pre-fold ledger's entries agent home `dir` still holds as Vidar placed them: a skill whose every
/// recorded file is a plain file with the recorded hash, an agent file likewise. Read-only.
fn home_ledger_from_legacy(agent: Agent, home_dir: &Path, dir: &Path) -> Result<Ledger, String> {
    let old = read_ledger(&legacy_ledger(agent, home_dir))?;
    let skills_dir = dir.join("skills");
    let agents_dir = dir.join("agents");
    let skills = old
        .skills
        .into_iter()
        .filter(|(_, p)| plain_target(&skills_dir, &p.name).is_some_and(|d| d.is_dir()) && p.files.iter().all(|(rel, h)| plain_target(&skills_dir.join(&p.name), rel).and_then(|t| hash_of(&t)).as_ref() == Some(h)))
        .collect();
    let agents = old
        .agents
        .into_iter()
        .filter(|(_, p)| plain_target(&agents_dir, &p.name).and_then(|t| hash_of(&t)).as_ref() == p.files.values().next())
        .collect();
    Ok(Ledger { skills, agents })
}

/// Copies the validated pre-fold entries into `<dir>\.vidar-copies.json` (plan F6); the original
/// stays where it is, untouched. Nothing to keep writes nothing.
fn seed_home_ledger(agent: Agent, home_dir: &Path, dir: &Path) -> Result<(), String> {
    let seeded = home_ledger_from_legacy(agent, home_dir, dir)?;
    if seeded == Ledger::default() {
        return Ok(());
    }
    let path = dir.join(HOME_LEDGER);
    let json = serde_json::to_string_pretty(&seeded).map_err(|e| e.to_string())?;
    crate::fsx::atomic_write(&path, json.as_bytes()).map_err(|e| format!("Bare copies ledger {} not seeded ({e})", path.display()))
}

/// A Codex home's ledger as a spawn would start from it, read-only: its own, else the seed.
fn codex_ledger_now(home_dir: &Path, codex_home: &Path) -> Ledger {
    let own = codex_home.join(HOME_LEDGER);
    match exists(&own) {
        true => read_ledger(&own).unwrap_or_default(),
        false => home_ledger_from_legacy(Agent::Codex, home_dir, codex_home).unwrap_or_default(),
    }
}

/// The skill folders a plan's listing covers: every one, in plan order.
fn listed_order(plan: &Plan) -> Vec<String> {
    plan.skills.iter().map(|s| s.name.clone()).collect()
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

/// The listing a Codex spawn with no runesets would carry now, read-only (no lock, no sync, no ledger
/// write): the built-in skill, then whatever the empty resolve gives for Codex (`set_loadout::resolve`),
/// each listed only when the installed copy still matches the ledger, as after a sync.
pub fn listing_now(config: &Path, home_dir: &Path, codex_home: &Path) -> String {
    let root = crate::paths::root();
    let user_home = super::set_layer::user_home();
    let env = ResolveEnv { root: &root, config, home: home_dir, user_home: user_home.as_deref() };
    let (loadout, _) = super::set_loadout::resolve(&env, Agent::Codex, &[]);
    let order = listed_order(&plan_for(Agent::Codex, &codex_skills_in(&root, &loadout.skills), &[], Some(home_dir)));
    let ledger = codex_ledger_now(home_dir, codex_home);
    listing(&installed_listing(&codex_home.join("skills"), &order, &ledger, &mut Vec::new()))
}

/// The shared sync: skills into `skills_dir`, agents into `agents_dir` (none: agents are not
/// copied), the ledger at `ledger_path`. `delete_gone` false keeps dropped items (see `sync_codex`).
/// Returns the ledger as left and the warnings.
fn sync_into(ledger_path: &Path, home_dir: &Path, skills_dir: &Path, agents_dir: Option<&Path>, plan: Plan, delete_gone: bool) -> (Ledger, Vec<String>) {
    let mut warnings = plan.warnings;
    let mut ledger = match read_ledger(ledger_path) {
        Ok(l) => l,
        Err(e) => {
            warnings.push(e);
            return (Ledger::default(), warnings);
        }
    };
    let before = ledger.clone();
    sync_skills(skills_dir, &plan.skills, &mut ledger.skills, &mut warnings, delete_gone);
    if let Some(agents_dir) = agents_dir {
        sync_agents(agents_dir, &plan.agents, &mut ledger.agents, &mut warnings, delete_gone);
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
    }

    #[test]
    fn claude_plan_ignores_the_codex_keys() {
        let f = fx("codexlist");
        let (a, b) = (skill(&f.src, "alpha", "A."), skill(&f.src, "beta", "B."));
        let config = f.src.join("config.json");
        let names = |p: &Plan| p.skills.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        let write = |v: serde_json::Value| std::fs::write(&config, v.to_string()).unwrap();
        write(serde_json::json!({ "bareSkills": [a], "bareCodexSkills": [b] }));
        assert_eq!(names(&plan(&config, &f.home)), vec!["alpha".to_string()]);
        write(serde_json::json!({ "bareCodexSkills": [b] }));
        assert!(plan(&config, &f.home).skills.is_empty());
    }

    #[test]
    fn codex_plan_copies_only_skill_runes_in_the_vault() {
        let f = fx("builtin");
        let root = f.src.join("root");
        skill(&root.join("profiles").join("bare").join("codex-skills"), "vidar-control", "Built in.");
        let other = skill(&f.src, "beta", "B.");
        let dup = skill(&f.src.join("mine"), "vidar-control", "Mine.");

        let p = plan_for(Agent::Codex, &codex_skills_in(&root, &[other, dup]), &[], Some(&f.home));
        let names: Vec<_> = p.skills.iter().map(|s| s.name.clone()).collect();
        assert_eq!(names, vec!["beta".to_string(), "vidar-control".to_string()]);
        assert!(!p.skills[1].source.contains("codex-skills"), "{}", p.skills[1].source);

        // Merely having the built-in folder on disk never injects it.
        assert!(plan_for(Agent::Codex, &codex_skills_in(&root, &[]), &[], Some(&f.home)).skills.is_empty());
        assert!(codex_skills_in(&f.src.join("nowhere"), &[]).is_empty());
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
    fn codex_plan_takes_role_files_and_derives_from_md_agents() {
        let f = fx("cagentplan");
        let a = codex_agent(&f.src, "reviewer", ROLE);
        // No frontmatter: no role is derived from it (a warning), so only the role file shows.
        let claude = agent(&f.src, "claude", "Review it.");
        let names = |p: &Plan| p.agents.iter().map(|s| s.name.clone()).collect::<Vec<_>>();

        let p = plan_for(Agent::Codex, &[], &[a.clone(), claude.clone()], Some(&f.home));
        assert_eq!(names(&p), vec!["reviewer.toml".to_string()]);
        let p = plan_for(Agent::Codex, &[], &[claude], Some(&f.home));
        assert!(p.agents.is_empty(), "{:?}", names(&p));
        assert!(p.warnings.iter().any(|w| w.contains("has no frontmatter; no Codex role derived")), "{:?}", p.warnings);
        // Claude's plan refuses a role file.
        let p = plan_for(Agent::Claude, &[], &[a], Some(&f.home));
        assert!(p.agents.is_empty() && !p.warnings.is_empty(), "{:?}", p.warnings);
    }

    const CLAUDE_AGENT: &str = "---\nname: reviewer\ndescription: Reviews a diff.\nmodel: opus\ntools: Read, Grep\n---\nReview the diff.\n";

    #[test]
    fn a_bare_agent_becomes_a_codex_role_in_the_codex_home_and_claude_keeps_the_md() {
        let f = fx("derived");
        let codex_home = f.home.join("codex");
        let md = agent(&f.src, "reviewer", CLAUDE_AGENT);
        let config = f.src.join("config.json");
        std::fs::write(&config, serde_json::json!({ "bareAgents": [md] }).to_string()).unwrap();

        let p = plan_for(Agent::Codex, &[], std::slice::from_ref(&md), Some(&f.home));
        assert!(p.warnings.is_empty(), "{:?}", p.warnings);
        assert_eq!(p.agents.len(), 1);
        assert_eq!(p.agents[0].name, "reviewer.toml");
        assert_eq!(p.agents[0].source, md);
        assert_eq!(p.agents[0].sha, sha(&p.agents[0].bytes));
        let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();
        assert!(sync_codex(&lock, &f.home, &codex_home, p, true).1.is_empty());
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
        // The role file wins whatever its place in the list.
        let p = plan_for(Agent::Codex, &[], &[md.clone(), explicit], Some(&f.home));
        assert_eq!(p.agents.len(), 1);
        assert_eq!(p.agents[0].bytes, ROLE.as_bytes());
        assert!(p.warnings.iter().any(|w| w.contains("derived role reviewer.toml skipped; a Codex role file takes that name")), "{:?}", p.warnings);
        // Two derived roles of one name: the first stays.
        let p = plan_for(Agent::Codex, &[], &[md.clone(), other], Some(&f.home));
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
            sync_codex(&lock, &f.home, &codex_home, plan, true).1
        };
        let w = go(vec![mine.clone(), theirs.clone()]);
        assert_eq!(w.iter().filter(|w| w.contains("was not placed by Vidar")).count(), 1, "{w:?}");
        assert_eq!(std::fs::read_to_string(codex_home.join("agents").join("reviewer.toml")).unwrap(), ROLE);
        assert_eq!(std::fs::read_to_string(codex_home.join("agents").join("planner.toml")).unwrap(), "user's own");
        let ledger = std::fs::read_to_string(codex_home.join(HOME_LEDGER)).unwrap();
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
            sync_codex(&lock, &f.home, &codex_home, plan, true)
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
            sync_codex(&lock, &f.home, &codex_home, plan, true)
        };
        let (listed, w) = run_codex(&[tidy.clone(), other.clone()]);
        assert_eq!(listed, vec![Listed { name: "tidy".into(), description: "Keep it tidy.".into() }]);
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(codex_home.join("skills").join("tidy").join("refs").join("notes.md").is_file());
        assert!(codex_home.join(HOME_LEDGER).is_file());
        assert!(!f.home.join("layer").join(CODEX_LEDGER).exists(), "a Codex sync wrote the pre-W2 ledger");
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
        for set in ["set-a", "set-b"] {
            std::fs::write(lib.join(format!("{set}.md")), format!("---\nname: {set}\nkind: set\nscope: [global]\n---\n{set} text.\n")).unwrap();
        }
        std::fs::write(lib.join("set-a.layer.json"), serde_json::json!({ "skills": [a] }).to_string()).unwrap();
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

    /// A Codex plan for the rules-library set `set` through the resolver.
    fn row_plan(config: &Path, f: &Fx, set: &str) -> Plan {
        let sets = [super::super::layer::SetRef { library: None, set: set.to_string() }];
        // The checkout's root for the bundle catalog; the fixture sets carry no rune members.
        let root = crate::paths::root();
        let env = ResolveEnv { root: &root, config, home: &f.home, user_home: None };
        let (loadout, warnings) = super::super::set_loadout::resolve(&env, Agent::Codex, &sets);
        let mut plan = plan_for(Agent::Codex, &codex_skills_in(&f.src, &loadout.skills), &loadout.agents, Some(&f.home));
        plan.warnings.splice(0..0, warnings);
        plan
    }

    #[test]
    fn a_codex_plan_ignores_legacy_sidecar_skills() {
        let f = fx("union");
        let codex_home = f.home.join("codex");
        let (shared, a, b) = (described(&f.src, "shared"), described(&f.src, "only-a"), described(&f.src, "only-b"));
        let config = two_rows(&f, &shared, &a, &b);
        let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();

        // The home-wide `bareCodexSkills` reaches no Codex plan.
        let plan_a = row_plan(&config, &f, "set-a");
        assert!(plan_a.warnings.is_empty(), "{:?}", plan_a.warnings);
        let (listed_a, w) = sync_codex(&lock, &f.home, &codex_home, plan_a, true);
        assert!(w.is_empty(), "{w:?}");
        assert!(listed_a.is_empty());
        assert!(row_plan(&config, &f, "set-b").skills.is_empty());

        // The read-only listing names no set, so it lists none of them.
        drop(lock);
        let bare = listing_now(&config, &f.home, &codex_home);
        assert!(!bare.contains("only-a") && !bare.contains("shared"), "{bare}");
    }

    #[test]
    fn a_live_owned_home_keeps_a_removed_skill_until_ownerless() {
        let f = fx("owned");
        let codex_home = f.home.join("codex-homes").join("abc");
        let (a, b) = (described(&f.src, "keep"), described(&f.src, "drop"));
        let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();
        let go = |skills: &[String], delete_gone: bool| sync_codex(&lock, &f.home, &codex_home, plan_from(skills, &[], Some(&f.home), Vec::new()), delete_gone);
        go(&[a.clone(), b.clone()], true);
        // Owned: the dropped skill stays on disk and in the ledger, and leaves the listing.
        let (listed, w) = go(&[a.clone()], false);
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(listed.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["keep"]);
        assert!(codex_home.join("skills").join("drop").join("SKILL.md").is_file());
        assert!(std::fs::read_to_string(codex_home.join(HOME_LEDGER)).unwrap().contains("\"drop\""));
        // The next ownerless spawn deletes it.
        go(&[a.clone()], true);
        assert!(!codex_home.join("skills").join("drop").exists());
        assert!(codex_home.join("skills").join("keep").is_dir());
    }

    #[test]
    fn the_ledger_is_copied_into_each_home_and_the_original_is_untouched() {
        let f = fx("ledgerseed");
        let legacy = f.home.join("codex-home");
        let (a, b) = (described(&f.src, "one"), described(&f.src, "two"));
        let lock = home::lock(&f.home, home::LOCK_WAIT).unwrap();
        // A pre-W2 home: its skills placed and recorded in `<home>\layer\codex-copies.json`.
        sync_codex(&lock, &f.home, &legacy, plan_from(&[a.clone(), b.clone()], &[], Some(&f.home), Vec::new()), true);
        let own = std::fs::read(legacy.join(HOME_LEDGER)).unwrap();
        std::fs::create_dir_all(f.home.join("layer")).unwrap();
        let original = f.home.join("layer").join(CODEX_LEDGER);
        std::fs::write(&original, &own).unwrap();
        std::fs::remove_file(legacy.join(HOME_LEDGER)).unwrap();
        // One placed copy the user since edited: not carried into the home's ledger.
        std::fs::write(legacy.join("skills").join("two").join("SKILL.md"), "edited").unwrap();
        let before = std::fs::read(&original).unwrap();
        let mtime = std::fs::metadata(&original).unwrap().modified().unwrap();

        let (listed, _) = sync_codex(&lock, &f.home, &legacy, plan_from(&[a.clone()], &[], Some(&f.home), Vec::new()), true);
        assert_eq!(listed.len(), 1);
        let seeded = std::fs::read_to_string(legacy.join(HOME_LEDGER)).unwrap();
        assert!(seeded.contains("\"one\"") && !seeded.contains("\"two\""), "{seeded}");
        assert!(legacy.join("skills").join("two").join("SKILL.md").is_file(), "an unrecorded edited copy was deleted");
        // A new combination home starts from nothing the legacy home placed.
        let combo = f.home.join("codex-homes").join("abc");
        sync_codex(&lock, &f.home, &combo, plan_from(&[a.clone()], &[], Some(&f.home), Vec::new()), true);
        assert!(combo.join("skills").join("one").join("SKILL.md").is_file());
        assert_eq!(std::fs::read(&original).unwrap(), before, "the original ledger changed");
        assert_eq!(std::fs::metadata(&original).unwrap().modified().unwrap(), mtime);
    }

    #[test]
    fn a_bad_legacy_sidecar_path_does_not_enter_the_plan() {
        let f = fx("badsidecar");
        let (shared, a, b) = (described(&f.src, "shared"), described(&f.src, "only-a"), described(&f.src, "only-b"));
        let config = two_rows(&f, &shared, &a, &b);
        std::fs::write(f.src.join("lib").join("sets").join("set-a.layer.json"), serde_json::json!({ "skills": ["relative\\skill", f.src.join("missing"), a] }).to_string()).unwrap();
        let plan = row_plan(&config, &f, "set-a");
        let w = plan.warnings.join("\n");
        assert!(w.is_empty(), "{w}");
        let names: Vec<&str> = plan.skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.is_empty(), "legacy sidecars are never launch inputs");
        let _ = (shared, b);
    }
}
