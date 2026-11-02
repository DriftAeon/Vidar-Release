//! One concern: Codex's side of the Rendered agent manager: where its `codex.js` lives, the
//! `app-server` spawn (default and Bare), and the Codex names other modules read from the table.
//! The process machinery (`spawn_agent`, `BaseEnv`, the job object) stays in the parent.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::{mint_ctl_token, spawn_agent, valid_tab_id, AgentManager, BaseEnv};
use crate::agent_spec::{spec, Agent};
use crate::rules::codex::appserver_args;

/// The agent's table id (store folder under the Falcon runtime store, manifest key).
pub(crate) fn store_dir() -> &'static str {
    Agent::Codex.as_str()
}

/// The npm package its `codex.js` ships in (`AgentSpec.npm_package`).
pub(crate) fn npm_package() -> Option<&'static str> {
    spec(Agent::Codex).npm_package
}

/// Where the installed Codex lives: the `codex` shim on PATH is a .ps1 that
/// runs `node <npm>\node_modules\@openai\codex\bin\codex.js`; that script then
/// starts the native binary. Spawning node on the script directly avoids the
/// shell and keeps the whole tree inside the Job Object.
///
/// `%APPDATA%\npm` is tried first; any other npm prefix (nvm-windows, a custom
/// prefix) is found beside its shim on the process `Path`, as Bare's D7 resolver does.
pub(crate) fn codex_js() -> Result<PathBuf, String> {
    let bin = codex_binary_block();
    codex_js_from(
        std::env::var_os("APPDATA").as_deref(),
        std::env::var_os("Path").as_deref(),
        bin.as_ref(),
    )
}

/// The `binary` block of the agent's Bare profile (shims, script, package); None when unreadable.
fn codex_binary_block() -> Option<crate::bare::CodexBinary> {
    let path = crate::paths::root().join("profiles").join("bare").join(spec(Agent::Codex).profile_file);
    let v: serde_json::Value = crate::fsx::read_json(&path).ok()?;
    serde_json::from_value(v.get("binary")?.clone()).ok()
}

/// Pure core of `codex_js`: the values come in, so tests inject them.
fn codex_js_from(
    appdata: Option<&std::ffi::OsStr>,
    path: Option<&std::ffi::OsStr>,
    bin: Option<&crate::bare::CodexBinary>,
) -> Result<PathBuf, String> {
    let appdata_js = appdata.map(|a| {
        PathBuf::from(a)
            .join("npm")
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("bin")
            .join("codex.js")
    });
    if let Some(p) = appdata_js.as_ref().filter(|p| p.is_file()) {
        return Ok(p.clone());
    }
    if let (Some(path), Some(bin)) = (path, bin) {
        let mut env = crate::bare::Env::default();
        env.set("Path", path);
        if let Some((js, _)) = crate::bare::resolve_codex(&env, bin) {
            return Ok(js);
        }
    }
    let at = appdata_js.map_or_else(|| "%APPDATA%\\npm (APPDATA not set)".to_string(), |p| p.display().to_string());
    Err(format!("codex.js not found at {at} or beside a codex.ps1 or codex.cmd shim on the Path"))
}

/// The `spawn_codex_appserver` reply: the process generation, and the built rune payload's text for a
/// Bare row that has one (None otherwise; the default spawn never has one).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSpawned {
    gen: u64,
    developer_instructions: Option<String>,
    /// A Bare launch's notice-area warnings (the untrusted-folder one rides `codex_trust_offer`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    bare_warnings: Vec<String>,
}

