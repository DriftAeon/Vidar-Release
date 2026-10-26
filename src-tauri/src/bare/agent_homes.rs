//! src-tauri\src\bare\agent_homes.rs — one agent home per set combination, for both agents (run
//! 2026-10-24-runesets-full-stack, W2 L6; both agents since fold W2-pre L2h). A launch's sets
//! (`library/set`, an absent library read as the config's `rulesLibrary`, lowercased, sorted,
//! deduped) hash to `<home>\<agent dir>\<hash12>\`: `codex-homes` for Codex, `claude-homes` for
//! Claude. Each agent's index (`<home>\codex-homes.json`, `<home>\claude-homes.json`) maps each hash
//! to its sets, folder and last use, written atomically under the home lock. The vault migration
//! (`vault/migrate.rs`) re-keys a legacy home onto its vault (`adopt`, `pick_vault`), so Rendered
//! keeps its threads; with no entry, a combination launches on its own home. The empty combination and Flow stay on the
//! legacy home; a Falcon-hosted Codex spawn runs on its combination's home too, which Falcon admits
//! by path (`codex_payload::admit_codex_home`).
//!
//! Live owners (plan F2): a home's owners are the launch manifests under `<home>\manifests` whose
//! own-agent field (`homes.codexHome`, `homes.claudeConfig`) names it, live while the recording
//! Vidar (`vidarPid`) runs or, for a hosted one (`falconSession`), while any `falcon.exe` runs. An
//! in-flight launch holds the home lock, and its manifest is written before the lock drops. A
//! manifest that cannot be read leaves owners unknown. A prune removes only a combination home
//! unused for 14 days, with no transcript (Codex rollouts, Claude `projects`) and no owner.

use super::*;
use serde::Serialize;

use super::layer::RowSets;
pub(crate) use crate::falcon::Agent;

const PRUNE_AFTER_MS: u64 = 14 * 24 * 60 * 60 * 1000;

/// What differs per agent: folder, index file, the manifest field naming a launch's home, the
/// transcript folders that keep a home from a prune, and the word errors use.
struct Kind {
    dir: &'static str,
    index: &'static str,
    owner_field: &'static str,
    /// A home holding any file under these keeps its transcripts and is never pruned.
    transcripts: &'static [&'static str],
    label: &'static str,
}

const CODEX: Kind = Kind {
    dir: "codex-homes",
    index: "codex-homes.json",
    owner_field: "/homes/codexHome",
    transcripts: &["sessions", "archived_sessions"],
    label: "Codex",
};

const CLAUDE: Kind = Kind {
    dir: "claude-homes",
    index: "claude-homes.json",
    owner_field: "/homes/claudeConfig",
    transcripts: &["projects"],
    label: "Claude",
};

fn kind(agent: Agent) -> &'static Kind {
    match agent {
        Agent::Codex => &CODEX,
        Agent::Claude => &CLAUDE,
    }
}

/// One index entry: the combination's refs, its folder relative to the Bare home, last use (ms).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    pub sets: Vec<String>,
    pub dir: String,
    pub last_used: u64,
}

pub(super) type Index = BTreeMap<String, Entry>;

/// The combination's refs: `library/set`, lowercased, sorted, deduped.
pub(super) fn refs(row: &RowSets) -> Vec<String> {
    let lib = row.rules_library.as_deref().unwrap_or_default();
    let mut v: Vec<String> = row
        .sets
        .iter()
        .map(|r| format!("{}/{}", r.library.as_deref().unwrap_or(lib).trim().replace('\\', "/"), r.set.trim()).to_lowercase())
        .collect();
    v.sort();
    v.dedup();
    v
}

/// The first 12 hex chars of the refs' sha256; `None` for the empty combination.
pub(super) fn hash12(row: &RowSets) -> Option<String> {
    let refs = refs(row);
    (!refs.is_empty()).then(|| hex(&Sha256::digest(refs.join("\n").as_bytes()))[..12].to_string())
}

/// The home a launch runs on: the legacy one, or a combination folder.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Picked {
    pub dir: PathBuf,
    /// The combination's hash and refs; `None` on the legacy home.
    pub combo: Option<(String, Vec<String>)>,
    /// `dir` relative to the Bare home, `/`-joined (a homeDirs entry for the login sync).
    pub rel: String,
}

fn index_path(k: &Kind, home_dir: &Path) -> PathBuf {
    home_dir.join(k.index)
}

fn read_index(k: &Kind, home_dir: &Path) -> Option<Index> {
    let text = crate::fsx::read_text(&index_path(k, home_dir)).ok()?;
    serde_json::from_str(crate::fsx::strip_bom(&text)).ok()
}

