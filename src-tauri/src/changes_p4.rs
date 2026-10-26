// Changes tab, Perforce side (read-only): the files opened in the folder's p4 workspace, grouped by
// pending changelist. `changes_p4_status` runs `p4 -ztag info`, `opened -C <client>` and
// `changes -s pending -c <client> -l`, nothing that writes.
//
// Trust boundary: cwd must be an existing directory and is only p4's working directory; no path
// from the frontend reaches p4's arguments (the client name comes from p4's own `info`). P4 env
// (P4PORT, P4USER, P4CLIENT, P4CONFIG, `p4 set`) is p4's own; nothing is passed. No mutex: every
// call is a read. Only `info` is cached (per folder, 60 s); opened and changes read fresh.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::proc_job::JobChild;

const TIMEOUT: Duration = Duration::from_secs(15);
const CAP: usize = 4 * 1024 * 1024;
const STDERR_CAP: u64 = 64 * 1024;
const INFO_TTL: Duration = Duration::from_secs(60);
const INFO_CAP: usize = 8;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct P4File {
    pub depot_file: String,
    pub path: String,
    pub rel: String,
    pub action: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct P4Change {
    pub change: String,
    pub description: String,
    pub files: Vec<P4File>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum P4Status {
    NoP4 { reason: String },
    P4 { client: String, user: String, port: String, root: String, changes: Vec<P4Change> },
}

#[derive(Clone, Debug, PartialEq)]
struct Info {
    user: String,
    client: String,
    root: String,
    port: String,
}

// ---------- ztag parsing ----------

type Record = Vec<(String, String)>;

/// `-ztag` text: records of `... <key> <value>` lines (value may be empty) separated by blank
/// lines. A line not starting `... ` continues the previous value after a `\n`; a blank line that
/// is followed by such a line sits inside the value (a description with a paragraph break).
fn parse_ztag(text: &str) -> Vec<Record> {
    let mut out: Vec<Record> = Vec::new();
    let mut cur: Record = Vec::new();
    let mut blanks = 0usize;
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            blanks += 1;
            continue;
        }
        if let Some(rest) = line.strip_prefix("... ") {
            if blanks > 0 && !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            blanks = 0;
            let (k, v) = rest.split_once(' ').unwrap_or((rest, ""));
            cur.push((k.to_string(), v.to_string()));
        } else if let Some(last) = cur.last_mut() {
            for _ in 0..=blanks { last.1.push('\n'); }
            blanks = 0;
            last.1.push_str(line);
        } else {
            blanks = 0;
        }
    }
    if !cur.is_empty() { out.push(cur); }
    out
}

fn field<'a>(r: &'a Record, key: &str) -> Option<&'a str> {
    r.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

// ---------- status building ----------

/// `//<client>/a/b.c` → (`<root>\a\b.c`, `a/b.c`). A client file outside the client's namespace
/// is shown as it came.
fn local_paths(client_file: &str, client: &str, root: &str) -> (String, String) {
    let prefix = format!("//{client}/");
    let rest = client_file
        .get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(&prefix))
        .map(|_| &client_file[prefix.len()..]);
    match rest {
        Some(rest) => {
            let root = root.trim_end_matches(['\\', '/']);
            (format!("{root}\\{}", rest.replace('/', "\\")), rest.to_string())
        }
        None => (client_file.to_string(), client_file.to_string()),
    }
}

fn first_line(s: &str) -> String {
    s.trim().lines().next().unwrap_or("").trim().to_string()
}

/// The status from the three outputs. Default first (only with files), then each pending
/// changelist in `changes` order; a changelist with opened files but not in the list follows.
fn build_status(info: &Info, opened: &str, changes: &str) -> P4Status {
    let mut by_change: Vec<(String, Vec<P4File>)> = Vec::new();
    for r in parse_ztag(opened) {
        let Some(depot) = field(&r, "depotFile") else { continue };
        let change = field(&r, "change").unwrap_or("default").to_string();
        let client_file = field(&r, "clientFile").unwrap_or(depot);
        let (path, rel) = local_paths(client_file, &info.client, &info.root);
        let file = P4File {
            depot_file: depot.to_string(),
            path,
            rel,
            action: field(&r, "action").unwrap_or("").to_string(),
            kind: field(&r, "type").unwrap_or("").to_string(),
        };
        match by_change.iter_mut().find(|(c, _)| *c == change) {
            Some((_, v)) => v.push(file),
            None => by_change.push((change, vec![file])),
        }
    }
    let mut take = |c: &str| -> Vec<P4File> {
        by_change.iter().position(|(k, _)| k == c).map(|i| by_change.remove(i).1).unwrap_or_default()
    };
    let mut out: Vec<P4Change> = Vec::new();
    let default = take("default");
    if !default.is_empty() {
        out.push(P4Change { change: "default".into(), description: String::new(), files: default });
    }
    for r in parse_ztag(changes) {
        let Some(n) = field(&r, "change") else { continue };
        let files = take(n);
        out.push(P4Change { change: n.to_string(), description: field(&r, "desc").unwrap_or("").trim_end().to_string(), files });
    }
    for (change, files) in by_change {
        out.push(P4Change { change, description: String::new(), files });
    }
    P4Status::P4 { client: info.client.clone(), user: info.user.clone(), port: info.port.clone(), root: info.root.clone(), changes: out }
}