#[allow(clippy::too_many_arguments)] // one per spawn input, as spawn_codex_appserver
pub(super) fn spawn_appserver_blocking(
    app: AppHandle,
    id: String,
    cwd: String,
    rules_file: Option<String>,
    tab_name: Option<String>,
    profile: Option<String>,
    agent: Option<String>,
    row_key: Option<String>,
    sets: Option<Vec<crate::bare::LaunchSetRef>>,
    vault: Option<String>,
) -> Result<CodexSpawned, String> {
    let state = app.state::<AgentManager>();
    let vault = vault.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if vault.is_some() && profile.is_none() {
        return Err("A Rune Vault rides only a Bare spawn; spawn refused".into());
    }
    if !Path::new(&cwd).is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }
    crate::codex_cwd::refuse_home_cwd(Path::new(&cwd))?;
    // A row key names a Codex Bare row (its rune sets, bare/layer.rs); a blank one is none.
    crate::bare::admit_row_key_for(crate::agent_spec::Agent::Codex, row_key, profile.as_deref(), None)?;
    let mut env = vec![("VIDAR_TAB".to_string(), id.clone())];
    if let Some(name) = crate::pty::clean_tab_name(tab_name.as_deref()) {
        env.push(("VIDAR_TAB_NAME".to_string(), name));
    }
    let Some(profile) = profile else {
        let js = codex_js()?;
        let mut args = vec![js.to_string_lossy().into_owned(), "app-server".into()];
        // Re-validated here (canonical, under the built dir, `<hash12>.md`): the webview's path is not trusted.
        if let Some(file) = rules_file.filter(|f| !f.trim().is_empty()) {
            args.extend(appserver_args(&file).map_err(|e| format!("Rules file refused: {e}"))?);
        }
        let gen = spawn_agent(app.clone(), &state, id, "node".into(), args, cwd, env, BaseEnv::Scrubbed, None, None, None)?;
        return Ok(CodexSpawned { gen, developer_instructions: None, bare_warnings: Vec::new() });
    };
    if !valid_tab_id(&id) {
        return Err("invalid tab id".into());
    }
    crate::bare::admit_rendered(&profile, agent.as_deref(), rules_file.as_deref())?;
    crate::bare::refuse_profile_cwd(&cwd, std::env::var("USERPROFILE").ok().as_deref())?;
    // A named vault is the whole loadout (model R2); the transition pick is read only without one.
    let custom_sets = if vault.is_some() { None } else { sets.as_deref() };
    let opts = crate::bare::LaunchOpts { custom_sets, vault: vault.as_deref(), ..Default::default() };
    // Bare spawns stay serialized in-process, held until the home lock drops with `launch`.
    let prepare_guard = crate::pty::BARE_PREPARE.lock().unwrap_or_else(|e| e.into_inner());
    let mut launch = crate::bare::prepare_codex(&profile, &opts, &cwd)?;
    // Only a loadout with a `ctl: yes` rune gets a token (`bare::ctl_for`).
    let token = launch.ctl.then(mint_ctl_token).transpose()?;
    if let Some(token) = &token {
        env.push(("VIDAR_CTL_TOKEN".to_string(), token.clone()));
    }
    // The record names the final env (built names plus the tab variables); no record, no spawn.
    let mut names: Vec<String> = launch.env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
    names.extend(env.iter().map(|(k, _)| k.clone()));
    let manifest = launch.write_manifest(&id, names.iter().map(String::as_str))?;
    // Written by the stderr drain once it has opened (and possibly truncated) the log.
    let banner = launch.warning.as_ref().map(|w| format!("[Vidar Bare: {w}]"));
    let policy = app.state::<crate::control::policy::PolicyState>();
    if let Some(token) = &token {
        crate::control::policy::register(&policy, token.clone(), id.clone());
    }
    let program = launch.program.to_string_lossy().into_owned();
    let bare_warnings = launch.bare_warnings();
    let untrusted_dir = launch.is_untrusted().then(|| cwd.clone());
    let result = spawn_agent(
        app.clone(),
        &state,
        id.clone(),
        program,
        launch.args.clone(),
        cwd,
        env,
        BaseEnv::Exact(launch.env.clone()),
        Some((Agent::Codex, launch.codex_home.clone())),
        token.clone(),
        banner,
    );
    if result.is_err() {
        // Only this launch's token: a refused duplicate must not clear the live process's own.
        if let Some(token) = &token {
            crate::control::policy::unregister_token(&policy, token);
        }
        let _ = fs::remove_file(&manifest); // no process, so no launch record
    }
    // The card's Trust Folder action reads this; a failed spawn leaves no tab to offer it to.
    crate::bare::codex_trust::register(&id, untrusted_dir.filter(|_| result.is_ok()));
    let developer_instructions = launch.developer_instructions.take();
    drop(launch); // releases the home lock
    drop(prepare_guard);
    result.map(|gen| CodexSpawned { gen, developer_instructions, bare_warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codex_bin() -> crate::bare::CodexBinary {
        crate::bare::CodexBinary {
            shims: vec!["codex.ps1".into(), "codex.cmd".into()],
            script: "node_modules/@openai/codex/bin/codex.js".into(),
            package: "node_modules/@openai/codex/package.json".into(),
        }
    }

    /// `<base>/<sub>` shaped like an npm global folder; `shim` None leaves the shim out.
    fn fake_prefix(base: &Path, sub: &str, shim: Option<&str>) -> PathBuf {
        let dir = base.join(sub);
        let bin = dir.join("node_modules").join("@openai").join("codex").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("codex.js"), "//js").unwrap();
        if let Some(s) = shim {
            std::fs::write(dir.join(s), "#shim").unwrap();
        }
        dir
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vidar-codexjs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn codex_js_prefers_appdata_over_the_path_shim() {
        let t = scratch("appdata");
        let appdata = t.join("roaming");
        fake_prefix(&appdata, "npm", None);
        let other = fake_prefix(&t, "nvm", Some("codex.cmd"));
        let path = std::env::join_paths([&other]).unwrap();
        let got = codex_js_from(Some(appdata.as_os_str()), Some(&path), Some(&codex_bin())).unwrap();
        assert!(got.starts_with(&appdata), "{got:?}");
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn codex_js_falls_back_to_a_path_shim_folder_when_appdata_misses() {
        let t = scratch("path");
        let other = fake_prefix(&t, "nvm", Some("codex.cmd"));
        let path = std::env::join_paths([&t.join("empty"), &other]).unwrap();
        let got = codex_js_from(Some(t.join("roaming").as_os_str()), Some(&path), Some(&codex_bin())).unwrap();
        assert_eq!(got, other.join("node_modules").join("@openai").join("codex").join("bin").join("codex.js"));
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn codex_js_error_names_both_places() {
        let t = scratch("miss");
        let noshim = fake_prefix(&t, "noshim", None);
        let path = std::env::join_paths([&noshim]).unwrap();
        let appdata = t.join("roaming");
        let err = codex_js_from(Some(appdata.as_os_str()), Some(&path), Some(&codex_bin())).unwrap_err();
        assert!(err.starts_with("codex.js not found at "), "{err}");
        assert!(err.contains(&appdata.display().to_string()), "{err}");
        assert!(err.ends_with("or beside a codex.ps1 or codex.cmd shim on the Path"), "{err}");
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn table_names_are_codexs() {
        assert_eq!(store_dir(), "codex");
        assert_eq!(npm_package(), Some("@openai/codex"));
    }
}
