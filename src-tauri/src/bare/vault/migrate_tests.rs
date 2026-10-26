//! src-tauri\src\bare\vault\migrate_tests.rs — the startup Rune Vault migration against a temp root
//! (never the live folder). The fixture `tests\fixtures\rune-vault\migrate` copies the live shape on
//! 2026-10-25 with names changed: one import library with a sidecar, one per-row generation library,
//! four Bare rows, empty retired keys.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

use super::{run, vault_home_key, Env};
use crate::bare::agent_homes::{self, Agent, Entry, Index};
use crate::bare::layer::{RowSets, SetRef};
use crate::bare::vault::store::Store;
use crate::bare::vault::VaultFrom;
use crate::rules::library::Library;

/// Runs share the launcher-notice static; one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-migrate-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn repo() -> PathBuf {
    crate::paths::root()
}

fn fixture() -> PathBuf {
    repo().join("tests").join("fixtures").join("rune-vault").join("migrate")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().unwrap().is_dir() {
            copy_dir(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
    }
}

const GEN_OLD: &str = "gen-claude-rendered-bare-a1b2c3d4";

/// The toolkit sidecar's rune ids by `expected.json` entry `n`: each item's own name as Add Kit
/// (`bare/kit.rs`) names it; the Codex guard's last script clashes with a Claude guard's and takes `-2`.
const ITEM_IDS: [&str; 14] = [
    "alpha-review", "beta-notes", "gamma", "delta-review", "scout", "builder-o", "guard-one", "guard-two", "guard-three", "guard-two-2",
    "unreal-proxy", "jira-atlassian", "notion-notion", "slack-slack",
];

fn rendered_refs() -> Vec<SetRef> {
    vec![
        SetRef { library: Some("toolkit".into()), set: "toolkit".into() },
        SetRef { library: Some(GEN_OLD.into()), set: "row-claude-rendered-bare".into() },
    ]
}

fn old_key(refs: Vec<SetRef>) -> String {
    agent_homes::hash12(&RowSets { sets: refs, rules_library: Some(rules_library()) }).unwrap()
}

/// The fixture config's `rulesLibrary`.
fn rules_library() -> String {
    json(&fixture().join("vidar.fixture.json"))["rulesLibrary"].as_str().unwrap().to_string()
}

/// A temp root: the fixture's vidar.json and import libraries, the tracked templates, stock runes and
/// module bundles, and a Bare home whose Claude index holds the Rendered combination's folder.
struct Fx {
    t: TempDir,
}

impl Fx {
    fn new(tag: &str) -> Fx {
        let t = TempDir::new(tag);
        let root = &t.0;
        // Named vidar.fixture.json: the repo .gitignore drops every vidar.json.
        std::fs::copy(fixture().join("vidar.fixture.json"), crate::paths::config_path_in(root)).unwrap();
        copy_dir(&fixture().join("libraries"), &crate::paths::rune_imports_dir_in(root));
        copy_dir(&crate::paths::rune_templates_dir_in(&repo()), &crate::paths::rune_templates_dir_in(root));
        copy_dir(&crate::paths::rune_stock_dir_in(&repo()), &crate::paths::rune_stock_dir_in(root));
        std::fs::create_dir_all(root.join("contracts")).unwrap();
        std::fs::copy(repo().join("contracts/module-bundles.json"), root.join("contracts/module-bundles.json")).unwrap();
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        // Claude: the fold migration adopted the legacy home for the Rendered combination.
        let mut index = Index::new();
        index.insert(old_key(rendered_refs()), Entry { sets: vec!["toolkit/toolkit".into()], dir: "claude-legacy".into(), last_used: 7 });
        std::fs::write(agent_homes::index_file(Agent::Claude, &home), serde_json::to_string_pretty(&index).unwrap()).unwrap();
        // Codex: a combination folder for the toolkit combination.
        let key = old_key(vec![SetRef { library: Some("toolkit".into()), set: "toolkit".into() }]);
        let mut index = Index::new();
        index.insert(key.clone(), Entry { sets: vec!["toolkit/toolkit".into()], dir: format!("codex-homes/{key}"), last_used: 9 });
        std::fs::write(agent_homes::index_file(Agent::Codex, &home), serde_json::to_string_pretty(&index).unwrap()).unwrap();
        Fx { t }
    }
    fn root(&self) -> &Path {
        &self.t.0
    }
    fn config(&self) -> PathBuf {
        crate::paths::config_path_in(self.root())
    }
    fn home(&self) -> PathBuf {
        self.root().join("home")
    }
    fn imports(&self) -> PathBuf {
        crate::paths::rune_imports_dir_in(self.root())
    }
    fn run(&self, stamp: &str, fail_at: Option<&str>) -> Result<super::Outcome, String> {
        let (config, home) = (self.config(), self.home());
        run(&Env { root: self.root(), config: &config, home_dir: Some(&home), stamp, fail_at })
    }
    /// Every file under the root but the migrations folder, by relative path.
    fn tree(&self) -> BTreeMap<String, Vec<u8>> {
        let skip = crate::paths::migrations_dir_in(self.root());
        let mut out = BTreeMap::new();
        walk(self.root(), self.root(), &skip, &mut out);
        out
    }
}

fn walk(root: &Path, dir: &Path, skip: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p == skip {
            continue;
        }
        if e.file_type().unwrap().is_dir() {
            walk(root, &p, skip, out);
        } else {
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            out.insert(rel, std::fs::read(&p).unwrap());
        }
    }
}

/// A text file with LF line ends: a CRLF checkout (core.autocrlf) gives the fixtures CRLF, which the
/// migration keeps.
fn text(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap().replace("\r\n", "\n")
}

