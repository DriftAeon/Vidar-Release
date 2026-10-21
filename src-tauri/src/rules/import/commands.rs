//! src-tauri\src\rules\import\commands.rs — the `rules_import_*` IPC commands (onboarding plan IPC Contract,
//! D4-D8; TS shapes `RulesImport*` in `src/ipc.ts`).
//! - `rules_import_sources`: the offered files (`sources.rs`).
//! - `rules_import_scan {path}`: split the source and match it against the library's last import: a hash match,
//!   then a section-plus-position match, keeps its id, state and rows (`known`; a changed body is rewritten
//!   at apply). Unmatched bricks are `new` (kept) or, when another import library holds the same body,
//!   `duplicate` (dropped). Bricks gone from the source stay as `gone` until dropped. A brick naming the
//!   profile path or holding `{{` is `profilePath` and never kept (D7).
//! - `rules_import_apply {path, kept, rows}`: writes the library (`write.rs`; a re-import of the same source
//!   overwrites, a first import refuses a differing file), then the row refs (`assign.rs`), and emits
//!   `settings-changed {keys:["agents"], tier:"config"}`. The source is only ever read.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::split::{split, Brick, Kind, Split};
use super::write::{write_library, Meta};
use super::{assign, sources};

/// One brick of a scan (`RulesImportBrick`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanBrick {
    pub id: String,
    pub section: Vec<String>,
    pub body: String,
    pub line: usize,
    pub studs: usize,
    pub status: &'static str,
    pub kept: bool,
    pub rows: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub library: String,
    pub bricks: Vec<ScanBrick>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub library: String,
    /// Library files written (unchanged files are not rewritten).
    pub written: usize,
    /// Row keys that hold this library's set afterwards.
    pub rows: Vec<String>,
}

/// Everything the commands read from the machine, explicit so tests run on temp roots.
pub struct Env<'a> {
    /// The import libraries' folder (`paths::rune_imports_dir`).
    pub imports: &'a Path,
    /// vidar.json.
    pub config: &'a Path,
    pub home: Option<&'a Path>,
    pub cwd: Option<&'a Path>,
    pub primary: &'a str,
    /// The user-profile path the splitter flags (D7).
    pub profile: &'a str,
}

#[derive(Deserialize)]
struct PriorBrick {
    id: String,
    sha256: String,
    #[serde(default)]
    section: Vec<String>,
    #[serde(default)]
    line: usize,
    #[serde(default)]
    prefix: String,
}

/// A source matched against its library, ready to show or write.
struct Plan {
    library: String,
    dir: PathBuf,
    shown: String,
    /// Same source imported before: apply rewrites changed files.
    reimport: bool,
    /// The fresh split with matched ids, then the gone bricks (no slot) appended.
    split: Split,
    status: Vec<&'static str>,
    kept: Vec<bool>,
    rows: BTreeMap<String, Vec<String>>,
}

/// 1 stud per 25 chars, at least 3 (`docs/shelf/bottom-shelf/rules-bricks-view.md`).
fn studs(body: &str) -> usize {
    body.chars().count().div_ceil(25).max(3)
}

fn locked(b: &Brick) -> bool {
    b.not_bare || b.body.contains("{{")
}

fn prior_bricks(dir: &Path) -> Vec<PriorBrick> {
    #[derive(Deserialize)]
    struct ImportJson {
        #[serde(default)]
        bricks: Vec<PriorBrick>,
    }
    crate::fsx::read_json::<ImportJson>(&dir.join("import.json")).map(|j| j.bricks).unwrap_or_default()
}

/// Body hashes held by every other import library.
fn other_hashes(imports: &Path, library: &str) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(imports) else { return Vec::new() };
    rd.flatten()
        .filter(|e| e.file_name().to_string_lossy() != library && e.path().is_dir())
        .flat_map(|e| prior_bricks(&e.path()))
        .map(|b| b.sha256)
        .collect()
}

/// The k-th brick of its section, per brick.
fn ordinals<'a>(sections: impl Iterator<Item = &'a Vec<String>>) -> Vec<usize> {
    let mut seen: Vec<&Vec<String>> = Vec::new();
    sections
        .map(|s| {
            let n = seen.iter().filter(|x| **x == s).count();
            seen.push(s);
            n
        })
        .collect()
}

