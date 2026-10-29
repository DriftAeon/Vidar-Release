//! `codex_list_models`: the Codex model catalog without a tab. Starts the Codex app-server the
//! Codex Rendered Bare row would start (`bare::prepare_codex`, the same home, env, program and
//! args as `agent.rs spawn_codex_appserver`), sends `initialize`, then `model/list` page by page
//! as `src/agents/codex.ts` does, and ends the process tree on every path.
//!
//! Lifecycle: the child is a `JobChild` (suspended, joined to a kill-on-close job, then resumed,
//! `CREATE_NO_WINDOW`), so a success, an error reply, a closed stdout, a timeout or a panic all
//! end node, codex.exe and anything they started: the explicit `kill` below, and `Drop` behind it.
//! No session is registered and no `agent-event` is emitted: no tab sees this process.
//!
//! The rows go back raw (each page's `data`); the webview maps them with the Codex adapter's own
//! catalog (`codex-settings.ts`), so the saved `codexModels` has the shape a tab saves.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::proc_job::JobChild;

/// The whole exchange (initialize and every page) after the spawn.
const TIMEOUT: Duration = Duration::from_secs(15);
/// The catalog is a handful of rows; a cursor that keeps going is a loop (falcon/events.rs).
const MAX_PAGES: usize = 10;
/// How long a child that got EOF on stdin may take to exit before the job ends it.
const GRACE: Duration = Duration::from_millis(500);
/// The launch record's tab name (`bare/manifest.rs`); no tab carries it.
const TAB: &str = "codex-models";

/// One request line, in the adapter's framing (codex.ts `request`).
fn request(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// The reply to request `id`: its `result`, or the error the app-server named. Notifications and
/// server requests (anything with a `method`) and other ids are skipped.
fn wait(rx: &Receiver<String>, id: u64, method: &str, deadline: Instant) -> Result<Value, String> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(format!("{method}: timed out"));
        }
        let line = match rx.recv_timeout(left) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => return Err(format!("{method}: timed out")),
            Err(RecvTimeoutError::Disconnected) => return Err(format!("{method}: the app-server closed its output")),
        };
        let Ok(frame) = serde_json::from_str::<Value>(&line) else { continue };
        if frame.get("method").is_some() || frame.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(err) = frame.get("error") {
            let message = err.get("message").and_then(Value::as_str).unwrap_or("error");
            return Err(format!("{method}: {message}"));
        }
        return Ok(frame.get("result").cloned().unwrap_or_else(|| json!({})));
    }
}

/// The protocol half, pure over a line sink and a line channel: initialize, `initialized`, then
/// `model/list` pages until no `nextCursor` (or `MAX_PAGES`). Each page's `data` is kept as sent.
fn exchange(mut send: impl FnMut(&Value) -> Result<(), String>, rx: &Receiver<String>, deadline: Instant) -> Result<Vec<Value>, String> {
    send(&request(1, "initialize", json!({
        "clientInfo": { "name": "vidar", "title": "Vidar", "version": "0.1.0" },
        "capabilities": { "experimentalApi": true },
    })))?;
    wait(rx, 1, "initialize", deadline)?;
    send(&json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }))?;
    let mut pages = Vec::new();
    let mut cursor: Option<String> = None;
    let mut id = 2;
    loop {
        let params = cursor.as_ref().map_or_else(|| json!({}), |c| json!({ "cursor": c }));
        send(&request(id, "model/list", params))?;
        let result = wait(rx, id, "model/list", deadline)?;
        pages.push(result.get("data").cloned().unwrap_or_else(|| json!([])));
        cursor = result.get("nextCursor").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string);
        if cursor.is_none() || pages.len() >= MAX_PAGES {
            return Ok(pages);
        }
        id += 1;
    }
}

/// The agent id parsed once; only Codex has a model list, any other id is refused.
fn admit(agent: &str) -> Result<(), String> {
    let refuse = || format!("The Codex model list is for Codex only (agent {agent:?}); spawn refused");
    match crate::agent_spec::parse(agent).ok_or_else(refuse)? {
        crate::agent_spec::Agent::Codex => crate::bare::admit_rendered("bare", Some("codex"), None),
        crate::agent_spec::Agent::Claude => Err(refuse()),
    }
}

