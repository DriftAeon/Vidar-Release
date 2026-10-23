//! src-tauri\src\bare\actives.rs — the Bare Runes tab's two layer commands (run 2026-10-17-bare-runes-flow,
//! fold § Pinned shapes; TS `BareActives` in `src/ipc.ts`, consumer `src/runes/bare/flow.ts`).
//! - `bare_actives {rowKey}`, read-only: the row's rune libraries (one per library its `sets` name, read
//!   as `layer.rs` `row_sets` reads them) with every brick of an import library and whether the row's set
//!   holds it, plus the home-wide `bareSkills`, `bareAgents` and `bareGuards`. A library with no
//!   `import.json` has `source: null` (read-only) and lists its set's slots, each On. A library with
//!   `generate.json` reads through `actives_gen.rs` with `generated`, also when only gen-index.json names it.
//!   Each library carries `sets`: per set the row names in it, what its layer sidecar attaches (run
//!   2026-10-20-rune-sets, W4). `bare_set_layer_write {library, set, layer}` writes one (`set_layer::write_set`).
//! - `bare_layer_set {guards?, skills?, agents?, codexMcp?, codexSkills?, codexAgents?}`: writes `bareGuards`, `bareSkills`,
//!   `bareAgents`, `bareCodexMcp` (hosted names only, `codex_mcp::validate_names`), `bareCodexSkills` and
//!   `bareCodexAgents` (role `.toml` files, `copies::check_codex_agent`) in one
//!   read-modify-write (`with_config_root_at`); an omitted key is left untouched. Refuses, writing
//!   nothing, a guard list a spawn would refuse (`guards::validate`) and a skill or agent a spawn would
//!   skip (`copies::check_skill` / `check_agent`). Returns the arg keys whose value changed.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::actives_gen::{self, ActiveGenerated};
use super::codex_mcp;
use super::copies;
use super::guards::{self, BareGuard};
use super::layer;
use super::set_layer;
use crate::rules::import::{memory, sources};
use crate::rules::rune;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveBrick {
    pub id: String,
    pub section: Vec<String>,
    pub studs: usize,
    pub on: bool,
    /// The rune file (absolute); empty when the file is missing.
    pub path: String,
    pub kind: String,
    pub activate: String,
    pub description: String,
    pub body: String,
}

