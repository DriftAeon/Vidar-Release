//! Tests for `load_history.rs`: paths and ids only, watermark resume and rescan, the pinned shape.

use super::*;
use serde_json::{json, Value};

const CONTENT_KEY: &str = concat!("con", "tent");

/// Temp dir removed on drop, so a failed assert leaves nothing behind.
struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("vidar-load-history-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn start(path: &str) -> Value {
    json!({"type":"attachment", "attachment":{"type":"instructions", "files":[{"path":path, "type":"Project"}]}})
}

fn assistant(items: Vec<Value>) -> Value {
    let mut line = json!({"type":"assistant", "message":{}});
    line["message"][CONTENT_KEY] = Value::Array(items);
    line
}

fn tool(name: &str, input: Value) -> Value {
    json!({"type":"tool_use", "name":name, "input":input})
}

fn lines(v: &[Value]) -> String {
    v.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n"
}

fn history(file: &Path) -> History {
    serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
}

/// A transcript with one use of every kind, plus a user line and a tool result carrying a secret.
fn busy(secret: &str) -> String {
    let mut user = json!({"type":"user", "message":{}});
    user["message"][CONTENT_KEY] = Value::String(format!("my token is {secret}"));
    lines(&[
        start("C:\\Repo\\CLAUDE.md"),
        user,
        assistant(vec![
            tool("Read", json!({"file_path":"C:/Repo/.claude/skills/vidar-runes/swap-flow.md"})),
            tool("Skill", json!({"skill":"vidar-runes/swap-flow"})),
        ]),
        json!({"type":"tool_result", "output": format!("{secret} C:/repo/fake.md")}),
    ])
}

