//! src-tauri\src\bare\vault\mod.rs — the Rune Vault wire types and IPC.
//! Contract: `docs/projects/bare/runeset-model.md` (R2, R3, R4, R6). A vault is what a session loads:
//! runesets byte-copied in at placement plus one-off runes. `store.rs` is its single writer; `session.rs`
//! records which vault (and hash) each session loaded. Nothing here reads a launcher row.
//! Wire format: `tests/fixtures/rune-vault/vaults/**` (field order, nulls and empty `pins` always emitted).

pub mod migrate;
pub mod migrate_recall;
pub mod session;
pub mod store;
mod store_header;

#[cfg(test)]
mod member_tests;
#[cfg(test)]
mod migrate_recall_tests;
#[cfg(test)]
mod off_tests;
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// `<vaults folder>\<id>\vault.json`, version 1.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub created_utc: String,
    pub from: Option<VaultFrom>,
    pub runesets: Vec<RunesetCopy>,
    pub runes: Vec<RuneRef>,
    pub locked_utc: Option<String>,
    pub locked_by: Option<LockedBy>,
    /// hash12 over runesets (source + snapshot bytes) and runes, in order; lock, name and lineage excluded.
    pub hash: String,
    /// `<library>/<id>` -> sha12 of the body the locked vault loaded (recall members included); empty unlocked.
    #[serde(default)]
    pub pins: BTreeMap<String, String>,
    /// One-off runes Modify switched off (`Op::RemoveRune`): never loaded and outside the hash, kept so the
    /// Runes View still lists them off after Done and in a variant; `Op::AddRune` takes one back out.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub off: Vec<RuneRef>,
    /// Whole placed runesets Modify switched off (`Op::RemoveRuneset`): their copy is gone and they never load;
    /// outside the hash like `off`. The view lists the library runeset's runes off under its head;
    /// `Op::AddRuneset` takes one back out.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub off_sets: Vec<SetSource>,
}

/// Lineage: a variant of a vault at a hash, or a copy of a template.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum VaultFrom {
    Vault { vault: String, hash: String },
    Template { template: String },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LockedBy {
    Button,
    FirstMessage,
}

/// One rune stored once in a library.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RuneRef {
    pub library: String,
    pub id: String,
}

impl RuneRef {
    pub fn key(&self) -> String {
        format!("{}/{}", self.library, self.id)
    }
}

/// A library runeset, named where it came from.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SetSource {
    pub library: String,
    pub set: String,
}

/// One rune switched in (`on`) or out of the vault's own copy of placed runeset `library/runeset`
/// (`store::Op::Member`). Only the copy under the vault folder changes,
/// never the library runeset (model R3: copy, not link). `rune` names its own library (a cross-library slot).
/// A slotted rune's line goes or comes back; a `<?recall?>` member's id goes in or out of the copy's
/// `recall-off` header.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MemberEdit {
    pub library: String,
    pub runeset: String,
    pub rune: RuneRef,
    pub on: bool,
}

/// A runeset placed in a vault: a dated byte copy at `file` (`sets/<library>--<set>.md`), never linked.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunesetCopy {
    pub file: String,
    pub source: SetSource,
    pub copied_utc: String,
    /// sha256 (64 hex) of the snapshot bytes at copy time, CR stripped.
    pub source_hash: String,
}

/// A stock template (`profiles\bare\templates\<id>.json`): runesets named by source, copied at create.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub runesets: Vec<SetSource>,
    #[serde(default)]
    pub runes: Vec<RuneRef>,
}

/// sha256 hex of `bytes` with CR removed, so a CRLF checkout hashes like LF.
pub(crate) fn content_sha(bytes: &[u8]) -> String {
    let lf: Vec<u8> = bytes.iter().copied().filter(|b| *b != b'\r').collect();
    let d = Sha256::digest(&lf);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn sha12(bytes: &[u8]) -> String {
    content_sha(bytes)[..12].to_string()
}

/// The vault content hash: each runeset's source and snapshot sha, then each rune ref, in order.
pub(crate) fn vault_hash(sets: &[(SetSource, String)], runes: &[RuneRef]) -> String {
    let mut text = String::new();
    for (s, sha) in sets {
        text.push_str(&format!("set\t{}\t{}\t{sha}\n", s.library, s.set));
    }
    for r in runes {
        text.push_str(&format!("rune\t{}\t{}\n", r.library, r.id));
    }
    sha12(text.as_bytes())
}

// ---- IPC (registered in main.rs for the whole run; `src/ipc.ts` mirrors these shapes) ----

/// `rune_vault_list` row: a vault in the vaults folder (`paths::rune_vaults_dir_in`) or a stock template.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub id: String,
    pub name: String,
    pub template: bool,
    /// Empty for a template (its runesets are copied, and hashed, at create).
    pub hash: String,
    pub locked_utc: Option<String>,
}