impl ActiveBrick {
    /// `found`: the rune file and its parse; `None` keeps the defaults (`rule`, `always`, empty strings).
    pub(super) fn new(id: &str, section: Vec<String>, studs: usize, on: bool, found: Option<&(String, rune::Rune)>) -> ActiveBrick {
        let (path, kind, activate, description, body) = match found {
            Some((p, r)) => (p.clone(), r.kind.clone(), r.activate.clone(), r.description.clone(), r.body.trim_matches('\n').to_string()),
            None => (String::new(), "rule".into(), "always".into(), String::new(), String::new()),
        };
        ActiveBrick { id: id.to_string(), section, studs, on, path, kind, activate, description, body }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveLibrary {
    pub library: String,
    /// The absolute source path (`import.json` `source`, `~` expanded); `None`: not imported, read-only.
    pub source: Option<String>,
    pub scope: &'static str,
    pub source_gone: bool,
    pub bricks: Vec<ActiveBrick>,
    /// Set for a rune-generator library (`generate.json`); absent for import libraries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated: Option<ActiveGenerated>,
    /// Each set the row names in this library, with what its sidecar attaches (`set_layer.rs`).
    pub sets: Vec<ActiveSetLayer>,
}

/// One set's layer sidecar as `set_layer::read_set` reads it (paths absolute), plus its warnings.
/// `editable`: the library sits under `runtime\runes\`, so `bare_set_layer_write` takes it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSetLayer {
    pub set: String,
    pub editable: bool,
    pub skills: Vec<String>,
    pub agents: Vec<String>,
    pub guards: Vec<Value>,
    /// The set's `codexSkills`, else its `skills` (what a Codex row lists).
    pub codex_skills: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Actives {
    pub row_key: String,
    pub libraries: Vec<ActiveLibrary>,
    pub skills: Vec<String>,
    pub agents: Vec<String>,
    /// `bareCodexSkills`, kept apart from `skills` (`bareSkills`).
    pub codex_skills: Vec<String>,
    /// `bareCodexAgents`, kept apart from `agents` (`bareAgents`).
    pub codex_agents: Vec<String>,
    /// `bareCodexMcp`: hosted server names.
    pub codex_mcp: Vec<String>,
    pub guards: Vec<BareGuard>,
    /// `bareCodexGuards`, kept apart from `guards` (`bareGuards`).
    pub codex_guards: Vec<guards::BareCodexGuard>,
    pub guards_key: bool,
}

/// What the read touches, explicit so tests run on temp roots.
pub struct ActivesEnv<'a> {
    pub config: &'a Path,
    /// The Vidar root (`rulesLibrary` is relative to it).
    pub root: &'a Path,
    /// `runtime\runes\` (`paths::rune_imports_dir`).
    pub imports: &'a Path,
    /// runtime\runes\gen-index.json (`paths::rune_gen_index`).
    pub index: &'a Path,
    pub home: Option<&'a Path>,
}

/// 1 stud per 25 chars, at least 3 (twin of `studs` in `rules/import/commands.rs`).
pub(super) fn studs(body: &str) -> usize {
    body.chars().count().div_ceil(25).max(3)
}

/// Rune ids named by `<?rune id?>` slots (twin of `slot_ids` in `rules/import/assign.rs`).
fn slot_ids(text: &str) -> Vec<String> {
    text.split("<?rune ").skip(1).filter_map(|t| t.split_once("?>")).map(|(id, _)| id.trim().to_string()).collect()
}

/// A rune file of the library at `dir`, from any kind folder: its path and parse.
pub(super) fn rune_in(dir: &Path, id: &str) -> Option<(String, rune::Rune)> {
    if rune::check_id(id).is_err() {
        return None;
    }
    let (path, text) = rune::KINDS.iter().find_map(|(folder, _)| {
        let p = dir.join(folder).join(format!("{id}.md"));
        crate::fsx::read_text(&p).ok().map(|t| (p, t))
    })?;
    rune::parse(&text).ok().map(|r| (path.to_string_lossy().into_owned(), r))
}

#[derive(Deserialize)]
struct ImportJson {
    source: String,
    #[serde(default)]
    bricks: Vec<ImportBrick>,
}

#[derive(Deserialize)]
struct ImportBrick {
    id: String,
    #[serde(default)]
    section: Vec<String>,
    #[serde(default)]
    prefix: String,
}

/// Global for a source under `~\.claude\` or `~\.codex\` (memory folders excepted: they belong to a
/// project folder); every other source is project-scoped.
pub(super) fn scope_of(shown: &str, abs: &Path) -> &'static str {
    let s = shown.replace('/', "\\").to_lowercase();
    let user = s.starts_with("~\\.claude\\") || s.starts_with("~\\.codex\\");
    if user && memory::library_of_dir(abs).is_none() && !s.ends_with("\\memory") {
        "global"
    } else {
        "project"
    }
}

/// One library of the row: `name` (None = `rulesLibrary`) with the sets the row names in it.
fn library(env: &ActivesEnv, name: Option<&str>, rules_library: Option<&str>, sets: &[String]) -> ActiveLibrary {
    let label = name.map(str::to_string).unwrap_or_else(|| rules_library.unwrap_or("rulesLibrary").to_string());
    let dir = match name {
        Some(n) if rune::check_id(n).is_ok() => Some(env.imports.join(n)),
        Some(_) => None,
        None => rules_library.map(|r| env.root.join(r)),
    };
    let mut on: Vec<String> = Vec::new();
    if let Some(dir) = &dir {
        for set in sets {
            let Ok(text) = crate::fsx::read_text(&dir.join("sets").join(format!("{set}.md"))) else { continue };
            for id in slot_ids(&text) {
                if !on.contains(&id) {
                    on.push(id);
                }
            }
        }
    }
    if let (Some(n), Some(d)) = (name, &dir) {
        if let Some(lib) = actives_gen::read(env, d, n, &on) {
            return lib;
        }
    }
    let import = match (name, &dir) {
        (Some(_), Some(d)) => crate::fsx::read_json::<ImportJson>(&d.join("import.json")).ok(),
        _ => None,
    };
    let Some(import) = import else {
        let bricks = on
            .iter()
            .map(|id| {
                let r = dir.as_deref().and_then(|d| rune_in(d, id));
                // no import.json means no headings: the description belongs to the card, not the heading path
                ActiveBrick::new(id, vec![], studs(r.as_ref().map(|(_, r)| r.body.trim_matches('\n')).unwrap_or("")), true, r.as_ref())
            })
            .collect();
        return ActiveLibrary { library: label, source: None, scope: "global", source_gone: false, bricks, generated: None, sets: Vec::new() };
    };
    let dir = dir.unwrap_or_default();
    let abs = sources::expand(&import.source, env.home);
    let bricks = import
        .bricks
        .iter()
        .filter_map(|b| {
            // A hand-deleted rune file has nothing left to show (as the importer's scan skips it).
            let r = rune_in(&dir, &b.id)?;
            let body = format!("{}{}", b.prefix, r.1.body.trim_matches('\n'));
            Some(ActiveBrick::new(&b.id, b.section.clone(), studs(&body), on.contains(&b.id), Some(&r)))
        })
        .collect();
    ActiveLibrary {
        library: label,
        scope: scope_of(&import.source, &abs),
        source_gone: !abs.exists(),
        source: Some(abs.to_string_lossy().into_owned()),
        bricks,
        generated: None,
        sets: Vec::new(),
    }
}

