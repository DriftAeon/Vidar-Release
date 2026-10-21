//! src-tauri\src\lab.rs — `lab_item`: the Lab tab's detail for one rune. Cases come from the
//! rune's eval suite (`<library>\evals\<id>\<case>\{prompt.md, case.json}`, read-only, mirroring
//! `tools/lab/cases.mjs`); runs are the rows of `history.jsonl` for that item; `runner_present`
//! says whether `tools/lab/run.mjs` exists. A malformed history line is skipped, never fatal.
//! Paths never leave this module, so no verbatim prefix can leak.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

use crate::rules::rune::check_id;

/// History is read from at most the last this-many bytes (the oldest rows are dropped past it).
const HISTORY_CAP: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ArmCost {
    pub with: Option<Number>,
    pub without: Option<Number>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ArmHash {
    pub with: String,
    pub without: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Scores {
    pub with: Option<Number>,
    pub without: Option<Number>,
    pub delta: Option<Number>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ArmRuns {
    pub with: Vec<Number>,
    pub without: Vec<Number>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PerCase {
    pub case: String,
    pub with: Option<Number>,
    pub without: Option<Number>,
    pub delta: Option<Number>,
    pub runs: ArmRuns,
}

/// One `history.jsonl` row, camelCase; the node runner writes it (`tests/fixtures/lab/history-row.json`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub run_id: String,
    pub item_kind: String,
    pub item: String,
    pub lib: String,
    pub lib_commit: Option<String>,
    pub item_commit: Option<String>,
    pub arm_hash: ArmHash,
    pub cases: u64,
    pub repeats: u64,
    pub sessions: u64,
    pub cost_usd: ArmCost,
    pub scores: Scores,
    pub per_case: Vec<PerCase>,
    pub partial: bool,
    pub dry: bool,
    pub isolation: String,
    pub comparable: bool,
    pub started_at: String,
    /// Instruction file the run measured; only Codex rows carry it (`AGENTS.md`), absent means CLAUDE.md.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaseRow {
    pub name: String,
    pub graders: usize,
    pub tools: Vec<String>,
    /// case.json declares a tool list; otherwise the tool list is the Read display default.
    pub tools_declared: bool,
    pub permission_mode: String,
    pub timeout_sec: u64,
    pub has_prompt: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LabItem {
    pub cases: Vec<CaseRow>,
    pub runs: Vec<HistoryRow>,
    pub runner_present: bool,
    /// The suite folder could not be read (anything but missing).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suite_error: Option<String>,
    /// `history.jsonl` could not be read (anything but missing).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_error: Option<String>,
    /// History lines that were not valid rows.
    pub skipped_lines: usize,
}

const GRADER_TYPES: [&str; 5] = ["regex", "not_regex", "tool_used", "tool_not_used", "file_exists"];
const MODES: [&str; 4] = ["default", "acceptEdits", "plan", "dontAsk"];

/// `confinedError` in `tools/lab/graders.mjs`.
fn confined_error(v: &Value) -> Option<String> {
    let Some(p) = v.as_str().filter(|p| !p.is_empty()) else {
        return Some("path must be a non-empty string".into());
    };
    let drive = p.len() >= 2 && p.as_bytes()[0].is_ascii_alphabetic() && p.as_bytes()[1] == b':';
    if Path::new(p).is_absolute() || drive || p.starts_with('/') || p.starts_with('\\') {
        return Some(format!("path must be relative: {p}"));
    }
    if p.split(['\\', '/']).any(|s| s == "..") {
        return Some(format!("path escapes its folder: {p}"));
    }
    None
}

/// `validateGrader`. The regex pattern is not compiled here: JS and Rust syntaxes differ, so a
/// compile test could reject a pattern the runner accepts.
fn check_grader(g: &Value) -> Result<(), String> {
    let t = g.get("type").and_then(Value::as_str).filter(|t| GRADER_TYPES.contains(t));
    let Some(t) = t else {
        return Err(format!("grader: type must be one of {}", GRADER_TYPES.join(", ")));
    };
    if let Some(w) = g.get("weight") {
        if !w.as_f64().is_some_and(|w| w > 0.0) {
            return Err("grader: weight must be a positive number".into());
        }
    }
    match t {
        "regex" | "not_regex" => {
            if !g.get("pattern").and_then(Value::as_str).is_some_and(|p| !p.is_empty()) {
                return Err(format!("grader {t}: pattern required"));
            }
            if let Some(f) = g.get("flags") {
                if !f.as_str().is_some_and(|f| f.chars().all(|c| "ims".contains(c))) {
                    return Err(format!("grader {t}: flags may be i, m, s"));
                }
            }
        }
        "file_exists" => {
            if let Some(bad) = confined_error(g.get("path").unwrap_or(&Value::Null)) {
                return Err(format!("grader file_exists: {bad}"));
            }
        }
        _ => {
            if !g.get("name").and_then(Value::as_str).is_some_and(|n| !n.is_empty()) {
                return Err(format!("grader {t}: name required"));
            }
        }
    }
    Ok(())
}

/// The `TOOL` pattern: `Name` or `Name(args)` with no `,` `(` `)` inside the args.
fn tool_ok(t: &str) -> bool {
    let (name, rest) = match t.find('(') {
        Some(i) => (&t[..i], Some(&t[i + 1..])),
        None => (t, None),
    };
    let mut ch = name.chars();
    let name_ok = ch.next().is_some_and(|c| c.is_ascii_alphabetic()) && ch.all(|c| c.is_ascii_alphanumeric() || c == '_');
    let args_ok = rest.is_none_or(|r| r.ends_with(')') && !r[..r.len() - 1].contains([',', '(', ')']));
    name_ok && args_ok
}

struct CaseSpec {
    graders: usize,
    tools: Vec<String>,
    tools_declared: bool,
    permission_mode: String,
    timeout_sec: u64,
}

/// `validateCase` plus the file checks `loadCases` makes (prompt, scaffold folder).
fn validate_case(dir: &Path, cfg: &Value) -> Result<CaseSpec, String> {
    let Some(obj) = cfg.as_object() else { return Err("case.json must be an object".into()) };
    let graders = match obj.get("graders").and_then(Value::as_array) {
        Some(g) if !g.is_empty() => g,
        _ => return Err("graders must be a non-empty array".into()),
    };
    graders.iter().try_for_each(check_grader)?;
    let mode = match obj.get("permissionMode") {
        None | Some(Value::Null) => "default",
        Some(Value::String(m)) if m == "bypassPermissions" => return Err("permissionMode bypassPermissions is refused".into()),
        Some(Value::String(m)) if MODES.contains(&m.as_str()) => m.as_str(),
        _ => return Err(format!("permissionMode must be one of {}", MODES.join(", "))),
    };
    let tools_declared = !matches!(cfg.pointer("/tools"), None | Some(Value::Null));
    let tools: Vec<String> = match cfg.pointer("/tools") {
        None | Some(Value::Null) => vec!["Read".into()],
        Some(Value::Array(a)) => {
            let names: Option<Vec<String>> = a.iter().map(|t| t.as_str().filter(|t| tool_ok(t)).map(String::from)).collect();
            names.ok_or("tools must be tool names")?
        }
        _ => return Err("tools must be tool names".into()),
    };
    let timeout = match obj.get("timeoutSec") {
        None | Some(Value::Null) => 120.0,
        Some(v) => v.as_f64().filter(|t| (1.0..=900.0).contains(t)).ok_or("timeoutSec must be 1-900")?,
    };
    if let Some(sc) = obj.get("scaffold") {
        if let Some(bad) = confined_error(sc) {
            return Err(format!("scaffold {bad}"));
        }
        let rel = sc.as_str().unwrap_or_default();
        if !dir.join(rel).is_dir() {
            return Err(format!("scaffold folder not found: {rel}"));
        }
    }
    if !dir.join("prompt.md").is_file() {
        return Err("prompt.md is missing".into());
    }
    Ok(CaseSpec { graders: graders.len(), tools, tools_declared, permission_mode: mode.into(), timeout_sec: timeout as u64 })
}

fn read_case(dir: &Path, name: &str) -> CaseRow {
    let mut row = CaseRow {
        name: name.to_string(),
        graders: 0,
        tools: vec!["Read".into()],
        tools_declared: false,
        permission_mode: "default".into(),
        timeout_sec: 120,
        has_prompt: dir.join("prompt.md").is_file(),
        error: None,
    };
    if let Err(e) = check_id(name) {
        row.error = Some(format!("case name: {e}"));
        return row;
    }
    let cfg = fs::read_to_string(dir.join("case.json"))
        .map_err(|e| format!("case.json unreadable ({e})"))
        .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| format!("case.json unreadable ({e})")))
        .and_then(|v| validate_case(dir, &v));
    match cfg {
        Ok(c) => {
            row.graders = c.graders;
            row.tools = c.tools;
            row.tools_declared = c.tools_declared;
            row.permission_mode = c.permission_mode;
            row.timeout_sec = c.timeout_sec;
        }
        Err(e) => row.error = Some(e),
    }
    row
}

/// Case folders of the suite (sorted); symlinked or junction folders are not followed.
/// A missing suite is an empty list, any other read error is the `Err`.
fn read_cases(lib_root: Option<&Path>, id: &str) -> Result<Vec<CaseRow>, String> {
    let Some(root) = lib_root else { return Ok(Vec::new()) };
    let entries = match fs::read_dir(root.join("evals").join(id)) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("suite unreadable ({e})")),
    };
    let mut out: Vec<CaseRow> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| read_case(&e.path(), &e.file_name().to_string_lossy()))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// A library path as the Node writer stores it: no `\\?\` prefix, forward slashes, no trailing