fn plan(env: &Env, path: &str) -> Result<Plan, String> {
    let path = sources::expand(path, env.home);
    let raw = sources::read(&path)?;
    // A memory folder names its library from its project folder (fold 7, 8), never by `sources` name logic.
    let library = super::memory::import_library_of(env.imports, &path, env.home, env.cwd, env.primary);
    let dir = env.imports.join(&library);
    let shown = sources::tilde(&path, env.home);
    let reimport = sources::imported_source(&dir).is_some_and(|s| s.eq_ignore_ascii_case(&shown));
    let prior = if reimport { prior_bricks(&dir) } else { Vec::new() };
    // A first apply that stopped before `import.json` left files naming this source: those may be replaced.
    let reimport = reimport || super::write::library_names_source(&dir, &shown);
    let old_ids: Vec<String> = prior.iter().map(|p| p.id.clone()).collect();
    let mut split = split(&raw, &old_ids, env.profile);

    // Match: hash first, then section plus position. Fresh ids avoid every old id, so a rename never clashes.
    let mut used = vec![false; prior.len()];
    let mut matched = vec![None; split.bricks.len()];
    for (i, b) in split.bricks.iter().enumerate() {
        if let Some(j) = (0..prior.len()).find(|j| !used[*j] && prior[*j].sha256 == b.sha256) {
            used[j] = true;
            matched[i] = Some(j);
        }
    }
    let (ord_new, ord_old) = (ordinals(split.bricks.iter().map(|b| &b.section)), ordinals(prior.iter().map(|p| &p.section)));
    for i in 0..split.bricks.len() {
        if matched[i].is_some() {
            continue;
        }
        if let Some(j) = (0..prior.len()).find(|j| !used[*j] && prior[*j].section == split.bricks[i].section && ord_old[*j] == ord_new[i]) {
            used[j] = true;
            matched[i] = Some(j);
        }
    }

    let state_of = |id: &str| -> Option<crate::rules::rune::Rune> {
        crate::rules::rune::parse(&crate::fsx::read_text(&dir.join("rules").join(format!("{id}.md"))).ok()?).ok()
    };
    let others = other_hashes(env.imports, &library);
    let (mut status, mut kept) = (Vec::new(), Vec::new());
    for (i, b) in split.bricks.iter_mut().enumerate() {
        let (s, k) = match matched[i] {
            Some(j) => {
                b.id = prior[j].id.clone();
                ("known", state_of(&b.id).is_none_or(|r| r.state == crate::rules::rune::State::Active))
            }
            None if others.contains(&b.sha256) => ("duplicate", false),
            None => ("new", true),
        };
        let (s, k) = if locked(b) { ("profilePath", false) } else { (s, k) };
        status.push(s);
        kept.push(k);
    }
    // Gone from the source: kept as written (a hand-deleted file has nothing left to keep).
    for (_, p) in prior.iter().enumerate().filter(|(j, _)| !used[*j]) {
        let Some(rune) = state_of(&p.id) else { continue };
        let body = rune.body.trim_matches('\n').to_string();
        let not_bare = rune.scope.iter().any(|s| s == "!bare");
        let prefix = if p.prefix == "- " { "- " } else { "" };
        let b = Brick { id: p.id.clone(), kind: Kind::Prose, prefix, body, section: p.section.clone(), line: p.line, sha256: p.sha256.clone(), not_bare };
        status.push(if locked(&b) { "profilePath" } else { "gone" });
        kept.push(!locked(&b) && rune.state == crate::rules::rune::State::Active);
        split.bricks.push(b);
    }
    let rows = assign::rows_by_brick(&dir, &library, &assign::read_agents(env.config));
    Ok(Plan { library, dir, shown, reimport, split, status, kept, rows })
}

pub fn scan_at(env: &Env, path: &str) -> Result<Scan, String> {
    let p = plan(env, path)?;
    let bricks = p
        .split
        .bricks
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let body = format!("{}{}", b.prefix, b.body);
            let rows = if p.status[i] == "profilePath" { Vec::new() } else { p.rows.get(&b.id).cloned().unwrap_or_default() };
            ScanBrick { id: b.id.clone(), section: b.section.clone(), studs: studs(&body), body, line: b.line, status: p.status[i], kept: p.kept[i], rows }
        })
        .collect();
    Ok(Scan { library: p.library, bricks })
}

