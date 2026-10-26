//! src-tauri\src\bare\vault\migrate.rs — the startup Rune Vault migration (run 2026-10-25-rune-vault, L4c;
//! plan v1 "Migration", D-f, D-g, D-j). Called once from `main.rs` setup after the fold call, per install
//! root. It turns today's Bare launcher rows into vaults and leaves no row binding behind:
//!
//! 1. Plan first, read-only; a plan with nothing to do writes nothing, so a second run is a no-op.
//! 2. Backup before any write: vidar.json, `gen-index.json`, every sidecar, every set file the run
//!    edits, every file in each renamed library, `overrides\` and both agent-home indexes go to
//!    `runtime\migrations\vault-<stamp>\` with `plan.txt`.
//! 3. Generation libraries are renamed first (D-f): `gen-<rowKey>-<hex>` → `gen-<hex>`, their `row-*`
//!    sets → `generated-<yyyymmdd>`; every set's `scope:` takes the new name and `generate.json`
//!    loses `rowKey` (M1).
//! 4. Each sidecar (`sets\<set>.layer.json`, and the retired home-wide `bare*` keys the fold
//!    migration folded, absorbed from `fold_migrate.rs`) becomes item runes in the same library plus
//!    slots in the set; Codex keys merge by name (one side only gets `agent:`).
//! 5. Each distinct (agent, body, sets) across Bare rows becomes one vault: the matching stock template
//!    plus dated snapshots of the sets, overrides (`shadow`, derived `add`/`off`) applied into the
//!    snapshots. Ids are deterministic (`<agent>-<body>`, `-<hash6>` when two combinations share it).
//!    No vault links to a library runeset, and no session record is derived (D-g: adopt builds those).
//! 6. Each vault's agent-home index entry points at its combination's folder, so threads stay. Index
//!    entries that are not `vault:<id>` go (`stale_entries`, M1), except a combination entry readers
//!    need to list its folder; no home folder or thread file is ever deleted.
//! 7. vidar.json last (D-j): rows lose `sets` and `permissionMode`, saved workspace sets become
//!    named vaults, and retired keys go. Then `gen-index.json` and converted sidecars are deleted.
//!
//! A write-ahead recovery marker reverses an interrupted run before any new plan. Returned errors
//! use the in-memory undo journal and keep a notice naming `plan.txt` for the launcher (`notice`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::{content_sha, vault_hash, RuneRef, RunesetCopy, SetSource, Template, Vault, VaultFrom};
use crate::bare::agent_homes::{self, Agent, Entry, Index};
use crate::bare::bundles;
use crate::bare::layer::{RowSets, SetRef};
use crate::bare::{home, set_layer};
use crate::rules::library::Library;
use crate::rules::rune;

#[path = "migrate_items.rs"]
mod items;
use items::{append_slots, items_of, remove_slots, rename_header, rescope_header, rune_text, slots_of, strings, Item, Retired};

#[path = "migrate_split.rs"]
mod split;

#[path = "migrate_durable.rs"]
mod durable;
use durable::{backup, backup_dir, recover, recovery_file, save_recovery, write_plan_txt, Recovery};

/// The retired home-wide keys (the fold migration's `DEPRECATED`), each with the sidecar list it feeds.
const RETIRED: &[(&str, &str)] = &[
    ("bareSkills", "skills"),
    ("bareAgents", "agents"),
    ("bareGuards", "guards"),
    ("bareCodexSkills", "codexSkills"),
    ("bareCodexAgents", "codexAgents"),
    ("bareCodexGuards", "codexGuards"),
    ("bareCodexMcp", "codexMcp"),
];

/// The built-in Bare rows (`src/launcher/roster.ts`): key, agent, body.
const BUILTIN: &[(&str, &str, &str)] = &[
    ("claude-rendered-bare", "claude", "rendered"),
    ("claude-bare", "claude", "raw"),
    ("codex-rendered-bare", "codex", "rendered"),
    ("codex-bare", "codex", "raw"),
];

/// The last failed run's launcher notice (D-j); `None` after a clean run.
static NOTICE: Mutex<Option<String>> = Mutex::new(None);

/// The notice a failed startup run left: it names the run's `plan.txt`. Read by the launcher's config
/// notice (wiring outside this lane).
#[allow(dead_code)]
pub fn notice() -> Option<String> {
    NOTICE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_notice(n: Option<String>) {
    *NOTICE.lock().unwrap_or_else(|e| e.into_inner()) = n;
}

/// What one run reads. `home_dir` `None` skips the home re-key; `fail_at` names a step to fail (tests).
pub(crate) struct Env<'a> {
    pub root: &'a Path,
    pub config: &'a Path,
    pub home_dir: Option<&'a Path>,
    pub stamp: &'a str,
    pub fail_at: Option<&'a str>,
}

// ---- plan ----

struct GenRename {
    from: String,
    to: String,
    /// (old set, new set) for each `row-*` set.
    sets: Vec<(String, String)>,
}

/// A library as the run sees it: names before and after, its folder before any write, the set files it
/// read (bytes before, text after) and the rune ids it planned.
struct Lib {
    old: String,
    new: String,
    dir: PathBuf,
    index: Option<Library>,
    set_names: BTreeMap<String, String>,
    sets: BTreeMap<String, (Vec<u8>, String)>,
    ids: BTreeSet<String>,
    /// Sets this run creates (agent splits of a converted sidecar); written as new files, never edits.
    made: BTreeSet<String>,
}

impl Lib {
    fn set_new(&self, set_old: &str) -> String {
        self.set_names.get(set_old).cloned().unwrap_or_else(|| set_old.to_string())
    }

    fn set_md(&self, set: &str) -> PathBuf {
        self.dir.join("sets").join(format!("{set}.md"))
    }

    fn text(&mut self, set_old: &str) -> Result<&mut String, String> {
        if !self.sets.contains_key(set_old) {
            let bytes = std::fs::read(self.set_md(set_old)).map_err(|_| format!("library {} has no set {set_old}", self.old))?;
            let mut text = String::from_utf8_lossy(&bytes).into_owned();
            // A renamed generation library's sets carry its old name in `scope:` (M1).
            if self.old != self.new {
                text = rescope_header(&text, &self.old, &self.new);
            }
            self.sets.insert(set_old.to_string(), (bytes, text));
        }
        Ok(&mut self.sets.get_mut(set_old).expect("inserted").1)
    }
}

struct RuneWrite {
    lib: String,
    rel: String,
    bytes: Vec<u8>,
}

struct VaultWrite {
    vault: Vault,
    files: Vec<(String, Vec<u8>)>,
    reuse: bool,
    rows: Vec<String>,
}

