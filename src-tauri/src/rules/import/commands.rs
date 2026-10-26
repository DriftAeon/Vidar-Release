//! src-tauri\src\rules\import\commands.rs — the `rules_import_*` IPC commands (onboarding plan IPC Contract,
//! D4-D8; TS shapes `RulesImport*` in `src/ipc.ts`).
//! - `rules_import_sources`: the offered files (`sources.rs`).
//! - `rules_import_scan {path}`: split the source and match it against the library's last import: a hash match,
//!   then a section-plus-position match, keeps its id, state and rows (`known`; a changed body is rewritten
//!   at apply). Unmatched bricks are `new` (kept) or, when another import library holds the same body,
//!   `duplicate` (dropped). Bricks gone from the source stay as `gone` until dropped. A brick naming the
//!   profile path or holding `{{` is `profilePath` and never kept (D7).
//! - The retired row-shaped apply entry point refuses calls until a vault-shaped import replaces it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::split::{split, Brick, Kind, Split};
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
    /// Legacy row keys; this result is no longer produced.
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
    let old_ids: Vec<String> = prior.iter().map(|p| p.id.clone()).collect();
    let mut split = split(&raw, &old_ids, env.profile);
    split.memory = super::memory::is_memory_dir(&path);

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
    Ok(Plan { library, split, status, kept, rows })
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

/// `cwd`, when given, overrides vidar.json `defaultCwd` for library naming.
#[tauri::command]
pub fn rules_import_scan(path: String, cwd: Option<String>) -> Result<Scan, String> {
    live(cwd.as_deref(), |env| scan_at(env, &path))
}

/// Compatibility name kept for the command registry; the row-shaped write is retired.
#[tauri::command]
pub fn rules_import_apply(_path: String, _kept: Vec<String>, _rows: BTreeMap<String, Vec<String>>, _cwd: Option<String>) -> Result<Applied, String> {
    Err("Row-shaped import apply is retired; import into a Rune Vault".into())
}