#[test]
fn load_history_writes_only_paths_and_ids() {
    let tmp = TempDir::new("secret");
    let t = tmp.0.join("a.jsonl");
    let secret = "SECRET-sk-9f8e7d6c5b4a";
    std::fs::write(&t, busy(secret)).unwrap();
    let file = tmp.0.join("out").join("h.json");
    run_at(&file, std::slice::from_ref(&t), &[(crate::fsx::now_ms(), vec!["vidar/recall-bare".into()])], "2026-10-25").unwrap();
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(!text.contains(secret), "transcript content leaked into the history");
    assert!(!text.contains("my token"));
    let h = history(&file);
    assert_eq!(h.paths.keys().collect::<Vec<_>>(), ["c:/repo/claude.md"]);
    assert_eq!(h.reads.keys().collect::<Vec<_>>(), ["c:/repo/.claude/skills/vidar-runes/swap-flow.md"]);
    assert_eq!(h.rune_reads.keys().collect::<Vec<_>>(), ["swap-flow"]);
    assert_eq!(h.skills.keys().collect::<Vec<_>>(), ["vidar-runes/swap-flow"]);
    assert_eq!(h.bare_sets.keys().collect::<Vec<_>>(), ["vidar/recall-bare"]);
    let date = local_date(ms(std::fs::metadata(&t).unwrap().modified().ok()));
    assert_eq!(h.paths["c:/repo/claude.md"], date, "dates come from the transcript mtime");
    assert_eq!((h.since.as_str(), h.last_sweep.as_str()), (date.as_str().min("2026-10-25"), "2026-10-25"));
    // no stray tmp beside the file
    assert_eq!(std::fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn load_history_resumes_a_grown_transcript_and_rescans_a_rewritten_head() {
    let tmp = TempDir::new("watermark");
    let t = tmp.0.join("a.jsonl");
    let file = tmp.0.join("h.json");
    std::fs::write(&t, lines(&[start("C:/r/a.md")])).unwrap();
    let h = run_at(&file, std::slice::from_ref(&t), &[], "2026-10-25").unwrap();
    let key = clean(&t);
    assert_eq!(h.transcripts[&key].len, std::fs::metadata(&t).unwrap().len());
    assert!(h.paths.contains_key("c:/r/a.md"));

    // forget `a` in the stored file: a resume cannot see it again, a rescan would
    let mut stored = history(&file);
    stored.paths.clear();
    std::fs::write(&file, serde_json::to_vec(&stored).unwrap()).unwrap();
    let mut grown = std::fs::read_to_string(&t).unwrap();
    grown.push_str(&lines(&[start("C:/r/b.md")]));
    std::fs::write(&t, &grown).unwrap();
    let h = run_at(&file, std::slice::from_ref(&t), &[], "2026-10-25").unwrap();
    assert_eq!(h.paths.keys().collect::<Vec<_>>(), ["c:/r/b.md"], "a grown transcript resumes from the watermark");
    assert_eq!(h.transcripts[&key].len, grown.len() as u64);

    // a partial trailing line is not consumed: the mark stops at the last complete line
    std::fs::write(&t, format!("{grown}{{\"type\":\"attach")).unwrap();
    let h = run_at(&file, std::slice::from_ref(&t), &[], "2026-10-25").unwrap();
    assert_eq!(h.transcripts[&key].len, grown.len() as u64);

    // a new head at least as long as the old file: only a full rescan finds `c` at offset 0
    let rewritten = lines(&[start("C:/r/c.md")]) + &" ".repeat(grown.len()) + "\n";
    std::fs::write(&t, &rewritten).unwrap();
    let h = run_at(&file, std::slice::from_ref(&t), &[], "2026-10-25").unwrap();
    assert!(h.paths.contains_key("c:/r/c.md"), "a changed head rescans from the start");
    assert_eq!(h.transcripts[&key].head, head_hash(&t, rewritten.len() as u64).unwrap());
}

#[test]
fn load_history_drops_a_deleted_transcript_and_keeps_its_dates() {
    let tmp = TempDir::new("deleted");
    let (a, b) = (tmp.0.join("a.jsonl"), tmp.0.join("b.jsonl"));
    std::fs::write(&a, lines(&[start("C:/r/a.md")])).unwrap();
    std::fs::write(&b, lines(&[start("C:/r/b.md")])).unwrap();
    let file = tmp.0.join("h.json");
    run_at(&file, &[a.clone(), b.clone()], &[], "2026-10-25").unwrap();
    std::fs::remove_file(&a).unwrap();
    // `b` is outside this sweep (another profile) but still on disk: its mark stays
    let h = run_at(&file, &[], &[], "2026-10-25").unwrap();
    assert_eq!(h.transcripts.keys().cloned().collect::<Vec<_>>(), [clean(&b)]);
    assert!(h.paths.contains_key("c:/r/a.md"), "a use outlives its transcript");
}

#[test]
fn load_history_since_resets_after_a_retention_gap_and_dates_only_rise() {
    let mut h = sweep(None, &[], &[(0, vec!["x/y".into()])], "2026-09-01");
    assert_eq!(h.since, "2026-09-01", "no transcripts: since is the first sweep");
    h.bare_sets.insert("x/y".into(), "2099-01-01".into());
    let h = sweep(Some(h), &[], &[(0, vec!["x/y".into()])], "2026-09-20");
    assert_eq!((h.since.as_str(), h.bare_sets["x/y"].as_str()), ("2026-09-01", "2099-01-01"));
    let h = sweep(Some(h), &[], &[], "2026-10-25");
    assert_eq!((h.since.as_str(), h.last_sweep.as_str()), ("2026-10-25", "2026-10-25"), "a 35-day gap resets since");
    assert_eq!(utc_date(0), "1970-01-01");
    assert_eq!(day_number("2026-10-25").unwrap() - day_number("2026-09-25").unwrap(), 30);
}

fn kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Same key set and value kinds; a map's entries compare by their first value (the keys are data).
fn same_shape(ours: &Value, fixture: &Value, at: &str) {
    assert_eq!(kind(ours), kind(fixture), "{at}: kind");
    let (Value::Object(o), Value::Object(f)) = (ours, fixture) else { return };
    if at.is_empty() {
        assert_eq!(o.keys().collect::<Vec<_>>(), f.keys().collect::<Vec<_>>(), "top-level keys");
        for (k, v) in f {
            let mine = &o[k];
            if let (Value::Object(m), Value::Object(fv)) = (mine, v) {
                let (Some(a), Some(b)) = (m.values().next(), fv.values().next()) else { panic!("{k}: empty map in the built history or the fixture") };
                same_shape(a, b, k);
            } else {
                same_shape(mine, v, k);
            }
        }
    } else {
        assert_eq!(o.keys().collect::<Vec<_>>(), f.keys().collect::<Vec<_>>(), "{at}: entry keys");
        for (k, v) in f {
            same_shape(&o[k], v, &format!("{at}.{k}"));
        }
    }
}

#[test]
fn load_history_matches_the_shared_fixture_shape() {
    let tmp = TempDir::new("shape");
    let t = tmp.0.join("a.jsonl");
    std::fs::write(&t, busy("s")).unwrap();
    let file = tmp.0.join("h.json");
    run_at(&file, &[t], &[(crate::fsx::now_ms(), vec!["vidar/recall-bare".into()])], "2026-10-25").unwrap();
    let ours: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    // the shared fixture, pinned shape
    let fixture: Value = serde_json::from_str(crate::fsx::strip_bom(include_str!("../../../tests/fixtures/runes/load-history.json"))).unwrap();
    same_shape(&ours, &fixture, "");
}