fn info_from(text: &str) -> Result<Info, String> {
    let rec = parse_ztag(text).into_iter().next().unwrap_or_default();
    let get = |k: &str| field(&rec, k).unwrap_or("").to_string();
    let client = get("clientName");
    if client.is_empty() || client == "*unknown*" {
        return Err("No Perforce Workspace for This Folder".into());
    }
    Ok(Info { user: get("userName"), client, root: get("clientRoot"), port: get("serverAddress") })
}

// ---------- running p4 ----------

fn spawn(program: &Path, cwd: &Path, args: &[&str]) -> std::io::Result<JobChild> {
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    JobChild::spawn_io(&mut cmd)
}

/// PATH first, then `%ProgramFiles%\Perforce\p4.exe`; only a missing program falls through.
fn start(cwd: &Path, args: &[&str]) -> Result<JobChild, String> {
    match spawn(Path::new("p4"), cwd, args) {
        Ok(c) => Ok(c),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).map(|p| p.join("Perforce").join("p4.exe"));
            match pf.filter(|p| p.is_file()) {
                Some(p) => spawn(&p, cwd, args).map_err(|e| format!("p4 not runnable: {e}")),
                None => Err("p4 not found.".into()),
            }
        }
        Err(e) => Err(format!("p4 not runnable: {e}")),
    }
}

/// Ok((exit code, stdout, stderr, stdout over the cap)) whenever p4 ran to the end; Err for a spawn
/// failure or timeout.
fn run(cwd: &Path, args: &[&str]) -> Result<(Option<i32>, String, String, bool), String> {
    let mut child = start(cwd, args)?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let out_thread = thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => push_capped(&mut kept, &mut truncated, &chunk[..n]),
            }
        }
        (kept, truncated)
    });
    let err_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stderr).take(STDERR_CAP).read_to_end(&mut buf);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        buf
    });
    let started = Instant::now();
    let waited: Result<std::process::ExitStatus, String> = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Ok(st),
            Ok(None) => {
                if started.elapsed() > TIMEOUT {
                    break Err(format!("p4 timed out after {}s", TIMEOUT.as_secs()));
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => break Err(format!("p4 wait failed: {e}")),
        }
    };
    child.kill();
    let _ = child.wait();
    let out = out_thread.join();
    let err = err_thread.join();
    let status = waited?;
    let out = out.map_err(|_| "stdout reader panicked")?;
    let err = err.map_err(|_| "stderr reader panicked")?;
    let (out, truncated) = out;
    Ok((status.code(), String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).trim().to_string(), truncated))
}

/// Keep a chunk unless it would pass the cap; once one does, nothing after it is kept either.
fn push_capped(kept: &mut Vec<u8>, truncated: &mut bool, chunk: &[u8]) {
    if *truncated { return; }
    if kept.len() + chunk.len() <= CAP { kept.extend_from_slice(chunk); } else { *truncated = true; }
}

/// Failure text for a p4 call that ended non-zero: stderr's first line (the next non-empty line
/// when that one ends in `:`, as in "Perforce client error:"), else stdout's, else the code.
fn failure(code: Option<i32>, out: &str, err: &str) -> String {
    let mut lines = err.lines().map(str::trim).filter(|l| !l.is_empty());
    if let Some(first) = lines.next() {
        if first.ends_with(':') {
            if let Some(next) = lines.next() { return next.to_string(); }
        }
        return first.to_string();
    }
    let o = first_line(out);
    if !o.is_empty() { return o; }
    format!("p4 failed ({})", code.map_or("no exit code".to_string(), |c| format!("exit code {c}")))
}