/// `rune_vault_read` reply: the vault, its drift, and the runes it loads as the Runes View draws them.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultView {
    pub vault: Vault,
    /// Pinned runes whose library body changed or vanished since lock; empty unless locked.
    pub drift: Vec<RuneRef>,
    /// Each runeset's runes in slot order (recall members after), then the one-offs (`Store::view_runes`).
    pub runes: Vec<ViewRune>,
    /// Runes left out of the list above: a missing copy or a file that does not parse.
    pub warnings: Vec<String>,
    /// Runes the vault holds switched off, never loaded, listed so Modify draws them off: a runeset copy's
    /// recall members (`recall-off` header, `store::RECALL_OFF`) and slot members (`slot-off` header,
    /// `store::SLOT_OFF`), then the vault's switched-off one-offs (`Vault::off`). Omitted when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub off: Vec<ViewRune>,
}

/// One rune a vault loads, for the Runes View: a text kind carries its body; an item kind
/// carries `item` (`rune_items::RuneItem::redacted`) and an empty body, so no hook command, MCP field
/// or env value reaches the UI. A locked vault's text is the copy in `revs/<hash>/` (R6).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ViewRune {
    /// The runeset it is slotted or recalled in; `None` for a one-off rune.
    pub set: Option<SetSource>,
    pub library: String,
    pub id: String,
    pub kind: String,
    pub activate: String,
    pub description: String,
    /// The heading path the library's `import.json` gives the rune; empty when it has none.
    pub section: Vec<String>,
    /// Joined through the runeset's `<?recall?>` line rather than a slot.
    pub recall: bool,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closes_when: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<crate::bare::rune_items::RedactedItem>,
    /// The library body changed or vanished since lock (D-e, a hash compare against `pins`).
    pub drift: bool,
}

fn store() -> store::Store {
    store::Store::open(&crate::paths::root())
}

#[tauri::command]
pub fn rune_vault_list() -> Result<Vec<Listed>, String> {
    store().list()
}

/// `hash` reads a revision (a session's loaded state, `revs/<hash>/`); absent reads the vault now.
#[tauri::command]
pub fn rune_vault_read(id: String, hash: Option<String>) -> Result<VaultView, String> {
    read_view(&store(), &id, hash.as_deref())
}

/// `rune_vault_read` against any store (tests use a temp root). A `stock-*` id is written from its
/// template when absent (`Store::ensure_stock`), so Custom finds the floor before any stock launch.
pub(crate) fn read_view(s: &store::Store, id: &str, hash: Option<&str>) -> Result<VaultView, String> {
    let id = id.to_string();
    let current = if id.starts_with("stock-") { s.ensure_stock(&id)? } else { s.get(&id)? };
    let (vault, earlier) = match hash {
        Some(h) if h != current.hash => (s.load_at(&id, h)?, true),
        _ => (current, false),
    };
    // drift against the read revision's own pins; a locked vault, or a session's earlier revision,
    // shows the copy that session loaded
    let drift = if earlier { s.view_drift(&vault)? } else { s.drift(&id)? };
    let (runes, warnings, off) = s.view_runes(&vault, earlier || vault.locked_utc.is_some(), &drift)?;
    Ok(VaultView { vault, drift, runes, warnings, off })
}

/// A Custom vault on `agent`'s floor (model R2): the stock template's runesets and runes, then the picks
/// not already in it, as `src/launcher/set-pick.ts` `createCustom` does. A missing or unreadable template
/// refuses: a vault without the floor would load without the identity and guard runes.
pub(crate) fn floored_custom(root: &std::path::Path, agent: &str, runesets: &[SetSource], runes: &[RuneRef]) -> Result<Vault, String> {
    let Some(parsed) = crate::agent_spec::parse(agent) else {
        return Err(format!("Agent {agent:?} is not claude or codex; vault refused"));
    };
    let s = store::Store::open(root);
    let id = format!("stock-{}", parsed.as_str());
    let file = crate::paths::rune_templates_dir_in(root).join(format!("{id}.json"));
    if !file.is_file() {
        return Err(format!("Stock Template Missing: {id}"));
    }
    let t = s.template(&id).map_err(|e| format!("Stock template {id}: {e}; vault refused"))?;
    let (mut sets, mut refs) = (t.runesets, t.runes);
    for p in runesets {
        if !sets.contains(p) {
            sets.push(p.clone());
        }
    }
    for r in runes {
        if !refs.contains(r) {
            refs.push(r.clone());
        }
    }
    s.create_custom(&sets, &refs)
}

/// `name: null` makes a Custom vault (`custom-<hash6>`, an identical pick reuses it; `from` ignored)
/// on `agent`'s stock floor (`floored_custom`), so no caller can make a Custom vault without it.
#[tauri::command]
pub fn rune_vault_create(name: Option<String>, from: Option<VaultFrom>, runesets: Vec<SetSource>, runes: Vec<RuneRef>, agent: Option<String>) -> Result<Vault, String> {
    create_at(&crate::paths::root(), name, from, &runesets, &runes, agent.as_deref())
}