fn json(p: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

#[test]
fn live_shape_migrates_into_expected_vaults() {
    let _g = lock();
    let fx = Fx::new("shape");
    let out = fx.run("20261025-120000", None).unwrap();
    assert!(out.backup.is_some(), "{:?}", out.lines);
    assert!(super::notice().is_none());
    let expected = json(&fixture().join("expected.json"));

    // Vaults: one per combination, each from its stock template plus dated snapshots.
    let store = Store::open(fx.root());
    let vaults = expected["vaults"].as_object().unwrap();
    let mut ids: Vec<String> = std::fs::read_dir(crate::paths::rune_vaults_dir_in(fx.root())).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
    ids.sort();
    assert_eq!(ids, vaults.keys().cloned().collect::<Vec<_>>());
    for (id, want) in vaults {
        let v = store.get(id).unwrap();
        assert_eq!(v.name, want["name"].as_str().unwrap());
        assert!(matches!(&v.from, Some(VaultFrom::Template { template }) if template == want["template"].as_str().unwrap()), "{id}: {:?}", v.from);
        let sets: Vec<String> = v.runesets.iter().map(|c| format!("{}/{}", c.source.library, c.source.set)).collect();
        let want_sets: Vec<String> = want["runesets"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
        assert_eq!(sets, want_sets, "{id}");
        assert!(v.locked_utc.is_none());
        let dir = crate::paths::rune_vaults_dir_in(fx.root()).join(id);
        for c in &v.runesets {
            let bytes = std::fs::read(dir.join(&c.file)).unwrap();
            assert_eq!(super::content_sha(&bytes), c.source_hash, "{id} {}", c.file);
        }
        let agent = if id.starts_with("claude") { "claude" } else { "codex" };
        assert_eq!(foreign_runes(&fx, &v, agent), Vec::<String>::new(), "{id} holds another agent's runes");
        let r = store.resolve(id).unwrap();
        assert!(!r.runes.is_empty(), "{id}");
        assert!(r.warnings.is_empty(), "{id}: {:?}", r.warnings);
    }

    // Item runes: one per sidecar entry, tagged by agent when one side only, all parse.
    let lib_dir = fx.imports().join("toolkit");
    let lib = Library::open(&lib_dir).unwrap();
    let want = expected["items"].as_array().unwrap();
    assert_eq!(want.len(), ITEM_IDS.len());
    for w in want {
        let (n, folder, has) = (w["n"].as_u64().unwrap() as usize, w["folder"].as_str().unwrap(), w["has"].as_str().unwrap());
        let id = rune_id(&lib_dir, folder, has);
        assert_eq!(id, ITEM_IDS[n], "entry {n}");
        let text = text(&lib_dir.join(folder).join(format!("{id}.md")));
        let entry = lib.entry(&id).unwrap().unwrap_or_else(|| panic!("library misses {id}"));
        lib.load(&entry).unwrap();
        // Untagged runes stay in the base set; a tagged one sits only in its agent's set.
        let in_set = |set: &str| self::text(&lib_dir.join(format!("sets/{set}.md"))).contains(&format!("- <?rune {id}?>"));
        match w["agent"].as_str().unwrap() {
            "" => {
                assert!(!text.contains("\nagent:"), "{id}");
                assert!(in_set("toolkit") && !in_set("toolkit-claude") && !in_set("toolkit-codex"), "slot {id}");
            }
            a => {
                assert!(text.contains(&format!("\nagent: {a}\n")), "{id}");
                let other = if a == "claude" { "codex" } else { "claude" };
                assert!(in_set(&format!("toolkit-{a}")) && !in_set("toolkit") && !in_set(&format!("toolkit-{other}")), "slot {id}");
            }
        }
    }
    let written: usize = ["skills", "agents", "hooks", "mcp", "permissions"].iter().map(|f| std::fs::read_dir(lib_dir.join(f)).map(|d| d.count()).unwrap_or(0)).sum();
    assert_eq!(written, want.len());
    assert!(!lib_dir.join("sets/toolkit.layer.json").exists());

    // Generation library renamed first: library, set, set header (name and scope), generate.json
    // (library, no rowKey), the vault's snapshot too.
    let gen = fx.imports().join("gen-a1b2c3d4");
    assert!(!fx.imports().join(GEN_OLD).exists());
    let set = text(&gen.join("sets/generated-20261025.md"));
    assert!(set.contains("\nname: generated-20261025\n"));
    assert!(set.contains("\nscope: [gen-a1b2c3d4]\n") && !set.contains(GEN_OLD), "{set}");
    let snap = text(&crate::paths::rune_vaults_dir_in(fx.root()).join("claude-rendered/sets/gen-a1b2c3d4--generated-20261025.md"));
    assert!(snap.contains("\nscope: [gen-a1b2c3d4]\n"), "{snap}");
    assert!(!gen.join("sets/row-claude-rendered-bare.md").exists());
    let meta = json(&gen.join("generate.json"));
    assert_eq!(meta["library"], "gen-a1b2c3d4");
    assert!(meta.get("rowKey").is_none(), "{meta}");
    assert!(!crate::paths::legacy_rune_gen_index_in(fx.root()).exists());

    // vidar.json last: rows lose sets, retired keys go, the rest stays.
    let cfg = json(&fx.config());
    for k in ["bareCodexMcp", "bareGuards", "bareSkills", "bareAgents", "bareCodexSkills"] {
        assert!(cfg.get(k).is_none(), "{k}");
    }
    assert_eq!(cfg["theme"], "night");
    assert_eq!(cfg["rulesLibrary"], rules_library().as_str());
    for row in cfg["agents"].as_array().unwrap() {
        assert!(row.get("sets").is_none(), "{row}");
    }
    assert_eq!(cfg["agents"][3]["cwd"], "C:\\Work");
    assert_eq!(cfg["agents"][4]["profile"], "default");

    // Home re-key: the adopted legacy home carries over to the vault's key, and L2a's pick takes it.
    let home = fx.home();
    let index: Index = serde_json::from_str(&std::fs::read_to_string(agent_homes::index_file(Agent::Claude, &home)).unwrap()).unwrap();
    let old = old_key(rendered_refs());
    let e = index.get(&vault_home_key(Agent::Claude, &home, "claude-rendered").unwrap()).expect("re-keyed entry");
    assert_eq!(e.dir, "claude-legacy");
    assert_eq!(e.sets, vec!["vault:claude-rendered".to_string()]);
    // The old key on the legacy home goes (M1): readers list the legacy home anyway.
    assert!(!index.contains_key(&old), "old row-combination key dropped");
    let legacy = home.join("claude-legacy");
    assert_eq!(agent_homes::pick_vault(Agent::Claude, &home, &legacy, Some("claude-rendered")).dir, legacy);
    // A combination folder re-keys too (L2g): each Codex vault on the toolkit rows opens that folder.
    let index: Index = serde_json::from_str(&std::fs::read_to_string(agent_homes::index_file(Agent::Codex, &home)).unwrap()).unwrap();
    let old = old_key(vec![SetRef { library: Some("toolkit".into()), set: "toolkit".into() }]);
    let combo = format!("codex-homes/{old}");
    // A combination folder is listed only under its own key (`agent_homes::listed`), so that one stays.
    assert!(index.contains_key(&old), "old entry on its own folder stays");
    let codex_legacy = home.join("codex-legacy");
    for id in ["codex-raw", "codex-rendered"] {
        let e = index.get(&vault_home_key(Agent::Codex, &home, id).unwrap()).expect("re-keyed codex entry");
        assert_eq!((e.dir.as_str(), e.sets.clone()), (combo.as_str(), vec![format!("vault:{id}")]));
        let p = agent_homes::pick_vault(Agent::Codex, &home, &codex_legacy, Some(id));
        assert_eq!((p.dir, p.rel), (home.join("codex-homes").join(&old), combo.clone()), "{id}");
    }
    assert!(!out.lines.iter().any(|l| l.contains("keeps its threads")), "{:?}", out.lines);
}

/// Slotted runes of `v`'s runeset copies tagged for an agent other than `agent`.
fn foreign_runes(fx: &Fx, v: &crate::bare::vault::Vault, agent: &str) -> Vec<String> {
    let dir = crate::paths::rune_vaults_dir_in(fx.root()).join(&v.id);
    let mut out = Vec::new();
    for c in &v.runesets {
        let lib = Library::open(&fx.imports().join(&c.source.library)).unwrap();
        for id in super::split::slot_order(&text(&dir.join(&c.file))) {
            let rune = lib.load(&lib.entry(&id).unwrap().unwrap()).unwrap();
            if rune.agent.as_deref().is_some_and(|a| a != agent) {
                out.push(format!("{}/{id}", c.source.library));
            }
        }
    }
    out
}

/// A library's set files joined, base and per-agent splits alike.
fn all_sets(lib: &Path) -> String {
    let mut names: Vec<PathBuf> = std::fs::read_dir(lib.join("sets")).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "md")).collect();
    names.sort();
    names.iter().map(|p| text(p)).collect()
}