/// Notice for a call whose stdout went over the cap (refused, never shown truncated).
fn over_cap(what: &str) -> String {
    format!("p4 {what} output is over 4 MiB")
}

type InfoCache = HashMap<String, (Instant, Result<Info, String>)>;
static INFO: Mutex<Option<InfoCache>> = Mutex::new(None);

/// A failed `info` is cached as long as a good one, so a down server is asked once a minute.
fn info_for(cwd: &str, dir: &Path) -> Result<Info, String> {
    {
        let g = INFO.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, i)) = g.as_ref().and_then(|m| m.get(cwd)) {
            if at.elapsed() < INFO_TTL { return i.clone(); }
        }
    }
    let res = run(dir, &["-ztag", "info"]).and_then(|(code, out, err, truncated)| {
        if truncated { return Err(over_cap("info")); }
        if code != Some(0) { return Err(failure(code, &out, &err)); }
        info_from(&out)
    });
    let mut g = INFO.lock().unwrap_or_else(|p| p.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    if !m.contains_key(cwd) && m.len() >= INFO_CAP { m.clear(); }
    m.insert(cwd.to_string(), (Instant::now(), res.clone()));
    res
}

fn status_blocking(cwd: &str) -> Result<P4Status, String> {
    let dir = Path::new(cwd);
    if !dir.is_dir() { return Err("not a folder".into()); }
    let no_p4 = |reason: String| Ok(P4Status::NoP4 { reason });
    let info = match info_for(cwd, dir) {
        Ok(i) => i,
        Err(reason) => return no_p4(reason),
    };
    let (code, opened, err, truncated) = match run(dir, &["-ztag", "opened", "-C", &info.client]) {
        Ok(r) => r,
        Err(reason) => return no_p4(reason),
    };
    if truncated { return no_p4(over_cap("opened")); }
    // nothing opened is p4's message, not a failure
    let nothing = err.contains("not opened on this client") || opened.contains("not opened on this client");
    if code != Some(0) && !nothing { return no_p4(failure(code, &opened, &err)); }
    let opened = if nothing { String::new() } else { opened };
    let (code, changes, err, truncated) = match run(dir, &["-ztag", "changes", "-s", "pending", "-c", &info.client, "-l"]) {
        Ok(r) => r,
        Err(reason) => return no_p4(reason),
    };
    if truncated { return no_p4(over_cap("changes")); }
    if code != Some(0) { return no_p4(failure(code, &changes, &err)); }
    Ok(build_status(&info, &opened, &changes))
}