/// slash; folded to lower case on Windows (the file system ignores case there).
fn lib_key(p: &str) -> String {
    let s = p.strip_prefix(r"\\?\").unwrap_or(p).replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) { s.to_lowercase() } else { s.to_string() }
}

fn canon_lib(root: &Path) -> String {
    lib_key(&root.canonicalize().unwrap_or_else(|_| root.to_path_buf()).to_string_lossy())
}

/// Rows of `id` written for `lib_root`, from the last `cap` bytes of the history, plus the count of
/// lines that were not valid rows. A missing file is no runs; other read errors are the `Err`.
fn read_runs(history: &Path, lib_root: Option<&Path>, id: &str, cap: u64) -> Result<(Vec<HistoryRow>, usize), String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match fs::File::open(history) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
        Err(e) => return Err(format!("history unreadable ({e})")),
    };
    let err = |e: std::io::Error| format!("history unreadable ({e})");
    let len = file.metadata().map_err(err)?.len();
    // start one byte early: the first line is dropped unless that byte is a line break
    let start = len.saturating_sub(cap).saturating_sub(1);
    file.seek(SeekFrom::Start(start)).map_err(err)?;
    let mut bytes = Vec::new();
    file.take(len - start).read_to_end(&mut bytes).map_err(err)?;
    if start > 0 {
        let cut = bytes.iter().position(|&b| b == b'\n').map_or(bytes.len(), |i| i + 1);
        bytes.drain(..cut);
    }
    let Some(want) = lib_root.map(canon_lib) else { return Ok((Vec::new(), 0)) };
    let (mut runs, mut skipped) = (Vec::new(), 0);
    for line in bytes.split(|&b| b == b'\n') {
        let line = line.trim_ascii();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_slice::<HistoryRow>(line) {
            Ok(r) if r.item_kind == "rune" && r.item == id && lib_key(&r.lib) == want => runs.push(r),
            Ok(_) => {}
            Err(_) => skipped += 1,
        }
    }
    Ok((runs, skipped))
}