/// The id of the rune in `folder` whose text holds `has`.
fn rune_id(lib: &Path, folder: &str, has: &str) -> String {
    let hits: Vec<String> = std::fs::read_dir(lib.join(folder))
        .unwrap()
        .flatten()
        .filter(|e| text(&e.path()).contains(has))
        .map(|e| e.path().file_stem().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(hits.len(), 1, "{folder} {has}: {hits:?}");
    hits[0].clone()
}

#[test]
fn second_run_is_a_no_op() {
    let _g = lock();
    let fx = Fx::new("twice");
    fx.run("20261025-120000", None).unwrap();
    // The first run re-keyed the Codex combination folder too (L2g); the second leaves it.
    assert!(std::fs::read_to_string(agent_homes::index_file(Agent::Codex, &fx.home())).unwrap().contains("vault:codex-rendered"));
    let after_first = fx.tree();
    let out = fx.run("20261025-120100", None).unwrap();
    assert!(out.backup.is_none(), "{:?}", out.lines);
    assert_eq!(fx.tree(), after_first);
    assert!(!crate::paths::migrations_dir_in(fx.root()).join("vault-20261025-120100").exists());
}

fn read_index(a: Agent, home: &Path) -> Index {
    serde_json::from_str(&std::fs::read_to_string(agent_homes::index_file(a, home)).unwrap()).unwrap()
}

fn add_entries(a: Agent, home: &Path, entries: &[(&str, &str, &str)]) {
    let mut index = read_index(a, home);
    for (key, set, dir) in entries {
        index.insert(key.to_string(), Entry { sets: vec![set.to_string()], dir: dir.to_string(), last_used: 5 });
    }
    std::fs::write(agent_homes::index_file(a, home), serde_json::to_string_pretty(&index).unwrap()).unwrap();
}

/// M1: index entries that are not `vault:<id>` go, a probe's included; a combination entry readers
/// need for its folder stays; no folder or thread file is touched; the backup holds the index.
#[test]
fn stale_home_keys_go_and_their_folders_stay() {
    let _g = lock();
    let fx = Fx::new("stale");
    let home = fx.home();
    let probe_set = "c:/users/x/appdata/local/temp/vidar-runes-probe-1/lib/probe-runes";
    add_entries(Agent::Claude, &home, &[
        ("00005dc1d553", probe_set, "claude-homes/00005dc1d553"),
        ("005b1ea67bc7", "kit/kit", "claude-homes/005b1ea67bc7"),
        ("aaaaaaaaaaaa", "vault:other", "claude-homes/aaaaaaaaaaaa"),
    ]);
    add_entries(Agent::Codex, &home, &[("ec7f28b9eaa2", probe_set, "codex-homes/ec7f28b9eaa2")]);
    let threads = [home.join("claude-homes/00005dc1d553/projects/p/t.jsonl"), home.join("claude-homes/005b1ea67bc7/projects/p/t.jsonl"), home.join("claude-legacy/projects/p/t.jsonl")];
    for t in &threads {
        std::fs::create_dir_all(t.parent().unwrap()).unwrap();
        std::fs::write(t, "{}\n").unwrap();
    }
    let claude_before = std::fs::read(agent_homes::index_file(Agent::Claude, &home)).unwrap();

    let out = fx.run("20261025-120000", None).unwrap();
    let claude = read_index(Agent::Claude, &home);
    assert!(!claude.contains_key("00005dc1d553"), "probe entry dropped");
    assert!(!claude.contains_key(&old_key(rendered_refs())), "legacy-home row key dropped");
    assert!(claude.contains_key("005b1ea67bc7"), "own-folder entry stays");
    assert!(claude.contains_key("aaaaaaaaaaaa"), "a vault entry stays");
    assert!(claude.contains_key(&vault_home_key(Agent::Claude, &home, "claude-rendered").unwrap()));
    assert!(!read_index(Agent::Codex, &home).contains_key("ec7f28b9eaa2"), "codex probe entry dropped");
    for t in &threads {
        assert!(t.is_file(), "{} kept", t.display());
    }
    assert!(out.lines.iter().any(|l| l.starts_with("drop home index Claude 00005dc1d553")), "{:?}", out.lines);
    assert!(out.lines.iter().any(|l| l.contains("005b1ea67bc7") && l.contains("stays")), "{:?}", out.lines);
    assert_eq!(std::fs::read(out.backup.unwrap().join("homes/claude-homes.json")).unwrap(), claude_before);

    let again = fx.run("20261025-120100", None).unwrap();
    assert!(again.backup.is_none(), "{:?}", again.lines);
}

#[test]
fn backup_lists_every_source_file_before_any_write() {
    let _g = lock();
    let fx = Fx::new("backup");
    std::fs::create_dir_all(fx.imports().join(GEN_OLD).join("nested")).unwrap();
    std::fs::write(fx.imports().join(GEN_OLD).join("nested/extra.txt"), b"keep every byte").unwrap();
    let before = fx.tree();
    let out = fx.run("20261025-120000", None).unwrap();
    let dir = out.backup.unwrap();
    let plan = std::fs::read_to_string(dir.join("plan.txt")).unwrap();
    let cfg_name = fx.config().file_name().unwrap().to_string_lossy().into_owned();
    let mut sources: Vec<(String, String)> = vec![(cfg_name.clone(), cfg_name), ("homes/claude-homes.json".into(), "home/claude-homes.json".into())];
    for rel in ["gen-index.json", "toolkit/sets/toolkit.layer.json", "toolkit/sets/toolkit.md"]
        .into_iter()
        .map(str::to_string)
        .chain([format!("{GEN_OLD}/sets/row-claude-rendered-bare.md"), format!("{GEN_OLD}/generate.json")])
    {
        let backup_rel = if rel == "gen-index.json" { rel.clone() } else { format!("libraries/{rel}") };
        sources.push((backup_rel, format!("runtime/runes/{rel}")));
    }
    for (rel, src) in sources {
        assert_eq!(std::fs::read(dir.join(&rel)).unwrap_or_default(), before[&src], "{rel}");
        assert!(plan.lines().any(|l| l == format!("backup {rel}")), "plan lists {rel}");
    }
    let imports_rel = fx.imports().strip_prefix(fx.root()).unwrap().to_string_lossy().replace('\\', "/");
    let old = format!("{imports_rel}/{GEN_OLD}/");
    for (path, bytes) in before.iter().filter(|(p, _)| p.starts_with(&old)) {
        let rel = format!("libraries/{}", path.strip_prefix(&format!("{imports_rel}/")).unwrap());
        assert_eq!(std::fs::read(dir.join(&rel)).unwrap(), *bytes, "missing generated library file {rel}");
        assert!(plan.lines().any(|l| l == format!("backup {rel}")), "plan omits {rel}");
    }
    assert!(plan.starts_with("state: done\n"));
}

#[test]
fn failure_mid_run_leaves_everything_as_it_was() {
    let _g = lock();
    for step in ["renames", "items", "vaults", "homes", "config"] {
        let fx = Fx::new(step);
        let config = std::fs::read(fx.config()).unwrap();
        let before = fx.tree();
        let err = fx.run("20261025-120000", Some(step)).unwrap_err();
        assert_eq!(std::fs::read(fx.config()).unwrap(), config, "{step}: vidar.json byte-equal");
        let after = fx.tree();
        let changed: Vec<&String> = after.keys().chain(before.keys()).filter(|k| after.get(*k) != before.get(*k)).collect();
        assert!(changed.is_empty(), "{step}: every write undone, changed {changed:?}");
        let plan = crate::paths::migrations_dir_in(fx.root()).join("vault-20261025-120000").join("plan.txt");
        assert!(err.contains(&plan.display().to_string()), "{step}: {err}");
        assert!(std::fs::read_to_string(&plan).unwrap().starts_with("state: failed, nothing changed"), "{step}");
        let notice = super::notice().unwrap();
        assert!(notice.contains("plan.txt") && notice.contains("changed nothing"), "{step}: {notice}");
        // The next clean run migrates and clears the notice.
        fx.run("20261025-120100", None).unwrap();
        assert!(super::notice().is_none());
    }
}

#[test]
fn interruption_after_rename_recovers_before_replanning() {
    let _g = lock();
    let fx = Fx::new("interrupted-rename");
    let err = fx.run("20261025-120000", Some("interrupt-after-rename")).unwrap_err();
    assert!(err.contains("recovery required"), "{err}");
    assert!(!fx.imports().join(GEN_OLD).exists());
    assert!(fx.imports().join("gen-a1b2c3d4").exists());
    assert!(super::recovery_file(fx.root()).exists());
    let out = fx.run("20261025-120100", None).unwrap();
    assert!(out.backup.is_some());
    assert!(!super::recovery_file(fx.root()).exists());
    let vault = Store::open(fx.root()).get("claude-rendered").unwrap();
    assert!(vault.runesets.iter().any(|s| s.source.library == "gen-a1b2c3d4" && s.source.set == "generated-20261025"));
    assert!(fx.imports().join("gen-a1b2c3d4/sets/generated-20261025.md").exists());
    assert!(json(&fx.config())["agents"].as_array().unwrap().iter().all(|row| row.get("sets").is_none()));
}

#[test]
fn recovery_refuses_two_generation_library_names() {
    let _g = lock();
    let fx = Fx::new("recovery-conflict");
    fx.run("20261025-120000", Some("interrupt-after-rename")).unwrap_err();
    std::fs::create_dir_all(fx.imports().join(GEN_OLD)).unwrap();
    std::fs::write(fx.imports().join(GEN_OLD).join("new.txt"), b"new user content").unwrap();
    let err = fx.run("20261025-120100", None).unwrap_err();
    assert!(err.contains("both") && err.contains("manual review"), "{err}");
    assert_eq!(std::fs::read(fx.imports().join(GEN_OLD).join("new.txt")).unwrap(), b"new user content");
    assert!(fx.imports().join("gen-a1b2c3d4").exists());
    assert!(super::recovery_file(fx.root()).exists());
}

#[test]
fn workspace_sets_become_an_explicit_vault() {
    let _g = lock();
    let fx = Fx::new("workspace-sets");
    let mut cfg = json(&fx.config());
    let root_name = cfg["rulesLibrary"].as_str().unwrap().to_string();
    let sets = fx.root().join(&root_name).join("sets");
    std::fs::create_dir_all(&sets).unwrap();
    std::fs::write(sets.join("app-core.md"), b"---\nname: app-core\nkind: set\nscope: [global]\n---\n# App Core\n").unwrap();
    cfg["locations"][0]["cwd"] = "C:\\Work".into();
    cfg["locations"][0]["sets"] = serde_json::json!([{ "set": "app-core" }]);
    cfg["locations"].as_array_mut().unwrap().push(serde_json::json!({"label":"Kit","cwd":"C:\\Kit","sets":[{"library":"toolkit","set":"toolkit"}]}));
    std::fs::write(fx.config(), serde_json::to_vec_pretty(&cfg).unwrap()).unwrap();
    fx.run("20261025-120000", None).unwrap();
    assert!(json(&fx.config())["locations"][0].get("sets").is_none());
    let id = format!("workspace-{}", super::hex6("C:\\Work"));
    let vault = Store::open(fx.root()).get(&id).unwrap();
    assert_eq!(vault.name, "Workspace Work");
    assert!(vault.runesets.iter().any(|s| s.source.library == root_name && s.source.set == "app-core"));
    assert!(json(&fx.config())["locations"][1].get("sets").is_none());
    let kit_id = format!("workspace-{}", super::hex6("C:\\Kit"));
    let kit = Store::open(fx.root()).get(&kit_id).unwrap();
    assert!(kit.runesets.iter().any(|s| s.source.library == "toolkit" && s.source.set == "toolkit"));
}

#[test]
fn unreadable_workspace_sets_remain_in_config() {
    let _g = lock();
    let fx = Fx::new("workspace-missing-source");
    let mut cfg = json(&fx.config());
    let refs = serde_json::json!([{ "set": "missing" }]);
    cfg["locations"][0]["sets"] = refs.clone();
    std::fs::write(fx.config(), serde_json::to_vec_pretty(&cfg).unwrap()).unwrap();
    let out = fx.run("20261025-120000", None).unwrap();
    assert_eq!(json(&fx.config())["locations"][0]["sets"], refs);
    assert!(out.lines.iter().any(|l| l.contains("location 0") && l.contains("kept")));
}

#[test]
fn recall_off_override_survives_migration_with_warning() {
    let _g = lock();
    let fx = Fx::new("recall-off");
    let ov = crate::paths::legacy_rune_overrides_dir_in(fx.root()).join("toolkit/toolkit.json");
    std::fs::create_dir_all(ov.parent().unwrap()).unwrap();
    std::fs::write(&ov, r#"{"off":["recall-item"]}"#).unwrap();
    let out = fx.run("20261025-120000", None).unwrap();
    assert_eq!(json(&ov)["off"][0], "recall-item");
    assert!(out.lines.iter().any(|l| l.contains("recall member `recall-item` is off")), "{:?}", out.lines);
}

#[test]
fn overrides_and_retired_keys_land_in_snapshots_and_runes() {
    let _g = lock();
    let fx = Fx::new("overrides");
    let ov = crate::paths::legacy_rune_overrides_dir_in(fx.root());
    std::fs::create_dir_all(ov.join(GEN_OLD)).unwrap();
    std::fs::create_dir_all(ov.join("toolkit")).unwrap();
    // A shadowed member of the generated set leaves the snapshot only.
    std::fs::write(ov.join(GEN_OLD).join("row-claude-rendered-bare.json"), r#"{"source":{"set":"row-claude-rendered-bare"},"shadow":["verdict-first"]}"#).unwrap();
    // A derived set: the base plus `add` minus `off`.
    // Its `off` id is the Bash guard's rune id, known before the run: its last script's name.
    let bash_guard = "guard-two".to_string();
    let lite_override = serde_json::json!({ "source": { "set": "toolkit" }, "add": ["short-replies"], "off": [bash_guard] });
    std::fs::write(ov.join("toolkit").join("toolkit-lite.json"), lite_override.to_string()).unwrap();
    let mut cfg = json(&fx.config());
    cfg["agents"][0]["sets"] = serde_json::json!([{ "library": "toolkit", "set": "toolkit-lite" }]);
    cfg["agents"][0]["permissionMode"] = "plan".into();
    cfg["bareSkills"] = serde_json::json!(["~\\.claude\\skills\\epsilon"]);
    std::fs::write(fx.config(), serde_json::to_string_pretty(&cfg).unwrap()).unwrap();

    let out = fx.run("20261025-120000", None).unwrap();
    let vaults = crate::paths::rune_vaults_dir_in(fx.root());
    let rendered = text(&vaults.join("claude-rendered/sets/gen-a1b2c3d4--generated-20261025.md"));
    assert!(rendered.contains("<?rune short-replies?>") && !rendered.contains("<?rune verdict-first?>"), "{rendered}");
    let lib_set = text(&fx.imports().join("gen-a1b2c3d4/sets/generated-20261025.md"));
    assert!(lib_set.contains("<?rune verdict-first?>"), "the library set keeps it");
    let lite = text(&vaults.join("claude-raw/sets/toolkit--toolkit-lite.md"));
    assert!(lite.contains("\nname: toolkit-lite\n"), "{lite}");
    let lib = fx.imports().join("toolkit");
    assert_eq!(rune_id(&lib, "hooks", "matcher: \"Bash\""), bash_guard);
    let agent_guard = rune_id(&lib, "hooks", "matcher: \"Agent|Task\"");
    assert!(lite.contains("<?rune short-replies?>") && lite.contains(&format!("<?rune {agent_guard}?>")), "{lite}");
    assert!(!lite.contains(&format!("<?rune {bash_guard}?>")), "{lite}");
    let epsilon = rune_id(&lib, "skills", "epsilon");
    assert_eq!(epsilon, "epsilon");
    assert!(lite.contains(&format!("<?rune {epsilon}?>")), "retired bareSkills reach the base set: {lite}");
    assert_eq!(json(&ov.join("toolkit/toolkit-lite.json")), lite_override, "off overrides remain until vaults represent per-member recall");
    let cfg = json(&fx.config());
    assert!(cfg.get("bareSkills").is_none());
    assert!(cfg["agents"][0].get("permissionMode").is_none());
    assert!(out.lines.iter().any(|l| l.contains("permissionMode")), "{:?}", out.lines);
}

#[test]
fn a_row_on_a_rules_library_set_keeps_its_sets() {
    let _g = lock();
    let fx = Fx::new("rules-lib");
    let mut cfg = json(&fx.config());
    cfg["agents"][1]["sets"] = serde_json::json!([{ "set": "kit" }]);
    std::fs::write(fx.config(), serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
    let out = fx.run("20261025-120000", None).unwrap();
    let cfg = json(&fx.config());
    assert_eq!(cfg["agents"][1]["sets"], serde_json::json!([{ "set": "kit" }]));
    assert!(cfg["agents"][0].get("sets").is_none());
    assert!(out.lines.iter().any(|l| l.starts_with("warning: row codex-bare")), "{:?}", out.lines);
    assert!(!crate::paths::rune_vaults_dir_in(fx.root()).join("codex-raw").exists());
}

/// Every retired home-wide key (the fold migration's `DEPRECATED`, deleted in D1) converts: each entry
/// becomes an item rune in the picked set's library and every key leaves vidar.json.
#[test]
fn every_retired_key_becomes_runes_and_leaves_vidar_json() {
    let _g = lock();
    let fx = Fx::new("retired");
    let mut cfg = json(&fx.config());
    cfg["bareSkills"] = serde_json::json!(["~\\.claude\\skills\\zeta-skill"]);
    cfg["bareAgents"] = serde_json::json!(["~\\.claude\\agents\\ranger.md"]);
    cfg["bareGuards"] = serde_json::json!([{ "event": "Stop", "run": ["~\\.claude\\hooks\\stop-claude.mjs"] }]);
    cfg["bareCodexSkills"] = serde_json::json!(["~\\.codex\\skills\\omega-skill"]);
    cfg["bareCodexAgents"] = serde_json::json!(["~\\.codex\\agents\\warden.toml"]);
    cfg["bareCodexGuards"] = serde_json::json!([{ "event": "Stop", "run": ["~\\.codex\\hooks\\stop-codex.mjs"] }]);
    cfg["bareCodexMcp"] = serde_json::json!(["p4"]);
    std::fs::write(fx.config(), serde_json::to_string_pretty(&cfg).unwrap()).unwrap();

    let out = fx.run("20261025-120000", None).unwrap();
    let cfg = json(&fx.config());
    for k in ["bareSkills", "bareAgents", "bareGuards", "bareCodexSkills", "bareCodexAgents", "bareCodexGuards", "bareCodexMcp"] {
        assert!(cfg.get(k).is_none(), "{k} stayed: {:?}", out.lines);
    }
    let lib = fx.imports().join("toolkit");
    let set = all_sets(&lib);
    for (folder, has) in [
        ("skills", "zeta-skill"),
        ("skills", "omega-skill"),
        ("agents", "ranger.md"),
        ("agents", "warden.toml"),
        ("hooks", "stop-claude.mjs"),
        ("hooks", "stop-codex.mjs"),
        ("mcp", "p4"),
    ] {
        let id = rune_id(&lib, folder, has);
        assert!(set.contains(&format!("<?rune {id}?>")), "{has} slotted: {set}");
    }
}

/// Conversion scans every library set, including one no launcher row selected. Module bundles with
/// non-MCP items and the old Claude output style become ordinary member runes before sidecar removal.
#[test]
fn unpicked_library_sidecar_converts_every_item_kind() {
    let _g = lock();
    let fx = Fx::new("all-sidecars");
    let lib = fx.imports().join("extra");
    std::fs::create_dir_all(lib.join("sets")).unwrap();
    std::fs::write(lib.join("sets/extra.md"), "---\nname: extra\nkind: set\nscope: [global]\n---\nExtra.\n").unwrap();
    std::fs::write(lib.join("sets/extra.layer.json"), r#"{"modules":{"sample":{}},"outputStyle":"compact"}"#).unwrap();
    let catalog = serde_json::json!({"version": 1, "bundles": {"sample": {
        "mcp": [], "skills": ["mods/review"], "agents": ["agents/reader.md"],
        "guards": [{"event": "Stop", "run": ["hooks/check.mjs"]}]
    }}});
    std::fs::write(fx.root().join("contracts/module-bundles.json"), catalog.to_string()).unwrap();
    fx.run("20261025-120000", None).unwrap();
    assert!(!lib.join("sets/extra.layer.json").exists());
    let set = all_sets(&lib);
    for (folder, id) in [("skills", "review"), ("agents", "reader"), ("hooks", "check"), ("styles", "compact")] {
        assert!(set.contains(&format!("<?rune {id}?>")), "{id} missing from {set}");
        let body = text(&lib.join(folder).join(format!("{id}.md")));
        crate::rules::rune::parse(&body).unwrap();
    }
}

/// A sidecar with no set file beside it is left where it is, with a warning (D1 item 6).
#[test]
fn a_sidecar_without_its_set_file_stays() {
    let _g = lock();
    let fx = Fx::new("orphan");
    let orphan = fx.imports().join("toolkit/sets/orphan.layer.json");
    std::fs::write(&orphan, r#"{"skills":["~\\.claude\\skills\\lonely"]}"#).unwrap();
    let out = fx.run("20261025-120000", None).unwrap();
    assert!(orphan.is_file(), "the sidecar stays");
    assert_eq!(text(&orphan), r#"{"skills":["~\\.claude\\skills\\lonely"]}"#);
    assert!(out.lines.iter().any(|l| l.contains("sidecar toolkit/orphan has no set file")), "{:?}", out.lines);
}

/// The first release left one mixed runeset in every stock vault. The next run splits the library set and
/// each vault's own copy per agent, backs the vaults up first, and a further run changes nothing.
#[test]
fn a_mixed_stock_runeset_is_split_per_agent_and_stays_split() {
    use crate::bare::vault::{content_sha, vault_hash, RunesetCopy, SetSource};
    let _g = lock();
    let fx = Fx::new("mixed");
    fx.run("20261025-120000", None).unwrap();
    let lib = fx.imports().join("toolkit");
    let mut mixed = text(&lib.join("sets/toolkit.md"));
    for s in ["toolkit-claude", "toolkit-codex"] {
        let p = lib.join(format!("sets/{s}.md"));
        for id in super::split::slot_order(&text(&p)) {
            mixed.push_str(&format!("- <?rune {id}?>\n"));
        }
        std::fs::remove_file(&p).unwrap();
    }
    std::fs::write(lib.join("sets/toolkit.md"), &mixed).unwrap();
    let store = Store::open(fx.root());
    let vaults = crate::paths::rune_vaults_dir_in(fx.root());
    for id in ["claude-raw", "claude-rendered", "codex-raw", "codex-rendered"] {
        let mut v = store.get(id).unwrap();
        let dir = vaults.join(id);
        let mut sets = vec![RunesetCopy {
            file: "sets/toolkit--toolkit.md".into(),
            source: SetSource { library: "toolkit".into(), set: "toolkit".into() },
            copied_utc: "2026-10-26T00:00:00Z".into(),
            source_hash: content_sha(mixed.as_bytes()),
        }];
        for c in v.runesets.drain(..) {
            if c.source.library == "toolkit" {
                std::fs::remove_file(dir.join(&c.file)).unwrap();
            } else {
                sets.push(c);
            }
        }
        std::fs::write(dir.join("sets/toolkit--toolkit.md"), &mixed).unwrap();
        let pairs: Vec<_> = sets.iter().map(|c| (c.source.clone(), c.source_hash.clone())).collect();
        v.hash = vault_hash(&pairs, &v.runes);
        v.runesets = sets;
        std::fs::write(dir.join("vault.json"), serde_json::to_string_pretty(&v).unwrap()).unwrap();
        assert!(!foreign_runes(&fx, &v, if id.starts_with("claude") { "claude" } else { "codex" }).is_empty(), "{id} starts mixed");
    }

    let out = fx.run("20261025-120200", None).unwrap();
    let backup = out.backup.expect("a repair backs up");
    assert!(out.lines.iter().any(|l| l.contains("split mixed runesets of vault claude-raw")), "{:?}", out.lines);
    for id in ["claude-raw", "claude-rendered", "codex-raw", "codex-rendered"] {
        assert!(backup.join("vaults").join(id).join("vault.json").is_file(), "{id} backed up");
    }
    assert!(backup.join("libraries/toolkit/sets/toolkit.md").is_file());
    let expected = json(&fixture().join("expected.json"));
    for (id, want) in expected["vaults"].as_object().unwrap() {
        let v = store.get(id).unwrap();
        let sets: Vec<String> = v.runesets.iter().map(|c| format!("{}/{}", c.source.library, c.source.set)).collect();
        let want_sets: Vec<&str> = want["runesets"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
        assert_eq!(sets, want_sets, "{id}");
        assert_eq!(foreign_runes(&fx, &v, if id.starts_with("claude") { "claude" } else { "codex" }), Vec::<String>::new(), "{id}");
        let pairs: Vec<_> = v.runesets.iter().map(|c| (c.source.clone(), c.source_hash.clone())).collect();
        assert_eq!(v.hash, vault_hash(&pairs, &v.runes), "{id} hash");
        for c in &v.runesets {
            assert_eq!(content_sha(&std::fs::read(vaults.join(id).join(&c.file)).unwrap()), c.source_hash, "{id} {}", c.file);
        }
        assert!(store.resolve(id).unwrap().warnings.is_empty(), "{id}");
    }
    assert!(lib.join("sets/toolkit-claude.md").is_file() && lib.join("sets/toolkit-codex.md").is_file());
    assert!(!text(&lib.join("sets/toolkit.md")).contains("<?rune alpha-review?>"));

    let after = fx.tree();
    let again = fx.run("20261025-120300", None).unwrap();
    assert!(again.backup.is_none(), "{:?}", again.lines);
    assert_eq!(fx.tree(), after);
}

/// A sidecar whose runes are all tagged leaves an empty base set, which no vault loads.
#[test]
fn an_all_tagged_sidecar_drops_its_empty_base_from_the_vaults() {
    let _g = lock();
    let fx = Fx::new("all-tagged");
    let lib = fx.imports().join("solo");
    std::fs::create_dir_all(lib.join("sets")).unwrap();
    std::fs::write(lib.join("sets/solo.md"), "---\nname: solo\nkind: set\nscope: [solo]\n---\nSolo.\n").unwrap();
    std::fs::write(lib.join("sets/solo.layer.json"), r#"{"skills":["~\\.claude\\skills\\only-claude"],"codexSkills":["~\\.codex\\skills\\only-codex"]}"#).unwrap();
    let mut cfg = json(&fx.config());
    cfg["agents"][0]["sets"] = serde_json::json!([{ "library": "solo", "set": "solo" }]);
    cfg["agents"][1]["sets"] = serde_json::json!([{ "library": "solo", "set": "solo" }]);
    std::fs::write(fx.config(), serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
    fx.run("20261025-120000", None).unwrap();
    let store = Store::open(fx.root());
    for (id, set) in [("claude-raw", "solo/solo-claude"), ("codex-raw", "solo/solo-codex")] {
        let v = store.get(id).unwrap();
        let sets: Vec<String> = v.runesets.iter().map(|c| format!("{}/{}", c.source.library, c.source.set)).collect();
        assert_eq!(sets, vec![set.to_string()], "{id}");
        assert_eq!(foreign_runes(&fx, &v, if id.starts_with("claude") { "claude" } else { "codex" }), Vec::<String>::new(), "{id}");
    }
    assert!(!lib.join("sets/solo.layer.json").exists());
}

/// A rewrite that fails midway puts every vault back from the journal.
#[test]
fn a_failed_repair_leaves_the_mixed_vaults_as_they_were() {
    use crate::bare::vault::{content_sha, vault_hash, RunesetCopy, SetSource};
    let _g = lock();
    let fx = Fx::new("mixed-fail");
    fx.run("20261025-120000", None).unwrap();
    let lib = fx.imports().join("toolkit");
    let mut mixed = text(&lib.join("sets/toolkit.md"));
    for s in ["toolkit-claude", "toolkit-codex"] {
        let p = lib.join(format!("sets/{s}.md"));
        for id in super::split::slot_order(&text(&p)) {
            mixed.push_str(&format!("- <?rune {id}?>\n"));
        }
        std::fs::remove_file(&p).unwrap();
    }
    std::fs::write(lib.join("sets/toolkit.md"), &mixed).unwrap();
    let store = Store::open(fx.root());
    let dir = crate::paths::rune_vaults_dir_in(fx.root()).join("claude-raw");
    let mut v = store.get("claude-raw").unwrap();
    for c in v.runesets.drain(..) {
        std::fs::remove_file(dir.join(&c.file)).unwrap();
    }
    std::fs::write(dir.join("sets/toolkit--toolkit.md"), &mixed).unwrap();
    v.runesets = vec![RunesetCopy {
        file: "sets/toolkit--toolkit.md".into(),
        source: SetSource { library: "toolkit".into(), set: "toolkit".into() },
        copied_utc: "2026-10-26T00:00:00Z".into(),
        source_hash: content_sha(mixed.as_bytes()),
    }];
    v.hash = vault_hash(&[(v.runesets[0].source.clone(), v.runesets[0].source_hash.clone())], &v.runes);
    std::fs::write(dir.join("vault.json"), serde_json::to_string_pretty(&v).unwrap()).unwrap();
    let before = fx.tree();
    assert!(fx.run("20261025-120200", Some("vaults")).is_err());
    assert_eq!(fx.tree(), before);
}

/// `p` canonicalised, `\\?\` dropped, `\`-separated, lowercased, no trailing separator.
fn norm(p: &Path) -> String {
    let c = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let t = c.to_string_lossy().replace('/', "\\");
    t.strip_prefix(r"\\?\").unwrap_or(&t).trim_end_matches('\\').to_lowercase()
}

/// Refuses `p` when it is, or sits under, the checkout this test builds from (and the main checkout
/// above it when that is a worktree), the paths root, or `%LOCALAPPDATA%\Vidar`.
fn refuse_live(p: &Path) {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let checkout = norm(manifest.parent().unwrap_or(manifest));
    let mut live = vec![checkout.clone(), norm(&repo())];
    if let Some((main, _)) = checkout.split_once(r"\runtime\worktrees\") {
        live.push(main.to_string());
    }
    if let Some(lad) = std::env::var_os("LOCALAPPDATA") {
        live.push(norm(&PathBuf::from(lad).join("Vidar")));
    }
    let n = norm(p);
    for l in live {
        assert!(n != l && !n.starts_with(&format!("{l}\\")), "refused: {} is under live {l}", p.display());
    }
}

/// Rehearsal (run 2026-10-25-rune-vault R1): the migration against a copied root, never live data.
/// `VIDAR_MIGRATE_REHEARSAL_ROOT` is the copied install root (vidar.json, runtime\runes, profiles\bare,
/// contracts\module-bundles.json); `VIDAR_MIGRATE_REHEARSAL_HOME`, when set, the copied Bare home
/// (claude-homes.json, codex-homes.json). Runs twice: the second run must be a no-op.
/// `cargo test -- --ignored bare::vault::migrate::tests::rehearsal --nocapture`
#[test]
#[ignore]
fn rehearsal() {
    let _g = lock();
    let root = PathBuf::from(std::env::var_os("VIDAR_MIGRATE_REHEARSAL_ROOT").expect("set VIDAR_MIGRATE_REHEARSAL_ROOT"));
    let home = std::env::var_os("VIDAR_MIGRATE_REHEARSAL_HOME").map(PathBuf::from);
    refuse_live(&root);
    if let Some(h) = &home {
        refuse_live(h);
    }
    let config = crate::paths::config_path_in(&root);
    assert!(config.is_file(), "no vidar.json under {}", root.display());
    let (_, stamp) = crate::bare::manifest::stamps();
    let env = Env { root: &root, config: &config, home_dir: home.as_deref(), stamp: &stamp, fail_at: None };
    let first = run(&env);
    println!("== run 1 ({stamp})");
    match &first {
        Ok(o) => {
            o.lines.iter().for_each(|l| println!("{l}"));
            println!("backup: {:?}", o.backup);
        }
        Err(e) => println!("error: {e}"),
    }
    let first = first.expect("run 1 failed");
    let stamp2 = format!("{stamp}-2");
    let second = run(&Env { stamp: &stamp2, ..env }).expect("run 2 failed");
    println!("== run 2 ({stamp2})");
    second.lines.iter().for_each(|l| println!("{l}"));
    println!("backup: {:?}", second.backup);
    assert!(first.backup.is_some(), "run 1 wrote nothing");
    assert!(second.backup.is_none(), "run 2 was not a no-op: {:?}", second.lines);
}