#[tauri::command]
pub async fn changes_p4_status(cwd: String) -> Result<P4Status, String> {
    tauri::async_runtime::spawn_blocking(move || status_blocking(&cwd))
        .await
        .map_err(|e| format!("changes_p4_status task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const INFO: &str = "... userName p4user\n... clientName ws1\n... clientRoot D:\\Work\\ws1\\\n... serverAddress perforce:1666\n... serverVersion P4D/NTX64/2024.1\n";

    const OPENED: &str = "\
... depotFile //depot/a/one.cpp
... clientFile //ws1/a/one.cpp
... rev 3
... action edit
... change default
... type text

... depotFile //depot/b/two.h
... clientFile //ws1/b/two.h
... action add
... change 1234
... type text+x

... depotFile //depot/c/three.txt
... clientFile //ws1/c/three.txt
... action move/delete
... change 1234
... type
";

    const CHANGES: &str = "\
... change 1234
... time 1700000000
... user p4user
... client ws1
... status pending
... desc Fix the thing
Second line of the description

Third paragraph

... change 1100
... status pending
... desc Empty one
";

    #[test]
    fn changes_p4_ztag_multi_record_and_empty_value() {
        let recs = parse_ztag(OPENED);
        assert_eq!(recs.len(), 3);
        assert_eq!(field(&recs[0], "change"), Some("default"));
        assert_eq!(field(&recs[1], "type"), Some("text+x"));
        assert_eq!(field(&recs[2], "type"), Some(""));
        assert_eq!(field(&recs[2], "action"), Some("move/delete"));
    }

    #[test]
    fn changes_p4_ztag_multiline_desc() {
        let recs = parse_ztag(CHANGES);
        assert_eq!(recs.len(), 2);
        assert_eq!(field(&recs[0], "desc").unwrap().trim_end(), "Fix the thing\nSecond line of the description\n\nThird paragraph");
        assert_eq!(field(&recs[1], "change"), Some("1100"));
        assert_eq!(field(&recs[1], "desc"), Some("Empty one"));
    }

    #[test]
    fn changes_p4_info_and_unknown_client() {
        let i = info_from(INFO).unwrap();
        assert_eq!((i.user.as_str(), i.client.as_str(), i.port.as_str()), ("p4user", "ws1", "perforce:1666"));
        assert_eq!(info_from("... clientName *unknown*\n... userName p4user\n").unwrap_err(), "No Perforce Workspace for This Folder");
        assert!(info_from("... userName p4user\n").is_err());
    }

    #[test]
    fn changes_p4_status_groups_default_first_then_pending_order() {
        let info = info_from(INFO).unwrap();
        let P4Status::P4 { client, root, changes, .. } = build_status(&info, OPENED, CHANGES) else { panic!("not p4") };
        assert_eq!(client, "ws1");
        assert_eq!(root, "D:\\Work\\ws1\\");
        let ids: Vec<&str> = changes.iter().map(|c| c.change.as_str()).collect();
        assert_eq!(ids, ["default", "1234", "1100"]);
        assert_eq!(changes[0].description, "");
        assert_eq!(changes[1].files.len(), 2);
        assert!(changes[2].files.is_empty());
        let f = &changes[0].files[0];
        assert_eq!(f.path, "D:\\Work\\ws1\\a\\one.cpp");
        assert_eq!(f.rel, "a/one.cpp");
        assert_eq!(f.depot_file, "//depot/a/one.cpp");
    }

    #[test]
    fn changes_p4_default_is_left_out_when_empty() {
        let info = info_from(INFO).unwrap();
        let only_numbered = "... depotFile //depot/x\n... clientFile //ws1/x\n... action edit\n... change 1234\n... type text\n";
        let P4Status::P4 { changes, .. } = build_status(&info, only_numbered, CHANGES) else { panic!("not p4") };
        assert_eq!(changes.iter().map(|c| c.change.as_str()).collect::<Vec<_>>(), ["1234", "1100"]);
    }

    #[test]
    fn changes_p4_failure_skips_header_line_ending_in_colon() {
        let err = "Perforce client error:\n\n\tConnect to server failed; check $P4PORT.\n\tTCP connect to perforce:1666 failed.";
        assert_eq!(failure(Some(1), "", err), "Connect to server failed; check $P4PORT.");
        assert_eq!(failure(Some(1), "", "Perforce client error:"), "Perforce client error:");
        assert_eq!(failure(Some(1), "", "plain failure\nmore"), "plain failure");
        assert_eq!(failure(Some(2), "", ""), "p4 failed (exit code 2)");
    }

    #[test]
    fn changes_p4_stdout_cap_keeps_nothing_after_overflow() {
        let mut kept = Vec::new();
        let mut truncated = false;
        push_capped(&mut kept, &mut truncated, &vec![1u8; CAP - 10]);
        assert!(!truncated);
        push_capped(&mut kept, &mut truncated, &[2u8; 64]);
        assert!(truncated);
        push_capped(&mut kept, &mut truncated, &[3u8; 4]);
        assert_eq!(kept.len(), CAP - 10);
        assert!(truncated);
        assert_eq!(over_cap("opened"), "p4 opened output is over 4 MiB");
    }

    #[test]
    fn changes_p4_client_prefix_matches_case_insensitively() {
        let (path, rel) = local_paths("//WS1/a/one.cpp", "ws1", "D:\\Work\\ws1");
        assert_eq!((path.as_str(), rel.as_str()), ("D:\\Work\\ws1\\a\\one.cpp", "a/one.cpp"));
        let (path, rel) = local_paths("//other/a.c", "ws1", "D:\\Work\\ws1");
        assert_eq!((path.as_str(), rel.as_str()), ("//other/a.c", "//other/a.c"));
    }

    #[test]
    fn changes_p4_wire_shape() {
        let v = serde_json::to_value(P4Status::NoP4 { reason: "x".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "no-p4", "reason": "x" }));
        let info = info_from(INFO).unwrap();
        let v = serde_json::to_value(build_status(&info, OPENED, CHANGES)).unwrap();
        assert_eq!(v["kind"], "p4");
        assert_eq!(v["changes"][0]["files"][0]["depotFile"], "//depot/a/one.cpp");
        assert_eq!(v["changes"][0]["files"][0]["type"], "text");
    }
}
