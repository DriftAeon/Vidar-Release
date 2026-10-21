//! src-tauri\src\bare\set_layer.rs — what a rune set attaches beside its rules (run 2026-10-20-rune-sets, W1).
//! A set `<set>` of a library keeps an optional sidecar `<library>\sets\<set>.layer.json`:
//! `{ "skills"?: [..], "agents"?: [..], "guards"?: [..], "codexSkills"?: [..] }`. `skills`, `agents` and
//! `codexSkills` hold absolute or `~`-relative paths (the shapes of `bareSkills`, `bareAgents`,
//! `bareCodexSkills`); `guards` holds the objects of `bareGuards` (`{ event, matcher?, run: [..], open?: [..] }`),
//! their `run`/`open` paths absolute or `~`-relative. A row reads the sidecar of each of its set refs in ref order
//! and dedupes by name (file or folder name, case-insensitive; a guard by event, matcher and run files), first wins.
//! A missing sidecar is empty. A bad item, bad JSON or a bad set name is a warning and is skipped: reading a
//! sidecar never refuses a spawn. W1 consumes only the Codex skills (`codexSkills`, else `skills`, as
//! `bareCodexSkills` falls back to `bareSkills`); the other keys are parsed and kept for later waves.
//! `write_set` (W4, the Runes tab's `bare_set_layer_write`) writes a sidecar of a library under `runtime\runes\`.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::guards::{self, BareGuard};
use super::layer::{self, RowSets};

/// One row's merged attachments; every path is absolute (a `~` already expanded).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct SetLayer {
    pub skills: Vec<String>,
    pub agents: Vec<String>,
    pub guards: Vec<Value>,
    /// The Codex skills each set contributes: its `codexSkills` when the key is present, else its `skills`.
    pub codex_skills: Vec<String>,
}

/// The sidecar of `set` in library folder `dir`.
pub fn sidecar_path(dir: &Path, set: &str) -> PathBuf {
    dir.join("sets").join(format!("{set}.layer.json"))
}

/// The real user home a `~` stands for.
pub fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn expand(path: &str, home: Option<&Path>) -> Option<PathBuf> {
    // A `~` with no home stays relative, so it fails the absolute test.
    let p = crate::rules::import::sources::expand(path, home);
    p.is_absolute().then_some(p)
}

fn name_of(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_else(|| path.to_lowercase())
}

/// A list of path strings under `key`; each bad item is a warning naming `file`.
fn paths(obj: &serde_json::Map<String, Value>, key: &str, file: &Path, home: Option<&Path>, warnings: &mut Vec<String>) -> Option<Vec<String>> {
    let v = obj.get(key).filter(|v| !v.is_null())?;
    let Some(a) = v.as_array() else {
        warnings.push(format!("Set layer {}: `{key}` is not a list; skipped", file.display()));
        return Some(Vec::new());
    };
    let mut out = Vec::new();
    for item in a {
        match item.as_str().and_then(|s| expand(s, home)) {
            Some(p) => out.push(p.to_string_lossy().into_owned()),
            None => warnings.push(format!("Set layer {}: `{key}` entry {item} is not an absolute or ~ path; skipped", file.display())),
        }
    }
    Some(out)
}

/// A guard object with its `run`/`open` paths expanded, or `None` (warned) when it is malformed.
fn guard(item: &Value, file: &Path, home: Option<&Path>, warnings: &mut Vec<String>) -> Option<Value> {
    let bad = |why: &str, w: &mut Vec<String>| {
        w.push(format!("Set layer {}: `guards` entry {item} {why}; skipped", file.display()));
        None
    };
    let Some(o) = item.as_object() else { return bad("is not an object", warnings) };
    if !o.get("event").and_then(Value::as_str).is_some_and(|e| !e.trim().is_empty()) {
        return bad("has no `event`", warnings);
    }
    let mut out = o.clone();
    for key in ["run", "open"] {
        let Some(v) = o.get(key).filter(|v| !v.is_null()) else { continue };
        let list: Option<Vec<String>> = v.as_array().and_then(|a| {
            a.iter().map(|s| s.as_str().and_then(|s| expand(s, home)).map(|p| p.to_string_lossy().into_owned())).collect()
        });
        match list {
            Some(l) => {
                out.insert(key.into(), Value::from(l));
            }
            None => return bad(&format!("has a `{key}` that is not a list of absolute or ~ paths"), warnings),
        }
    }
    if !out.get("run").and_then(Value::as_array).is_some_and(|r| !r.is_empty()) {
        return bad("has no `run` files", warnings);
    }
    Some(Value::Object(out))
}