#[derive(Default)]
pub(crate) struct Plan {
    renames: Vec<GenRename>,
    libs: BTreeMap<String, Lib>,
    runes: Vec<RuneWrite>,
    vaults: Vec<VaultWrite>,
    rekeys: Vec<(Agent, String, Entry)>,
    /// Home index entries that are not `vault:<id>` and go (M1); folders and threads stay.
    drops: Vec<(Agent, String, Entry)>,
    strip_sets: BTreeSet<String>,
    strip_mode: BTreeSet<String>,
    strip_locations: BTreeSet<usize>,
    remove_keys: Vec<&'static str>,
    /// (library before, set before) of each converted sidecar.
    sidecars: Vec<(String, String)>,
    /// (library before, set before) of a converted sidecar -> its per-agent sets (agent, final set name).
    splits: BTreeMap<(String, String), Vec<(&'static str, String)>>,
    /// Stock vaults rewritten because a runeset mixed agent tags (`split::repair`).
    fixes: Vec<split::VaultFix>,
    delete_gen_index: bool,
    pub warnings: Vec<String>,
}

impl Plan {
    fn set_edits(&self) -> impl Iterator<Item = (&Lib, &String, &(Vec<u8>, String))> {
        self.libs.values().flat_map(|l| l.sets.iter().filter(|(s, (b, a))| !l.made.contains(*s) && (b.as_slice() != a.as_bytes() || l.set_new(s) != **s)).map(move |(s, v)| (l, s, v)))
    }

    pub fn is_empty(&self) -> bool {
        self.renames.is_empty()
            && self.runes.is_empty()
            && self.set_edits().next().is_none()
            && self.vaults.iter().all(|v| v.reuse)
            && self.rekeys.is_empty()
            && self.drops.is_empty()
            && self.strip_sets.is_empty()
            && self.strip_mode.is_empty()
            && self.strip_locations.is_empty()
            && self.remove_keys.is_empty()
            && self.sidecars.is_empty()
            && self.fixes.is_empty()
            && !self.delete_gen_index
    }