/// `dir` relative to the Bare home, `/`-joined; `None` when it does not sit under it.
fn rel_of(home_dir: &Path, dir: &Path) -> Option<String> {
    let rel = dir.strip_prefix(home_dir).ok()?;
    let parts: Vec<String> = rel.components().map(|c| match c {
        std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
        _ => None,
    }).collect::<Option<_>>()?;
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// The index as read; absent or unreadable is empty (the seed branch went with the fold migration's
/// adoption, fold W2 L2b).
fn index_of(k: &Kind, home_dir: &Path) -> Index {
    read_index(k, home_dir).unwrap_or_default()
}

/// The agent's index file under the Bare home (the fold migration backs it up).
pub(super) fn index_file(agent: Agent, home_dir: &Path) -> PathBuf {
    index_path(kind(agent), home_dir)
}

/// The entry that adopts the legacy home for `row`'s combination, read-only: `None` when the
/// legacy home is not a plain folder under the Bare home, the combination is empty, or the index
/// already holds the combination or an entry on the legacy home. The refs and hash are the ones a
/// launch of `row` computes (`refs`, `hash12`).
#[cfg(test)] // the fold migration that adopted at startup is gone; fixtures still build a pre-vault index
pub(super) fn adoption(agent: Agent, home_dir: &Path, legacy: &Path, row: &RowSets) -> Option<(String, Entry)> {
    let k = kind(agent);
    let legacy_rel = rel_of(home_dir, legacy)?;
    if !std::fs::symlink_metadata(legacy).is_ok_and(|m| m.is_dir() && !is_reparse(&m)) {
        return None;
    }
    let hash = hash12(row)?;
    let index = index_of(k, home_dir);
    if index.contains_key(&hash) || index.values().any(|e| e.dir.eq_ignore_ascii_case(&legacy_rel)) {
        return None;
    }
    Some((hash, Entry { sets: refs(row), dir: legacy_rel, last_used: 0 }))
}

/// Writes an `adoption` entry under the lock, re-reading the index; an entry already there for the
/// hash stays.
pub(super) fn adopt(agent: Agent, _lock: &home::HomeLock, home_dir: &Path, hash: &str, entry: &Entry) -> Result<(), String> {
    let k = kind(agent);
    let mut index = index_of(k, home_dir);
    if index.contains_key(hash) {
        return Ok(());
    }
    index.insert(hash.to_string(), entry.clone());
    write_index(k, home_dir, &index)
}

/// Picks the home for `row` (read-only; `record` writes the index under the lock). A Falcon-hosted
/// Codex spawn picks the same way and hands a combination home to its host
/// (`SpawnParams.codex_home`). A legacy home outside the Bare home takes every launch. `_config` is
/// unread since the seed went (fold W2 L2b); the parameter stays for the callers on master.
#[cfg_attr(not(test), allow(dead_code))] // spawns pick by vault (`pick_vault`) since run 2026-10-25-rune-vault L2a
pub(super) fn pick(agent: Agent, home_dir: &Path, legacy: &Path, _config: &Path, row: Option<&RowSets>) -> Picked {
    pick_refs(agent, home_dir, legacy, row.map(refs).unwrap_or_default())
}

/// The home a spawn on vault `vault_id` runs on (run 2026-10-25-rune-vault, L2a): the combination of
/// one ref, `vault:<id>`, hashed as any combination (`<agent dir>\<hash12>`); `None` (a test's
/// no-vault spawn) is the empty combination, the legacy home.
pub(super) fn pick_vault(agent: Agent, home_dir: &Path, legacy: &Path, vault_id: Option<&str>) -> Picked {
    pick_refs(agent, home_dir, legacy, vault_id.map(|id| vec![format!("vault:{id}")]).unwrap_or_default())
}

fn pick_refs(agent: Agent, home_dir: &Path, legacy: &Path, refs: Vec<String>) -> Picked {
    let k = kind(agent);
    let legacy_pick = |rel: String| Picked { dir: legacy.to_path_buf(), combo: None, rel };
    let Some(legacy_rel) = rel_of(home_dir, legacy) else { return legacy_pick(String::new()) };
    if refs.is_empty() {
        return legacy_pick(legacy_rel);
    }
    let hash = hex(&Sha256::digest(refs.join("\n").as_bytes()))[..12].to_string();
    let index = index_of(k, home_dir);
    let combo = Some((hash.clone(), refs));
    let own = format!("{}/{hash}", k.dir);
    match index.get(&hash) {
        Some(e) if e.dir.eq_ignore_ascii_case(&legacy_rel) => Picked { dir: legacy.to_path_buf(), combo, rel: legacy_rel },
        // A re-keyed entry (the vault migration maps `vault:<id>` onto the row's old combination
        // folder, run 2026-10-25-rune-vault L2g) keeps its folder; only one under the agent's dir.
        Some(e) => match in_agent_dir(k, &e.dir) {
            Some(rel) => Picked { dir: under(home_dir, &rel), combo, rel },
            None => Picked { dir: under(home_dir, &own), combo, rel: own },
        },
        None => Picked { dir: under(home_dir, &own), combo, rel: own },
    }
}

/// `dir` (an index entry's folder, relative to the Bare home) normalised to `/`-joined when it sits
/// strictly under the agent's dir (`codex-homes/..`, `claude-homes/..`) through plain names only;
/// `None` for anything else (an absolute path, a drive, `..`, `.`, the agent dir itself).
fn in_agent_dir(k: &Kind, dir: &str) -> Option<String> {
    let parts: Vec<&str> = dir.split(['/', '\\']).collect();
    let (first, rest) = parts.split_first()?;
    if !first.eq_ignore_ascii_case(k.dir) || rest.is_empty() {
        return None;
    }
    let plain = |p: &str| !p.is_empty() && p != "." && p != ".." && !p.contains(':');
    rest.iter().all(|p| plain(p)).then(|| std::iter::once(k.dir).chain(rest.iter().copied()).collect::<Vec<_>>().join("/"))
}

impl Picked {
    /// Whether this launch runs on the legacy home (no combination, or the adopted one).
    pub fn on_legacy(&self, legacy: &Path) -> bool {
        self.dir == legacy
    }
}

/// Records the pick in the agent's index and creates a combination folder, refusing a link or
/// junction on the way. The empty combination records nothing. `_config` as `pick`.
pub(super) fn record(agent: Agent, _lock: &home::HomeLock, home_dir: &Path, legacy: &Path, _config: &Path, picked: &Picked) -> Result<(), String> {
    let k = kind(agent);
    let Some((hash, sets)) = &picked.combo else { return Ok(()) };
    if !picked.on_legacy(legacy) {
        for d in [home_dir.join(k.dir), picked.dir.clone()] {
            if std::fs::symlink_metadata(&d).is_ok_and(|m| m.file_type().is_symlink() || is_reparse(&m)) {
                return Err(format!("{} home {} is a link or junction; spawn refused", k.label, d.display()));
            }
            std::fs::create_dir_all(&d).map_err(|e| format!("{} home {}: {e}; spawn refused", k.label, d.display()))?;
        }
    }
    let mut index = index_of(k, home_dir);
    index.insert(hash.clone(), Entry { sets: sets.clone(), dir: picked.rel.clone(), last_used: crate::fsx::now_ms() });
    write_index(k, home_dir, &index)
}

fn write_index(k: &Kind, home_dir: &Path, index: &Index) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
    let path = index_path(k, home_dir);
    crate::fsx::atomic_write(&path, &json).map_err(|e| format!("{} homes index {}: {e}", k.label, path.display()))
}