pub fn item_in(
    lib_root: Option<&Path>,
    history: &Path,
    runner: &Path,
    id: &str,
) -> Result<LabItem, String> {
    check_id(id)?;
    let (cases, suite_error) = match read_cases(lib_root, id) {
        Ok(c) => (c, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    let (runs, skipped_lines, history_error) = match read_runs(history, lib_root, id, HISTORY_CAP) {
        Ok((r, n)) => (r, n, None),
        Err(e) => (Vec::new(), 0, Some(e)),
    };
    Ok(LabItem { cases, runs, runner_present: runner.is_file(), suite_error, history_error, skipped_lines })
}

#[tauri::command]
pub async fn lab_item(library: String, id: String) -> Result<LabItem, String> {
    let root = match library.as_str() {
        "global" => crate::paths::global_runes_dir(),
        "vidar" => Some(crate::paths::runes_dir()),
        _ => return Err(format!("invalid library `{library}`")),
    };
    check_id(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        item_in(root.as_deref(), &crate::paths::lab_history(), &crate::paths::lab_runner(), &id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/lab/history-row.json")
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> TempDir {
            let d = std::env::temp_dir().join(format!("vidar-lab-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&d);
            fs::create_dir_all(&d).unwrap();
            TempDir(d)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lab_item_refuses_bad_ids() {
        let dir = std::env::temp_dir();
        let none = dir.join("vidar-lab-no-such-file");
        for id in ["", "..", "../x", "a/b", "a\\b", "Upper", "a b", "x.json", "-a", "a--b", "con"] {
            assert!(item_in(None, &none, &none, id).is_err(), "id {id}");
        }
        let ok = item_in(None, &none, &none, "lab-alpha").unwrap();
        assert!(ok.cases.is_empty() && ok.runs.is_empty() && !ok.runner_present);
    }

    #[test]
    fn lab_history_row_matches_node_fixture() {
        let text = fs::read_to_string(fixture()).unwrap();
        let want: serde_json::Value = serde_json::from_str(&text).unwrap();
        let row: HistoryRow = serde_json::from_str(&text).unwrap();
        assert_eq!(serde_json::to_value(&row).unwrap(), want);
        assert_eq!(row.item_kind, "rune");
    }

    #[test]
    fn lab_codex_history_row_keeps_its_target() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/lab/history-row-codex.json");
        let text = fs::read_to_string(path).unwrap();
        let want: serde_json::Value = serde_json::from_str(&text).unwrap();
        let row: HistoryRow = serde_json::from_str(&text).unwrap();
        assert_eq!(row.target.as_deref(), Some("AGENTS.md"));
        assert_eq!(serde_json::to_value(&row).unwrap(), want);
        let claude: HistoryRow = serde_json::from_str(&fs::read_to_string(fixture()).unwrap()).unwrap();
        assert_eq!(claude.target, None);
    }

    #[test]
    fn lab_case_reports_declared_tools() {
        let tmp = TempDir::new("declared-tools");
        let suite = tmp.0.join("evals").join("lab-alpha");
        case(&suite, "declared", Some(r#"{"graders":[{"type":"tool_used","name":"Read"}],"tools":["Read","Grep"]}"#), true);
        case(&suite, "plain", Some(r#"{"graders":[{"type":"tool_used","name":"Read"}]}"#), true);
        let cases = read_cases(Some(&tmp.0), "lab-alpha").unwrap();
        let get = |n: &str| cases.iter().find(|c| c.name == n).unwrap();
        assert!(get("declared").tools_declared && get("declared").tools == vec!["Read", "Grep"]);
        assert!(!get("plain").tools_declared && get("plain").tools == vec!["Read"]);
    }

    /// The fixture row as one JSON line with the given item, lib and run id.
    fn row_line(item: &str, lib: &str, run_id: &str) -> String {
        let mut v: Value = serde_json::from_str(&fs::read_to_string(fixture()).unwrap()).unwrap();
        v["item"] = item.into();
        v["lib"] = lib.into();
        v["runId"] = run_id.into();
        v.to_string()
    }

    fn case(suite: &Path, name: &str, json: Option<&str>, prompt: bool) {
        let d = suite.join(name);
        fs::create_dir_all(&d).unwrap();
        if let Some(j) = json {
            fs::write(d.join("case.json"), j).unwrap();
        }
        if prompt {
            fs::write(d.join("prompt.md"), "Say hi\n").unwrap();
        }
    }

    #[test]
    fn lab_item_reads_cases_and_skips_bad_history_lines() {
        let tmp = TempDir::new("item");
        let lib = tmp.0.join("lib");
        let suite = lib.join("evals").join("lab-alpha");
        case(&suite, "greet", Some(r#"{"graders":[{"type":"regex","pattern":"hi"}],"timeoutSec":30}"#), true);
        case(&suite, "broken", Some("{nope"), true);
        case(&suite, "noprompt", Some(r#"{"graders":[{"type":"tool_used","name":"Read"}]}"#), false);
        case(&suite, "bypass", Some(r#"{"graders":[{"type":"tool_used","name":"Read"}],"permissionMode":"bypassPermissions"}"#), true);
        case(&suite, "badtool", Some(r#"{"graders":[{"type":"tool_used","name":"Read"}],"tools":["Bash(a,b)"]}"#), true);
        case(&suite, "slow", Some(r#"{"graders":[{"type":"tool_used","name":"Read"}],"timeoutSec":901}"#), true);
        case(&suite, "grader", Some(r#"{"graders":[{"type":"file_exists","path":"../x"}]}"#), true);
        case(&suite, "scaf", Some(r#"{"graders":[{"type":"tool_used","name":"Read"}],"scaffold":"files"}"#), true);

        let key = canon_lib(&lib);
        let good = row_line("lab-alpha", &key, "r1");
        let other = row_line("other-rune", &key, "r2");
        let hist = tmp.0.join("history.jsonl");
        fs::write(&hist, format!("{good}\nnot json\n{{\"item\":\"lab-alpha\"}}\n{other}\n{good}\n")).unwrap();
        let runner = tmp.0.join("run.mjs");
        fs::write(&runner, "").unwrap();

        let got = item_in(Some(&lib), &hist, &runner, "lab-alpha").unwrap();
        assert!(got.runner_present);
        assert_eq!(got.runs.len(), 2);
        assert_eq!(got.skipped_lines, 2);
        let names: Vec<&str> = got.cases.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["badtool", "broken", "bypass", "grader", "greet", "noprompt", "scaf", "slow"]);
        let bad: Vec<&str> = got.cases.iter().filter(|c| c.error.is_some()).map(|c| c.name.as_str()).collect();
        assert_eq!(bad, vec!["badtool", "broken", "bypass", "grader", "noprompt", "scaf", "slow"]);
        let greet = got.cases.iter().find(|c| c.name == "greet").unwrap();
        assert_eq!((greet.graders, greet.timeout_sec, greet.has_prompt, greet.error.clone()), (1, 30, true, None));
        assert!(got.cases.iter().find(|c| c.name == "noprompt").unwrap().error.as_deref().unwrap().contains("prompt.md"));
        // a scaffold folder that exists makes the case clean
        fs::create_dir_all(suite.join("scaf").join("files")).unwrap();
        let again = item_in(Some(&lib), &hist, &runner, "lab-alpha").unwrap();
        assert!(again.cases.iter().find(|c| c.name == "scaf").unwrap().error.is_none());
    }

    #[test]
    fn lab_item_matches_history_rows_to_the_library() {
        let tmp = TempDir::new("lib");
        let lib = tmp.0.join("lib");
        fs::create_dir_all(&lib).unwrap();
        let elsewhere = tmp.0.join("elsewhere");
        let key = canon_lib(&lib);
        let hist = tmp.0.join("history.jsonl");
        let lines = [
            row_line("lab-alpha", &key, "mine"),
            row_line("lab-alpha", &canon_lib(&elsewhere), "theirs"),
            row_line("lab-alpha", &format!("{}/", key.to_uppercase()), "mine-upper"),
        ];
        fs::write(&hist, lines.join("\n") + "\n").unwrap();
        let got = item_in(Some(&lib), &hist, &tmp.0.join("none"), "lab-alpha").unwrap();
        let ids: Vec<&str> = got.runs.iter().map(|r| r.run_id.as_str()).collect();
        assert_eq!(ids, if cfg!(windows) { vec!["mine", "mine-upper"] } else { vec!["mine"] });
        assert!(item_in(None, &hist, &tmp.0.join("none"), "lab-alpha").unwrap().runs.is_empty());
    }

    #[test]
    fn lab_history_reads_the_tail_and_survives_cut_characters() {
        let tmp = TempDir::new("tail");
        let key = canon_lib(&tmp.0);
        let hist = tmp.0.join("history.jsonl");
        let old = row_line("lab-alpha", &key, "old");
        let new = row_line("lab-alpha", &key, "new");
        // a multi-byte tail char inside the old row would be cut by the window
        let mut bytes = "é".repeat(40).into_bytes();
        bytes.push(b'\n');
        bytes.extend(old.bytes());
        bytes.push(b'\n');
        bytes.extend(new.bytes());
        bytes.push(b'\n');
        fs::write(&hist, &bytes).unwrap();
        let cap = new.len() as u64 + 1 + 10; // the new row plus part of the old one
        let (runs, skipped) = read_runs(&hist, Some(&tmp.0), "lab-alpha", cap).unwrap();
        assert_eq!(runs.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(), vec!["new"]);
        assert_eq!(skipped, 0, "the partial first line is dropped, not counted");
        let (all, _) = read_runs(&hist, Some(&tmp.0), "lab-alpha", HISTORY_CAP).unwrap();
        assert_eq!(all.len(), 2);
        // a window starting exactly at a line start keeps that line
        let exact = new.len() as u64 + 1;
        let (runs, _) = read_runs(&hist, Some(&tmp.0), "lab-alpha", exact).unwrap();
        assert_eq!(runs.len(), 1);
        let err = read_runs(&tmp.0, Some(&tmp.0), "lab-alpha", HISTORY_CAP);
        assert!(err.is_err(), "a directory is a read error, not empty data");
    }
}
