use std::fs;
use std::path::PathBuf;

use tauri::AppHandle;

use super::rollout_index::{cached_limits, cached_model, newest_rollout, RolloutLimits};

fn codex_home() -> Option<PathBuf> {
    crate::rules::codex::codex_home() // `$CODEX_HOME`, else `~\.codex`: one resolver for both
}

/// The Codex home a tab runs on: a live bare tab's own `codex-home` (kept on its agent session,
/// agent.rs), else the default `~\.codex`. The fallback also covers a bare tab that is not live
/// (no agent session) or a call with no `tab`; the only caller today sends none.
pub fn codex_home_for(app: &AppHandle, tab: Option<&str>) -> Option<PathBuf> {
    use tauri::Manager; // local: the import block at the top is shared with the Claude half (P4)
    tab.and_then(|t| app.state::<crate::agent::AgentManager>().codex_home(t)).or_else(codex_home)
}

/// The model a raw Codex tab runs, for its character (a raw tab's launcher `model` is only a
/// label; the CLI picks from its own config). The newest top-level `turn_context` in the newest
/// rollout for this cwd, written at turn start, so a `/model` change shows with the next turn;
/// before any rollout exists, `model` from `~/.codex/config.toml`. Off the main thread: a
/// rollout runs to megabytes (`rollout_index` keeps the last answer per file and rereads a file
/// only when its stat changes). `tab` names the tab when it may be a bare one: its own Codex home
/// is read instead of `~\.codex` (`codex_home_for`).
#[tauri::command]
pub async fn read_codex_model(app: AppHandle, cwd: String, tab: Option<String>) -> Option<String> {
    let home = codex_home_for(&app, tab.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        newest_rollout(&home, &cwd)
            .and_then(|p| cached_model(&p))
            .or_else(|| config_model(&fs::read_to_string(home.join("config.toml")).ok()?))
    })
    .await
    .ok()
    .flatten()
}

/// A raw Codex tab's model and account meters from its newest rollout, one read per poll
/// (`rollout_index::cached_limits`). The home is the tab's own (`codex_config::home_for_row`: a live
/// session, else the Bare `profile`'s home, else the default); a Bare profile that cannot resolve
/// reads nothing, never the user's home. Without a rollout only the config model comes back,
/// stamped now; with neither, None. Off the main thread.
#[tauri::command]
pub async fn read_codex_limits(
    app: AppHandle,
    cwd: String,
    tab: Option<String>,
    falcon_session: Option<String>,
    profile: Option<String>,
    row: Option<String>,
) -> Option<RolloutLimits> {
    let home = home_path(crate::codex_config::home_for_row(&app, tab.as_deref(), falcon_session.as_deref(), profile.as_deref(), row.as_deref()))?;
    tauri::async_runtime::spawn_blocking(move || limits_for(&home, &cwd)).await.ok().flatten()
}

/// The directory a resolved `Home` reads from; `NotRunning` (a Bare profile with no home) is None.
fn home_path(home: crate::codex_config::Home) -> Option<PathBuf> {
    use crate::codex_config::Home;
    match home {
        Home::Live(p) | Home::Profile(p) => Some(p),
        Home::Default(p) => p,
        Home::NotRunning => None,
    }
}

fn limits_for(home: &std::path::Path, cwd: &str) -> Option<RolloutLimits> {
    let mut limits = match newest_rollout(home, cwd).and_then(|p| cached_limits(&p)) {
        Some(l) => l,
        None => RolloutLimits {
            observed_ms: std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
            ..Default::default()
        },
    };
    if limits.model.is_none() {
        limits.model = fs::read_to_string(home.join("config.toml")).ok().and_then(|t| config_model(&t));
    }
    (limits.model.is_some() || limits.five_hour.is_some() || limits.seven_day.is_some()).then_some(limits)
}

/// One rollout of a cwd: its session (thread) id and mtime in epoch ms.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RolloutThread {
    pub id: String,
    pub mtime_ms: u64,
}

const ROLLOUT_THREADS_CAP: usize = 32;