/// `plan` with the `kept` and `rows` of an apply checked and narrowed to the bricks that can be kept.
fn prepare(env: &Env, path: &str, kept: &[String], rows: &BTreeMap<String, Vec<String>>) -> Result<(Plan, Vec<String>, Vec<(String, Vec<String>)>), String> {
    let p = plan(env, path)?;
    let known = |id: &String| p.split.bricks.iter().position(|b| &b.id == id);
    if let Some(id) = kept.iter().chain(rows.values().flatten()).find(|id| known(id).is_none()) {
        return Err(format!("`{id}` is not a brick of {}", p.shown));
    }
    let keepable = |id: &String| known(id).is_some_and(|i| p.status[i] != "profilePath");
    let kept: Vec<String> = kept.iter().filter(|id| keepable(id)).cloned().collect();
    let rows: Vec<(String, Vec<String>)> =
        rows.iter().map(|(k, ids)| (k.clone(), ids.iter().filter(|id| kept.contains(id)).cloned().collect())).collect();
    Ok((p, kept, rows))
}

pub fn apply_at(env: &Env, path: &str, kept: &[String], rows: &BTreeMap<String, Vec<String>>, date: &str) -> Result<Applied, String> {
    let (p, kept, rows) = prepare(env, path, kept, rows)?;
    let meta = Meta { name: &p.library, source: &p.shown, date };
    let written = write_library(&p.dir, &p.split, &meta, &kept, &rows, p.reimport)?;
    let keys = assign::set_row_refs(env.config, &p.library, &rows)?;
    Ok(Applied { library: p.library, written: written.len(), rows: keys })
}