/// The layer sidecar of each set the row names in library `name` (None = `rulesLibrary`, never editable).
fn set_layers(env: &ActivesEnv, name: Option<&str>, rules_library: Option<&str>, sets: &[String]) -> Vec<ActiveSetLayer> {
    let (dir, editable) = match name {
        Some(n) if rune::check_id(n).is_ok() => (Some(env.imports.join(n)), true),
        Some(_) => (None, false),
        None => (rules_library.map(|r| env.root.join(r)), false),
    };
    let Some(dir) = dir else { return Vec::new() };
    sets.iter()
        .map(|set| {
            let (l, warnings) = set_layer::read_set(&dir, set, env.home);
            ActiveSetLayer { set: set.clone(), editable, skills: l.skills, agents: l.agents, guards: l.guards, codex_skills: l.codex_skills, warnings }
        })
        .collect()
}

fn read_root(config: &Path) -> Result<Value, String> {
    match crate::fsx::read_text(config) {
        Ok(t) => serde_json::from_str(crate::fsx::strip_bom(&t)).map_err(|e| format!("vidar.json {} is unreadable ({e})", config.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(format!("vidar.json {} is unreadable ({e})", config.display())),
    }
}

fn strings(root: &Value, key: &str) -> Vec<String> {
    root.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// The row's actives. A blank `row_key` is refused (fold 3: never stored as a key).
pub fn read(env: &ActivesEnv, row_key: &str) -> Result<Actives, String> {
    let key = row_key.trim();
    if key.is_empty() {
        return Err("bare_actives needs a row key".into());
    }
    let root = read_root(env.config)?;
    let row = layer::row_sets(env.config, key)?;
    // Libraries in first-ref order, each with the sets the row names in it.
    let mut libs: Vec<(Option<String>, Vec<String>)> = Vec::new();
    for r in &row.sets {
        match libs.iter_mut().find(|(n, _)| *n == r.library) {
            Some((_, sets)) if !sets.contains(&r.set) => sets.push(r.set.clone()),
            Some(_) => {}
            None => libs.push((r.library.clone(), vec![r.set.clone()])),
        }
    }
    // The row's current generation stays listed, all Off, when no ref names it (E3).
    let names: Vec<Option<String>> = libs.iter().map(|(n, _)| n.clone()).collect();
    if let Some(lib) = actives_gen::listed_by_index(env, key, &names) {
        libs.push((Some(lib), Vec::new()));
    }
    let rl = row.rules_library.as_deref();
    let libraries = libs
        .iter()
        .map(|(n, sets)| ActiveLibrary { sets: set_layers(env, n.as_deref(), rl, sets), ..library(env, n.as_deref(), rl, sets) })
        .collect();
    let guards = guards::read(env.config)?;
    Ok(Actives {
        row_key: key.to_string(),
        libraries,
        skills: strings(&root, "bareSkills"),
        agents: strings(&root, "bareAgents"),
        codex_skills: strings(&root, "bareCodexSkills"),
        codex_agents: strings(&root, "bareCodexAgents"),
        codex_mcp: strings(&root, "bareCodexMcp"),
        guards,
        codex_guards: guards::read_codex(env.config)?,
        guards_key: root.get("bareGuards").is_some(),
    })
}

/// `bare_layer_set`'s args; an absent key is left untouched.
#[derive(Deserialize, Default, Debug)]
pub struct LayerSet {
    #[serde(default)]
    pub guards: Option<Vec<BareGuard>>,
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    #[serde(default)]
    pub agents: Option<Vec<String>>,
    /// Hosted MCP server names for Codex Bare (`bareCodexMcp`); see `codex_mcp::validate_names`.
    #[serde(default)]
    pub codex_mcp: Option<Vec<String>>,
    /// Codex Bare's own skill list (`bareCodexSkills`), separate from `skills`.
    #[serde(default)]
    pub codex_skills: Option<Vec<String>>,
    /// Codex Bare's role files (`bareCodexAgents`), separate from `agents` (Claude `.md`).
    #[serde(default)]
    pub codex_agents: Option<Vec<String>>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct LayerWritten {
    pub written: Vec<String>,
}

/// Checks every given key, then writes the changed ones to vidar.json at `config`. Returns the arg
/// keys (`guards`, `skills`, `agents`) whose value changed.
pub fn layer_set_at(config: &Path, set: &LayerSet) -> Result<Vec<String>, String> {
    if let Some(g) = &set.guards {
        guards::validate(g).map_err(|e| format!("{e}; bareGuards not saved"))?;
    }
    let names = |list: &[String], kind: &str, check: &dyn Fn(&str) -> Result<String, String>| -> Result<(), String> {
        let mut seen: Vec<String> = Vec::new();
        for p in list {
            let name = check(p).map_err(|e| format!("{e}; {kind} not saved"))?.to_lowercase();
            if seen.contains(&name) {
                return Err(format!("Two {kind} entries share the name {name}; {kind} not saved"));
            }
            seen.push(name);
        }
        Ok(())
    };
    if let Some(s) = &set.skills {
        names(s, "bareSkills", &|p| copies::check_skill(p, None).map(|c| c.name))?;
    }
    if let Some(a) = &set.agents {
        names(a, "bareAgents", &|p| copies::check_agent(p, None).map(|c| c.name))?;
    }
    if let Some(s) = &set.codex_skills {
        names(s, "bareCodexSkills", &|p| copies::check_skill(p, None).map(|c| c.name))?;
    }
    if let Some(a) = &set.codex_agents {
        names(a, "bareCodexAgents", &|p| copies::check_codex_agent(p, None).map(|c| c.name))?;
    }
    if let Some(m) = &set.codex_mcp {
        codex_mcp::validate_names(m).map_err(|e| format!("{e}; bareCodexMcp not saved"))?;
    }
    let mut pending: Vec<(&str, &str, Value)> = Vec::new();
    if let Some(g) = &set.guards {
        pending.push(("guards", "bareGuards", serde_json::to_value(g).map_err(|e| e.to_string())?));
    }
    if let Some(s) = &set.skills {
        pending.push(("skills", "bareSkills", Value::from(s.clone())));
    }
    if let Some(a) = &set.agents {
        pending.push(("agents", "bareAgents", Value::from(a.clone())));
    }
    if let Some(m) = &set.codex_mcp {
        pending.push(("codexMcp", "bareCodexMcp", Value::from(m.clone())));
    }
    if let Some(s) = &set.codex_skills {
        pending.push(("codexSkills", "bareCodexSkills", Value::from(s.clone())));
    }
    if let Some(a) = &set.codex_agents {
        pending.push(("codexAgents", "bareCodexAgents", Value::from(a.clone())));
    }
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    let current = read_root(config)?;
    let changed: Vec<(&str, &str, Value)> = pending.into_iter().filter(|(_, k, v)| current.get(*k) != Some(v)).collect();
    if changed.is_empty() {
        return Ok(Vec::new());
    }
    crate::settings::store::with_config_root_at(config, |obj| {
        for (_, k, v) in &changed {
            obj.insert(k.to_string(), v.clone());
        }
        Ok(())
    })?;
    Ok(changed.iter().map(|(arg, _, _)| arg.to_string()).collect())
}

#[tauri::command]
pub fn bare_actives(row_key: String) -> Result<Actives, String> {
    let (config, root, imports, index, home) =
        (crate::paths::config_path(), crate::paths::root(), crate::paths::rune_imports_dir(), crate::paths::rune_gen_index(), crate::paths::home());
    read(&ActivesEnv { config: &config, root: &root, imports: &imports, index: &index, home: home.as_deref() }, &row_key)
}

/// Writes the layer sidecar of `set` in library `library` (a name under `runtime\runes\`); see
/// `set_layer::write_set`. A key absent from `layer` is left as it is.
#[tauri::command]
pub fn bare_set_layer_write(library: String, set: String, layer: set_layer::SetLayerWrite) -> Result<(), String> {
    set_layer::write_set(&crate::paths::rune_imports_dir(), &library, &set, &layer, crate::paths::home().as_deref())
}

#[tauri::command]
pub fn bare_layer_set(
    app: AppHandle,
    guards: Option<Vec<BareGuard>>,
    skills: Option<Vec<String>>,
    agents: Option<Vec<String>>,
    codex_mcp: Option<Vec<String>>,
    codex_skills: Option<Vec<String>>,
    codex_agents: Option<Vec<String>>,
) -> Result<LayerWritten, String> {
    let written = layer_set_at(&crate::paths::config_path(), &LayerSet { guards, skills, agents, codex_mcp, codex_skills, codex_agents })?;
    if !written.is_empty() {
        let keys: Vec<&str> = written
            .iter()
            .map(|k| match k.as_str() {
                "guards" => "bareGuards",
                "skills" => "bareSkills",
                "codexMcp" => "bareCodexMcp",
                "codexSkills" => "bareCodexSkills",
                "codexAgents" => "bareCodexAgents",
                _ => "bareAgents",
            })
            .collect();
        // Best-effort, as `rules_import_apply`: the file is already correct.
        let _ = app.emit("settings-changed", serde_json::json!({ "keys": keys, "tier": "config" }));
    }
    Ok(LayerWritten { written })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> TempDir {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("vidar-actives-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn rune_file(dir: &Path, id: &str, desc: &str, body: &str) {
        std::fs::create_dir_all(dir.join("rules")).unwrap();
        let text = format!("---\nname: {id}\nkind: rule\nscope: [lib]\nstate: active\nactivate: always\ndescription: \"{desc}\"\n---\n\n{body}\n");
        std::fs::write(dir.join("rules").join(format!("{id}.md")), text).unwrap();
    }

    /// An imported library `claude-user` from `~\.claude\CLAUDE.md` with two bricks, the row's set holding
    /// the first; a read-only `vidar-recall` with one slot.
    fn fixture(t: &TempDir) -> (PathBuf, PathBuf, PathBuf) {
        let (root, home) = (t.0.join("root"), t.0.join("home"));
        let imports = root.join("imports");
        let lib = imports.join("claude-user");
        rune_file(&lib, "keep-it-short-1", "Style", "Keep answers short.");
        rune_file(&lib, "run-tests-2", "Work", "Run the tests before every commit lands.");
        std::fs::create_dir_all(lib.join("sets")).unwrap();
        std::fs::write(lib.join("sets").join("row-claude-bare.md"), "# Style\n\n<?rune keep-it-short-1?>\n").unwrap();
        std::fs::write(lib.join("sets").join("row-claude-bare.layer.json"), r#"{ "skills": ["~\\skills\\tidy"] }"#).unwrap();
        std::fs::write(
            lib.join("import.json"),
            json!({ "source": "~\\.claude\\CLAUDE.md", "bricks": [
                { "id": "keep-it-short-1", "sha256": "a", "section": ["Style"], "line": 3, "prefix": "- " },
                { "id": "run-tests-2", "sha256": "b", "section": ["Work"], "line": 7, "prefix": "- " },
                { "id": "deleted-3", "sha256": "c", "section": ["Gone"], "line": 9 }
            ]})
            .to_string(),
        )
        .unwrap();
        let recall = imports.join("vidar-recall");
        rune_file(&recall, "recall-first-1", "Recall", "Search the notes first.");
        std::fs::create_dir_all(recall.join("sets")).unwrap();
        std::fs::write(recall.join("sets").join("recall.md"), "<?rune recall-first-1?>\n").unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude").join("CLAUDE.md"), "# Style\n").unwrap();
        let config = root.join("config.json");
        std::fs::write(
            &config,
            json!({
                "agents": [{ "key": "claude-bare", "sets": [
                    { "library": "claude-user", "set": "row-claude-bare" },
                    { "library": "vidar-recall", "set": "recall" }
                ]}],
                "bareSkills": ["D:\\Work\\skills\\tidy"],
                "bareAgents": ["D:\\Work\\agents\\reviewer.md"],
            })
            .to_string(),
        )
        .unwrap();
        (root, home, config)
    }

    #[test]
    fn actives_read_a_row() {
        let t = TempDir::new("read");
        let (root, home, config) = fixture(&t);
        let imports = root.join("imports");
        let index = imports.join("rowlib.json");
        let env = ActivesEnv { config: &config, root: &root, imports: &imports, index: &index, home: Some(&home) };
        let a = read(&env, "claude-bare").unwrap();
        let v = serde_json::to_value(&a).unwrap();
        let source = home.join(".claude").join("CLAUDE.md").to_string_lossy().into_owned();
        let file = |lib: &str, id: &str| imports.join(lib).join("rules").join(format!("{id}.md")).to_string_lossy().into_owned();
        let tidy = home.join("skills").join("tidy").to_string_lossy().into_owned();
        assert_eq!(
            v,
            json!({
                "rowKey": "claude-bare",
                "libraries": [
                    { "library": "claude-user", "source": source, "scope": "global", "sourceGone": false, "bricks": [
                        { "id": "keep-it-short-1", "section": ["Style"], "studs": 3, "on": true, "path": file("claude-user", "keep-it-short-1"),
                          "kind": "rule", "activate": "always", "description": "Style", "body": "Keep answers short." },
                        { "id": "run-tests-2", "section": ["Work"], "studs": 3, "on": false, "path": file("claude-user", "run-tests-2"),
                          "kind": "rule", "activate": "always", "description": "Work", "body": "Run the tests before every commit lands." }
                    ], "sets": [
                        { "set": "row-claude-bare", "editable": true, "skills": [tidy], "agents": [], "guards": [], "codexSkills": [tidy], "warnings": [] }
                    ]},
                    { "library": "vidar-recall", "source": null, "scope": "global", "sourceGone": false, "bricks": [
                        { "id": "recall-first-1", "section": [], "studs": 3, "on": true, "path": file("vidar-recall", "recall-first-1"),
                          "kind": "rule", "activate": "always", "description": "Recall", "body": "Search the notes first." }
                    ], "sets": [
                        { "set": "recall", "editable": true, "skills": [], "agents": [], "guards": [], "codexSkills": [], "warnings": [] }
                    ]}
                ],
                "skills": ["D:\\Work\\skills\\tidy"],
                "agents": ["D:\\Work\\agents\\reviewer.md"],
                "codexSkills": [],
                "codexAgents": [],
                "codexMcp": [],
                "guards": [],
                "codexGuards": [],
                "guardsKey": false
            })
        );
        // The source gone: flagged, still listed.
        std::fs::remove_file(home.join(".claude").join("CLAUDE.md")).unwrap();
        assert!(read(&env, "claude-bare").unwrap().libraries[0].source_gone);
        // A row with no sets: no libraries; a blank key refuses.
        assert!(read(&env, "claude-rendered-bare").unwrap().libraries.is_empty());
        assert!(read(&env, " ").is_err());
    }

    #[test]
    fn no_import_json_sends_an_empty_section() {
        let t = TempDir::new("nosection");
        let (root, home, config) = fixture(&t);
        let imports = root.join("imports");
        let index = imports.join("rowlib.json");
        let env = ActivesEnv { config: &config, root: &root, imports: &imports, index: &index, home: Some(&home) };
        let v = serde_json::to_value(&read(&env, "claude-bare").unwrap().libraries[1].bricks).unwrap();
        // the rune has description "Recall"; it must not ride in the heading path
        assert_eq!(v[0]["description"], "Recall");
        assert_eq!(v[0]["section"], json!([]));
    }

    #[test]
    fn a_missing_rune_file_gives_the_defaults() {
        let t = TempDir::new("missing");
        let (root, home, config) = fixture(&t);
        let imports = root.join("imports");
        // The read-only library's slot outlives its rune file.
        std::fs::remove_file(imports.join("vidar-recall").join("rules").join("recall-first-1.md")).unwrap();
        let index = imports.join("rowlib.json");
        let env = ActivesEnv { config: &config, root: &root, imports: &imports, index: &index, home: Some(&home) };
        let v = serde_json::to_value(&read(&env, "claude-bare").unwrap().libraries[1].bricks).unwrap();
        assert_eq!(
            v,
            json!([{ "id": "recall-first-1", "section": [], "studs": 3, "on": true, "path": "",
                     "kind": "rule", "activate": "always", "description": "", "body": "" }])
        );
    }

    #[test]
    fn a_memory_library_is_project_scoped() {
        let abs = Path::new(r"D:\Work\home\.claude\projects\D--Work-app\memory");
        assert_eq!(scope_of(r"~\.claude\projects\D--Work-app\memory", abs), "project");
        assert_eq!(scope_of(r"~\.codex\AGENTS.md", Path::new(r"D:\Work\home\.codex\AGENTS.md")), "global");
        assert_eq!(scope_of(r"D:\Work\app\CLAUDE.md", Path::new(r"D:\Work\app\CLAUDE.md")), "project");
    }

    fn guard_file(dir: &Path, name: &str) -> String {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, "export {};\n").unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn layer_set_writes_only_given_keys_and_names_the_changed_ones() {
        let t = TempDir::new("set");
        let config = t.0.join("config.json");
        std::fs::write(&config, json!({ "primaryAgent": "claude", "bareAgents": [] }).to_string()).unwrap();
        let hook = guard_file(&t.0.join("hooks"), "guard-cwd.mjs");
        let skill = t.0.join("skills").join("tidy");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "tidy\n").unwrap();
        let g = BareGuard { event: "PreToolUse".into(), matcher: Some("Bash".into()), run: vec![hook.clone()] };
        let set = LayerSet { guards: Some(vec![g.clone()]), skills: Some(vec![skill.to_string_lossy().into_owned()]), agents: Some(vec![]), ..Default::default() };
        assert_eq!(layer_set_at(&config, &set).unwrap(), vec!["guards".to_string(), "skills".to_string()]);
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(root["bareGuards"], json!([{ "event": "PreToolUse", "matcher": "Bash", "run": [hook] }]));
        assert_eq!(root["primaryAgent"], "claude");
        // Same values again: nothing changed. An omitted key stays.
        assert!(layer_set_at(&config, &set).unwrap().is_empty());
        assert_eq!(layer_set_at(&config, &LayerSet { guards: Some(vec![]), ..Default::default() }).unwrap(), vec!["guards".to_string()]);
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(root["bareGuards"], json!([]));
        assert_eq!(root["bareSkills"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn layer_set_refuses_a_codex_mcp_name_outside_hosted_and_writes_nothing() {
        let t = TempDir::new("cmcp");
        let config = t.0.join("config.json");
        let before = json!({ "bareCodexMcp": ["notion"] }).to_string();
        std::fs::write(&config, &before).unwrap();
        for (list, want) in [
            (vec!["figma"], "unknown server"),
            (vec!["notion", "stdio-local"], "unknown server"),
            (vec!["slack"], "manual only"),
            (vec!["notion", "notion"], "twice"),
        ] {
            let list: Vec<String> = list.into_iter().map(String::from).collect();
            let e = layer_set_at(&config, &LayerSet { codex_mcp: Some(list), skills: Some(vec![]), ..Default::default() }).unwrap_err();
            assert!(e.contains(want) && e.ends_with("bareCodexMcp not saved"), "{e}");
        }
        assert_eq!(std::fs::read_to_string(&config).unwrap(), before, "nothing written");
        // A hosted list writes, in the order given, and only that key changes.
        let set = LayerSet { codex_mcp: Some(vec!["atlassian".into(), "notion".into()]), ..Default::default() };
        assert_eq!(layer_set_at(&config, &set).unwrap(), vec!["codexMcp".to_string()]);
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(root["bareCodexMcp"], json!(["atlassian", "notion"]));
        assert!(root.get("bareSkills").is_none());
    }

    #[test]
    fn bare_codex_skills_round_trip_separately_from_bare_skills() {
        let t = TempDir::new("cskills");
        let config = t.0.join("config.json");
        std::fs::write(&config, "{}").unwrap();
        let skill = |n: &str| {
            let d = t.0.join("skills").join(n);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), format!("{n}\n")).unwrap();
            d.to_string_lossy().into_owned()
        };
        let (tidy, lint) = (skill("tidy"), skill("lint"));
        let set = LayerSet { skills: Some(vec![tidy.clone()]), codex_skills: Some(vec![lint.clone()]), ..Default::default() };
        assert_eq!(layer_set_at(&config, &set).unwrap(), vec!["skills".to_string(), "codexSkills".to_string()]);
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(root["bareSkills"], json!([tidy]));
        assert_eq!(root["bareCodexSkills"], json!([lint]));
        // Changing one key leaves the other alone.
        let set = LayerSet { codex_skills: Some(vec![]), ..Default::default() };
        assert_eq!(layer_set_at(&config, &set).unwrap(), vec!["codexSkills".to_string()]);
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(root["bareSkills"], json!([tidy]));
        assert_eq!(root["bareCodexSkills"], json!([]));
        // The read returns each list under its own field.
        let (rt, imports) = (t.0.join("root"), t.0.join("root").join("imports"));
        let index = imports.join("rowlib.json");
        let env = ActivesEnv { config: &config, root: &rt, imports: &imports, index: &index, home: None };
        let a = read(&env, "claude-bare").unwrap();
        assert_eq!((a.skills, a.codex_skills, a.codex_mcp), (vec![tidy], Vec::<String>::new(), Vec::<String>::new()));
        // A codex skill a spawn would skip refuses, naming its own key.
        let e = layer_set_at(&config, &LayerSet { codex_skills: Some(vec![r"D:\Work\no-such-skill".into()]), ..Default::default() }).unwrap_err();
        assert!(e.ends_with("bareCodexSkills not saved"), "{e}");
        // The same skill under both keys is fine: the lists are separate.
        let both = LayerSet { skills: Some(vec![lint.clone()]), codex_skills: Some(vec![lint]), ..Default::default() };
        layer_set_at(&config, &both).unwrap();
    }

    #[test]
    fn bare_codex_agents_round_trip_separately_from_bare_agents() {
        let t = TempDir::new("cagents");
        let config = t.0.join("config.json");
        std::fs::write(&config, "{}").unwrap();
        let role = |n: &str, body: &str| {
            let p = t.0.join("roles").join(format!("{n}.toml"));
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, body).unwrap();
            p.to_string_lossy().into_owned()
        };
        let ok = role("reviewer", "name = \"reviewer\"\ndeveloper_instructions = \"Review.\"\n");
        let set = LayerSet { codex_agents: Some(vec![ok.clone()]), ..Default::default() };
        assert_eq!(layer_set_at(&config, &set).unwrap(), vec!["codexAgents".to_string()]);
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(root["bareCodexAgents"], json!([ok]));
        assert!(root.get("bareAgents").is_none());
        let (rt, imports) = (t.0.join("root"), t.0.join("root").join("imports"));
        let index = imports.join("rowlib.json");
        let env = ActivesEnv { config: &config, root: &rt, imports: &imports, index: &index, home: None };
        let a = read(&env, "claude-bare").unwrap();
        assert_eq!((a.codex_agents, a.agents), (vec![ok.clone()], Vec::<String>::new()));
        // A role a spawn would skip refuses, names the file and its own key, and saves nothing.
        let bad = role("noinstr", "name = \"x\"\n");
        let e = layer_set_at(&config, &LayerSet { codex_agents: Some(vec![ok.clone(), bad.clone()]), ..Default::default() }).unwrap_err();
        assert!(e.contains(&bad) && e.ends_with("bareCodexAgents not saved"), "{e}");
        let notoml = role("junk", "= = =");
        assert!(layer_set_at(&config, &LayerSet { codex_agents: Some(vec![notoml]), ..Default::default() }).is_err());
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(root["bareCodexAgents"], json!([ok]));
    }

    #[test]
    fn layer_set_refuses_any_guard_list_a_spawn_would_refuse() {
        let t = TempDir::new("refuse");
        let config = t.0.join("config.json");
        std::fs::write(&config, "{}").unwrap();
        let hook = guard_file(&t.0.join("a"), "guard-cwd.mjs");
        let twin = guard_file(&t.0.join("b"), "guard-cwd.mjs");
        let wrapper = guard_file(&t.0.join("a"), "fail-closed.mjs");
        let g = |event: &str, run: Vec<String>| BareGuard { event: event.into(), matcher: None, run };
        let cases: Vec<(Vec<BareGuard>, &str)> = vec![
            (vec![g("PreTooluse", vec![hook.clone()])], "not a Claude Code hook event"),
            (vec![g("PreToolUse", vec![])], "empty `run`"),
            (vec![g("Stop", vec![wrapper.clone(), hook.clone()])], "wraps PreToolUse only"),
            (vec![g("PreToolUse", vec![wrapper.clone()])], "no guard after it"),
            (vec![g("PreToolUse", vec![r"hooks\guard-cwd.mjs".into()])], "absolute path to a .mjs"),
            (vec![g("PreToolUse", vec![t.0.join("a").join("guard.js").to_string_lossy().into_owned()])], "absolute path to a .mjs"),
            (vec![g("PreToolUse", vec![t.0.join("a").join("missing.mjs").to_string_lossy().into_owned()])], "is missing"),
            (vec![g("PreToolUse", vec![hook.clone()]), g("Stop", vec![twin.clone()])], "share a file name"),
        ];
        let home = t.0.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let lock = crate::bare::home::lock(&home, crate::bare::home::LOCK_WAIT).unwrap();
        for (list, want) in &cases {
            let e = layer_set_at(&config, &LayerSet { guards: Some(list.clone()), ..Default::default() }).unwrap_err();
            assert!(e.contains(want) && e.ends_with("bareGuards not saved"), "{e}");
            // The spawn refuses the same list.
            let spawn = guards::copy(&lock, &home, list).unwrap_err();
            assert!(spawn.contains(want) && spawn.ends_with("Bare spawn refused"), "{spawn}");
        }
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "{}", "nothing written");
        // Skills and agents a spawn would skip refuse too.
        let e = layer_set_at(&config, &LayerSet { skills: Some(vec![r"D:\Work\no-such-skill".into()]), ..Default::default() }).unwrap_err();
        assert!(e.contains("bareSkills not saved"), "{e}");
        let e = layer_set_at(&config, &LayerSet { agents: Some(vec![r"agents\reviewer.md".into()]), ..Default::default() }).unwrap_err();
        assert!(e.contains("bareAgents not saved"), "{e}");
    }
}
