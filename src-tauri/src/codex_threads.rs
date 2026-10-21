//! Past Codex threads for a folder, for the Rendered tab's Resume picker: starts a
//! short-lived `codex app-server` (same node + codex.js, Job Object and env scrub as
//! agent.rs), runs initialize then `thread/list`, and always kills the tree. Not a tab:
//! nothing here is registered with the AgentManager or emits events. Protocol shape is
//! the 0.160.1 schema (`ThreadListParams`, `Thread`); `runtime/bridge/codex-schema/` holds 0.153.4.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

use crate::proc_job::JobChild;
use crate::pty::SCRUBBED_ENV;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const OVERALL_CAP: Duration = Duration::from_secs(10);
const LABEL_MAX: usize = 80;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRow {
    pub id: String,
    pub label: String,
    pub cwd: String,
    pub age_secs: u64,
    pub model: Option<String>,
}

/// Name when set, else the first non-empty line of the preview, cut to `LABEL_MAX` chars.
fn label_for(name: Option<&str>, preview: &str) -> String {
    let pick = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .or_else(|| preview.lines().map(str::trim).find(|l| !l.is_empty()))
        .unwrap_or("");
    if pick.chars().count() <= LABEL_MAX {
        return pick.to_string();
    }
    let cut: String = pick.chars().take(LABEL_MAX - 3).collect();
    format!("{}...", cut.trim_end())
}

/// `thread/list` result (`{data:[Thread]}`) → rows in server order (newest first).
fn rows_from_result(result: &Value, now_secs: i64) -> Vec<ThreadRow> {
    let Some(data) = result.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    data.iter()
        .filter_map(|t| {
            let id = t.get("id")?.as_str()?.to_string();
            let updated = t.get("updatedAt").and_then(Value::as_i64).unwrap_or(now_secs);
            Some(ThreadRow {
                label: label_for(
                    t.get("name").and_then(Value::as_str),
                    t.get("preview").and_then(Value::as_str).unwrap_or(""),
                ),
                cwd: t.get("cwd").and_then(Value::as_str).unwrap_or("").to_string(),
                age_secs: (now_secs - updated).max(0) as u64,
                model: t.get("model").and_then(Value::as_str).map(str::to_string),
                id,
            })
        })
        .collect()
}

/// The folder as given, plus the same path without trailing separators when that differs
/// (thread/list matches the recorded cwd exactly).
fn cwd_variants(cwd: &str) -> Vec<String> {
    let mut out = vec![cwd.to_string()];
    let trimmed = cwd.trim_end_matches(['\\', '/']);
    if !trimmed.is_empty() && trimmed != cwd && !trimmed.ends_with(':') {
        out.push(trimmed.to_string());
    }
    out
}

/// Waits for the response carrying `id`; other lines (notifications) are skipped.
fn await_response(rx: &mpsc::Receiver<String>, id: u64, deadline: Instant) -> Result<Value, String> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let line = match rx.recv_timeout(left) {
            Ok(l) => l,
            Err(RecvTimeoutError::Timeout) => return Err("Codex did not answer in 10 s".into()),
            Err(RecvTimeoutError::Disconnected) => return Err("Codex exited before answering".into()),
        };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("id").and_then(Value::as_u64) != Some(id) || v.get("method").is_some() {
            continue;
        }
        if let Some(err) = v.get("error") {
            let msg = err.get("message").and_then(Value::as_str).unwrap_or("error");
            return Err(format!("Codex refused the request: {msg}"));
        }
        return Ok(v.get("result").cloned().unwrap_or(Value::Null));
    }
}

/// The `CODEX_HOME` a list call runs under: none for the default home, the Bare profile's home
/// when a profile is named. A profile whose home cannot be resolved is an error, never a
/// fallback to `~\.codex` (trust boundary: a Bare row must not list the default home's threads).
/// A codex row whose home folder was never created (profile never opened) has no threads: `Empty`.
#[derive(Debug, PartialEq)]
enum HomeChoice {
    Default,
    Profile(PathBuf),
    Empty,
}

/// Profile ids are folder names under `profiles\`: `^[a-z0-9][a-z0-9-]*$`, checked before any join.
fn valid_profile_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The resolver's "row present, home folder missing" error (`codex_home_for_profile_with`); the
/// bare tests pin the "does not exist" wording.
fn is_home_missing(err: &str) -> bool {
    err.starts_with("Bare Codex home ") && err.contains("does not exist yet")
}

fn home_for(profile: Option<&str>, resolve: impl Fn(&str) -> Result<PathBuf, String>) -> Result<HomeChoice, String> {
    match profile.map(str::trim).filter(|p| !p.is_empty()) {
        None => Ok(HomeChoice::Default),
        Some(id) if !valid_profile_id(id) => Err(format!("Invalid Bare profile id {id:?}")),
        Some(id) => match resolve(id) {
            Ok(h) => Ok(HomeChoice::Profile(h)),
            Err(e) if is_home_missing(&e) => Ok(HomeChoice::Empty),
            Err(e) => Err(e),
        },
    }
}