fn is_reparse(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_attributes() & 0x400 != 0
}

/// Who holds an agent home now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Owners {
    None,
    Live,
    /// The manifests could not all be read: treat as live for deletions and prunes.
    Unknown,
}

fn norm(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// The live owners of `agent_home`, from the launch manifests under `<home>\manifests`.
pub(super) fn owners(agent: Agent, home_dir: &Path, agent_home: &Path) -> Owners {
    owners_with(agent, home_dir, agent_home, &crate::procs::is_alive, &|| crate::procs::snapshot().values().any(|r| r.exe == "falcon.exe"))
}

pub(super) fn owners_with(agent: Agent, home_dir: &Path, agent_home: &Path, alive: &dyn Fn(u32) -> bool, falcon_up: &dyn Fn() -> bool) -> Owners {
    let field = kind(agent).owner_field;
    let dir = home_dir.join("manifests");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Owners::None,
        Err(_) => return Owners::Unknown,
    };
    let want = norm(&agent_home.to_string_lossy());
    let mut falcon: Option<bool> = None;
    let mut unknown = false;
    for e in entries {
        let Ok(e) = e else { unknown = true; continue };
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(v) = crate::fsx::read_text(&path).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(crate::fsx::strip_bom(&t)).ok()) else {
            unknown = true;
            continue;
        };
        let home = v.pointer(field).and_then(serde_json::Value::as_str).unwrap_or_default();
        if home.is_empty() || norm(home) != want {
            continue;
        }
        let pid = v.get("vidarPid").and_then(serde_json::Value::as_u64).and_then(|p| u32::try_from(p).ok());
        let hosted = v.get("falconSession").is_some_and(|s| s.is_string());
        let live = match hosted {
            true => *falcon.get_or_insert_with(falcon_up),
            false => pid.is_none_or(alive),
        };
        if live {
            return Owners::Live;
        }
    }
    if unknown { Owners::Unknown } else { Owners::None }
}

/// Whether `dir` holds a transcript (any file under the agent's transcript folders). An
/// unreadable folder counts as one.
fn has_transcripts(k: &Kind, dir: &Path) -> bool {
    fn any_file(d: &Path) -> bool {
        let Ok(entries) = std::fs::read_dir(d) else { return d.exists() };
        for e in entries {
            let Ok(e) = e else { return true };
            let Ok(t) = e.file_type() else { return true };
            if t.is_file() || t.is_symlink() || (t.is_dir() && any_file(&e.path())) {
                return true;
            }
        }
        false
    }
    k.transcripts.iter().any(|r| any_file(&dir.join(r)))
}

