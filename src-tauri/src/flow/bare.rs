//! Flow nodes on the Bare home (run 2026-10-19-codex-primary, U2): every Codex node gets the
//! Bare Codex env (`CODEX_HOME` = the Bare home), every Claude node the Bare Claude env
//! (`CLAUDE_CONFIG_DIR` = the Bare config dir). Both envs are built from the allowlist
//! (`bare/env.rs`), so no inherited `ANTHROPIC_*` or `CODEX_*` rides along.
//!
//! The home and login are checked once per run and kind: the first verdict for a run is kept,
//! so a missing home fails that node and every later one of its kind with the same message,
//! before anything spawns.
//!
//! Codex nodes also get, per spawn: network on (`sandbox_workspace_write.network_access`), and
//! the user's URL-only MCP servers from the default Codex home's config.toml (name and URL only;
//! `codex_config::url_only_servers`). A server carrying headers, a token, env or a command stays
//! out with one warning. Probed on Codex 0.163.0 in a scratch home: both `-c` overrides take
//! effect per spawn (`debug prompt-input`, `mcp list`).
//!
//! Claude-model nodes also get the Bare payload and the user's URL-only Claude MCP servers as
//! sidecar args (`flow/claude_mcp.rs`, W3e2); gateway-model nodes do not.

use std::collections::HashMap;
#[cfg(test)]
use std::ffi::OsString;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use crate::bare::{CodexEnv, Env};
use crate::codex_config::Dropped;

use super::child::{lock, RunnerSpec};
use super::codex_mcp::valid_name;
use super::env::{EnvPlan, CLAUDE_MODELS};

/// The launch profile Flow nodes run on.
pub(super) const PROFILE: &str = "bare";
/// u1's strings, verbatim (bare/mod.rs `codex_env_for_profile_with`).
const NO_HOME: &str = "Open a Bare tab once to create its home";
const NO_LOGIN: &str = "Sign in from a Bare tab";
/// The Bare Claude login file in its config dir; tested for presence only, never opened.
const CLAUDE_LOGIN: &str = ".credentials.json";
/// Old runs' verdicts are dropped wholesale past this many entries.
const CHECKS_CAP: usize = 256;

/// What a node needs from the Bare home: Codex (home + `auth.json`), Claude (config dir +
/// login), or a gateway model on the Claude sidecar (config dir only; the key comes from the
/// gateway module).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Need {
    Codex,
    Claude,
    Gateway,
}

pub(super) fn need_for(backend: &str, model: &str) -> Option<Need> {
    match backend {
        "codex" => Some(Need::Codex),
        "sdk" if CLAUDE_MODELS.contains(&model) => Some(Need::Claude),
        "sdk" => Some(Need::Gateway),
        _ => None,
    }
}

/// Per-run verdicts, keyed by run id and need.
pub(super) type Checks = Arc<Mutex<HashMap<(String, Need), Result<(), String>>>>;