/// The home a Raw Codex tab's rollouts are read from: a Bare profile's own `CODEX_HOME`, else the
/// default. A named profile never falls back to the default home: an unknown profile is an error,
/// a home never created has no rollouts (`None`). Profile ids are checked before any join.
fn rollout_home(
    profile: Option<&str>,
    resolve: impl Fn(&str) -> Result<PathBuf, String>,
    default: impl FnOnce() -> Option<PathBuf>,
) -> Result<Option<PathBuf>, String> {
    let Some(id) = profile.map(str::trim).filter(|p| !p.is_empty()) else { return Ok(default()) };
    let mut chars = id.chars();
    let valid = matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(format!("Invalid Bare profile id {id:?}"));
    }
    match resolve(id) {
        Ok(h) => Ok(Some(h)),
        // bare/mod.rs codex_home_for_profile_with: the row exists, its home was never opened
        Err(e) if crate::bare::home_unopened(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

fn rollout_threads(home: &std::path::Path, cwd: &str) -> Vec<RolloutThread> {
    super::rollout_index::entries_newest_first(home, cwd)
        .into_iter()
        .filter_map(|(_, id, m)| {
            let ms = m.duration_since(std::time::SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
            Some(RolloutThread { id: id?, mtime_ms: ms })
        })
        .take(ROLLOUT_THREADS_CAP)
        .collect()
}

/// The threads recorded for `cwd` in a Raw Codex tab's own home (`profile`: its Bare profile),
/// newest rollout first: the tab's live thread is resolved from these when its launch line names
/// none or a stale one (src/panels/sessions/codex-thread.ts). A `tab` whose session recorded a Codex
/// home (its Rune Vault record, `vault::session::find`) reads that home; otherwise the profile's.
/// Reads rollout names and first lines only; never creates a home. Off the main thread.
#[tauri::command]
pub async fn codex_rollout_threads(cwd: String, profile: Option<String>, tab: Option<String>, falcon_session: Option<String>) -> Result<Vec<RolloutThread>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let recorded = recorded_codex_home(&crate::paths::root(), tab.as_deref(), falcon_session.as_deref());
        let home = match recorded {
            Some(h) => Some(h),
            None => rollout_home(profile.as_deref(), crate::bare::codex_home_for_profile, codex_home)?,
        };
        Ok(home.map(|h| rollout_threads(&h, &cwd)).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The Codex home the tab's session record names, Falcon session first, then tab id (`session::find`).
fn recorded_codex_home(root: &std::path::Path, tab: Option<&str>, falcon_session: Option<&str>) -> Option<PathBuf> {
    let tab = tab.map(str::trim).unwrap_or("");
    if tab.is_empty() && falcon_session.is_none_or(str::is_empty) {
        return None;
    }
    crate::bare::vault::session::find(root, tab, falcon_session, None).ok().flatten()
        .filter(|r| r.agent == "codex")
        .map(|r| PathBuf::from(r.home))
}

/// The top-level `model = "..."` of a Codex config.toml (keys before the first table header).
fn config_model(toml: &str) -> Option<String> {
    for line in toml.lines() {
        let line = line.trim();
        if line.starts_with('[') { break; }
        let Some((key, value)) = line.split_once('=') else { continue };
        if key.trim() != "model" { continue; }
        let value = value.split('#').next()?.trim().trim_matches(|c| c == '"' || c == '\'');
        return (!value.is_empty()).then(|| value.to_owned());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{config_model, home_path};
    use crate::codex_config::Home;
    use crate::rules::codex::codex_home_from;
    use std::path::PathBuf;

    #[test]
    fn a_rollout_read_finds_a_readopted_tabs_record_by_its_falcon_session() {
        use crate::bare::vault::{session::{self, VaultPin}, store::Store};
        let root = std::env::temp_dir().join(format!("vidar-codex-rollout-home-{}-{}", std::process::id(), crate::fsx::now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        let vault = Store::open(&root).create("Chosen", None, &[], &[]).unwrap();
        let mut rec = session::record("codex", "hosted", "tab-old", VaultPin { id: vault.id.clone(), hash: vault.hash.clone() }, "C:\\h\\codex", "loadout");
        rec.falcon_session = Some("fs-1".into());
        session::write(&root, &rec).unwrap();
        let got = |tab: Option<&str>, fs: Option<&str>| super::recorded_codex_home(&root, tab, fs);
        assert_eq!(got(Some("tab-new"), None), None, "a new tab id alone finds nothing");
        assert_eq!(got(Some("tab-new"), Some("fs-1")), Some(PathBuf::from("C:\\h\\codex")));
        assert_eq!(got(None, Some("fs-1")), Some(PathBuf::from("C:\\h\\codex")));
        assert_eq!(got(Some("tab-old"), None), Some(PathBuf::from("C:\\h\\codex")));
        assert_eq!(got(Some("tab-new"), Some("fs-other")), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn status_home_path_maps_every_home() {
        let p = |s: &str| PathBuf::from(s);
        assert_eq!(home_path(Home::Live(p("live"))), Some(p("live")));
        assert_eq!(home_path(Home::Profile(p("prof"))), Some(p("prof")));
        assert_eq!(home_path(Home::Default(Some(p("user")))), Some(p("user")));
        assert_eq!(home_path(Home::Default(None)), None);
        assert_eq!(home_path(Home::NotRunning), None);
    }

    #[test]
    fn status_codex_home_honours_codex_home_env() {
        let home = Some(PathBuf::from(r"C:\Users\t"));
        assert_eq!(codex_home_from(Some(r"X:\ch".into()), home.clone()), Some(PathBuf::from(r"X:\ch")));
        assert_eq!(codex_home_from(None, home.clone()), Some(PathBuf::from(r"C:\Users\t\.codex")));
        assert_eq!(codex_home_from(Some("".into()), home), Some(PathBuf::from(r"C:\Users\t\.codex")));
        assert_eq!(codex_home_from(None, None), None);
    }

    #[test]
    fn a_bare_tab_never_reads_the_default_home() {
        use super::rollout_home;
        let never = || -> Option<PathBuf> { panic!("default home read for a Bare tab") };
        let miss = |id: &str| Err::<PathBuf, String>(format!("no profile {id}"));
        assert!(rollout_home(Some("bare"), miss, never).is_err());
        let unopened = |_: &str| Err::<PathBuf, String>("Bare Codex home X:\\h does not exist yet; open the profile once to create it".into());
        assert_eq!(rollout_home(Some("bare"), unopened, never).unwrap(), None);
        let ok = |_: &str| Ok(PathBuf::from(r"X:\bare-home"));
        assert_eq!(rollout_home(Some("bare"), ok, never).unwrap(), Some(PathBuf::from(r"X:\bare-home")));
        for bad in ["..", "a/b", "a\\b", "Bare", "-x"] {
            assert!(rollout_home(Some(bad), ok, never).is_err(), "{bad}");
        }
        // no profile (or blank): the default home, the resolver untouched
        let unused = |_: &str| -> Result<PathBuf, String> { panic!("resolver called") };
        assert_eq!(rollout_home(None, unused, || Some(PathBuf::from(r"C:\u\.codex"))).unwrap(), Some(PathBuf::from(r"C:\u\.codex")));
        assert_eq!(rollout_home(Some(" "), unused, || None).unwrap(), None);
    }

    #[test]
    fn rollout_threads_come_newest_first_from_the_tabs_home_only() {
        use std::time::{Duration, SystemTime};
        let base = std::env::temp_dir().join(format!("vidar-a3r-threads-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let write = |home: &std::path::Path, name: &str, id: &str, age: u64| {
            let dir = home.join("sessions").join("2026").join("10").join("19");
            std::fs::create_dir_all(&dir).unwrap();
            let p = dir.join(name);
            std::fs::write(&p, format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"C:\\\\p\"}}}}\n")).unwrap();
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(SystemTime::now() - Duration::from_secs(age)).unwrap();
        };
        let (bare, default) = (base.join("bare"), base.join("default"));
        write(&bare, "a.jsonl", "bare-old", 300);
        write(&bare, "b.jsonl", "bare-new", 10);
        write(&default, "c.jsonl", "default-newest", 1);
        let ids: Vec<_> = super::rollout_threads(&bare, "C:\\p").into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["bare-new", "bare-old"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn config_model_reads_the_top_level_key_only() {
        let toml = "model_reasoning_effort = \"low\"\nmodel = \"gpt-6-astra\" # default\n[profiles.x]\nmodel = \"other\"\n";
        assert_eq!(config_model(toml).as_deref(), Some("gpt-6-astra"));
        assert_eq!(config_model("[profiles.x]\nmodel = \"other\"\n"), None);
    }
}