/// Removes the agent's combination homes unused for 14 days with no transcript and no owner, and
/// drops them from its index. Never the legacy home, a folder outside the agent's dir, or a link.
/// Returns warnings.
pub(super) fn prune(agent: Agent, lock: &home::HomeLock, home_dir: &Path, now_ms: u64) -> Vec<String> {
    prune_with(agent, lock, home_dir, now_ms, &|d| owners(agent, home_dir, d))
}

pub(super) fn prune_with(agent: Agent, _lock: &home::HomeLock, home_dir: &Path, now_ms: u64, owners_of: &dyn Fn(&Path) -> Owners) -> Vec<String> {
    let k = kind(agent);
    let Some(mut index) = read_index(k, home_dir) else { return Vec::new() };
    let mut warnings = Vec::new();
    let mut gone = Vec::new();
    for (hash, e) in &index {
        if e.dir != format!("{}/{hash}", k.dir) || now_ms.saturating_sub(e.last_used) < PRUNE_AFTER_MS {
            continue;
        }
        // A re-keyed `vault:<id>` entry on the same folder (L2g) keeps it while that entry is in use.
        if index.iter().any(|(h, o)| h != hash && o.dir.eq_ignore_ascii_case(&e.dir) && now_ms.saturating_sub(o.last_used) < PRUNE_AFTER_MS) {
            continue;
        }
        let dir = under(home_dir, &e.dir);
        let plain = |d: &Path| std::fs::symlink_metadata(d).is_ok_and(|m| m.is_dir() && !is_reparse(&m));
        if !dir.exists() {
            gone.push(hash.clone());
            continue;
        }
        if !plain(&home_dir.join(k.dir)) || !plain(&dir) || has_transcripts(k, &dir) || owners_of(&dir) != Owners::None {
            continue;
        }
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => gone.push(hash.clone()),
            Err(err) => warnings.push(format!("Unused {} home {} not removed ({err})", k.label, dir.display())),
        }
    }
    if !gone.is_empty() {
        for h in gone {
            index.remove(&h);
        }
        if let Err(e) = write_index(k, home_dir, &index) {
            warnings.push(e);
        }
    }
    warnings
}