/// Runs `build` unless this run already failed the check for `need`, in which case the first
/// failure is returned and nothing is built. The first verdict per run and need is kept.
pub(super) fn check_once<T>(
    checks: &Checks,
    run_id: &str,
    need: Need,
    build: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let key = (run_id.to_string(), need);
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

/// The Bare Claude env for a node, after the home and (for a Claude model) login check.
pub(super) fn claude_env(need: Need) -> Result<Env, String> {
    verify_claude(crate::bare::login_env(PROFILE, std::env::vars_os())?, need)
}

#[cfg(test)]
fn claude_env_with(root: &Path, home_dir: &Path, inherited: impl IntoIterator<Item = (OsString, OsString)>, need: Need) -> Result<Env, String> {
    verify_claude(crate::bare::login_env_with(PROFILE, root, home_dir, inherited)?, need)
}

fn verify_claude(env: Env, need: Need) -> Result<Env, String> {
    let dir = env.get("CLAUDE_CONFIG_DIR").map(PathBuf::from).filter(|d| d.is_dir()).ok_or(NO_HOME)?;
    if need == Need::Claude && !dir.join(CLAUDE_LOGIN).is_file() {
        return Err(NO_LOGIN.to_string());
    }
    Ok(env)
}

/// The sidecar's env on the Bare home: exactly the Bare env, then the plan's `set` entries
/// (`CONTEXT_GATE`, a gateway's `ANTHROPIC_*`). The plan's `remove` list is moot: nothing is
/// inherited.
pub(super) fn apply_claude_env(cmd: &mut Command, env: &Env, plan: &EnvPlan) {
    cmd.env_clear();
    for (k, v) in env.iter() {
        cmd.env(k, v);
    }
    for (k, v) in &plan.set {
        cmd.env(k, v);
    }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/// A Codex node's Bare spawn inputs: the env (with `VIDAR_CTL_TOKEN`), `node`, the per-spawn
/// `-c` overrides, the carried server names and the left-out warnings.
pub(super) struct BareCodex {
    /// Also in `env` as `VIDAR_CTL_TOKEN`; flow.rs registers it for the node's lifetime.
    pub(super) ctl_token: String,
    pub(super) env: Env,
    pub(super) node: PathBuf,
    pub(super) args: Vec<String>,
    pub(super) carried: Vec<String>,
    pub(super) warnings: Vec<String>,
}

/// Production: the Bare Codex env (Err with u1's strings when the home or login is missing),
/// plus the user's URL-only servers from the default Codex home.
pub(super) fn codex_spec(ctl_token: &str) -> Result<RunnerSpec, String> {
    let ce = crate::bare::codex_env_for_profile(PROFILE, std::env::vars_os())?;
    let user_config = crate::rules::codex::codex_home()
        .map(|h| h.join("config.toml"))
        .filter(|p| p.is_file())
        .and_then(|p| std::fs::read_to_string(p).ok());
    Ok(codex_spec_from(ce, user_config.as_deref(), ctl_token))
}

fn codex_spec_from(ce: CodexEnv, user_config: Option<&str>, ctl_token: &str) -> RunnerSpec {
    let bare_names: Vec<String> = crate::codex_config::read(&ce.codex_home)
        .ok()
        .flatten()
        .map(|c| c.mcp_servers.into_iter().map(|m| m.name).collect())
        .unwrap_or_default();
    let carry = carry_args(user_config, &bare_names);
    let mut env = ce.env;
    // The Bare config's `vidar_drive` server forwards it (`env_vars`).
    env.set("VIDAR_CTL_TOKEN", ctl_token);
    RunnerSpec::Codex {
        js: ce.js,
        home: Some(ce.codex_home),
        bare: Some(BareCodex {
            ctl_token: ctl_token.to_string(),
            env,
            node: ce.node,
            args: carry.args,
            carried: carry.names,
            warnings: carry.warnings,
        }),
    }
}

/// The control token a spec's node carries (Bare Codex nodes only).
pub(super) fn ctl_token_of(spec: &RunnerSpec) -> Option<String> {
    match spec {
        RunnerSpec::Codex { bare: Some(b), .. } => Some(b.ctl_token.clone()),
        _ => None,
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Carry {
    pub(super) args: Vec<String>,
    pub(super) names: Vec<String>,
    pub(super) warnings: Vec<String>,
}

const NETWORK_ON: &str = "sandbox_workspace_write.network_access=true";

/// Pure: network on, plus one `-c mcp_servers.<n>.url="<url>"` per URL-only user server the
/// Bare config does not already define (the Bare one wins). Never a header, token, env or
/// command: those servers stay out with a warning naming them.
pub(super) fn carry_args(user_config: Option<&str>, bare_names: &[String]) -> Carry {
    let mut carry = Carry { args: vec!["-c".to_string(), NETWORK_ON.to_string()], ..Carry::default() };
    let Some(text) = user_config else { return carry };
    let split = match crate::codex_config::url_only_servers(text) {
        Ok(split) => split,
        Err(e) => {
            carry.warnings.push(format!("MCP servers left out of Flow: {e}"));
            return carry;
        }
    };
    for (name, why) in split.dropped {
        if bare_names.contains(&name) {
            continue;
        }
        let reason = match why {
            Dropped::Secrets => "it carries headers, a token, env or a command",
            Dropped::UrlLogin => "its URL carries a login",
        };
        carry.warnings.push(left_out(&name, reason));
    }
    for server in split.pass {
        if bare_names.contains(&server.name) {
            continue;
        }
        if !valid_name(&server.name) {
            carry.warnings.push(left_out(&server.name, "its name is not valid in a Codex config key"));
            continue;
        }
        carry.args.push("-c".to_string());
        carry.args.push(format!("mcp_servers.{}.url={}", server.name, toml_string(&server.url)));
        carry.names.push(server.name);
    }
    carry
}

fn left_out(name: &str, reason: &str) -> String {
    format!("MCP server \"{name}\" left out of Flow: {reason}")
}

/// A TOML basic string: quotes, backslashes and control characters escaped.
fn toml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A fresh control token for one Codex node (16 OS-random bytes, hex).
pub(super) fn mint_ctl_token() -> Result<String, String> {
    crate::control::secrets::mint()
}

/// The policy tab id a Flow node's control token is registered under.
pub(super) fn ctl_tab(run_id: &str, node_id: &str) -> String {
    format!("flow:{run_id}:{node_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bare::{CodexBinary, CodexProbes};

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vidar-flow-bare-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn inherited() -> Vec<(OsString, OsString)> {
        [
            ("Path", r"C:\Windows\System32"),
            ("SystemRoot", r"C:\Windows"),
            ("ANTHROPIC_API_KEY", "sk-inherited"),
            ("ANTHROPIC_BASE_URL", "https://inherited.example"),
            ("CLAUDE_CONFIG_DIR", r"C:\inherited\claude"),
            ("CODEX_HOME", r"C:\inherited\codex"),
        ]
        .into_iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect()
    }

    fn no_find(_: &Env, _: &str) -> Option<PathBuf> {
        Some(PathBuf::from(r"C:\node\node.exe"))
    }

    fn no_codex(_: &Env, _: &CodexBinary) -> Option<(PathBuf, Option<String>)> {
        Some((PathBuf::from(r"C:\codex\codex.js"), None))
    }

    #[test]
    fn need_follows_backend_and_model() {
        assert_eq!(need_for("codex", "codex-default"), Some(Need::Codex));
        assert_eq!(need_for("sdk", "claude-opus-5-5"), Some(Need::Claude));
        assert_eq!(need_for("sdk", "some-gateway-model"), Some(Need::Gateway));
        assert_eq!(need_for("other", "x"), None);
    }

    #[test]
    fn no_home_fails_the_run_before_anything_is_built() {
        let home = scratch("nohome");
        let claude = claude_env_with(&root(), &home, inherited(), Need::Claude).unwrap_err();
        assert_eq!(claude, NO_HOME);
        let probes = CodexProbes { find: &no_find, codex: &no_codex };
        let codex = crate::bare::codex_env_for_profile_with(PROFILE, &root(), &home, inherited(), &probes).err().unwrap();
        assert_eq!(codex, NO_HOME);

        // The first verdict sticks for the run: a later node's build is never called.
        let checks: Checks = Arc::default();
        let first: Result<(), String> = check_once(&checks, "r1", Need::Claude, || Err(claude.clone()));
        assert_eq!(first.unwrap_err(), NO_HOME);
        let built = std::cell::Cell::new(false);
        let second: Result<(), String> = check_once(&checks, "r1", Need::Claude, || {
            built.set(true);
            Ok(())
        });
        assert_eq!(second.unwrap_err(), NO_HOME);
        assert!(!built.get(), "a failed run must not build (nor spawn) a later node");
        // Another run, or another kind in the same run, checks afresh.
        assert!(check_once(&checks, "r2", Need::Claude, || Ok(())).is_ok());
        assert!(check_once(&checks, "r1", Need::Codex, || Ok(())).is_ok());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn claude_env_is_the_bare_dir_with_no_inherited_anthropic() {
        let home = scratch("claude");
        let probe = crate::bare::login_env_with(PROFILE, &root(), &home, inherited()).unwrap();
        let dir = PathBuf::from(probe.get("CLAUDE_CONFIG_DIR").expect("Bare sets CLAUDE_CONFIG_DIR"));
        assert!(dir.starts_with(&home), "{}", dir.display());
        std::fs::create_dir_all(&dir).unwrap();
        // Home but no login: a Claude model is refused, a gateway model is not.
        assert_eq!(claude_env_with(&root(), &home, inherited(), Need::Claude).unwrap_err(), NO_LOGIN);
        assert!(claude_env_with(&root(), &home, inherited(), Need::Gateway).is_ok());
        std::fs::write(dir.join(CLAUDE_LOGIN), "").unwrap();
        let env = claude_env_with(&root(), &home, inherited(), Need::Claude).unwrap();

        // The plan the Claude runner builds from Vidar's env, applied over the Bare env.
        let names: HashMap<String, String> = inherited().into_iter().map(|(k, _)| (k.to_string_lossy().into_owned(), String::new())).collect();
        let plan = super::super::env::build_node_env("claude-opus-5-5", &names, &|_| None, &|_| None).unwrap();
        let mut cmd = Command::new("node");
        apply_claude_env(&mut cmd, &env, &plan);
        let got: HashMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().to_uppercase(), v.map(|v| v.to_string_lossy().into_owned())))
            .collect();
        assert_eq!(got.get("CLAUDE_CONFIG_DIR").cloned().flatten(), Some(dir.display().to_string()));
        assert!(!got.keys().any(|k| k.starts_with("ANTHROPIC_")), "{got:?}");
        assert!(!got.keys().any(|k| k.starts_with("CODEX_")), "{got:?}");
        assert_eq!(got.get("CONTEXT_GATE").cloned().flatten().as_deref(), Some("0"));
        let _ = std::fs::remove_dir_all(&home);
    }

    const USER: &str = r#"
[mcp_servers.wiki]
url = "https://wiki.example/mcp"

[mcp_servers.quoted]
url = "https://q.example/mcp?a=\"b\""

[mcp_servers.headed]
url = "https://h.example/mcp"
http_headers = { Authorization = "Bearer SECRET-H" }

[mcp_servers.tokened]
url = "https://t.example/mcp"
bearer_token_env_var = "SECRET_VAR"

[mcp_servers.local]
command = "node"
args = ["server.js"]

[mcp_servers.logged]
url = "https://user:SECRET-P@l.example/mcp"

[mcp_servers."bad.name"]
url = "https://b.example/mcp"

[mcp_servers.vidar_drive]
url = "https://shadow.example/mcp"
"#;

    #[test]
    fn carry_passes_url_only_and_leaves_secret_carriers_out() {
        let carry = carry_args(Some(USER), &["vidar_drive".to_string()]);
        assert_eq!(
            carry.args,
            [
                "-c",
                NETWORK_ON,
                "-c",
                r#"mcp_servers.quoted.url="https://q.example/mcp?a=\"b\"""#,
                "-c",
                r#"mcp_servers.wiki.url="https://wiki.example/mcp""#,
            ]
        );
        assert_eq!(carry.names, ["quoted", "wiki"]);
        assert_eq!(
            carry.warnings,
            [
                "MCP server \"headed\" left out of Flow: it carries headers, a token, env or a command",
                "MCP server \"local\" left out of Flow: it carries headers, a token, env or a command",
                "MCP server \"logged\" left out of Flow: its URL carries a login",
                "MCP server \"tokened\" left out of Flow: it carries headers, a token, env or a command",
                "MCP server \"bad.name\" left out of Flow: its name is not valid in a Codex config key",
            ]
        );
        let all = format!("{carry:?}");
        assert!(!all.contains("SECRET"), "{all}");
        // No user config: network only. Unparseable: network only, one warning.
        assert_eq!(carry_args(None, &[]).args, ["-c", NETWORK_ON]);
        let bad = carry_args(Some("[mcp_servers"), &[]);
        assert_eq!(bad.args, ["-c", NETWORK_ON]);
        assert_eq!(bad.warnings, ["MCP servers left out of Flow: Invalid Codex config.toml"]);
    }

    #[test]
    fn codex_spec_carries_the_token_and_the_home() {
        let home = scratch("codex");
        std::fs::write(home.join("config.toml"), "[mcp_servers.vidar_drive]\ncommand = \"node\"\n").unwrap();
        let ce = CodexEnv { env: Env::default(), node: PathBuf::from("node.exe"), js: PathBuf::from("codex.js"), codex_home: home.clone() };
        let RunnerSpec::Codex { home: got_home, bare: Some(b), .. } = codex_spec_from(ce, Some(USER), "tok123") else {
            panic!("a Bare Codex spec")
        };
        assert_eq!(got_home.as_deref(), Some(home.as_path()));
        assert_eq!(b.env.get("VIDAR_CTL_TOKEN").and_then(|v| v.to_str()), Some("tok123"));
        assert_eq!(b.ctl_token, "tok123");
        assert!(!b.carried.contains(&"vidar_drive".to_string()), "the Bare server wins");
        assert_eq!(b.carried, ["quoted", "wiki"]);
        let _ = std::fs::remove_dir_all(&home);
    }
}