    pub fn lines(&self) -> Vec<String> {
        let mut out = Vec::new();
        for r in &self.renames {
            out.push(format!("rename library {} to {}", r.from, r.to));
            for (a, b) in &r.sets {
                out.push(format!("rename set {}/{a} to {}/{b}", r.to, r.to));
            }
        }
        for (lib, (lib_old, set_old)) in self.sidecars.iter().map(|k| (self.libs.get(&k.0), k)) {
            let new = lib.map(|l| l.new.clone()).unwrap_or_else(|| lib_old.clone());
            out.push(format!("convert sidecar {lib_old}/{set_old}.layer.json into runes of library {new}"));
        }
        for w in &self.runes {
            out.push(format!("write rune {}/{}", w.lib, w.rel));
        }
        for (l, s, _) in self.set_edits() {
            out.push(format!("edit set {}/{} (slots, name)", l.new, l.set_new(s)));
        }
        for v in &self.vaults {
            let sets: Vec<String> = v.vault.runesets.iter().map(|c| format!("{}/{}", c.source.library, c.source.set)).collect();
            let verb = if v.reuse { "reuse" } else { "write" };
            out.push(format!("{verb} vault {} ({}) hash {}: runesets [{}], rows {}", v.vault.id, v.vault.name, v.vault.hash, sets.join(", "), v.rows.join(", ")));
        }
        for f in &self.fixes {
            let sets: Vec<String> = f.vault.runesets.iter().map(|c| format!("{}/{}", c.source.library, c.source.set)).collect();
            out.push(format!("split mixed runesets of vault {}: runesets [{}] hash {}", f.vault.id, sets.join(", "), f.vault.hash));
        }
        for (a, key, e) in &self.rekeys {
            out.push(format!("home index {a:?} {key} ({}) -> {}", e.sets.join(", "), e.dir));
        }
        for (a, key, e) in &self.drops {
            out.push(format!("drop home index {a:?} {key} ({}) on {}", e.sets.join(", "), e.dir));
        }
        for k in &self.strip_sets {
            out.push(format!("remove sets from row {k}"));
        }
        for k in &self.strip_mode {
            out.push(format!("remove permissionMode from row {k}"));
        }
        for i in &self.strip_locations {
            out.push(format!("move location {i} sets to a workspace vault"));
        }
        for k in &self.remove_keys {
            out.push(format!("remove {k} from vidar.json"));
        }
        if self.delete_gen_index {
            out.push("delete gen-index.json".into());
        }
        out.extend(self.warnings.iter().map(|w| format!("warning: {w}")));
        out
    }
}

fn read_config(config: &Path) -> Result<Map<String, Value>, String> {
    match crate::fsx::read_text(config) {
        Ok(t) => match serde_json::from_str(crate::fsx::strip_bom(&t)) {
            Ok(Value::Object(o)) => Ok(o),
            Ok(_) => Err(format!("vidar.json {} is not a JSON object", config.display())),
            Err(e) => Err(format!("vidar.json {} is unreadable ({e})", config.display())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(format!("vidar.json {} is unreadable ({e})", config.display())),
    }
}

/// One Bare row: key, agent, body, and the `sets` of the last entry with that key that has one.
struct Row {
    key: String,
    agent: Option<String>,
    body: String,
    sets: Option<Value>,
}

fn bare_rows(obj: &Map<String, Value>) -> Vec<Row> {
    let mut rows: Vec<Row> = BUILTIN.iter().map(|(k, a, b)| Row { key: k.to_string(), agent: Some(a.to_string()), body: b.to_string(), sets: None }).collect();
    for e in obj.get("agents").and_then(Value::as_array).into_iter().flatten() {
        let Some(key) = e.get("key").and_then(Value::as_str).map(str::trim).filter(|k| !k.is_empty()) else { continue };
        let i = match rows.iter().position(|r| r.key == key) {
            Some(i) => i,
            None if e.get("profile").and_then(Value::as_str) == Some("bare") => {
                let agent = e.get("id").and_then(Value::as_str).map(str::to_string);
                let body = if e.get("body").and_then(Value::as_str) == Some("rendered") { "rendered" } else { "raw" };
                rows.push(Row { key: key.to_string(), agent, body: body.to_string(), sets: None });
                rows.len() - 1
            }
            None => continue,
        };
        if let Some(s) = e.get("sets") {
            rows[i].sets = Some(s.clone());
        }
    }
    rows
}

fn is_bare_entry(e: &Value, rows: &[Row]) -> Option<String> {
    let key = e.get("key").and_then(Value::as_str).map(str::trim)?;
    rows.iter().any(|r| r.key == key).then(|| key.to_string())
}

/// `<hex>` of a per-row generation library name `gen-<rowKey>-<hex>`; a renamed `gen-<hex>` gives none.
fn gen_hex(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("gen-")?;
    let (row, hex) = rest.rsplit_once('-')?;
    (!row.is_empty() && hex.len() >= 6 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some(hex)
}

fn sub_dirs(dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'))
        .collect();
    out.sort();
    out
}

fn files_in(dir: &Path, suffix: &str) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|n| n.strip_suffix(suffix).map(str::to_string))
        .collect();
    out.sort();
    out
}

/// The import libraries (one folder each under the imports folder; not `overrides`, not hidden).
fn libraries(env: &Env) -> Vec<String> {
    let overrides = crate::paths::legacy_rune_overrides_dir_in(env.root);
    let imports = crate::paths::rune_imports_dir_in(env.root);
    sub_dirs(&imports).into_iter().filter(|n| imports.join(n) != overrides && rune::check_id(n).is_ok()).collect()
}

fn gen_renames(env: &Env, warnings: &mut Vec<String>) -> Vec<GenRename> {
    let imports = crate::paths::rune_imports_dir_in(env.root);
    let fallback: String = env.stamp.chars().take(10).filter(char::is_ascii_digit).collect();
    let mut out: Vec<GenRename> = Vec::new();
    for name in libraries(env) {
        let Some(hex) = gen_hex(&name) else { continue };
        let dir = imports.join(&name);
        let Ok(meta) = crate::fsx::read_json::<Value>(&dir.join("generate.json")) else { continue };
        let taken = |n: &str, out: &[GenRename]| imports.join(n).exists() || out.iter().any(|r| r.to == n);
        let Some(to) = (1..10).map(|i| if i == 1 { format!("gen-{hex}") } else { format!("gen-{hex}-{i}") }).find(|n| !taken(n, &out)) else {
            warnings.push(format!("library {name}: no free gen-{hex} name; left as it is"));
            continue;
        };
        let date: String = meta.get("date").and_then(Value::as_str).unwrap_or_default().chars().filter(char::is_ascii_digit).collect();
        let date = if date.len() == 8 { date } else { fallback.clone() };
        let existing = files_in(&dir.join("sets"), ".md");
        let mut sets: Vec<(String, String)> = Vec::new();
        for s in existing.iter().filter(|s| s.starts_with("row-")) {
            let new = (1..100)
                .map(|i| if i == 1 { format!("generated-{date}") } else { format!("generated-{date}-{i}") })
                .find(|n| !existing.contains(n) && !sets.iter().any(|(_, b)| b == n))
                .unwrap_or_else(|| s.clone());
            sets.push((s.clone(), new));
        }
        out.push(GenRename { from: name, to, sets });
    }
    out
}

impl Plan {
    fn lib(&mut self, env: &Env, name: &str) -> Result<&mut Lib, String> {
        if !self.libs.contains_key(name) {
            rune::check_id(name).map_err(|e| format!("library {name:?}: {e}"))?;
            let dir = crate::bare::layer::library_dir_named(env.root, name)?;
            let r = self.renames.iter().find(|r| r.from == name);
            let lib = Lib {
                old: name.to_string(),
                new: r.map(|r| r.to.clone()).unwrap_or_else(|| name.to_string()),
                index: Library::open(&dir).ok(),
                dir,
                set_names: r.map(|r| r.sets.iter().cloned().collect()).unwrap_or_default(),
                sets: BTreeMap::new(),
                ids: BTreeSet::new(),
                made: BTreeSet::new(),
            };
            self.libs.insert(name.to_string(), lib);
        }
        Ok(self.libs.get_mut(name).expect("inserted"))
    }
}

// ---- sidecar -> item runes (conversion in `migrate_items.rs`) ----

/// Places `items` as runes of `lib` and slots them into set `set_old`. An id already in the library with
/// the same bytes is reused (no write); any other clash takes the next free id.
fn place(plan: &mut Plan, env: &Env, lib_old: &str, set_old: &str, items: Vec<Item>) -> Result<(), String> {
    let lib = plan.lib(env, lib_old)?;
    let origin = format!("{}/{}", lib.new, lib.set_new(set_old));
    lib.text(set_old)?;
    let mut ids = Vec::new();
    let mut writes = Vec::new();
    for it in items {
        let base = it.name.clone();
        let mut cands = vec![base.clone()];
        cands.extend((2..50).map(|n| format!("{base}-{n}")));
        let mut chosen = None;
        for c in cands {
            if rune::check_id(&c).is_err() || lib.ids.contains(&c) {
                continue;
            }
            let text = rune_text(&c, &it, &origin);
            let rel = format!("{}/{c}.md", it.folder);
            let at_path = lib.dir.join(&rel);
            let entry = lib.index.as_ref().map(|i| i.entry(&c));
            match entry {
                Some(Ok(Some(e))) => {
                    if std::fs::read(&e.path).is_ok_and(|b| b == text.as_bytes()) {
                        chosen = Some((c, None));
                        break;
                    }
                }
                Some(Err(_)) => {}
                _ if at_path.exists() => {}
                _ => {
                    chosen = Some((c, Some((rel, text))));
                    break;
                }
            }
        }
        let (id, write) = chosen.ok_or_else(|| format!("no free rune id for {} in library {}", base, lib.old))?;
        lib.ids.insert(id.clone());
        ids.push(id);
        if let Some((rel, text)) = write {
            writes.push(RuneWrite { lib: lib.new.clone(), rel, bytes: text.into_bytes() });
        }
    }
    append_slots(lib.text(set_old)?, &ids);
    plan.runes.extend(writes);
    Ok(())
}

// ---- snapshots and vaults ----

fn override_file(env: &Env, lib_old: &str, set: &str) -> Option<Value> {
    crate::fsx::read_json(&crate::paths::legacy_rune_overrides_dir_in(env.root).join(lib_old).join(format!("{set}.json"))).ok()
}

fn required(env: &Env, lib_old: &str) -> BTreeSet<String> {
    let v: Option<Value> = crate::fsx::read_json(&crate::paths::legacy_rune_overrides_dir_in(env.root).join(lib_old).join("_required.json")).ok();
    strings(v.as_ref().and_then(|v| v.get("required"))).into_iter().collect()
}

/// The snapshot of row ref `set` in `lib_old` as the run leaves the library: a plain set with its
/// override's `shadow` ids taken out, or a derived set (an override file only) built from its base.
///
/// A set whose sidecar split by agent (`plan.splits`) yields its base (unless it holds nothing) plus the
/// per-agent sets for `agent` (every agent when `None`); overrides apply across all of them.
fn snapshot(plan: &mut Plan, env: &Env, lib_old: &str, set: &str, agent: Option<&str>) -> Result<Vec<(SetSource, Vec<u8>)>, String> {
    let must = required(env, lib_old);
    let split_of = |plan: &Plan, s: &str| -> Vec<(&'static str, String)> { plan.splits.get(&(lib_old.to_string(), s.to_string())).cloned().unwrap_or_default() };
    let own = split_of(plan, set);
    let own_sel: Vec<String> = own.iter().filter(|(a, _)| agent.is_none_or(|x| x == *a)).map(|(_, n)| n.clone()).collect();
    let ov = override_file(env, lib_old, set);
    let base_splits: Vec<(&'static str, String)> = ov.as_ref().and_then(|o| o.get("source")).and_then(|s| s.get("set")).and_then(Value::as_str).map(|b| split_of(plan, b)).unwrap_or_default();
    let base_sel: Vec<String> = base_splits.iter().filter(|(a, _)| agent.is_none_or(|x| x == *a)).map(|(_, n)| n.clone()).collect();
    let lib = plan.lib(env, lib_old)?;
    let mut warnings = Vec::new();
    let plain = lib.set_md(set).is_file() || lib.sets.contains_key(set);
    let mut extra: Vec<(String, String)> = Vec::new();
    let mut plain_out: BTreeSet<String> = BTreeSet::new();
    let (text, name) = if plain {
        let text = lib.text(set)?.clone();
        let mut combined = text.clone();
        for n in &own_sel {
            let t = lib.text(n)?.clone();
            append_slots(&mut combined, &split::slot_order(&t));
            extra.push((n.clone(), t));
        }
        let have = slots_of(&combined);
        let mut out: BTreeSet<String> = BTreeSet::new();
        if let Some(o) = &ov {
            for id in strings(o.get("shadow")).into_iter().filter(|i| !must.contains(i)) {
                if have.contains(&id) {
                    out.insert(id);
                } else {
                    warnings.push(format!("{lib_old}/{set}: `{id}` is shadowed but has no slot; a snapshot cannot drop it"));
                }
            }
            for id in strings(o.get("off")).into_iter().filter(|i| !must.contains(i) && !have.contains(i)) {
                warnings.push(format!("{lib_old}/{set}: recall member `{id}` is off; a snapshot cannot drop it"));
            }
        }
        let kept = remove_slots(&text, &out);
        plain_out = out;
        (kept, lib.set_new(set))
    } else {
        let o = ov.ok_or_else(|| format!("{lib_old} has no set {set}"))?;
        let base = o.get("source").and_then(|s| s.get("set")).and_then(Value::as_str).filter(|b| *b != set && rune::check_id(b).is_ok()).ok_or_else(|| format!("derived set {lib_old}/{set} names no base"))?.to_string();
        let mut text = lib.text(&base).map_err(|_| format!("derived set {lib_old}/{set}: base set {base} is missing"))?.clone();
        for n in &base_sel {
            let t = lib.text(n)?.clone();
            append_slots(&mut text, &split::slot_order(&t));
        }
        append_slots(&mut text, &strings(o.get("add")));
        let have = slots_of(&text);
        let mut out = BTreeSet::new();
        for id in strings(o.get("off")).into_iter().chain(strings(o.get("shadow"))).filter(|i| !must.contains(i)) {
            if have.contains(&id) {
                out.insert(id);
            } else {
                warnings.push(format!("{lib_old}/{set}: `{id}` is off but has no slot; a snapshot cannot drop it"));
            }
        }
        (rename_header(&remove_slots(&text, &out), set), set.to_string())
    };
    let lib_new = lib.new.clone();
    let source = SetSource { library: lib_new.clone(), set: name.clone() };
    let text = if plain && name != set { rename_header(&text, &name) } else { text };
    plan.warnings.extend(warnings);
    let mut out = Vec::new();
    // A base that held only sidecar slots, now moved into the agent sets, is no runeset.
    let empty = slots_of(&text).is_empty() && !text.contains("<?recall");
    if !(plain && !own.is_empty() && empty) {
        out.push((source, text.into_bytes()));
    }
    for (n, t) in extra {
        out.push((SetSource { library: lib_new.clone(), set: n }, remove_slots(&t, &plain_out).into_bytes()));
    }
    Ok(out)
}

/// A template runeset's snapshot straight from its library (`stock` or an import library).
fn template_set(env: &Env, s: &SetSource) -> Result<Vec<u8>, String> {
    rune::check_id(&s.library).and(rune::check_id(&s.set))?;
    let dir = if s.library == "stock" { crate::paths::rune_stock_dir_in(env.root) } else { crate::paths::rune_imports_dir_in(env.root).join(&s.library) };
    std::fs::read(dir.join("sets").join(format!("{}.md", s.set))).map_err(|_| format!("template runeset {}/{} is missing", s.library, s.set))
}

fn hex6(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(3).map(|b| format!("{b:02x}")).collect()
}

/// The agent-home index key a spawn on vault `id` looks up: L2a's `agent_homes::pick_vault` (the
/// combination of one ref `vault:<id>`). The legacy path only has to sit under the home; the key does
/// not depend on it.
pub(crate) fn vault_home_key(agent: Agent, home_dir: &Path, id: &str) -> Option<String> {
    agent_homes::pick_vault(agent, home_dir, &home_dir.join(".vault-key"), Some(id)).combo.map(|(hash, _)| hash)
}

fn title(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn agent_of(a: &str) -> Option<Agent> {
    match a {
        "claude" => Some(Agent::Claude),
        "codex" => Some(Agent::Codex),
        _ => None,
    }
}

/// The home index entries that go (M1): every entry that is not one `vault:<id>` ref, unless it is
/// the only way readers reach its folder. `agent_homes::listed` (recent sessions, Codex threads,
/// cap SIDs) lists a combination folder only under the key it is named after
/// (`<agent dir>/<key>`), never under a re-keyed `vault:<id>` entry, so dropping that entry would hide
/// the folder's threads: it stays with a warning. A probe's entry (`vidar-runes-probe-*`) and an
/// entry on any other folder (the legacy home, always listed) go. Only index entries change.
fn stale_entries(plan: &mut Plan, home_dir: &Path) {
    for a in [Agent::Claude, Agent::Codex] {
        let file = agent_homes::index_file(a, home_dir);
        let Ok(index) = crate::fsx::read_json::<Index>(&file) else { continue };
        let dir = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        for (key, e) in index {
            if matches!(e.sets.as_slice(), [s] if s.starts_with("vault:")) {
                continue;
            }
            let probe = e.sets.iter().any(|s| s.contains("vidar-runes-probe-"));
            if !probe && e.dir == format!("{dir}/{key}") {
                plan.warnings.push(format!("home index {a:?} {key} on {} stays: readers list that folder only under this key", e.dir));
                continue;
            }
            plan.drops.push((a, key, e));
        }
    }
}

/// A row ready to migrate: its refs as written (old library names) and the refs after renames.
struct Ready {
    key: String,
    agent: String,
    body: String,
    refs: Vec<SetRef>,
}

/// The run's plan, read-only.
pub(crate) fn plan(env: &Env) -> Result<Plan, String> {
    let obj = read_config(env.config)?;
    let mut plan = Plan::default();
    plan.renames = gen_renames(env, &mut plan.warnings);
    // Every set of a renamed library is read, so each takes its new name and scope (M1), picked by
    // a row or not.
    let imports = crate::paths::rune_imports_dir_in(env.root);
    for name in plan.renames.iter().map(|r| r.from.clone()).collect::<Vec<_>>() {
        for set in files_in(&imports.join(&name).join("sets"), ".md") {
            plan.lib(env, &name)?.text(&set)?;
        }
    }
    let rows = bare_rows(&obj);
    let rules_library = obj.get("rulesLibrary").and_then(Value::as_str).map(str::to_string);

    // Rows whose refs can migrate; the rest keep `sets` with a warning.
    let mut ready: Vec<Ready> = Vec::new();
    for r in &rows {
        let Some(v) = r.sets.as_ref() else { continue };
        let refs: Vec<SetRef> = match serde_json::from_value::<Option<Vec<SetRef>>>(v.clone()) {
            Ok(r) => r.unwrap_or_default(),
            Err(e) => {
                plan.warnings.push(format!("row {}: `sets` is not a list of {{ library?, set }} ({e}); left in vidar.json", r.key));
                continue;
            }
        };
        if refs.is_empty() {
            plan.strip_sets.insert(r.key.clone());
            continue;
        }
        let Some(agent) = r.agent.clone().filter(|a| agent_of(a).is_some()) else {
            plan.warnings.push(format!("row {}: agent {:?} has no stock template; left in vidar.json", r.key, r.agent));
            continue;
        };
        let mut bad = None;
        for s in &refs {
            match &s.library {
                None => bad = Some(format!("set {} names no library (rulesLibrary sets have no vault source yet)", s.set)),
                Some(l) if plan.lib(env, l).is_err() => bad = Some(format!("library {l:?} has no folder")),
                Some(_) if rune::check_id(&s.set).is_err() => bad = Some(format!("set {:?} is not a set name", s.set)),
                Some(_) => {}
            }
        }
        if let Some(b) = bad {
            plan.warnings.push(format!("row {}: {b}; left in vidar.json", r.key));
            continue;
        }
        ready.push(Ready { key: r.key.clone(), agent, body: r.body.clone(), refs });
    }

    // Sidecars and the retired keys become item runes (step 2).
    let (catalog, catalog_warnings) = bundles::load(env.root);
    let mut retired = Retired::default();
    let mut retired_left: BTreeSet<&'static str> = BTreeSet::new();
    for (k, list) in RETIRED {
        match obj.get(*k) {
            None => {}
            Some(Value::Array(a)) if a.is_empty() => plan.remove_keys.push(k),
            Some(Value::Array(a)) => {
                retired.lists.insert(list, a.clone());
            }
            Some(_) => {
                plan.warnings.push(format!("{k} is not a list; left in vidar.json"));
                retired_left.insert(k);
            }
        }
    }
    let mut targets: Vec<(String, String)> = Vec::new();
    if !retired.lists.is_empty() {
        for r in &ready {
            for s in &r.refs {
                let lib = s.library.clone().unwrap_or_default();
                let l = plan.lib(env, &lib)?;
                let set = if l.set_md(&s.set).is_file() {
                    s.set.clone()
                } else {
                    match override_file(env, &lib, &s.set).and_then(|o| o.get("source").and_then(|x| x.get("set")).and_then(Value::as_str).map(str::to_string)) {
                        Some(b) => b,
                        None => continue,
                    }
                };
                if !targets.contains(&(lib.clone(), set.clone())) {
                    targets.push((lib, set));
                }
            }
        }
    }
    let mut sources: Vec<(String, String, bool)> = Vec::new();
    for lib in libraries(env) {
        for set in files_in(&imports.join(&lib).join("sets"), ".layer.json") {
            sources.push((lib.clone(), set, true));
        }
    }
    for (lib, set) in &targets {
        if !sources.iter().any(|(l, s, _)| l == lib && s == set) {
            sources.push((lib.clone(), set.clone(), false));
        }
    }
    let mut retired_ok = true;
    for (lib, set, has_file) in sources {
        let label = format!("{lib}/{set}");
        let target = targets.contains(&(lib.clone(), set.clone()));
        let obj: Map<String, Value> = if has_file {
            match crate::fsx::read_json::<Value>(&set_layer::sidecar_path(&imports.join(&lib), &set)) {
                Ok(Value::Object(o)) => o,
                _ => {
                    plan.warnings.push(format!("sidecar {label} is not a JSON object; it stays"));
                    retired_ok &= !target;
                    continue;
                }
            }
        } else {
            Map::new()
        };
        let empty = Retired::default();
        let extra = if target { &retired } else { &empty };
        if !catalog_warnings.is_empty() && (obj.get("modules").is_some() || extra.lists.contains_key("codexMcp")) {
            plan.warnings.push(format!("{label}: {}; it stays", catalog_warnings.join("; ")));
            retired_ok &= !target;
            continue;
        }
        if !plan.lib(env, &lib)?.set_md(&set).is_file() {
            plan.warnings.push(format!("sidecar {label} has no set file; it stays"));
            retired_ok &= !target;
            continue;
        }
        let mut warnings = Vec::new();
        let (items, ok) = items_of(&obj, extra, &catalog, &label, &mut warnings);
        plan.warnings.extend(warnings);
        retired_ok &= ok || !target;
        split::place_split(&mut plan, env, &lib, &set, items)?;
        if has_file && ok {
            plan.sidecars.push((lib, set));
        }
    }
    if !retired.lists.is_empty() {
        if targets.is_empty() || !retired_ok {
            let why = if targets.is_empty() { "no Bare row picks an import library set" } else { "an entry did not convert" };
            plan.warnings.push(format!("the retired bare* keys stay in vidar.json: {why}"));
        } else {
            plan.remove_keys.extend(RETIRED.iter().filter(|(_, l)| retired.lists.contains_key(l)).map(|(k, _)| *k));
        }
    }
    let _ = retired_left;

    // Vaults, one per distinct (agent, body, sets) (step 3).
    let mut groups: Vec<(String, String, Vec<SetRef>, Vec<usize>)> = Vec::new();
    for (i, r) in ready.iter().enumerate() {
        match groups.iter_mut().find(|g| g.0 == r.agent && g.1 == r.body && g.2 == r.refs) {
            Some(g) => g.3.push(i),
            None => groups.push((r.agent.clone(), r.body.clone(), r.refs.clone(), vec![i])),
        }
    }
    let vaults_dir = crate::paths::rune_vaults_dir_in(env.root);
    let store = super::store::Store::open(env.root);
    let now = crate::runlog::utc_stamp();
    for (agent, body, refs, members) in &groups {
        let tid = format!("stock-{agent}");
        let template: Template = crate::fsx::read_json(&crate::paths::rune_templates_dir_in(env.root).join(format!("{tid}.json")))?;
        let mut sets: Vec<(RunesetCopy, Vec<u8>)> = Vec::new();
        let add = |source: SetSource, bytes: Vec<u8>, sets: &mut Vec<(RunesetCopy, Vec<u8>)>| {
            if !sets.iter().any(|(c, _)| c.source == source) {
                let file = format!("sets/{}--{}.md", source.library, source.set);
                sets.push((RunesetCopy { file, source, copied_utc: now.clone(), source_hash: content_sha(&bytes) }, bytes));
            }
        };
        for s in &template.runesets {
            add(s.clone(), template_set(env, s)?, &mut sets);
        }
        for s in refs {
            for (source, bytes) in snapshot(&mut plan, env, s.library.as_deref().unwrap_or_default(), &s.set, Some(agent.as_str()))? {
                add(source, bytes, &mut sets);
            }
        }
        let runes: Vec<RuneRef> = template.runes.clone();
        let pairs: Vec<(SetSource, String)> = sets.iter().map(|(c, b)| (c.source.clone(), content_sha(b))).collect();
        let hash = vault_hash(&pairs, &runes);
        let key_text = format!("{agent}\t{body}\t{}", pairs.iter().map(|(s, _)| format!("{}/{}", s.library, s.set)).collect::<Vec<_>>().join("\t"));
        let base = format!("{agent}-{body}");
        let shared = groups.iter().filter(|g| g.0 == *agent && g.1 == *body).count() > 1;
        let mut cands = Vec::new();
        if !shared {
            cands.push(base.clone());
        }
        cands.push(format!("{base}-{}", hex6(&key_text)));
        let mut pick = None;
        for c in cands {
            if plan.vaults.iter().any(|v| v.vault.id == c) {
                continue;
            }
            match store.get(&c) {
                Ok(v) if v.hash == hash => {
                    pick = Some((c, true));
                    break;
                }
                Ok(_) => continue,
                Err(_) if vaults_dir.join(&c).exists() => continue,
                Err(_) => {
                    pick = Some((c, false));
                    break;
                }
            }
        }
        let (id, reuse) = pick.ok_or_else(|| format!("no free vault id for {base}"))?;
        let rows: Vec<String> = members.iter().map(|i| ready[*i].key.clone()).collect();
        let vault = Vault {
            version: 1,
            id: id.clone(),
            name: format!("{} {}", title(agent), title(body)),
            created_utc: now.clone(),
            from: Some(VaultFrom::Template { template: tid }),
            runesets: sets.iter().map(|(c, _)| c.clone()).collect(),
            runes,
            locked_utc: None,
            locked_by: None,
            hash,
            pins: BTreeMap::new(),
        };
        let files = sets.into_iter().map(|(c, b)| (c.file, b)).collect();
        // Home re-key (step 5): the row's home (the adopted legacy one or its combination folder)
        // carries over to the vault's key, so the row keeps its threads (L2g). The folder never moves:
        // a live Falcon session may hold it. `pick_vault` follows only the legacy home or a folder
        // under the agent's dir.
        if let (Some(home_dir), Some(a)) = (env.home_dir, agent_of(agent)) {
            let index: Index = crate::fsx::read_json(&agent_homes::index_file(a, home_dir)).unwrap_or_default();
            let old = agent_homes::hash12(&RowSets { sets: refs.clone(), rules_library: rules_library.clone() });
            let new_key = vault_home_key(a, home_dir, &id);
            if let (Some(e), Some(new_key)) = (old.and_then(|k| index.get(&k).cloned()), new_key) {
                if !index.contains_key(&new_key) && !plan.rekeys.iter().any(|(x, k, _)| *x == a && *k == new_key) {
                    plan.rekeys.push((a, new_key, Entry { sets: vec![format!("vault:{id}")], dir: e.dir, last_used: e.last_used }));
                }
            }
        }
        plan.strip_sets.extend(rows.iter().cloned());
        plan.vaults.push(VaultWrite { vault, files, reuse, rows });
    }
    split::repair(env, &mut plan)?;
    if let Some(home_dir) = env.home_dir {
        stale_entries(&mut plan, home_dir);
    }

    // vidar.json tail (step 6).
    for e in obj.get("agents").and_then(Value::as_array).into_iter().flatten() {
        if let Some(k) = is_bare_entry(e, &rows) {
            if e.get("permissionMode").is_some() {
                plan.strip_mode.insert(k);
            }
        }
    }
    for k in &plan.strip_mode {
        plan.warnings.push(format!("row {k}: permissionMode leaves the row; the vault's permission rune sets the mode"));
    }
    for (i, loc) in obj.get("locations").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let Some(raw) = loc.get("sets") else { continue };
        let mut refs: Vec<SetRef> = match serde_json::from_value(raw.clone()) {
            Ok(r) => r,
            Err(e) => { plan.warnings.push(format!("location {i}: invalid sets ({e}); kept")); continue; }
        };
        if refs.is_empty() { plan.strip_locations.insert(i); continue; }
        let root_name = rules_library.as_deref().map(crate::bare::layer::library_name);
        if refs.iter().any(|s| s.library.is_none()) && root_name.as_ref().is_some_and(|name| imports.join(name).exists()) {
            plan.warnings.push(format!("location {i}: rules library name also names an import library; sets kept"));
            continue;
        }
        for s in &mut refs {
            if s.library.is_none() { s.library = root_name.clone(); }
        }
        if refs.iter().any(|s| {
            let Some(lib) = s.library.as_deref() else { return true };
            if rune::check_id(&s.set).is_err() { return true }
            let Ok(l) = plan.lib(env, lib) else { return true };
            !l.set_md(&s.set).is_file() && override_file(env, lib, &s.set).is_none()
        }) {
            plan.warnings.push(format!("location {i}: a set has no readable library source; kept"));
            continue;
        }
        let cwd = loc.get("cwd").and_then(Value::as_str).unwrap_or_default();
        let id = format!("workspace-{}", hex6(cwd));
        let label = loc.get("label").and_then(Value::as_str).unwrap_or("Workspace");
        let mut sets = Vec::new();
        for s in &refs {
            for (source, bytes) in snapshot(&mut plan, env, s.library.as_deref().unwrap(), &s.set, None)? {
                if sets.iter().any(|(c, _): &(RunesetCopy, Vec<u8>)| c.source == source) { continue; }
                let file = format!("sets/{}--{}.md", source.library, source.set);
                sets.push((RunesetCopy { file, source, copied_utc: now.clone(), source_hash: content_sha(&bytes) }, bytes));
            }
        }
        let pairs: Vec<(SetSource, String)> = sets.iter().map(|(c, b)| (c.source.clone(), content_sha(b))).collect();
        let hash = vault_hash(&pairs, &[]);
        let reuse = match plan.vaults.iter().find(|v| v.vault.id == id) {
            Some(v) if v.vault.hash == hash => { plan.strip_locations.insert(i); continue; }
            Some(_) => { plan.warnings.push(format!("location {i}: workspace vault {id} differs; sets kept")); continue; }
            None => match store.get(&id) {
            Ok(v) if v.hash == hash => true,
            Ok(_) => { plan.warnings.push(format!("location {i}: workspace vault {id} differs; sets kept")); continue; }
            Err(_) if vaults_dir.join(&id).exists() => { plan.warnings.push(format!("location {i}: workspace vault {id} unreadable; sets kept")); continue; }
            Err(_) => false,
            },
        };
        let vault = Vault { version: 1, id: id.clone(), name: format!("Workspace {label}"), created_utc: now.clone(), from: None,
            runesets: sets.iter().map(|(c, _)| c.clone()).collect(), runes: vec![], locked_utc: None, locked_by: None, hash, pins: BTreeMap::new() };
        plan.vaults.push(VaultWrite { vault, files: sets.into_iter().map(|(c, b)| (c.file, b)).collect(), reuse, rows: vec![format!("workspace {label}")] });
        plan.strip_locations.insert(i);
    }
    plan.delete_gen_index = crate::paths::legacy_rune_gen_index_in(env.root).is_file();
    Ok(plan)
}

// ---- run ----

/// One write the run can take back.
enum Undo {
    Created(PathBuf),
    CreatedDir(PathBuf),
    Restore(PathBuf, Vec<u8>),
    Renamed(PathBuf, PathBuf),
}

fn undo(journal: Vec<Undo>) -> Vec<String> {
    let mut errors = Vec::new();
    for u in journal.into_iter().rev() {
        let r = match &u {
            Undo::Created(p) => std::fs::remove_file(p).map_err(|e| format!("{}: {e}", p.display())),
            Undo::CreatedDir(p) => std::fs::remove_dir_all(p).map_err(|e| format!("{}: {e}", p.display())),
            Undo::Restore(p, b) => crate::fsx::atomic_write(p, b),
            Undo::Renamed(from, to) => std::fs::rename(to, from).map_err(|e| format!("{} -> {}: {e}", to.display(), from.display())),
        };
        if let Err(e) = r {
            errors.push(e);
        }
    }
    errors
}

fn fail(env: &Env, step: &str) -> Result<(), String> {
    if env.fail_at == Some(step) {
        return Err(format!("injected failure at {step}"));
    }
    Ok(())
}

/// Creates `dir` and any missing parents, journalling the topmost folder it made.
fn make_dir(dir: &Path, journal: &mut Vec<Undo>) -> Result<(), String> {
    let mut top = None;
    let mut cur = Some(dir);
    while let Some(c) = cur {
        if c.exists() {
            break;
        }
        top = Some(c.to_path_buf());
        cur = c.parent();
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if let Some(t) = top {
        journal.push(Undo::CreatedDir(t));
    }
    Ok(())
}

fn create(path: &Path, bytes: &[u8], journal: &mut Vec<Undo>) -> Result<(), String> {
    if path.exists() {
        return Err(format!("{} appeared since the plan", path.display()));
    }
    make_dir(path.parent().ok_or("no parent")?, journal)?;
    crate::fsx::atomic_write(path, bytes)?;
    journal.push(Undo::Created(path.to_path_buf()));
    Ok(())
}

fn rewrite(path: &Path, bytes: &[u8], journal: &mut Vec<Undo>) -> Result<(), String> {
    let before = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    journal.push(Undo::Restore(path.to_path_buf(), before));
    crate::fsx::atomic_write(path, bytes)
}

/// Every write before vidar.json, journalled.
fn apply(env: &Env, plan: &Plan, journal: &mut Vec<Undo>) -> Result<(), String> {
    let imports = crate::paths::rune_imports_dir_in(env.root);
    fail(env, "renames")?;
    for r in &plan.renames {
        let (from, to) = (imports.join(&r.from), imports.join(&r.to));
        if to.exists() {
            return Err(format!("{} appeared since the plan", to.display()));
        }
        std::fs::rename(&from, &to).map_err(|e| format!("rename {} -> {}: {e}", from.display(), to.display()))?;
        journal.push(Undo::Renamed(from, to.clone()));
        let meta = to.join("generate.json");
        if let Ok(Value::Object(mut o)) = crate::fsx::read_json::<Value>(&meta) {
            o.insert("library".into(), Value::from(r.to.clone()));
            // Generate output is no longer bound to a launcher row (model "Not the model").
            o.shift_remove("rowKey");
            let json = serde_json::to_string_pretty(&Value::Object(o)).map_err(|e| e.to_string())? + "\n";
            rewrite(&meta, json.as_bytes(), journal)?;
        }
    }
    fail(env, "interrupt-after-rename")?;
    fail(env, "items")?;
    for w in &plan.runes {
        create(&imports.join(&w.lib).join(&w.rel), &w.bytes, journal)?;
    }
    for (l, s, (_, after)) in plan.set_edits() {
        let sets = imports.join(&l.new).join("sets");
        let new = l.set_new(s);
        if new == *s {
            rewrite(&sets.join(format!("{s}.md")), after.as_bytes(), journal)?;
        } else {
            let text = rename_header(after, &new);
            create(&sets.join(format!("{new}.md")), text.as_bytes(), journal)?;
            let old = sets.join(format!("{s}.md"));
            let before = std::fs::read(&old).map_err(|e| format!("{}: {e}", old.display()))?;
            std::fs::remove_file(&old).map_err(|e| format!("{}: {e}", old.display()))?;
            journal.push(Undo::Restore(old, before));
        }
    }
    fail(env, "vaults")?;
    let vaults_dir = crate::paths::rune_vaults_dir_in(env.root);
    for f in &plan.fixes {
        split::apply_fix(&vaults_dir.join(&f.vault.id), f, journal)?;
    }
    for v in plan.vaults.iter().filter(|v| !v.reuse) {
        let dir = vaults_dir.join(&v.vault.id);
        if dir.exists() {
            return Err(format!("vault folder {} appeared since the plan", dir.display()));
        }
        make_dir(&dir, journal)?;
        for (rel, bytes) in &v.files {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
            crate::fsx::atomic_write(&p, bytes)?;
        }
        let json = serde_json::to_string_pretty(&v.vault).map_err(|e| e.to_string())? + "\n";
        crate::fsx::atomic_write(&dir.join("vault.json"), json.as_bytes())?;
    }
    fail(env, "homes")?;
    if let (Some(home_dir), false) = (env.home_dir, plan.rekeys.is_empty() && plan.drops.is_empty()) {
        let lock_file = home_dir.join(".vidar-lock");
        if !lock_file.exists() {
            journal.push(Undo::Created(lock_file));
        }
        let lock = home::lock(home_dir, home::LOCK_WAIT)?;
        for a in [Agent::Claude, Agent::Codex] {
            let mine: Vec<&(Agent, String, Entry)> = plan.rekeys.iter().filter(|(x, _, _)| *x == a).collect();
            let drops: Vec<&String> = plan.drops.iter().filter(|(x, _, _)| *x == a).map(|(_, k, _)| k).collect();
            if mine.is_empty() && drops.is_empty() {
                continue;
            }
            let f = agent_homes::index_file(a, home_dir);
            match std::fs::read(&f) {
                Ok(b) => journal.push(Undo::Restore(f.clone(), b)),
                Err(_) => journal.push(Undo::Created(f.clone())),
            }
            for (_, key, e) in mine {
                agent_homes::adopt(a, &lock, home_dir, key, e)?;
            }
            if !drops.is_empty() {
                // Re-read under the lock: only the planned keys go, whatever a spawn added since.
                let mut index: Index = crate::fsx::read_json(&f)?;
                for k in drops {
                    index.remove(k);
                }
                let json = serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?;
                crate::fsx::atomic_write(&f, &json)?;
            }
        }
    }
    fail(env, "config")?;
    Ok(())
}

/// The vidar.json patch: rows lose `sets` and `permissionMode`; converted workspace choices
/// lose `sets` after their vault exists, and retired keys go.
fn patch_config(plan: &Plan, obj: &mut Map<String, Value>) -> Result<(), String> {
    let strip = |o: &mut Map<String, Value>| {
        let key = o.get("key").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
        if plan.strip_sets.contains(&key) {
            o.remove("sets");
        }
        if plan.strip_mode.contains(&key) {
            o.remove("permissionMode");
        }
    };
    for e in obj.get_mut("agents").and_then(Value::as_array_mut).into_iter().flatten() {
        if let Some(o) = e.as_object_mut() {
            strip(o);
        }
    }
    if !plan.strip_locations.is_empty() {
        for (i, l) in obj.get_mut("locations").and_then(Value::as_array_mut).into_iter().flatten().enumerate() {
            if !plan.strip_locations.contains(&i) { continue; }
            if let Some(o) = l.as_object_mut() {
                o.remove("sets");
            }
        }
    }
    for k in &plan.remove_keys {
        obj.remove(*k);
    }
    Ok(())
}

/// What a run did: the plan's lines and the backup folder (`None` when it wrote nothing).
#[derive(Debug)]
pub(crate) struct Outcome {
    pub lines: Vec<String>,
    pub backup: Option<PathBuf>,
}

fn failed(env: &Env, dir: Option<&Path>, plan: Option<&Plan>, listed: &[String], why: &str) -> String {
    let dir = dir.map(Path::to_path_buf).unwrap_or_else(|| backup_dir(env));
    let _ = std::fs::create_dir_all(&dir);
    let empty = Plan::default();
    let _ = write_plan_txt(&dir, plan.unwrap_or(&empty), listed, &format!("failed, nothing changed: {why}"));
    let txt = dir.join("plan.txt");
    set_notice(Some(format!("Rune Vault migration failed and changed nothing; see {}", txt.display())));
    format!("{why} (plan: {})", txt.display())
}

/// Recovers first, then plans. A nonempty plan backs up before writing libraries, vaults,
/// home indexes and vidar.json; cleanup runs only after that write.
pub(crate) fn run(env: &Env) -> Result<Outcome, String> {
    set_notice(None);
    if let Err(e) = recover(env) {
        set_notice(Some(format!("Rune Vault migration recovery failed; see {}: {e}", recovery_file(env.root).display())));
        return Err(format!("recovery failed: {e}"));
    }
    let plan = match plan(env) {
        Ok(p) => p,
        Err(e) => return Err(failed(env, None, None, &[], &e)),
    };
    if plan.is_empty() {
        return Ok(Outcome { lines: plan.lines(), backup: None });
    }
    let (dir, listed) = match backup(env, &plan) {
        Ok(b) => b,
        Err(e) => return Err(failed(env, None, Some(&plan), &[], &e)),
    };
    let mut recovery = Recovery {
        stamp: env.stamp.to_string(), committed: false,
        config_existed: env.config.is_file(),
        renames: plan.renames.iter().map(|r| (r.from.clone(), r.to.clone())).collect(),
        vaults: plan.vaults.iter().filter(|v| !v.reuse).map(|v| v.vault.id.clone()).collect(),
        runes: plan.runes.iter().map(|w| (w.lib.clone(), w.rel.clone())).collect(),
        fixes: plan.fixes.iter().map(|f| f.vault.id.clone()).collect(),
        homes: env.home_dir.map(|home_dir| [Agent::Claude, Agent::Codex].into_iter()
            .filter(|a| plan.rekeys.iter().any(|(x, _, _)| x == a) || plan.drops.iter().any(|(x, _, _)| x == a))
            .filter_map(|a| agent_homes::index_file(a, home_dir).file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect()).unwrap_or_default(),
    };
    if let Err(e) = save_recovery(env.root, &recovery) {
        return Err(failed(env, Some(&dir), Some(&plan), &listed, &e));
    }
    let mut journal = Vec::new();
    let written = apply(env, &plan, &mut journal).and_then(|_| crate::settings::store::with_config_root_at(env.config, |obj| patch_config(&plan, obj)));
    if env.fail_at == Some("interrupt-after-rename") {
        let _ = write_plan_txt(&dir, &plan, &listed, "interrupted; recovery required");
        set_notice(Some(format!("Rune Vault migration interrupted; recovery pending; see {}", dir.join("plan.txt").display())));
        return Err("interrupted after rename; recovery required".into());
    }
    if let Err(e) = written {
        let errors = undo(journal);
        if errors.is_empty() {
            let _ = std::fs::remove_file(recovery_file(env.root));
            return Err(failed(env, Some(&dir), Some(&plan), &listed, &e));
        }
        let why = format!("{e}; undo left: {}; recovery required", errors.join("; "));
        let _ = write_plan_txt(&dir, &plan, &listed, &format!("interrupted; {why}"));
        set_notice(Some(format!("Rune Vault migration recovery pending; see {}", dir.join("plan.txt").display())));
        return Err(why);
    }
    let mut plan = plan;
    let imports = crate::paths::rune_imports_dir_in(env.root);
    for (lib_old, set) in plan.sidecars.clone() {
        let lib_new = plan.libs.get(&lib_old).map(|l| l.new.clone()).unwrap_or(lib_old);
        let p = set_layer::sidecar_path(&imports.join(lib_new), &set);
        if let Err(e) = std::fs::remove_file(&p) {
            plan.warnings.push(format!("delete {}: {e}", p.display()));
        }
    }
    if plan.delete_gen_index {
        let p = crate::paths::legacy_rune_gen_index_in(env.root);
        if let Err(e) = std::fs::remove_file(&p) {
            plan.warnings.push(format!("delete {}: {e}", p.display()));
        }
    }
    let _ = write_plan_txt(&dir, &plan, &listed, "done");
    recovery.committed = true;
    save_recovery(env.root, &recovery)?;
    std::fs::remove_file(recovery_file(env.root)).map_err(|e| e.to_string())?;
    Ok(Outcome { lines: plan.lines(), backup: Some(dir) })
}

/// The production run: this install's root, vidar.json and Bare home. Lines land in the release log;
/// an error leaves vidar.json as it was, keeps `notice` and Vidar starts.
pub fn run_at_startup() {
    let root = crate::paths::root();
    let config = crate::paths::config_path();
    let home_dir = home::resolve().map_err(|e| eprintln!("vault migrate: {e}; home index not re-keyed")).ok();
    let (_, stamp) = crate::bare::manifest::stamps();
    let env = Env { root: &root, config: &config, home_dir: home_dir.as_deref(), stamp: &stamp, fail_at: None };
    match run(&env) {
        Ok(o) => {
            for l in o.lines {
                eprintln!("vault migrate: {l}");
            }
            if let Some(b) = o.backup {
                eprintln!("vault migrate: backup {}", b.display());
            }
        }
        Err(e) => eprintln!("vault migrate: {e}"),
    }
}

#[cfg(test)]
#[path = "migrate_tests.rs"]
mod tests;