/// Every home of an agent in an install, for readers (W3 L9): the legacy home first (with the sets
/// of the entry mapped onto it, none when no entry does), then each indexed combination home that
/// is a plain folder one level under `<agent dir>` (its own hash or another key), once per folder;
/// a folder an entry keyed to a vault names lists
/// that entry's `vault:<id>` (the readers show the vault's runesets). Read-only; an entry that names any other
/// folder, a link or a missing folder is skipped, so a hand-edited index cannot point a reader
/// elsewhere.
pub(super) fn listed(agent: Agent, home_dir: &Path, legacy: &Path) -> Vec<(PathBuf, Vec<String>)> {
    let k = kind(agent);
    let legacy_rel = rel_of(home_dir, legacy).unwrap_or_default();
    let index = read_index(k, home_dir).unwrap_or_default();
    // The sets a folder lists: those of the entry keyed to a vault (`vault:<id>`, the migration's
    // re-key) when one names the folder, so a re-keyed home never shows its old row's sets.
    let sets_of = |dir: &str| -> Option<Vec<String>> {
        let same = |e: &&Entry| !dir.is_empty() && e.dir.replace('\\', "/").eq_ignore_ascii_case(&dir.replace('\\', "/"));
        let hits: Vec<&Entry> = index.values().filter(same).collect();
        hits.iter().find(|e| e.sets.iter().any(|s| s.starts_with("vault:"))).or(hits.first()).map(|e| e.sets.clone())
    };
    let mut out = vec![(legacy.to_path_buf(), sets_of(&legacy_rel).unwrap_or_default())];
    let plain = |d: &Path| std::fs::symlink_metadata(d).is_ok_and(|m| m.is_dir() && !is_reparse(&m));
    if !plain(&home_dir.join(k.dir)) {
        return out;
    }
    for e in index.values() {
        // One plain segment under the agent dir: a hash folder, or the older combination folder a
        // vault re-key (or a hand migration) left its entry pointing at.
        let Some(name) = e.dir.replace('\\', "/").strip_prefix(&format!("{}/", k.dir)).map(str::to_string) else { continue };
        if name.is_empty() || name.contains('/') || name == "." || name == ".." {
            continue;
        }
        let dir = under(home_dir, &format!("{}/{name}", k.dir));
        let seen = out.iter().any(|(d, _)| d.to_string_lossy().replace('\\', "/").eq_ignore_ascii_case(&dir.to_string_lossy().replace('\\', "/")));
        if !seen && plain(&dir) {
            out.push((dir, sets_of(&e.dir).unwrap_or_else(|| e.sets.clone())));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bare::layer::SetRef;

    const C: Agent = Agent::Codex;
    const DIR: &str = "codex-homes";

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("vidar-agent-homes-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(p.join("home")).unwrap();
            Tmp(p)
        }
        fn home(&self) -> PathBuf {
            self.0.join("home")
        }
        fn legacy(&self) -> PathBuf {
            self.home().join("codex-home")
        }
        fn claude_legacy(&self) -> PathBuf {
            self.home().join("claude-config")
        }
        /// Both seed rows pick `rendered`.
        fn config(&self, rendered: &str) -> PathBuf {
            let c = self.0.join("row-config.json");
            let text = format!(
                r#"{{"rulesLibrary":"lib","agents":[{{"key":"codex-rendered-bare","sets":[{rendered}]}},{{"key":"claude-rendered-bare","sets":[{rendered}]}}]}}"#
            );
            std::fs::write(&c, text).unwrap();
            c
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn row(sets: &[(Option<&str>, &str)]) -> RowSets {
        RowSets { sets: sets.iter().map(|(l, s)| SetRef { library: l.map(str::to_string), set: s.to_string() }).collect(), rules_library: Some("lib".into()) }
    }

    #[test]
    fn order_permuted_sets_pick_one_dir() {
        let t = Tmp::new("order");
        let c = t.config("");
        let a = pick(C, &t.home(), &t.legacy(), &c, Some(&row(&[(None, "Alpha"), (Some("ext"), "beta")])));
        let b = pick(C, &t.home(), &t.legacy(), &c, Some(&row(&[(Some("EXT"), "beta"), (Some("lib"), "alpha"), (None, "alpha")])));
        assert_eq!(a.dir, b.dir);
        assert!(a.dir.starts_with(t.home().join(DIR)), "{:?}", a.dir);
        assert_eq!(a.combo.as_ref().unwrap().1, ["ext/beta", "lib/alpha"]);
    }

    /// Creates `legacy` and adopts it for `rendered`, as the fold migration does.
    fn adopt_now(agent: Agent, t: &Tmp, lock: &home::HomeLock, legacy: &Path, rendered: &RowSets) {
        std::fs::create_dir_all(legacy).unwrap();
        let (hash, entry) = adoption(agent, &t.home(), legacy, rendered).expect("an adoption");
        adopt(agent, lock, &t.home(), &hash, &entry).unwrap();
        assert!(adoption(agent, &t.home(), legacy, rendered).is_none(), "a second adoption");
    }

    #[test]
    fn with_no_adoption_the_rendered_combination_gets_its_own_home() {
        let t = Tmp::new("no-seed");
        let c = t.config(r#"{"set":"core"}"#);
        std::fs::create_dir_all(t.legacy()).unwrap();
        let p = pick(C, &t.home(), &t.legacy(), &c, Some(&row(&[(None, "core")])));
        assert_eq!(p.dir.parent().unwrap(), t.home().join(DIR));
        // A legacy home that does not exist is never adopted.
        assert!(adoption(Agent::Claude, &t.home(), &t.claude_legacy(), &row(&[(None, "core")])).is_none());
        assert!(adoption(C, &t.home(), &t.legacy(), &row(&[])).is_none());
    }

    #[test]
    fn the_adoption_maps_the_rendered_combination_to_the_legacy_home() {
        let t = Tmp::new("seed");
        let c = t.config(r#"{"set":"core"},{"library":"ext","set":"x"}"#);
        let lock = home::lock(&t.home(), home::LOCK_WAIT).unwrap();
        let rendered = row(&[(Some("ext"), "x"), (None, "core")]);
        adopt_now(C, &t, &lock, &t.legacy(), &rendered);
        let p = pick(C, &t.home(), &t.legacy(), &c, Some(&rendered));
        assert_eq!(p.dir, t.legacy());
        record(C, &lock, &t.home(), &t.legacy(), &c, &p).unwrap();
        // The adoption holds after the Rendered row's sets change.
        let c = t.config(r#"{"set":"other"}"#);
        assert_eq!(pick(C, &t.home(), &t.legacy(), &c, Some(&rendered)).dir, t.legacy());
        let raw = pick(C, &t.home(), &t.legacy(), &c, Some(&row(&[(None, "other")])));
        assert_ne!(raw.dir, t.legacy());
        record(C, &lock, &t.home(), &t.legacy(), &c, &raw).unwrap();
        assert!(raw.dir.is_dir());
        let index = read_index(&CODEX, &t.home()).unwrap();
        assert_eq!(index.len(), 2);
        assert!(index.values().any(|e| e.dir == "codex-home"));
        assert!(!t.home().join("claude-homes.json").exists(), "a Codex record wrote the Claude index");
    }

    #[test]
    fn an_empty_pick_and_flow_stay_on_the_legacy_home() {
        let t = Tmp::new("empty");
        let c = t.config("");
        assert_eq!(pick(C, &t.home(), &t.legacy(), &c, None).dir, t.legacy());
        assert_eq!(pick(C, &t.home(), &t.legacy(), &c, Some(&row(&[]))).dir, t.legacy());
        let lock = home::lock(&t.home(), home::LOCK_WAIT).unwrap();
        record(C, &lock, &t.home(), &t.legacy(), &c, &pick(C, &t.home(), &t.legacy(), &c, None)).unwrap();
        assert!(read_index(&CODEX, &t.home()).is_none(), "the empty combination wrote the index");
    }

    #[test]
    fn listed_gives_legacy_first_then_plain_combination_homes_only() {
        let t = Tmp::new("listed");
        let c = t.config(r#"{"set":"core"}"#);
        assert_eq!(listed(C, &t.home(), &t.legacy()), vec![(t.legacy(), Vec::<String>::new())]);
        let lock = home::lock(&t.home(), home::LOCK_WAIT).unwrap();
        adopt_now(C, &t, &lock, &t.legacy(), &row(&[(None, "core")]));
        let seeded = pick(C, &t.home(), &t.legacy(), &c, Some(&row(&[(None, "core")])));
        assert_eq!(seeded.dir, t.legacy());
        record(C, &lock, &t.home(), &t.legacy(), &c, &seeded).unwrap();
        let raw = pick(C, &t.home(), &t.legacy(), &c, Some(&row(&[(None, "other")])));
        record(C, &lock, &t.home(), &t.legacy(), &c, &raw).unwrap();
        let l = listed(C, &t.home(), &t.legacy());
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].0.clone(), l[0].1.clone()), (t.legacy(), vec!["lib/core".to_string()]));
        assert_eq!((l[1].0.clone(), l[1].1.clone()), (raw.dir.clone(), vec!["lib/other".to_string()]));
        // An entry naming any other folder, or a folder that is gone, is skipped.
        let mut index = read_index(&CODEX, &t.home()).unwrap();
        index.insert("evil".into(), Entry { sets: vec!["x/y".into()], dir: "..\\elsewhere".into(), last_used: 0 });
        write_index(&CODEX, &t.home(), &index).unwrap();
        std::fs::remove_dir_all(&raw.dir).unwrap();
        assert_eq!(listed(C, &t.home(), &t.legacy()).len(), 1);
    }

    #[test]
    fn listed_shows_an_entry_whose_folder_is_another_key_once_and_never_a_deeper_one() {
        let t = Tmp::new("listed-other-key");
        let other = t.home().join(DIR).join("6a5688b43b67");
        std::fs::create_dir_all(other.join("nested")).unwrap();
        let mut index = BTreeMap::new();
        let rel = format!("{DIR}/6a5688b43b67");
        index.insert("005b1ea67bc7".to_string(), Entry { sets: vec!["lib/a".into()], dir: rel.clone(), last_used: 0 });
        index.insert("ffff00000000".to_string(), Entry { sets: vec!["lib/b".into()], dir: rel.replace('/', "\\"), last_used: 0 });
        index.insert("deep".to_string(), Entry { sets: vec!["x/y".into()], dir: format!("{rel}/nested"), last_used: 0 });
        index.insert("dots".to_string(), Entry { sets: vec!["x/y".into()], dir: format!("{DIR}/.."), last_used: 0 });
        write_index(&CODEX, &t.home(), &index).unwrap();
        let l = listed(C, &t.home(), &t.legacy());
        assert_eq!(l.iter().map(|(d, _)| d.clone()).collect::<Vec<_>>(), vec![t.legacy(), other], "{l:?}");
        assert_eq!(l[1].1, ["lib/a"]);
    }

    fn manifest(home: &Path, name: &str, field: &str, agent_home: &Path, pid: u32, hosted: bool) {
        let dir = home.join("manifests");
        std::fs::create_dir_all(&dir).unwrap();
        let mut v = serde_json::json!({ "vidarPid": pid, "homes": { field: agent_home.to_string_lossy() } });
        if hosted {
            v["falconSession"] = "s1".into();
        }
        std::fs::write(dir.join(name), v.to_string()).unwrap();
    }

    #[test]
    fn owners_come_from_manifests_and_a_bad_one_is_unknown() {
        let t = Tmp::new("owners");
        let dir = t.home().join(DIR).join("abc");
        let alive = |p: u32| p == 7;
        assert_eq!(owners_with(C, &t.home(), &dir, &alive, &|| false), Owners::None);
        manifest(&t.home(), "a.json", "codexHome", &t.legacy(), 7, false);
        manifest(&t.home(), "b.json", "codexHome", &dir, 8, false);
        assert_eq!(owners_with(C, &t.home(), &dir, &alive, &|| false), Owners::None);
        manifest(&t.home(), "c.json", "codexHome", &dir, 9, true);
        assert_eq!(owners_with(C, &t.home(), &dir, &alive, &|| false), Owners::None);
        assert_eq!(owners_with(C, &t.home(), &dir, &alive, &|| true), Owners::Live);
        manifest(&t.home(), "d.json", "codexHome", &dir, 7, false);
        assert_eq!(owners_with(C, &t.home(), &dir, &alive, &|| false), Owners::Live);
        std::fs::remove_file(t.home().join("manifests").join("d.json")).unwrap();
        std::fs::write(t.home().join("manifests").join("e.json"), "{not json").unwrap();
        assert_eq!(owners_with(C, &t.home(), &dir, &alive, &|| false), Owners::Unknown);
    }

    #[test]
    fn a_home_with_a_rollout_an_owner_or_recent_use_is_never_pruned() {
        let t = Tmp::new("prune");
        let c = t.config("");
        let lock = home::lock(&t.home(), home::LOCK_WAIT).unwrap();
        let mut picks = Vec::new();
        for s in ["a", "b", "c", "d"] {
            let p = pick(C, &t.home(), &t.legacy(), &c, Some(&row(&[(None, s)])));
            record(C, &lock, &t.home(), &t.legacy(), &c, &p).unwrap();
            picks.push(p.dir);
        }
        let rollout = picks[0].join("sessions").join("2026").join("rollout-1.jsonl");
        std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        std::fs::write(&rollout, "{}").unwrap();
        let owned = picks[1].clone();
        let owners_of = |d: &Path| if d == owned { Owners::Live } else if d == picks[3] { Owners::Unknown } else { Owners::None };
        // Not yet 14 days: nothing goes.
        assert!(prune_with(C, &lock, &t.home(), crate::fsx::now_ms(), &owners_of).is_empty());
        assert!(picks.iter().all(|p| p.is_dir()));
        let later = crate::fsx::now_ms() + PRUNE_AFTER_MS + 1;
        assert!(prune_with(C, &lock, &t.home(), later, &owners_of).is_empty());
        assert!(picks[0].is_dir(), "a home with a rollout was pruned");
        assert!(picks[1].is_dir(), "a live-owned home was pruned");
        assert!(!picks[2].exists(), "an unused ownerless home stayed");
        assert!(picks[3].is_dir(), "a home with unknown owners was pruned");
        assert_eq!(read_index(&CODEX, &t.home()).unwrap().len(), 3);
        assert!(t.legacy().parent().unwrap().is_dir());
    }

    // Claude twins: `claude-homes`, `claude-homes.json`, seed row `claude-rendered-bare`, owners
    // from `homes.claudeConfig`.

    #[test]
    fn claude_adoption_takes_the_legacy_config_dir() {
        let t = Tmp::new("claude-seed");
        let c = t.config(r#"{"set":"kit"}"#);
        let lock = home::lock(&t.home(), home::LOCK_WAIT).unwrap();
        let kit = row(&[(None, "kit")]);
        adopt_now(Agent::Claude, &t, &lock, &t.claude_legacy(), &kit);
        let p = pick(Agent::Claude, &t.home(), &t.claude_legacy(), &c, Some(&kit));
        assert_eq!(p.dir, t.claude_legacy());
        assert_eq!(p.rel, "claude-config");
        record(Agent::Claude, &lock, &t.home(), &t.claude_legacy(), &c, &p).unwrap();
        let index = read_index(&CLAUDE, &t.home()).unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(index.values().next().unwrap().dir, "claude-config");
        assert!(t.home().join("claude-homes.json").is_file());
        assert!(!t.home().join("codex-homes.json").exists(), "a Claude record wrote the Codex index");
        assert_eq!(listed(Agent::Claude, &t.home(), &t.claude_legacy()), vec![(t.claude_legacy(), vec!["lib/kit".to_string()])]);
    }

    #[test]
    fn claude_new_combination_gets_its_own_dir() {
        let t = Tmp::new("claude-new");
        let c = t.config(r#"{"set":"kit"}"#);
        let lock = home::lock(&t.home(), home::LOCK_WAIT).unwrap();
        let p = pick(Agent::Claude, &t.home(), &t.claude_legacy(), &c, Some(&row(&[(None, "other")])));
        assert_eq!(p.dir.parent().unwrap(), t.home().join("claude-homes"));
        assert_eq!(p.rel, format!("claude-homes/{}", p.combo.as_ref().unwrap().0));
        record(Agent::Claude, &lock, &t.home(), &t.claude_legacy(), &c, &p).unwrap();
        assert!(p.dir.is_dir());
        // The same combination keeps the same dir; Codex's pick for it lands under codex-homes.
        assert_eq!(pick(Agent::Claude, &t.home(), &t.claude_legacy(), &c, Some(&row(&[(Some("LIB"), "Other")]))).dir, p.dir);
        let codex = pick(C, &t.home(), &t.legacy(), &c, Some(&row(&[(None, "other")])));
        assert_eq!(codex.dir.parent().unwrap(), t.home().join(DIR));
        let l = listed(Agent::Claude, &t.home(), &t.claude_legacy());
        assert_eq!(l.len(), 2);
        assert_eq!(l[1], (p.dir.clone(), vec!["lib/other".to_string()]));
    }

    #[test]
    fn claude_prune_skips_a_home_with_a_live_manifest() {
        let t = Tmp::new("claude-prune");
        let c = t.config("");
        let lock = home::lock(&t.home(), home::LOCK_WAIT).unwrap();
        let mut picks = Vec::new();
        for s in ["a", "b", "c"] {
            let p = pick(Agent::Claude, &t.home(), &t.claude_legacy(), &c, Some(&row(&[(None, s)])));
            record(Agent::Claude, &lock, &t.home(), &t.claude_legacy(), &c, &p).unwrap();
            picks.push(p.dir);
        }
        // a: a live Claude manifest owns it. b: only a Codex field names it, which Claude ignores.
        // c: a transcript under projects keeps it.
        manifest(&t.home(), "a.json", "claudeConfig", &picks[0], 7, false);
        manifest(&t.home(), "b.json", "codexHome", &picks[1], 7, false);
        let transcript = picks[2].join("projects").join("C--x").join("s.jsonl");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(&transcript, "{}").unwrap();
        let alive = |p: u32| p == 7;
        let owners_of = |d: &Path| owners_with(Agent::Claude, &t.home(), d, &alive, &|| false);
        let later = crate::fsx::now_ms() + PRUNE_AFTER_MS + 1;
        assert!(prune_with(Agent::Claude, &lock, &t.home(), later, &owners_of).is_empty());
        assert!(picks[0].is_dir(), "a home with a live Claude manifest was pruned");
        assert!(!picks[1].exists(), "a Codex manifest field held a Claude home");
        assert!(picks[2].is_dir(), "a home with a transcript was pruned");
        assert_eq!(read_index(&CLAUDE, &t.home()).unwrap().len(), 2);
    }

    /// The `vault:<id>` key the vault migration writes for `id` (L4c, L2g).
    fn vault_key(agent: Agent, t: &Tmp, id: &str) -> String {
        pick_vault(agent, &t.home(), &t.legacy(), Some(id)).combo.unwrap().0
    }

    #[test]
    fn a_combination_home_re_keyed_to_a_vault_is_the_dir_its_spawn_opens() {
        let t = Tmp::new("rekey");
        let c = t.config("");
        let lock = home::lock(&t.home(), home::LOCK_WAIT).unwrap();
        let old = pick(C, &t.home(), &t.legacy(), &c, Some(&row(&[(None, "core")])));
        record(C, &lock, &t.home(), &t.legacy(), &c, &old).unwrap();
        let key = vault_key(C, &t, "codex-rendered");
        let entry = Entry { sets: vec!["vault:codex-rendered".into()], dir: old.rel.clone(), last_used: 5 };
        adopt(C, &lock, &t.home(), &key, &entry).unwrap();
        let p = pick_vault(C, &t.home(), &t.legacy(), Some("codex-rendered"));
        assert_eq!((p.dir.clone(), p.rel.clone()), (old.dir.clone(), old.rel.clone()));
        // The spawn's record keeps the folder and the old entry stays; nothing moves.
        record(C, &lock, &t.home(), &t.legacy(), &c, &p).unwrap();
        let mut index = read_index(&CODEX, &t.home()).unwrap();
        let old_key = old.combo.clone().unwrap().0;
        assert_eq!(index[&key].dir, old.rel);
        assert_eq!(index[&old_key].dir, old.rel);
        assert_eq!(pick_vault(C, &t.home(), &t.legacy(), Some("codex-rendered")).dir, old.dir);
        // Readers list the folder once, under the vault it is keyed to, never the old row's sets.
        let shown: Vec<_> = listed(C, &t.home(), &t.legacy()).into_iter().filter(|(d, _)| *d == old.dir).collect();
        assert_eq!(shown, vec![(old.dir.clone(), vec!["vault:codex-rendered".to_string()])]);
        // A prune spares the folder while the vault entry is in use, though the old one is stale.
        index.get_mut(&old_key).unwrap().last_used = 0;
        write_index(&CODEX, &t.home(), &index).unwrap();
        let later = index[&key].last_used + PRUNE_AFTER_MS / 2;
        assert!(prune_with(C, &lock, &t.home(), later, &|_| Owners::None).is_empty());
        assert!(old.dir.is_dir(), "a re-keyed home in use was pruned");
    }

    #[test]
    fn an_index_entry_outside_the_agent_dir_is_refused() {
        let t = Tmp::new("outside");
        let lock = home::lock(&t.home(), home::LOCK_WAIT).unwrap();
        let own = |id: &str| format!("{DIR}/{}", vault_key(C, &t, id));
        let outside = t.0.join("elsewhere");
        let cases = [
            ("abs", outside.to_string_lossy().into_owned()),
            ("dotdot", format!("{DIR}/../../elsewhere")),
            ("sibling", "claude-homes/abc".to_string()),
            ("root", DIR.to_string()),
            ("bare", "elsewhere".to_string()),
        ];
        for (id, dir) in cases {
            adopt(C, &lock, &t.home(), &vault_key(C, &t, id), &Entry { sets: vec![format!("vault:{id}")], dir: dir.clone(), last_used: 1 }).unwrap();
            let p = pick_vault(C, &t.home(), &t.legacy(), Some(id));
            assert_eq!(p.rel, own(id), "{id}: {dir}");
            assert_eq!(p.dir, t.home().join(DIR).join(vault_key(C, &t, id)), "{id}: {dir}");
        }
        assert_eq!(in_agent_dir(&CODEX, "Codex-Homes\\x\\y"), Some(format!("{DIR}/x/y")));
    }
}
