//! src-tauri\src\rules\generate\home.rs — the generator homes: where the rune generator's
//! agent runs, holding the login and nothing else. `<Bare home>\gen-claude\` and `gen-codex\` sit inside this
//! install's agent home (`bare::home::resolve`, `%LOCALAPPDATA%\Vidar\homes\<install key>`), so the private ACL of
//! `homes\` covers them. A run clears the folder once (`build_run`: `skill.md`, `merge-skill.md`) and gives each
//! agent call its own `calls\<name>\{config, user-home, work}` (`call`), removed together at the end (`remove_calls`):
//! - `config\` is `CLAUDE_CONFIG_DIR` / `CODEX_HOME`: Claude gets `.credentials.json` and `settings.json` (`{}`),
//!   Codex `auth.json` and a `config.toml` with no `developer_instructions` (not `generate_codex_config`, which
//!   carries the static payload). The credential is a hard link to the run's login source (copy when the link
//!   fails), which W0 proved works and leaves the source unchanged: the newer of the shared store's file and the
//!   Bare home's own (`login_back::source`). A missing login is `login:`. After each call `hand_back` puts a login
//!   the CLI refreshed by rename back over the source (`login_back::write_back`), before `remove_calls` drops it.
//! - `user-home\AppData\{Roaming,Local\Temp}` are the folders the env overlay (`USERPROFILE`, `APPDATA`, `TEMP`...)
//!   points at, as `tools/bare/probe-generate.ps1` `Overlay-For` makes them.
//! - `work\` is the call's fresh empty cwd; the run's `skill.md` (Claude) is the `--system-prompt-file` copy.
//! `assert_clean` runs immediately before the spawn: Codex loads an `AGENTS.md` from `CODEX_HOME` or the cwd whatever
//! flags it gets (W0), so neither agent's instruction file may exist in the config dir or the cwd.

use std::path::{Path, PathBuf};

use crate::agent_spec::{parse, spec, Agent, ALL};

pub const CONFIG: &str = "config";
pub const USER_HOME: &str = "user-home";
pub const WORK: &str = "work";
pub const SKILL_COPY: &str = "skill.md";
pub const MERGE_SKILL_COPY: &str = "merge-skill.md";
/// The folder under `gen-<agent>` that holds one home per call.
pub const CALLS: &str = "calls";
/// Instruction files an agent loads without being asked.
/// Codex also loads this one in place of its `AGENTS.md`.
const OVERRIDE_FILE: &str = "AGENTS.override.md";

/// Every instruction file any agent loads without being asked: each `AgentSpec` `instructions_file` and the override.
pub fn instruction_files() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = ALL.iter().map(|a| spec(*a).instructions_file).collect();
    names.push(OVERRIDE_FILE);
    names
}

/// How the generator home got its login.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placed {
    Link,
    Copy,
}

/// One call's generator home.
#[derive(Debug)]
pub struct GenHome {
    pub agent: Agent,
    /// `<Bare home>\gen-<agent>`.
    pub dir: PathBuf,
    /// `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.
    pub config: PathBuf,
    /// The empty working folder of this call.
    pub cwd: PathBuf,
    /// The skill copy Claude reads (`None` for Codex, which takes it on stdin).
    pub skill: Option<PathBuf>,
    pub placed: Placed,
}

/// The folder name under the Bare home.
pub fn dir_name(agent: &str) -> Result<&'static str, String> {
    agent_of(agent).map(|a| spec(a).gen_dir)
}

/// The one parse of a generator request's agent string: an unknown agent is refused here, never handed the other
/// agent's path.
pub fn agent_of(agent: &str) -> Result<Agent, String> {
    parse(agent).ok_or_else(|| format!("invalid: agent `{agent}` is not claude or codex"))
}

/// The Bare home's credential for `agent`: `(folder, file)`, the first shared-login file of its config folder.
fn credential(agent: Agent) -> (&'static str, &'static str) {
    let s = spec(agent);
    (s.config_dir, s.logins[0])
}

