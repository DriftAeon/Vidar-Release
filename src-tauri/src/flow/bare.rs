//! Flow nodes on their Rune Vault's home: every agent node spawns on the home
//! its vault builds (`bare/flow_vault.rs`), the way a Rendered tab does, with the vault's payload,
//! plugins and MCP file and nothing of Flow's own. An unset vault is refused.
//! The envs are built from the allowlist (`bare/env.rs`), so no inherited `ANTHROPIC_*` or
//! `CODEX_*` rides along.
//!
//! A home or login failure is kept once per run, need and vault: the first verdict for that key
//! fails the node and every later one on the same vault with the same message, before anything
//! spawns; a node on another vault is untouched.
//!
//! Codex nodes also get, per spawn, network on (`sandbox_workspace_write.network_access`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use crate::agent_spec::{self, Agent};
use crate::bare::Env;
use crate::proc_job::SpawnExt;

use super::child::{lock, RunnerSpec};
use super::env::{EnvPlan, FIRST_PARTY_MODELS};

/// u1's string, verbatim.
const NO_LOGIN: &str = "Sign in from a Bare tab";
/// The Bare Claude login file in its config dir; tested for presence only, never opened.
const CLAUDE_LOGIN: &str = ".credentials.json";
/// Old runs' verdicts are dropped wholesale past this many entries.
const CHECKS_CAP: usize = 256;

/// What a node needs from its vault's home: the app-server agent (home + `auth.json`), the Claude
/// sidecar with a Claude model (config dir + login), or a gateway model on the Claude sidecar
/// (config dir only; the key comes from the gateway module).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Need {
    Codex,
    Claude,
    Gateway,
}

/// The backend word a node carries for an agent: the sidecar agent's is `sdk`, the app-server agent's
/// is its id.
fn backend_of(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => "sdk",
        Agent::Codex => agent.as_str(),
    }
}

/// The agent a backend runs. A word no agent's node carries is `None` (the node refuses).
pub(super) fn agent_of(backend: &str) -> Option<Agent> {
    agent_spec::ALL.into_iter().find(|a| backend_of(*a) == backend)
}

/// What the agent's node needs from its home. Every agent has a Flow adapter; a new one fails to
/// compile here until it gets one.
pub(super) fn need_for(agent: Agent, model: &str) -> Need {
    match agent {
        Agent::Claude => {
            if FIRST_PARTY_MODELS.contains(&model) {
                Need::Claude
            } else {
                Need::Gateway
            }
        }
        Agent::Codex => Need::Codex,
    }
}

/// Per-run verdicts, keyed by run id, need and vault.
pub(super) type Checks = Arc<Mutex<HashMap<(String, Need, String), Result<(), String>>>>;