/// UTC `YYYY-MM-DD` for `origin` and `import.json`.
fn today() -> String {
    let days = (crate::fsx::now_ms() / 86_400_000) as i64;
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The cwd library names derive from: `over` (the tab's cwd) when it is an existing dir, else `default`.
fn pick_cwd(over: Option<&str>, default: Option<&str>) -> Option<PathBuf> {
    let dir = |s: Option<&str>| s.map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from).filter(|p| p.is_dir());
    dir(over).or_else(|| dir(default))
}

/// The live inputs: vidar.json read-only for `defaultCwd` (an existing dir; `cwd` overrides it) and
/// `primaryAgent`.
fn live<R>(cwd: Option<&str>, f: impl FnOnce(&Env) -> R) -> R {
    let (imports, config, home) = (crate::paths::rune_imports_dir(), crate::paths::config_path(), crate::paths::home());
    let root: serde_json::Value = crate::fsx::read_text(&config)
        .ok()
        .and_then(|t| serde_json::from_str(crate::fsx::strip_bom(&t)).ok())
        .unwrap_or(serde_json::Value::Null);
    let text = |k: &str| root.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let cwd = pick_cwd(cwd, text("defaultCwd").as_deref());
    let primary = text("primaryAgent").unwrap_or_default();
    let profile = std::env::var("USERPROFILE").unwrap_or_default();
    f(&Env { imports: &imports, config: &config, home: home.as_deref(), cwd: cwd.as_deref(), primary: &primary, profile: &profile })
}

#[tauri::command]
pub fn rules_import_sources() -> Vec<sources::Source> {
    live(None, |env| sources::list(env.imports, env.home, env.cwd, env.primary))
}

/// `cwd`, when given, overrides vidar.json `defaultCwd` for library naming (the Bare tab's cwd).
#[tauri::command]
pub fn rules_import_scan(path: String, cwd: Option<String>) -> Result<Scan, String> {
    live(cwd.as_deref(), |env| scan_at(env, &path))
}

#[tauri::command]
pub fn rules_import_apply(
    app: AppHandle,
    path: String,
    kept: Vec<String>,
    rows: BTreeMap<String, Vec<String>>,
    cwd: Option<String>,
) -> Result<Applied, String> {
    let applied = live(cwd.as_deref(), |env| apply_at(env, &path, &kept, &rows, &today()))?;
    // Best-effort, as `patch_settings`: the file is already correct.
    let _ = app.emit("settings-changed", serde_json::json!({ "keys": ["agents"], "tier": "config" }));
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use serde_json::{json, Value};

    use super::*;

    /// A synthetic user profile; tests never read the real one.
    const PROFILE: &str = r"C:\Users\example-user";
    const SOURCE: &str = "\u{FEFF}# Rules\r\n\r\n- Keep every change small and reviewed.\r\n- Run the build before every commit lands.\r\n\
- Wrap commit bodies at seventy-two chars.\r\n\r\n## Paths\r\n\r\n- Logs live in C:\\Users\\example-user\\logs today.\r\n";

    struct Fx {
        root: PathBuf,
        imports: PathBuf,
        config: PathBuf,
        src: PathBuf,
    }

    impl Fx {
        fn new(tag: &str) -> Fx {
            let root = std::env::temp_dir().join(format!("vidar-import-cmd-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let src = root.join("Proj").join("CLAUDE.md");
            std::fs::create_dir_all(src.parent().unwrap()).unwrap();
            std::fs::write(&src, SOURCE).unwrap();
            // A stand-in config name: any file `with_config_root_at` is handed works.
            Fx { imports: crate::paths::rune_imports_dir_in(&root), config: root.join("config-under-test.json"), src, root }
        }
        fn env(&self) -> Env<'_> {
            Env { imports: &self.imports, config: &self.config, home: None, cwd: None, primary: "", profile: PROFILE }
        }
        fn path(&self) -> String {
            self.src.to_string_lossy().into_owned()
        }
        fn scan(&self) -> Scan {
            scan_at(&self.env(), &self.path()).unwrap()
        }
        fn apply(&self, kept: &[&str], rows: &[(&str, &[&str])]) -> Applied {
            let kept: Vec<String> = kept.iter().map(|s| s.to_string()).collect();
            let rows: BTreeMap<String, Vec<String>> =
                rows.iter().map(|(k, ids)| (k.to_string(), ids.iter().map(|s| s.to_string()).collect())).collect();
            apply_at(&self.env(), &self.path(), &kept, &rows, "2026-10-16").unwrap()
        }
        fn agents(&self) -> Vec<Value> {
            assign::read_agents(&self.config)
        }
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut out = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.insert(p.clone(), std::fs::read(&p).unwrap());
                }
            }
        }
        out
    }

    fn id_of(scan: &Scan, starts: &str) -> String {
        scan.bricks.iter().find(|b| b.body.starts_with(starts)).unwrap_or_else(|| panic!("no brick {starts}")).id.clone()
    }

    #[test]
    fn apply_leaves_the_source_byte_identical_and_writes_only_inside_the_library() {
        let fx = Fx::new("readonly");
        let scan = fx.scan();
        assert_eq!(scan.library, "proj-claude-md");
        let logs = scan.bricks.iter().find(|b| b.body.contains("Logs live")).unwrap();
        assert_eq!((logs.status, logs.kept), ("profilePath", false));
        assert!(scan.bricks.iter().filter(|b| b.status != "profilePath").all(|b| b.status == "new" && b.kept && b.studs >= 3));
        let before = snapshot(&fx.root);
        let all: Vec<&str> = scan.bricks.iter().map(|b| b.id.as_str()).collect();
        // The UI never keeps a profile-path brick; apply drops it from kept and rows even if sent.
        let applied = fx.apply(&all, &[("claude-bare", &all)]);
        assert_eq!(applied.rows, vec!["claude-bare".to_string()]);
        assert_eq!(std::fs::read(&fx.src).unwrap(), SOURCE.as_bytes());
        let lib = fx.imports.join(&scan.library);
        let after = snapshot(&fx.root);
        let changed: Vec<&PathBuf> = after.iter().filter(|(p, b)| before.get(*p) != Some(*b)).map(|(p, _)| p).collect();
        assert_eq!(changed.len(), applied.written + 1, "{changed:?}");
        assert!(changed.iter().all(|p| p.starts_with(&lib) || **p == fx.config), "{changed:?}");
        let set = std::fs::read_to_string(lib.join("sets/row-claude-bare.md")).unwrap();
        assert!(!set.contains(&logs.id), "{set}");
        let rune = std::fs::read_to_string(lib.join(format!("rules/{}.md", logs.id))).unwrap();
        assert!(rune.contains("state: draft") && rune.contains("\"!bare\""), "{rune}");
        // A second apply of the same choice rewrites nothing.
        assert_eq!(fx.apply(&all, &[("claude-bare", &all)]).written, 0);
    }

    #[test]
    fn apply_sets_row_refs_keeps_other_libraries_and_drops_empty_rows() {
        let fx = Fx::new("rows");
        let seed = json!({ "fontSize": 14, "agents": [
            { "id": "claude", "key": "claude-bare", "sets": [{ "library": "other-lib", "set": "s" }, { "set": "core" }] },
            { "id": "claude", "key": "claude-rendered-bare", "sets": [{ "library": "proj-claude-md", "set": "row-claude-rendered-bare" }] },
            { "id": "claude", "key": "claude-bare", "label": "Bare" },
        ]});
        std::fs::write(&fx.config, serde_json::to_string_pretty(&seed).unwrap()).unwrap();
        let scan = fx.scan();
        let keep = id_of(&scan, "- Keep");
        let run = id_of(&scan, "- Run");
        let applied = fx.apply(
            &[&keep, &run],
            &[("claude-bare", &[&keep]), ("claude-new", &[&run]), ("claude-empty", &[]), ("claude-rendered-bare", &[])],
        );
        assert_eq!(applied.rows, vec!["claude-bare".to_string(), "claude-new".to_string()]);
        let agents = fx.agents();
        let ours = json!({ "library": "proj-claude-md", "set": "row-claude-bare" });
        // The last `claude-bare` entry takes the sets, the earlier entry's other refs carried over in order.
        assert_eq!(agents[2]["sets"], json!([{ "library": "other-lib", "set": "s" }, { "set": "core" }, ours]));
        assert_eq!(agents[2]["label"], "Bare");
        // A row whose ref was this library's only set, now with no bricks, loses the ref.
        assert_eq!(agents[1]["sets"], json!([]));
        assert_eq!(agents[3], json!({ "key": "claude-new", "sets": [{ "library": "proj-claude-md", "set": "row-claude-new" }] }));
        assert_eq!(agents.len(), 4, "an empty row gets no entry");
        let lib = fx.imports.join("proj-claude-md");
        assert!(!lib.join("sets/row-claude-empty.md").exists());
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&fx.config).unwrap()).unwrap();
        assert_eq!(root["fontSize"], 14);
        // Dropping the row later removes only this library's ref.
        fx.apply(&[&keep], &[("claude-bare", &[]), ("claude-new", &[&keep])]);
        let agents = fx.agents();
        assert_eq!(agents[2]["sets"], json!([{ "library": "other-lib", "set": "s" }, { "set": "core" }]));
        assert_eq!(agents[3]["sets"], json!([{ "library": "proj-claude-md", "set": "row-claude-new" }]));
    }

    #[test]
    fn rescan_keeps_state_by_id_and_marks_gone_bricks() {
        let fx = Fx::new("rescan");
        let first = fx.scan();
        let (keep, run, wrap, logs) = (id_of(&first, "- Keep"), id_of(&first, "- Run"), id_of(&first, "- Wrap"), id_of(&first, "- Logs"));
        fx.apply(&[&keep, &wrap], &[("claude-bare", &[&keep, &wrap])]);
        // Edit the source: Run changes in place, Wrap leaves, a new rule arrives in a new section.
        let edited = "# Rules\n\n- Keep every change small and reviewed.\n- Run the full build before every commit lands.\n\n\
## Paths\n\n- Logs live in C:\\Users\\example-user\\logs today.\n\n## Extra\n\n- Ask before any force push to master.\n";
        std::fs::write(&fx.src, edited).unwrap();
        let again = fx.scan();
        assert_eq!(again.library, first.library);
        let get = |id: &str| again.bricks.iter().find(|b| b.id == id).unwrap_or_else(|| panic!("{id} missing")).clone();
        let k = get(&keep);
        assert_eq!((k.status, k.kept, k.rows.clone()), ("known", true, vec!["claude-bare".to_string()]));
        let r = get(&run);
        assert_eq!((r.status, r.kept), ("known", false), "a changed body keeps its id and its dropped state");
        assert!(r.body.contains("full build"));
        let w = get(&wrap);
        assert_eq!((w.status, w.kept, w.rows.clone()), ("gone", true, vec!["claude-bare".to_string()]));
        assert_eq!(get(&logs).status, "profilePath");
        let ask = id_of(&again, "- Ask");
        assert!(![&keep, &run, &wrap, &logs].contains(&&ask));
        let a = get(&ask);
        assert_eq!((a.status, a.kept, a.rows.len()), ("new", true, 0));
        // Re-import overwrites the changed body; the gone brick stays on disk, dropped, and is still listed.
        fx.apply(&[&keep, &ask], &[("claude-bare", &[&keep, &ask])]);
        let lib = fx.imports.join(&first.library);
        assert!(std::fs::read_to_string(lib.join(format!("rules/{run}.md"))).unwrap().contains("full build"));
        assert!(std::fs::read_to_string(lib.join(format!("rules/{wrap}.md"))).unwrap().contains("state: draft"));
        let third = fx.scan();
        let w = third.bricks.iter().find(|b| b.id == wrap).unwrap();
        assert_eq!((w.status, w.kept), ("gone", false));
        // A first import into a library folder holding hand-made files refuses to replace them.
        let other = Fx::new("refuse");
        let target = other.imports.join("proj-claude-md/rules").join(format!("{keep}.md"));
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "hand edited\n").unwrap();
        let err = apply_at(&other.env(), &other.path(), &[keep.clone()], &BTreeMap::new(), "2026-10-16").unwrap_err();
        assert!(err.contains("other content"), "{err}");
    }

    const EDITED: &str = "# Rules\n\n- Keep every change small and reviewed.\n- Run the build before every commit lands.\n\n\
## Paths\n\n- Logs live in C:\\Users\\example-user\\logs today.\n";

    #[test]
    fn a_kept_gone_brick_survives_apply_and_rescans_with_its_rows() {
        let fx = Fx::new("gone-kept");
        let first = fx.scan();
        let (keep, wrap) = (id_of(&first, "- Keep"), id_of(&first, "- Wrap"));
        fx.apply(&[&keep, &wrap], &[("claude-bare", &[&keep, &wrap])]);
        std::fs::write(&fx.src, EDITED).unwrap(); // Wrap leaves the source
        let gone = fx.scan();
        let w = gone.bricks.iter().find(|b| b.id == wrap).unwrap();
        assert_eq!((w.status, w.kept), ("gone", true));
        // Done keeps it on its row: the set emits it at the end of its section.
        fx.apply(&[&keep, &wrap], &[("claude-bare", &[&keep, &wrap])]);
        let set = std::fs::read_to_string(fx.imports.join(&first.library).join("sets/row-claude-bare.md")).unwrap();
        assert!(set.contains(&format!("<?rune {wrap}?>")), "{set}");
        assert!(set.trim_end().ends_with(&format!("\n- <?rune {wrap}?>")), "the gone bullet lost its marker: {set}");
        let again = fx.scan();
        let w = again.bricks.iter().find(|b| b.id == wrap).unwrap();
        assert_eq!((w.status, w.kept, w.rows.clone()), ("gone", true, vec!["claude-bare".to_string()]));
    }

    #[test]
    fn a_partial_first_apply_can_be_retried_but_another_sources_files_stay_refused() {
        let fx = Fx::new("partial");
        let first = fx.scan();
        let (keep, run) = (id_of(&first, "- Keep"), id_of(&first, "- Run"));
        fx.apply(&[&keep, &run], &[("claude-bare", &[&keep, &run])]);
        let lib = fx.imports.join(&first.library);
        // import.json is written last: a partial first apply leaves the files without it.
        std::fs::remove_file(lib.join("import.json")).unwrap();
        std::fs::write(&fx.src, SOURCE.replace("small and reviewed", "small and audited")).unwrap();
        fx.apply(&[&keep, &run], &[("claude-bare", &[&keep, &run])]);
        assert!(std::fs::read_to_string(lib.join(format!("rules/{keep}.md"))).unwrap().contains("small and audited"));
        assert!(lib.join("import.json").exists());
        // The same files naming another source are not ours to replace.
        std::fs::remove_file(lib.join("import.json")).unwrap();
        for e in std::fs::read_dir(lib.join("rules")).unwrap().flatten() {
            let t = std::fs::read_to_string(e.path()).unwrap();
            std::fs::write(e.path(), t.replace(&fx.src.to_string_lossy().replace('\\', "\\\\"), "C:\\\\elsewhere\\\\AGENTS.md")).unwrap();
        }
        std::fs::write(&fx.src, SOURCE.replace("small and reviewed", "small and checked")).unwrap();
        let (kept, rows) = (vec![keep.clone()], BTreeMap::new());
        let err = apply_at(&fx.env(), &fx.path(), &kept, &rows, "2026-10-17").unwrap_err();
        assert!(err.contains("other content"), "{err}");
    }

    #[test]
    fn a_scan_with_a_cwd_names_project_libraries_from_that_cwd() {
        let fx = Fx::new("cwd");
        let (default, tab, home) = (fx.root.join("Default"), fx.root.join("Tab Dir"), fx.root.join("home"));
        std::fs::create_dir_all(&default).unwrap();
        std::fs::create_dir_all(&tab).unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        assert_eq!(pick_cwd(Some(&s(&tab)), Some(&s(&default))), Some(tab.clone()));
        assert_eq!(pick_cwd(Some(&s(&fx.root.join("gone"))), Some(&s(&default))), Some(default.clone()));
        assert_eq!(pick_cwd(Some(" "), None), None);
        std::fs::write(tab.join("CLAUDE.md"), "- Keep tab rules short and reviewed.\n").unwrap();
        let mem = super::super::memory::memory_dir(&home, &tab);
        std::fs::create_dir_all(&mem).unwrap();
        std::fs::write(mem.join("note.md"), "---\nname: Note\n---\n\nThe tab cwd memory holds one note.\n").unwrap();
        let cwd = pick_cwd(Some(&s(&tab)), Some(&s(&default)));
        let env = Env { home: Some(&home), cwd: cwd.as_deref(), ..fx.env() };
        assert_eq!(scan_at(&env, &s(&tab.join("CLAUDE.md"))).unwrap().library, "tab-dir-claude-md");
        let m = scan_at(&env, &s(&mem)).unwrap();
        assert_eq!(m.library, super::super::memory::library_id(&tab));
        assert_eq!(m.bricks[0].section, vec!["Note".to_string()]);
    }

    #[test]
    fn a_body_another_import_library_holds_starts_dropped_as_duplicate() {
        let fx = Fx::new("dup");
        let scan = fx.scan();
        let keep = id_of(&scan, "- Keep");
        fx.apply(&[&keep], &[]);
        let copy = fx.root.join("Other").join("AGENTS.md");
        std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
        std::fs::write(&copy, "- Keep every change small and reviewed.\n- Something else entirely new here.\n").unwrap();
        let s = scan_at(&fx.env(), &copy.to_string_lossy()).unwrap();
        assert_eq!(s.library, "other-agents-md");
        let statuses: Vec<(&str, bool)> = s.bricks.iter().map(|b| (b.status, b.kept)).collect();
        assert_eq!(statuses, vec![("duplicate", false), ("new", true)]);
        assert!(today().len() == 10 && today().starts_with("20"));
    }

    /// Two sources of about 8,000 characters each: together past the old 12,000 Codex inline limit.
    fn halves(fx: &Fx) -> (String, String) {
        let write = |name: &str, range: std::ops::Range<usize>| {
            let text: String = range
                .map(|i| format!("- Rule number {i:03} says to keep the {i:03}th change small, reviewed and recorded before it ships to anyone.\n"))
                .collect();
            let path = fx.root.join(name).join("AGENTS.md");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            path.to_string_lossy().into_owned()
        };
        (write("First", 0..70), write("Second", 70..140))
    }

    /// Applies `path` with every brick kept to `row`.
    fn apply_all(fx: &Fx, path: &str, row: &str) -> Applied {
        let kept: Vec<String> = scan_at(&fx.env(), path).unwrap().bricks.into_iter().map(|b| b.id).collect();
        apply_at(&fx.env(), path, &kept, &BTreeMap::from([(row.to_string(), kept.clone())]), "2026-10-18").unwrap()
    }

    #[test]
    fn a_codex_row_takes_imports_past_the_old_inline_limit() {
        let fx = Fx::new("codex-uncapped");
        let seed = json!({ "agents": [{ "id": "codex", "key": "codex-bare" }, { "id": "claude", "key": "claude-bare" }] });
        std::fs::write(&fx.config, serde_json::to_string_pretty(&seed).unwrap()).unwrap();
        let (first, second) = halves(&fx);
        let applied = apply_all(&fx, &first, "codex-bare");
        assert_eq!(applied.rows, vec!["codex-bare".to_string()]);
        assert!(fx.imports.join(&applied.library).join("sets/row-codex-bare.md").exists());
        assert_eq!(fx.agents()[0]["sets"], json!([{ "library": applied.library, "set": "row-codex-bare" }]));
        // Two sources of about 8,000 characters: the row now holds both, with no refusal.
        apply_all(&fx, &second, "codex-bare");
        assert_eq!(fx.agents()[0]["sets"].as_array().unwrap().len(), 2);
    }

}