/// One run's shared part of the generator home: the skill copies every call home reads (`build_run`).
#[derive(Debug)]
pub struct RunHome {
    pub agent: Agent,
    /// `<Bare home>\gen-<agent>`.
    pub dir: PathBuf,
    /// The Bare home (its lock guards the hand-back).
    bare_home: PathBuf,
    /// The login file the call homes link to (`login_back::source`).
    source: PathBuf,
    pub skill: PathBuf,
    /// `None` when the run has no merge pass.
    pub merge_skill: Option<PathBuf>,
}

/// Clears `<bare_home>\gen-<agent>` once and writes `skill.md` and, when given, `merge-skill.md` into it; the
/// calls then take their own homes with `call`.
pub fn build_run(agent: &str, bare_home: &Path, run_id: &str, skill_text: &str, merge_skill_text: Option<&str>) -> Result<RunHome, String> {
    let agent = agent_of(agent)?;
    let name = spec(agent).gen_dir;
    check_name("run id", run_id)?;
    let (folder, file) = credential(agent);
    let id = agent.as_str();
    let Some(source) = super::login_back::source(bare_home, id, folder, file) else {
        let own = bare_home.join(folder).join(file);
        return Err(format!("login: no {id} login at {}; log in on a Bare {id} tab first", own.display()));
    };
    let dir = bare_home.join(name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("spawn: generator home {} not cleared ({e})", dir.display()))?;
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("spawn: generator home folder {} not made ({e})", dir.display()))?;
    let write = |path: &Path, text: &str| std::fs::write(path, text).map_err(|e| format!("spawn: {} not written ({e})", path.display()));
    let skill = dir.join(SKILL_COPY);
    write(&skill, skill_text)?;
    let merge_skill = match merge_skill_text {
        Some(text) => {
            let path = dir.join(MERGE_SKILL_COPY);
            write(&path, text)?;
            Some(path)
        }
        None => None,
    };
    Ok(RunHome { agent, dir, bare_home: bare_home.to_path_buf(), source, skill, merge_skill })
}

/// After a call, success or failure: its login goes back over the run's source when the CLI refreshed it into a
/// file of its own (`login_back::write_back`). A failed hand-back is not the call's failure; it is printed (paths
/// only) and the next run starts from the source as it is.
pub fn hand_back(run: &RunHome, call: &GenHome) -> Option<super::login_back::Back> {
    let (_, file) = credential(run.agent);
    match super::login_back::write_back(&run.bare_home, &run.source, &call.config.join(file)) {
        Ok(back) => Some(back),
        Err(e) => {
            eprintln!("rune generator: {e}");
            None
        }
    }
}

/// Makes `calls\<name>\{config, user-home, work}` for one agent call: the credential hard-linked (copied when the
/// link fails), Claude's `settings.json` `{}` or Codex's `config.toml`. `child_env` and the clean check take the
/// result (`dir` is the call's folder; `skill` is the run's copy).
pub fn call(run: &RunHome, name: &str) -> Result<GenHome, String> {
    check_name("call name", name)?;
    let (_, file) = credential(run.agent);
    let dir = run.dir.join(CALLS).join(name);
    let (config, cwd, user_home) = (dir.join(CONFIG), dir.join(WORK), dir.join(USER_HOME));
    // A half-made call home goes away with a failed make; a finished one is the caller's (`remove_calls`).
    let mut building = BuildGuard(Some(dir.clone()));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("spawn: call home {} not cleared ({e})", dir.display()))?;
    }
    for d in [config.clone(), cwd.clone(), user_home.join("AppData").join("Roaming"), user_home.join("AppData").join("Local").join("Temp")] {
        std::fs::create_dir_all(&d).map_err(|e| format!("spawn: generator home folder {} not made ({e})", d.display()))?;
    }
    let placed = place_credential(run.agent, &run.source, &config.join(file))?;
    let write = |path: &Path, text: &str| std::fs::write(path, text).map_err(|e| format!("spawn: {} not written ({e})", path.display()));
    match run.agent {
        Agent::Claude => write(&config.join("settings.json"), "{}")?,
        Agent::Codex => write(&config.join("config.toml"), "cli_auth_credentials_store = \"file\"\n")?,
    }
    building.0 = None;
    Ok(GenHome { agent: run.agent, dir, config, cwd, skill: Some(run.skill.clone()), placed })
}

