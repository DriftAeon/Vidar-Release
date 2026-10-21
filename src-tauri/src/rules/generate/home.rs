//! src-tauri\src\rules\generate\home.rs — the generator homes (plan D1, W0 result): where the rune generator's
//! agent runs, holding the login and nothing else. `<Bare home>\gen-claude\` and `gen-codex\` sit inside this
//! install's agent home (`bare::home::resolve`, `%LOCALAPPDATA%\Vidar\homes\<install key>`), so the private ACL of
//! `homes\` covers them. A run clears the folder once (`build_run`: `skill.md`, `merge-skill.md`) and gives each
//! agent call its own `calls\<name>\{config, user-home, work}` (`call`), removed together at the end (`remove_calls`):
//! - `config\` is `CLAUDE_CONFIG_DIR` / `CODEX_HOME`: Claude gets `.credentials.json` and `settings.json` (`{}`),
//!   Codex `auth.json` and a `config.toml` with no `developer_instructions` (not `generate_codex_config`, which
//!   carries the static payload). The credential is a hard link to the Bare home's file (copy when the link fails),
//!   which W0 proved works and leaves the source unchanged. A missing Bare credential is `login:`.
//! - `user-home\AppData\{Roaming,Local\Temp}` are the folders the env overlay (`USERPROFILE`, `APPDATA`, `TEMP`...)
//!   points at, as `tools/bare/probe-generate.ps1` `Overlay-For` makes them.
//! - `work\` is the call's fresh empty cwd; the run's `skill.md` (Claude) is the `--system-prompt-file` copy.
//! `assert_clean` runs immediately before the spawn: Codex loads an `AGENTS.md` from `CODEX_HOME` or the cwd whatever
//! flags it gets (W0), so neither agent's instruction file may exist in the config dir or the cwd.

use std::path::{Path, PathBuf};

pub const CONFIG: &str = "config";
pub const USER_HOME: &str = "user-home";
pub const WORK: &str = "work";
pub const SKILL_COPY: &str = "skill.md";
pub const MERGE_SKILL_COPY: &str = "merge-skill.md";
/// The folder under `gen-<agent>` that holds one home per call.
pub const CALLS: &str = "calls";
/// Instruction files an agent loads without being asked.
pub const INSTRUCTION_FILES: [&str; 2] = ["CLAUDE.md", "AGENTS.md"];

/// How the generator home got its login.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placed {
    Link,
    Copy,
}

/// One call's generator home.
#[derive(Debug)]
pub struct GenHome {
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
    match agent {
        "claude" => Ok("gen-claude"),
        "codex" => Ok("gen-codex"),
        other => Err(format!("invalid: agent `{other}` is not claude or codex")),
    }
}

/// The Bare home's credential for `agent`: `(folder, file)`.
fn credential(agent: &str) -> (&'static str, &'static str) {
    if agent == "claude" {
        ("claude-config", ".credentials.json")
    } else {
        ("codex-home", "auth.json")
    }
}

/// One run's shared part of the generator home: the skill copies every call home reads (`build_run`).
#[derive(Debug)]
pub struct RunHome {
    pub agent: &'static str,
    /// `<Bare home>\gen-<agent>`.
    pub dir: PathBuf,
    /// The Bare home's credential file the call homes link to.
    source: PathBuf,
    pub skill: PathBuf,
    /// `None` when the run has no merge pass.
    pub merge_skill: Option<PathBuf>,
}

/// Clears `<bare_home>\gen-<agent>` once and writes `skill.md` and, when given, `merge-skill.md` into it; the
/// calls then take their own homes with `call`.
pub fn build_run(agent: &str, bare_home: &Path, run_id: &str, skill_text: &str, merge_skill_text: Option<&str>) -> Result<RunHome, String> {
    let name = dir_name(agent)?;
    check_name("run id", run_id)?;
    let (folder, file) = credential(agent);
    let source = bare_home.join(folder).join(file);
    if !source.is_file() {
        return Err(format!("login: no {agent} login at {}; log in on a Bare {agent} tab first", source.display()));
    }
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
    Ok(RunHome { agent: if agent == "claude" { "claude" } else { "codex" }, dir, source, skill, merge_skill })
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
    if run.agent == "claude" {
        write(&config.join("settings.json"), "{}")?;
    } else {
        write(&config.join("config.toml"), "cli_auth_credentials_store = \"file\"\n")?;
    }
    building.0 = None;
    Ok(GenHome { dir, config, cwd, skill: Some(run.skill.clone()), placed })
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
fn place_credential(agent: &str, source: &Path, target: &Path) -> Result<Placed, String> {
    match std::fs::hard_link(source, target) {
        Ok(()) => Ok(Placed::Link),
        Err(_) => {
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

/// Refuses a home or cwd that holds an instruction file (checked right before the spawn).
pub fn assert_clean(home: &GenHome) -> Result<(), String> {
    assert_dirs_clean([home.config.as_path(), home.cwd.as_path()])
}

/// `assert_clean` over bare folders: the real runner calls it right before `cmd.spawn()`.
pub fn assert_dirs_clean<'a>(dirs: impl IntoIterator<Item = &'a Path>) -> Result<(), String> {
    for dir in dirs {
        for name in INSTRUCTION_FILES {
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