fn guard_name(g: &Value) -> String {
    let run: Vec<String> = g.get("run").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(name_of).collect();
    format!("{}|{}|{}", g["event"].as_str().unwrap_or(""), g.get("matcher").and_then(Value::as_str).unwrap_or(""), run.join(","))
}

/// Whether `set` is a plain set name: not empty, no `/ \ :` and no `..`.
pub fn plain_set_name(set: &str) -> bool {
    !(set.is_empty() || set.contains(['/', '\\', ':']) || set.contains(".."))
}

/// The sidecar of `set` in library folder `dir`, parsed. Missing = empty; anything else wrong is a warning.
pub fn read_set(dir: &Path, set: &str, home: Option<&Path>) -> (SetLayer, Vec<String>) {
    let mut warnings = Vec::new();
    if !plain_set_name(set) {
        warnings.push(format!("Set {set:?} is not a plain set name; its layer sidecar was not read"));
        return (SetLayer::default(), warnings);
    }
    let file = sidecar_path(dir, set);
    let text = match crate::fsx::read_text(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (SetLayer::default(), warnings),
        Err(e) => {
            warnings.push(format!("Set layer {} is unreadable ({e}); skipped", file.display()));
            return (SetLayer::default(), warnings);
        }
    };
    let root: Value = match serde_json::from_str(crate::fsx::strip_bom(&text)) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("Set layer {} is not valid JSON ({e}); skipped", file.display()));
            return (SetLayer::default(), warnings);
        }
    };
    let Some(obj) = root.as_object() else {
        warnings.push(format!("Set layer {} is not a JSON object; skipped", file.display()));
        return (SetLayer::default(), warnings);
    };
    let layer = parse_obj(obj, &file, home, &mut warnings);
    (layer, warnings)
}

/// One parsed sidecar object; every bad item is a warning naming `file`.
fn parse_obj(obj: &serde_json::Map<String, Value>, file: &Path, home: Option<&Path>, warnings: &mut Vec<String>) -> SetLayer {
    let file = file.to_path_buf();
    for k in obj.keys().filter(|k| !["skills", "agents", "guards", "codexSkills"].contains(&k.as_str())) {
        warnings.push(format!("Set layer {}: unknown key `{k}` ignored", file.display()));
    }
    let skills = paths(obj, "skills", &file, home, warnings);
    let codex = paths(obj, "codexSkills", &file, home, warnings);
    let mut guards = Vec::new();
    match obj.get("guards").filter(|v| !v.is_null()) {
        None => {}
        Some(Value::Array(a)) => guards = a.iter().filter_map(|g| guard(g, &file, home, warnings)).collect(),
        Some(_) => warnings.push(format!("Set layer {}: `guards` is not a list; skipped", file.display())),
    }
    SetLayer {
        codex_skills: codex.or_else(|| skills.clone()).unwrap_or_default(),
        skills: skills.unwrap_or_default(),
        agents: paths(obj, "agents", &file, home, warnings).unwrap_or_default(),
        guards,
    }
}

/// `bare_set_layer_write`'s layer: a present key replaces the sidecar's, an absent key is left as it is.
#[derive(serde::Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SetLayerWrite {
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    #[serde(default)]
    pub agents: Option<Vec<String>>,
    #[serde(default)]
    pub guards: Option<Vec<Value>>,
    #[serde(default)]
    pub codex_skills: Option<Vec<String>>,
}