/// Spawns, asks, ends. Every return after the spawn goes through the kill below.
fn fetch() -> Result<Vec<Value>, String> {
    admit("codex")?;
    // The model list asks Codex on the stock vault, never a row's sets.
    let opts = crate::bare::LaunchOpts { row_key: None, config: None, claude_json: None, vault: Some("stock-codex"), custom_sets: None };
    // Bare prepares stay serialized in-process (agent.rs, pty.rs); held until the spawn is in.
    let prepare_guard = crate::pty::BARE_PREPARE.lock().unwrap_or_else(|e| e.into_inner());
    // No launch folder: config.toml gets no trusted project, and nothing runs in a project.
    let mut launch = crate::bare::prepare_codex("bare", &opts, "")?;
    let names: Vec<String> = launch.env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
    let manifest = launch.write_manifest(TAB, names.iter().map(String::as_str))?;
    let cwd: PathBuf = launch.codex_home.clone();
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args).current_dir(&cwd).env_clear();
    for (key, value) in launch.env.iter() {
        cmd.env(key, value);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let spawned = JobChild::spawn(&mut cmd);
    drop(launch); // releases the home lock
    drop(prepare_guard);
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            let _ = std::fs::remove_file(&manifest); // no process, so no launch record
            return Err(format!("codex app-server: {e}"));
        }
    };
    let (mut stdin, stdout) = match child.stdin.take().zip(child.stdout.take()) {
        Some(pipes) => pipes,
        None => {
            child.kill();
            let _ = child.wait();
            return Err("codex app-server: missing pipes".into());
        }
    };
    let (tx, rx) = mpsc::channel();
    let reader = thread::Builder::new().name("codex-models-stdout".into()).spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let result = match &reader {
        Ok(_) => exchange(
            |frame| writeln!(stdin, "{frame}").and_then(|_| stdin.flush()).map_err(|e| format!("codex app-server stdin: {e}")),
            &rx,
            Instant::now() + TIMEOUT,
        ),
        Err(e) => Err(format!("codex app-server reader: {e}")),
    };
    drop(stdin); // EOF: the app-server's own way out
    let grace = Instant::now() + GRACE;
    while Instant::now() < grace && matches!(child.try_wait(), Ok(None)) {
        thread::sleep(Duration::from_millis(20));
    }
    child.kill(); // the whole tree, exited or not
    let _ = child.wait();
    if let Ok(handle) = reader {
        let _ = handle.join(); // the tree is gone, so stdout is at EOF
    }
    result
}

/// The Codex catalog as raw `model/list` pages (`data` per page); Err names why none came.
#[tauri::command]
pub async fn codex_list_models() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(fetch).await.map_err(|e| format!("model fetch task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Sender;

    #[test]
    fn only_codex_is_admitted_for_the_model_list() {
        assert!(admit("codex").is_ok());
        assert!(admit("grok").is_err());
        assert!(admit("claude").is_err());
    }

    /// A fake app-server: `answer` maps each sent frame to the lines it writes back.
    fn run(answer: impl Fn(&Value) -> Vec<Value>, timeout: Duration) -> (Result<Vec<Value>, String>, Vec<Value>) {
        let (tx, rx): (Sender<String>, Receiver<String>) = mpsc::channel();
        let mut sent = Vec::new();
        let result = exchange(
            |frame| {
                sent.push(frame.clone());
                for line in answer(frame) {
                    tx.send(line.to_string()).unwrap();
                }
                Ok(())
            },
            &rx,
            Instant::now() + timeout,
        );
        (result, sent)
    }

    fn reply(frame: &Value, result: Value) -> Value {
        json!({ "id": frame["id"], "result": result })
    }

    #[test]
    fn pages_follow_the_cursor_after_initialize() {
        let (result, sent) = run(
            |f| match f["method"].as_str() {
                Some("initialize") => vec![json!({ "method": "note", "params": {} }), reply(f, json!({}))],
                Some("model/list") if f["params"].get("cursor").is_none() => {
                    vec![reply(f, json!({ "data": [{ "model": "gpt-a" }], "nextCursor": "c2" }))]
                }
                Some("model/list") => vec![reply(f, json!({ "data": [{ "model": "gpt-b" }], "nextCursor": null }))],
                _ => vec![],
            },
            Duration::from_secs(5),
        );
        let pages = result.unwrap();
        assert_eq!(pages, vec![json!([{ "model": "gpt-a" }]), json!([{ "model": "gpt-b" }])]);
        let methods: Vec<&str> = sent.iter().map(|f| f["method"].as_str().unwrap()).collect();
        assert_eq!(methods, ["initialize", "initialized", "model/list", "model/list"]);
        assert!(sent[1].get("id").is_none(), "initialized is a notification");
        assert_eq!(sent[3]["params"]["cursor"], "c2");
    }

    #[test]
    fn an_error_reply_names_the_method() {
        let (result, _) = run(
            |f| match f["method"].as_str() {
                Some("initialize") => vec![reply(f, json!({}))],
                Some("model/list") => vec![json!({ "id": f["id"], "error": { "message": "not logged in" } })],
                _ => vec![],
            },
            Duration::from_secs(5),
        );
        assert_eq!(result.unwrap_err(), "model/list: not logged in");
    }

    #[test]
    fn silence_times_out() {
        let (result, sent) = run(|_| vec![], Duration::from_millis(50));
        assert_eq!(result.unwrap_err(), "initialize: timed out");
        assert_eq!(sent.len(), 1);
    }

    #[test]
    fn a_cursor_that_never_ends_stops_at_the_page_cap() {
        let (result, _) = run(
            |f| match f["method"].as_str() {
                Some("initialize") => vec![reply(f, json!({}))],
                Some("model/list") => vec![reply(f, json!({ "data": [], "nextCursor": "again" }))],
                _ => vec![],
            },
            Duration::from_secs(5),
        );
        assert_eq!(result.unwrap().len(), MAX_PAGES);
    }

    /// The real fetch against the installed Codex, through this checkout's Bare home. Spawns and
    /// ends one app-server; run by hand: `cargo test codex_models -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_fetch_prints_the_model_count() {
        let started = Instant::now();
        match fetch() {
            Ok(pages) => {
                let rows: usize = pages.iter().map(|p| p.as_array().map_or(0, Vec::len)).sum();
                println!("codex model/list: {} page(s), {rows} model(s), {:?}", pages.len(), started.elapsed());
            }
            Err(e) => println!("codex model/list failed after {:?}: {e}", started.elapsed()),
        }
    }
}