/// `rune_vault_create` against any root (tests use a temp one).
pub(crate) fn create_at(root: &std::path::Path, name: Option<String>, from: Option<VaultFrom>, runesets: &[SetSource], runes: &[RuneRef], agent: Option<&str>) -> Result<Vault, String> {
    match name.filter(|n| !n.trim().is_empty()) {
        Some(n) => store::Store::open(root).create(&n, from, runesets, runes),
        None => match agent.and_then(crate::agent_spec::parse) {
            Some(a) => floored_custom(root, a.as_str(), runesets, runes),
            None => Err("A Custom vault needs its agent (claude or codex) for the stock floor; vault refused".into()),
        },
    }
}

#[tauri::command]
pub fn rune_vault_edit(id: String, ops: Vec<store::Op>, mode: store::EditMode) -> Result<Vault, String> {
    store().edit(&id, &ops, mode)
}

#[tauri::command]
pub fn rune_vault_lock(id: String, by: LockedBy, expect_hash: String) -> Result<Vault, String> {
    store().lock(&id, by, &expect_hash)
}

/// `rune_vault_library_runes` reply: the runes Modify's Add Rune picker offers (`Store::library_runes`).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRunes {
    /// `set` is always `None`; item kinds are redacted, so no hook command, MCP field or env value is sent.
    pub runes: Vec<ViewRune>,
    pub warnings: Vec<String>,
}

/// Every rune a vault for `agent` can take as a one-off. Reads only.
#[tauri::command]
pub fn rune_vault_library_runes(agent: String) -> Result<LibraryRunes, String> {
    library_runes_in(&store(), &agent)
}

pub(crate) fn library_runes_in(s: &store::Store, agent: &str) -> Result<LibraryRunes, String> {
    crate::rules::rune::check_id(agent).map_err(|e| format!("agent {agent:?}: {e}"))?;
    let (runes, warnings) = s.library_runes(agent);
    Ok(LibraryRunes { runes, warnings })
}

/// The newest record by `falconSession`, then `threadId`, then `tab`; `null` when none.
#[tauri::command]
pub fn rune_vault_session(tab: String, falcon_session: Option<String>, thread_id: Option<String>) -> Result<Option<session::Record>, String> {
    session::find(&crate::paths::root(), &tab, falcon_session.as_deref(), thread_id.as_deref())
}

// ---- the launcher pre-pick (Last Vault Used), read by `src/launcher/roster.ts` only ----

/// `<vaults folder>\defaults.json`, version 1: the last vault a Bare launch used, per agent.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    pub version: u32,
    #[serde(default)]
    pub last_vault: BTreeMap<String, String>,
}

fn defaults_file(root: &std::path::Path) -> std::path::PathBuf {
    crate::paths::rune_vaults_dir_in(root).join("defaults.json")
}

/// The pre-pick per agent; empty when the file is absent or does not parse (the launcher falls back to stock).
pub(crate) fn read_defaults(root: &std::path::Path) -> BTreeMap<String, String> {
    crate::fsx::read_json::<Defaults>(&defaults_file(root)).map(|d| d.last_vault).unwrap_or_default()
}

/// Records `vault` as `agent`'s pre-pick; both must be plain ids.
pub(crate) fn write_default(root: &std::path::Path, agent: &str, vault: &str) -> Result<(), String> {
    use std::sync::Mutex;
    static WRITER: Mutex<()> = Mutex::new(());
    crate::rules::rune::check_id(agent).map_err(|e| format!("agent {agent:?}: {e}"))?;
    crate::rules::rune::check_id(vault).map_err(|e| format!("vault id {vault:?}: {e}"))?;
    let _w = WRITER.lock().unwrap_or_else(|p| p.into_inner());
    let mut last_vault = read_defaults(root);
    if last_vault.get(agent).map(String::as_str) == Some(vault) {
        return Ok(());
    }
    last_vault.insert(agent.to_string(), vault.to_string());
    let file = defaults_file(root);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(&Defaults { version: 1, last_vault }).map_err(|e| e.to_string())? + "\n";
    crate::fsx::atomic_write(&file, json.as_bytes())
}

/// The launcher pre-pick per agent (`agent` -> vault id).
#[tauri::command]
pub fn rune_vault_defaults() -> BTreeMap<String, String> {
    read_defaults(&crate::paths::root())
}

/// Records the vault a Bare launch used, so the next launcher pick pre-picks it after a relaunch.
#[tauri::command]
pub fn rune_vault_default_set(agent: String, vault: String) -> Result<(), String> {
    write_default(&crate::paths::root(), &agent, &vault)
}