fn list_blocking(cwd: &str, profile: Option<&str>) -> Result<Vec<ThreadRow>, String> {
    let deadline = Instant::now() + OVERALL_CAP;
    // Resolved before any process starts; read-only, it never creates a home.
    let home = match home_for(profile, crate::bare::codex_home_for_profile)? {
        HomeChoice::Empty => return Ok(Vec::new()),
        HomeChoice::Default => None,
        HomeChoice::Profile(h) => Some(h),
    };
    let js = crate::agent::codex_js()?;
    let mut cmd = Command::new("node");
    cmd.arg(js)
        .arg("app-server")
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for key in SCRUBBED_ENV {
        cmd.env_remove(key);
    }
    if let Some(h) = &home {
        cmd.env("CODEX_HOME", h);
    }
    let mut child = JobChild::spawn(&mut cmd)?;
    let mut stdin = child.stdin.take().ok_or("missing codex stdin")?;
    let stdout = child.stdout.take().ok_or("missing codex stdout")?;

    let (tx, rx) = mpsc::channel::<String>();
    std::thread::Builder::new()
        .name("codex-threads-stdout".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| e.to_string())?;

    let mut send = |v: Value| -> Result<(), String> {
        writeln!(stdin, "{v}").and_then(|_| stdin.flush()).map_err(|e| e.to_string())
    };
    send(json!({"jsonrpc":"2.0","id":1,"method":"initialize",
        "params":{"clientInfo":{"name":"vidar","title":"Vidar","version":"0.1.0"}}}))?;
    await_response(&rx, 1, deadline)?;
    send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}))?;
    send(json!({"jsonrpc":"2.0","id":2,"method":"thread/list","params":{
        "cwd": cwd_variants(cwd), "sortKey":"updated_at", "limit":30,
        "sourceKinds":["cli","vscode","appServer"]}}))?;
    let result = await_response(&rx, 2, deadline)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    Ok(rows_from_result(&result, now))
}

/// Up to 30 past Codex threads recorded under `cwd`, newest update first. `profile` names a Bare
/// Codex profile: the list then reads that profile's home (empty when the home was never created,
/// error when the profile is unknown or not a Codex row).
#[tauri::command]
pub async fn list_codex_threads(cwd: String, profile: Option<String>) -> Result<Vec<ThreadRow>, String> {
    tauri::async_runtime::spawn_blocking(move || list_blocking(&cwd, profile.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_use_name_then_first_preview_line_and_truncate() {
        let long = "x".repeat(200);
        let result = json!({"data":[
            {"id":"a","name":"Named","preview":"ignored","cwd":"C:\\p","updatedAt":900,"model":"gpt-5"},
            {"id":"b","name":null,"preview":"\n  first line\nsecond","cwd":"C:\\p","updatedAt":990,"model":null},
            {"id":"c","preview":long,"cwd":"C:\\p","updatedAt":2000},
            {"name":"no id"}
        ]});
        let rows = rows_from_result(&result, 1000);
        assert_eq!(rows.len(), 3);
        assert_eq!((rows[0].label.as_str(), rows[0].age_secs, rows[0].model.as_deref()), ("Named", 100, Some("gpt-5")));
        assert_eq!((rows[1].label.as_str(), rows[1].age_secs, rows[1].model.as_deref()), ("first line", 10, None));
        assert_eq!(rows[2].label.chars().count(), LABEL_MAX);
        assert!(rows[2].label.ends_with("..."));
        assert_eq!(rows[2].age_secs, 0);
    }

    #[test]
    fn profiled_call_errors_for_unknown_profiles_and_never_falls_back() {
        // a resolver that cannot find the profile: the call fails, no default-home fallback
        let miss = |id: &str| Err::<PathBuf, String>(format!("no profile {id}"));
        assert!(home_for(Some("bare"), miss).is_err());
        // the real resolver on a root with no profile row also errors
        let root = std::env::temp_dir().join("vidar-a2-no-such-root");
        let real = |id: &str| crate::bare::codex_home_for_profile_with(id, &root, &root);
        assert!(home_for(Some("bare"), real).is_err());
        // no profile (or blank): default home, the resolver is not consulted
        let never = |_: &str| -> Result<PathBuf, String> { panic!("resolver called") };
        assert_eq!(home_for(None, never).unwrap(), HomeChoice::Default);
        assert_eq!(home_for(Some("  "), never).unwrap(), HomeChoice::Default);
        let ok = |_: &str| Ok(PathBuf::from("C:\\h"));
        assert_eq!(home_for(Some("bare"), ok).unwrap(), HomeChoice::Profile(PathBuf::from("C:\\h")));
    }

    #[test]
    fn codex_row_with_missing_home_is_an_empty_list_and_creates_nothing() {
        let t = std::env::temp_dir().join(format!("vidar-a2-missing-home-{}", std::process::id()));
        let dir = t.join("root").join("profiles").join("bare");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(crate::paths::root().join("profiles").join("bare").join("codex.json"), dir.join("codex.json")).unwrap();
        let (root, home) = (t.join("root"), t.join("agent-home"));
        let real = |id: &str| crate::bare::codex_home_for_profile_with(id, &root, &home);
        assert_eq!(home_for(Some("bare"), real).unwrap(), HomeChoice::Empty);
        assert!(!home.exists(), "the lookup created the home");
        // a profile with no row stays an error
        assert!(home_for(Some("nope"), real).is_err());
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn profile_ids_that_could_escape_the_profiles_folder_are_refused() {
        let never = |_: &str| -> Result<PathBuf, String> { panic!("resolver called") };
        for bad in ["..", "../x", "C:\\x", "/abs", "a/b", "a\\b", "-x", "Bare", "a.b"] {
            assert!(home_for(Some(bad), never).is_err(), "{bad}");
        }
        assert!(valid_profile_id("bare") && valid_profile_id("a-1") && valid_profile_id("0x"));
    }

    #[test]
    fn cwd_variant_drops_trailing_separators_but_not_a_drive_root() {
        assert_eq!(cwd_variants("D:\\Work\\x\\"), vec!["D:\\Work\\x\\", "D:\\Work\\x"]);
        assert_eq!(cwd_variants("D:\\Work\\x"), vec!["D:\\Work\\x"]);
        assert_eq!(cwd_variants("C:\\"), vec!["C:\\"]);
    }
}