/// Writes the sidecar of `set` in library `library` under the import folder `imports` (`runtime\runes\`),
/// atomically (temp file, then rename). The library name passes the rune id grammar and its folder exists
/// and, canonical, sits under the canonical `imports` (a junction pointing out refuses); the set name is
/// plain (`plain_set_name`). The given keys replace the sidecar's, others (unknown ones too) stay. Refuses,
/// writing nothing, when the current sidecar is not a JSON object or the result would read with any warning.
pub fn write_set(imports: &Path, library: &str, set: &str, layer: &SetLayerWrite, home: Option<&Path>) -> Result<(), String> {
    if crate::rules::rune::check_id(library).is_err() {
        return Err(format!("Library {library:?} is not a library name (lowercase letters, digits and single hyphens); set layer not saved"));
    }
    if !plain_set_name(set) {
        return Err(format!("Set {set:?} is not a plain set name; set layer not saved"));
    }
    let outside = || format!("Library {library:?} has no folder under {}; set layer not saved", imports.display());
    let base = imports.canonicalize().map_err(|_| outside())?;
    let dir = imports.join(library).canonicalize().map_err(|_| outside())?;
    if !dir.is_dir() || !dir.starts_with(&base) {
        return Err(outside());
    }
    let file = sidecar_path(&imports.join(library), set);
    let mut obj = match crate::fsx::read_text(&file) {
        Ok(t) => match serde_json::from_str::<Value>(crate::fsx::strip_bom(&t)) {
            Ok(Value::Object(o)) => o,
            _ => return Err(format!("Set layer {} is not a JSON object; set layer not saved", file.display())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(e) => return Err(format!("Set layer {} is unreadable ({e}); set layer not saved", file.display())),
    };
    let lists: [(&str, Option<Value>); 4] = [
        ("skills", layer.skills.clone().map(Value::from)),
        ("agents", layer.agents.clone().map(Value::from)),
        ("guards", layer.guards.clone().map(Value::from)),
        ("codexSkills", layer.codex_skills.clone().map(Value::from)),
    ];
    for (k, v) in lists {
        if let Some(v) = v {
            obj.insert(k.into(), v);
        }
    }
    let mut warnings = Vec::new();
    let parsed = parse_obj(&obj, &file, home, &mut warnings);
    // a key this build does not know is carried as it is, not refused
    warnings.retain(|w| !w.contains(": unknown key `"));
    if !warnings.is_empty() {
        return Err(format!("{}; set layer not saved", warnings.join("; ")));
    }
    // the check a spawn applies to the guards (`guards::validate`), so a guard saved here never refuses one
    let mut list: Vec<BareGuard> = Vec::new();
    for g in &parsed.guards {
        let mut plain = g.clone();
        if let Some(o) = plain.as_object_mut() {
            o.remove("open");
        }
        list.push(serde_json::from_value(plain).map_err(|e| format!("Guard {g} is not an event, matcher? and run list ({e}); set layer not saved"))?);
    }
    guards::validate(&list).map_err(|e| format!("{e}; set layer not saved"))?;
    std::fs::create_dir_all(imports.join(library).join("sets")).map_err(|e| format!("{e}; set layer not saved"))?;
    let text = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())? + "\n";
    crate::fsx::atomic_write(&file, text.as_bytes()).map_err(|e| format!("{e}; set layer not saved"))
}

fn push_new<T: Clone>(into: &mut Vec<T>, from: &[T], key: &dyn Fn(&T) -> String) {
    for item in from {
        if !into.iter().any(|o| key(o) == key(item)) {
            into.push(item.clone());
        }
    }
}

/// The row's merged layer: each distinct set ref's sidecar in ref order, deduped by name, first wins.
/// A ref whose library folder does not resolve is a warning (the spawn's own build refuses it separately).
pub fn row_layer(root: &Path, row: &RowSets, home: Option<&Path>) -> (SetLayer, Vec<String>) {
    let (mut out, mut warnings) = (SetLayer::default(), Vec::new());
    let mut done = Vec::new();
    for r in &row.sets {
        if done.contains(&r) {
            continue;
        }
        done.push(r);
        let dir = match layer::library_dir(root, row, r) {
            Ok(d) => d,
            Err(e) => {
                warnings.push(format!("Set {:?}: layer sidecar not read ({e})", r.set));
                continue;
            }
        };
        let (l, w) = read_set(&dir, &r.set, home);
        warnings.extend(w);
        push_new(&mut out.skills, &l.skills, &|p| name_of(p));
        push_new(&mut out.agents, &l.agents, &|p| name_of(p));
        push_new(&mut out.guards, &l.guards, &guard_name);
        push_new(&mut out.codex_skills, &l.codex_skills, &|p| name_of(p));
    }
    (out, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bare::layer::SetRef;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("vidar-setlayer-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
        fn sidecar(&self, lib: &str, set: &str, body: &str) {
            let d = self.0.join(lib).join("sets");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join(format!("{set}.layer.json")), body).unwrap();
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn row(sets: &[&str]) -> RowSets {
        RowSets { sets: sets.iter().map(|s| SetRef { library: None, set: s.to_string() }).collect(), rules_library: Some("lib".into()) }
    }

    #[test]
    fn missing_sidecar_is_empty_without_a_warning() {
        let t = Tmp::new("missing");
        let (l, w) = row_layer(&t.0, &row(&["a"]), None);
        assert_eq!(l, SetLayer::default());
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn parses_all_four_keys_expands_tilde_and_falls_back_to_skills() {
        let t = Tmp::new("parse");
        let home = t.0.join("h");
        t.sidecar("lib", "a", r#"{ "skills": ["~/s/one"], "agents": ["~\\a\\x.md"], "guards": [{ "event": "PreToolUse", "matcher": "Bash", "run": ["~/g.mjs"] }] }"#);
        let (l, w) = row_layer(&t.0, &row(&["a"]), Some(&home));
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(l.skills, vec![home.join("s/one").to_string_lossy().into_owned()]);
        assert_eq!(l.codex_skills, l.skills, "codexSkills absent: falls back to skills");
        assert_eq!(l.agents.len(), 1);
        assert_eq!(l.guards[0]["run"][0], Value::from(home.join("g.mjs").to_string_lossy().into_owned()));
        t.sidecar("lib", "b", r#"{ "skills": ["~/s/one"], "codexSkills": ["~/s/two"] }"#);
        let (l, _) = row_layer(&t.0, &row(&["b"]), Some(&home));
        assert_eq!(l.codex_skills, vec![home.join("s/two").to_string_lossy().into_owned()], "codexSkills present wins, even over skills");
    }

    #[test]
    fn sets_merge_in_ref_order_and_first_name_wins() {
        let t = Tmp::new("merge");
        let (x, y) = (t.0.join("x"), t.0.join("y"));
        t.sidecar("lib", "a", &serde_json::json!({ "codexSkills": [x.join("tidy"), x.join("only-a")] }).to_string());
        t.sidecar("lib", "b", &serde_json::json!({ "codexSkills": [y.join("TIDY"), y.join("only-b")] }).to_string());
        let (l, w) = row_layer(&t.0, &row(&["a", "b", "a"]), None);
        assert!(w.is_empty(), "{w:?}");
        let names: Vec<String> = l.codex_skills.iter().map(|p| name_of(p)).collect();
        assert_eq!(names, vec!["tidy", "only-a", "only-b"]);
        assert!(l.codex_skills[0].starts_with(&x.to_string_lossy().into_owned()), "first set's tidy wins");
    }

    #[test]
    fn bad_paths_and_bad_json_warn_and_never_refuse() {
        let t = Tmp::new("bad");
        let good = t.0.join("ok").join("good");
        t.sidecar("lib", "a", &serde_json::json!({ "codexSkills": ["relative\\skill", 3, good], "guards": [{ "event": "" }, "x"], "agents": "nope", "extra": 1 }).to_string());
        t.sidecar("lib", "b", "{ not json");
        t.sidecar("lib", "c", "[1]");
        let (l, w) = row_layer(&t.0, &row(&["a", "b", "c", "../escape", "nothing"]), None);
        assert_eq!(l.codex_skills, vec![good.to_string_lossy().into_owned()]);
        assert!(l.guards.is_empty() && l.agents.is_empty());
        let all = w.join("\n");
        for needle in ["relative", "3 is not", "no `event`", "is not an object", "`agents` is not a list", "unknown key `extra`", "not valid JSON", "not a JSON object", "not a plain set name"] {
            assert!(all.contains(needle), "missing {needle:?} in:\n{all}");
        }
        assert!(!all.contains("nothing"), "a set with no sidecar stays silent");
    }

    #[test]
    fn write_then_read_gives_the_same_layer_and_keeps_absent_keys() {
        let t = Tmp::new("write");
        let imports = t.0.join("imports");
        std::fs::create_dir_all(imports.join("lib")).unwrap();
        let p = |s: &str| t.0.join(s).to_string_lossy().into_owned();
        std::fs::write(t.0.join("g.mjs"), "// guard").unwrap(); // a guard's script must exist, as at spawn
        let guard = serde_json::json!({ "event": "PreToolUse", "matcher": "Bash", "run": [p("g.mjs")] });
        let w = SetLayerWrite {
            skills: Some(vec![p("s/one")]),
            agents: Some(vec![p("a/x.md")]),
            guards: Some(vec![guard.clone()]),
            codex_skills: Some(vec![p("s/two")]),
        };
        write_set(&imports, "lib", "a", &w, None).unwrap();
        let (l, warn) = read_set(&imports.join("lib"), "a", None);
        assert!(warn.is_empty(), "{warn:?}");
        let want = SetLayer { skills: vec![p("s/one")], agents: vec![p("a/x.md")], guards: vec![guard], codex_skills: vec![p("s/two")] };
        assert_eq!(l, want);
        // only skills given: the rest stays
        write_set(&imports, "lib", "a", &SetLayerWrite { skills: Some(vec![]), ..Default::default() }, None).unwrap();
        let (l, _) = read_set(&imports.join("lib"), "a", None);
        assert_eq!(l, SetLayer { skills: vec![], ..want });
        let leftovers: Vec<_> = std::fs::read_dir(imports.join("lib").join("sets")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(leftovers.len(), 1, "no temp file left: {leftovers:?}");
    }

    #[test]
    fn write_refuses_bad_names_out_of_tree_libraries_and_bad_items() {
        let t = Tmp::new("refuse");
        let imports = t.0.join("imports");
        std::fs::create_dir_all(imports.join("lib")).unwrap();
        std::fs::create_dir_all(t.0.join("outside")).unwrap();
        let ok = SetLayerWrite { skills: Some(vec![t.0.join("s").to_string_lossy().into_owned()]), ..Default::default() };
        for set in ["", "a/b", "a\\b", "c:x", "..", "a..b"] {
            assert!(write_set(&imports, "lib", set, &ok, None).unwrap_err().contains("not a plain set name"), "{set:?}");
        }
        for lib in ["../outside", "Lib", "a/b", ""] {
            assert!(write_set(&imports, lib, "a", &ok, None).unwrap_err().contains("not a library name"), "{lib:?}");
        }
        let e = write_set(&imports, "outside", "a", &ok, None).unwrap_err();
        assert!(e.contains("has no folder under"), "{e}");
        let bad = SetLayerWrite { skills: Some(vec!["relative\\skill".into()]), ..Default::default() };
        assert!(write_set(&imports, "lib", "a", &bad, None).unwrap_err().ends_with("set layer not saved"));
        let bad = SetLayerWrite { guards: Some(vec![serde_json::json!({ "event": "" })]), ..Default::default() };
        assert!(write_set(&imports, "lib", "a", &bad, None).is_err());
        assert!(!imports.join("lib").join("sets").exists(), "nothing written");
        assert!(!t.0.join("outside").join("sets").exists());
    }

    #[test]
    fn write_refuses_a_guard_the_spawn_would_refuse_and_saves_a_valid_one() {
        let t = Tmp::new("guards");
        let imports = t.0.join("imports");
        std::fs::create_dir_all(imports.join("lib")).unwrap();
        let script = t.0.join("g.mjs");
        std::fs::write(&script, "// guard").unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let w = |g: Value| SetLayerWrite { guards: Some(vec![g]), ..Default::default() };
        let good = serde_json::json!({ "event": "PreToolUse", "run": [s(&script)] });
        write_set(&imports, "lib", "a", &w(good.clone()), None).unwrap();
        let file = sidecar_path(&imports.join("lib"), "a");
        let before = std::fs::read_to_string(&file).unwrap();
        for bad in [
            serde_json::json!({ "event": "NotAnEvent", "run": [s(&script)] }),
            serde_json::json!({ "event": "PreToolUse", "run": [s(&t.0.join("missing.mjs"))] }),
            serde_json::json!({ "event": "PreToolUse", "run": [s(&t.0.join("g.txt"))] }),
        ] {
            let e = write_set(&imports, "lib", "a", &w(bad.clone()), None).unwrap_err();
            assert!(e.contains("Bare guard") && e.ends_with("set layer not saved"), "{bad}: {e}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before, "file changed by a refused write");
        }
    }

    #[test]
    fn a_tilde_with_no_home_is_skipped_with_a_warning() {
        let t = Tmp::new("nohome");
        t.sidecar("lib", "a", r#"{ "skills": ["~/s/one"] }"#);
        let (l, w) = row_layer(&t.0, &row(&["a"]), None);
        assert!(l.skills.is_empty());
        assert_eq!(w.len(), 1);
    }
}