/// Removes every call home of the run. `TerminateJobObject` returns before the processes are gone, so a folder
/// they still hold is retried for about two seconds; what stays is cleared by the next `build_run`.
pub fn remove_calls(run: &RunHome) {
    let dir = run.dir.join(CALLS);
    for _ in 0..20 {
        if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn check_name(what: &str, name: &str) -> Result<(), String> {
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err(format!("invalid: {what} `{name}` is not plain lowercase"));
    }
    Ok(())
}

/// Hard-links `source` to `target`, copying when the link fails.
fn place_credential(agent: Agent, source: &Path, target: &Path) -> Result<Placed, String> {
    match std::fs::hard_link(source, target) {
        Ok(()) => Ok(Placed::Link),
        Err(_) => {
            let agent = agent.as_str();
            std::fs::copy(source, target).map_err(|e| format!("login: {agent} login not placed in the generator home ({e})"))?;
            Ok(Placed::Copy)
        }
    }
}

/// Removes a half-built call home when dropped armed (best effort, errors ignored: the next `build_run`
/// clears the whole home anyway).
pub(crate) struct BuildGuard(pub(crate) Option<PathBuf>);

impl Drop for BuildGuard {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_dir_all(p);
        }
    }
}

/// Refuses a call home that holds anything but its allow-list, or sits under an instruction file (checked right
/// before the spawn): the config dir holds only the agent's login files and the one config file `call` wrote, the
/// cwd nothing, and no ancestor of the cwd holds an instruction file the agent would walk up to and load.
pub fn assert_clean(home: &GenHome) -> Result<(), String> {
    assert_allowed(home.agent, &home.config, &home.cwd)
}

/// The one file `call` writes beside the credential.
fn config_file(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => "settings.json",
        Agent::Codex => "config.toml",
    }
}

/// The allow-list check for `agent`'s config dir and work cwd, then the ancestor walk from the cwd's parent up.
pub fn assert_allowed(agent: Agent, config: &Path, cwd: &Path) -> Result<(), String> {
    let allowed = |name: &str| spec(agent).logins.contains(&name) || name == config_file(agent);
    let entries = std::fs::read_dir(config).map_err(|e| format!("spawn: generator config {} not readable ({e})", config.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !allowed(&name) {
            return Err(format!("spawn: generator home holds {name}"));
        }
    }
    if let Some(entry) = std::fs::read_dir(cwd).map_err(|e| format!("spawn: generator cwd {} not readable ({e})", cwd.display()))?.flatten().next() {
        return Err(format!("spawn: generator home holds {}", entry.file_name().to_string_lossy()));
    }
    for ancestor in cwd.ancestors().skip(1) {
        for name in instruction_files() {
            if ancestor.join(name).exists() {
                return Err(format!("spawn: generator home sits under {name} in {}", ancestor.display()));
            }
        }
    }
    Ok(())
}

/// The instruction-file check over bare folders: the real runner calls it right before `cmd.spawn()`.
pub fn assert_dirs_clean<'a>(dirs: impl IntoIterator<Item = &'a Path>) -> Result<(), String> {
    for dir in dirs {
        for name in instruction_files() {
            if dir.join(name).exists() {
                return Err(format!("spawn: generator home holds {name}"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "home_tests.rs"]
mod tests;