/// Runs `build` unless this run already failed the check for `need` on `vault`, in which case the
/// first failure is returned and nothing is built. The first verdict per key is kept.
pub(super) fn check_once<T>(
    checks: &Checks,
    run_id: &str,
    need: Need,
    vault: &str,
    build: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let key = (run_id.to_string(), need, vault.to_string());
    if let Some(Err(e)) = lock(checks).get(&key) {
        return Err(e.clone());
    }
    let built = build();
    let mut map = lock(checks);
    if map.len() >= CHECKS_CAP && !map.contains_key(&key) {
        map.clear();
    }
    map.entry(key).or_insert_with(|| built.as_ref().map(|_| ()).map_err(Clone::clone));
    built
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/// A Claude-model node needs the login in its vault home's config dir; a gateway node needs none.
pub(super) fn verify_login(config_dir: &Path, need: Need) -> Result<(), String> {
    match need {
        Need::Claude => match config_dir.join(CLAUDE_LOGIN).is_file() {
            true => Ok(()),
            false => Err(NO_LOGIN.to_string()),
        },
        Need::Codex | Need::Gateway => Ok(()),
    }
}

/// Adds `warning` to a spec's warnings (the node still spawns).
pub(super) fn add_warning(spec: &mut RunnerSpec, warning: String) {
    match spec {
        RunnerSpec::Sidecar { warnings, .. } => warnings.push(warning),
        RunnerSpec::AppServer { bare, .. } => {
            if let Some(b) = bare {
                b.warnings.push(warning);
            }
        }
    }
}

/// The sidecar's env on the vault home: exactly the Bare env, then the plan's `set` entries
/// (`CONTEXT_GATE`, a gateway's `ANTHROPIC_*`). The plan's `remove` list is moot: nothing is
/// inherited.
pub(super) fn apply_claude_env(cmd: &mut Command, env: &Env, plan: &EnvPlan) {
    cmd.exact_env(env.iter());
    for (k, v) in &plan.set {
        cmd.env(k, v);
    }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/// A Codex node's spawn inputs: the env (with `VIDAR_CTL_TOKEN`), `node`, the per-spawn `-c`
/// overrides, the vault's instructions and the warnings.
pub(super) struct BareCodex {
    /// Also in `env` as `VIDAR_CTL_TOKEN`; flow.rs registers it for the node's lifetime. `None` when the
    /// vault has no `ctl: yes` rune.
    pub(super) ctl_token: Option<String>,
    pub(super) env: Env,
    pub(super) node: PathBuf,
    pub(super) args: Vec<String>,
    /// The vault's rendered runes, sent as `developerInstructions` on `thread/start`.
    pub(super) instructions: Option<String>,
    pub(super) warnings: Vec<String>,
}

/// The control token a spec's node carries: a Claude node's `VIDAR_CTL_TOKEN` env entry, or a Bare Codex
/// node's minted token.
pub(super) fn ctl_token_of(spec: &RunnerSpec) -> Option<String> {
    match spec {
        RunnerSpec::Sidecar { env, .. } => env.as_ref().and_then(|e| e.get("VIDAR_CTL_TOKEN")).map(|t| t.to_string_lossy().into_owned()),
        RunnerSpec::AppServer { bare, .. } => bare.as_ref().and_then(|b| b.ctl_token.clone()),
    }
}

/// The policy tab id a Flow node's control token is registered under.
pub(super) fn ctl_tab(run_id: &str, node_id: &str) -> String {
    format!("flow:{run_id}:{node_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vidar-flow-bare-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn need_follows_agent_and_model() {
        let (claude, other) = (agent_of("sdk").unwrap(), agent_of(agent_spec::ALL[1].as_str()).unwrap());
        assert_ne!(claude, other);
        assert_eq!(need_for(other, "codex-default"), Need::Codex);
        assert_eq!(need_for(claude, "claude-opus-5-5"), Need::Claude);
        assert_eq!(need_for(claude, "some-gateway-model"), Need::Gateway);
        assert_eq!(agent_of("not-an-agent"), None, "an unknown agent refuses");
    }

    #[test]
    fn a_backend_word_names_one_agent_and_the_sidecar_agent_has_no_id_backend() {
        let sidecar = agent_of("sdk").unwrap();
        for a in agent_spec::ALL {
            assert_eq!(agent_of(backend_of(a)), Some(a), "{}", a.as_str());
            assert_eq!(agent_of(a.as_str()).is_some(), a != sidecar, "{}", a.as_str());
        }
    }

    #[test]
    fn one_vaults_failure_does_not_fail_another_vault() {
        let checks: Checks = Arc::default();
        let first: Result<(), String> = check_once(&checks, "r1", Need::Claude, "v1", || Err("Sign in from a Bare tab".into()));
        assert_eq!(first.unwrap_err(), NO_LOGIN);
        // The same run, need and vault: the first verdict sticks and nothing is built.
        let built = std::cell::Cell::new(false);
        let again: Result<(), String> = check_once(&checks, "r1", Need::Claude, "v1", || {
            built.set(true);
            Ok(())
        });
        assert_eq!(again.unwrap_err(), NO_LOGIN);
        assert!(!built.get(), "a failed vault must not build (nor spawn) a later node");
        // Another vault, run or need checks afresh.
        assert!(check_once(&checks, "r1", Need::Claude, "v2", || Ok(())).is_ok());
        assert!(check_once(&checks, "r2", Need::Claude, "v1", || Ok(())).is_ok());
        assert!(check_once(&checks, "r1", Need::Codex, "v1", || Ok(())).is_ok());
    }

    #[test]
    fn a_claude_model_needs_the_login_and_a_gateway_model_does_not() {
        let dir = scratch("login");
        assert_eq!(verify_login(&dir, Need::Claude).unwrap_err(), NO_LOGIN);
        assert!(verify_login(&dir, Need::Gateway).is_ok());
        std::fs::write(dir.join(CLAUDE_LOGIN), "").unwrap();
        assert!(verify_login(&dir, Need::Claude).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_claude_env_is_the_bare_env_over_the_plan_with_no_inherited_anthropic() {
        let mut env = Env::default();
        env.set("CLAUDE_CONFIG_DIR", r"C:\home\claude-homes\abc");
        let names: HashMap<String, String> = ["ANTHROPIC_API_KEY", "CODEX_HOME", "Path"].iter().map(|k| (k.to_string(), String::new())).collect();
        let plan = super::super::env::build_node_env("claude-opus-5-5", &names, &|_| None, &|_| None).unwrap();
        let mut cmd = Command::new("node");
        apply_claude_env(&mut cmd, &env, &plan);
        let got: HashMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().to_uppercase(), v.map(|v| v.to_string_lossy().into_owned())))
            .collect();
        assert_eq!(got.get("CLAUDE_CONFIG_DIR").cloned().flatten().as_deref(), Some(r"C:\home\claude-homes\abc"));
        assert!(!got.keys().any(|k| k.starts_with("ANTHROPIC_") || k.starts_with("CODEX_")), "{got:?}");
        assert_eq!(got.get("CONTEXT_GATE").cloned().flatten().as_deref(), Some("0"));
    }

    #[test]
    fn codex_spec_carries_the_token_the_home_and_the_instructions() {
        let mut env = Env::default();
        env.set("VIDAR_CTL_TOKEN", "tok123");
        let n = crate::bare::flow_vault::CodexNode {
            node: PathBuf::from("node.exe"),
            js: PathBuf::from("codex.js"),
            env,
            args: vec!["-c".into(), "x=1".into()],
            home: PathBuf::from(r"C:\home\codex-home"),
            instructions: Some("rune text".into()),
            warnings: vec!["login note".into()],
            ctl_token: Some("tok123".into()),
        };
        let mut spec = super::super::codex::spec_from(n);
        add_warning(&mut spec, "dropped".into());
        assert_eq!(ctl_token_of(&spec).as_deref(), Some("tok123"));
        let RunnerSpec::AppServer { home, bare: Some(b), .. } = spec else { panic!("a Codex spec") };
        assert_eq!(home.as_deref(), Some(Path::new(r"C:\home\codex-home")));
        assert_eq!(b.env.get("VIDAR_CTL_TOKEN").and_then(|v| v.to_str()), Some("tok123"));
        assert_eq!(b.instructions.as_deref(), Some("rune text"));
        assert_eq!(b.warnings, ["login note", "dropped"]);
    }
}
