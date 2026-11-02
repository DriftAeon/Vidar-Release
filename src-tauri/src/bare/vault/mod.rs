//! src-tauri\src\bare\vault\mod.rs — the Rune Vault wire types and IPC.
//! Contract: `docs/projects/bare/runeset-model.md` (R2, R3, R4, R6). A vault is what a session loads:
//! runesets byte-copied in at placement plus one-off runes. `store.rs` is its single writer; `session.rs`
//! records which vault (and hash) each session loaded. Nothing here reads a launcher row.
//! Wire format: `tests/fixtures/rune-vault/vaults/**` (field order, nulls and empty `pins` always emitted).

pub mod library_sets;
pub mod migrate_lib_rename;
pub mod session;
pub mod store;
mod store_header;
pub(crate) mod vidar;

#[cfg(test)]
mod member_tests;
#[cfg(test)]
mod off_tests;
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod vidar_tests;
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

/// Lineage: a variant of a vault at a hash.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum VaultFrom {
    Vault { vault: String, hash: String },
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

/// `rune_vault_list` row: a vault in the vaults folder (`paths::rune_vaults_dir_in`).
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
    /// The other placed runesets that also slot or recall it: it loads once, under `set`, and each of
    /// these lists and counts it too. Omitted when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub also: Vec<SetSource>,
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
    /// The library file the rune lives in as a plain drive-rooted path (`store::source_path`); empty when
    /// the library no longer holds it, so the View offers no Edit or Open Folder.
    pub path: String,
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
    /// A Vidar Runeset slot only: the name of the on slot that needs it (`vidar::Slot::needed_by`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needed_by: Option<String>,
    /// A Vidar Runeset slot only: the shipped set marks it required (`vidar::Slot::required`), text runes included.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
}

/// `Store::view_runes`' one-listing check for `lib/id` met in placed runeset `set`: true the first time
/// (list it). Met again, the row stays one (it loads once) and names `set` in `also`, so that runeset's
/// card lists and counts it too; a one-off row is left alone.
pub(crate) fn listed_once(seen: &mut std::collections::HashSet<String>, out: &mut [ViewRune], lib: &str, id: &str, set: &SetSource) -> bool {
    if seen.insert(format!("{lib}/{id}")) {
        return true;
    }
    if let Some(r) = out.iter_mut().find(|r| r.set.is_some() && r.library == lib && r.id == id) {
        if r.set.as_ref() != Some(set) && !r.also.contains(set) {
            r.also.push(set.clone());
        }
    }
    false
}

fn store() -> store::Store {
    store::Store::open(&crate::paths::root())
}

#[tauri::command]
pub fn rune_vault_list() -> Result<Vec<Listed>, String> {
    store().list()
}

/// `hash` reads a revision (a session's loaded state, `revs/<hash>/`); absent reads the vault now. A null
/// `id` reads no vault: the blank view of a new one for `agent` (`Store::blank_view`).
#[tauri::command]
pub fn rune_vault_read(id: Option<String>, hash: Option<String>, agent: Option<String>) -> Result<VaultView, String> {
    read_view_for(&store(), id.as_deref(), hash.as_deref(), agent.as_deref().and_then(crate::agent_spec::parse))
}

/// `rune_vault_read` against any store (tests use a temp root), with no agent filter.
pub(crate) fn read_view(s: &store::Store, id: Option<&str>, hash: Option<&str>) -> Result<VaultView, String> {
    read_view_for(s, id, hash, None)
}

/// `read_view` for a tab's `agent`: the Vidar Runeset lists only the members that fit it (`Rune::fits`), so
/// a tab's pane never draws the other agent's members. No id is the blank view.
pub(crate) fn read_view_for(s: &store::Store, id: Option<&str>, hash: Option<&str>, agent: Option<crate::agent_spec::Agent>) -> Result<VaultView, String> {
    let Some(id) = id else { return s.blank_view(agent) };
    let id = id.to_string();
    let current = s.get(&id)?;
    let (vault, earlier) = match hash {
        Some(h) if h != current.hash => (s.load_at(&id, h)?, true),
        _ => (current, false),
    };
    // drift against the read revision's own pins; a locked vault, or a session's earlier revision,
    // shows the copy that session loaded
    let drift = if earlier { s.view_drift(&vault)? } else { s.drift(&id)? };
    let (runes, warnings, off) = s.view_runes(&vault, earlier || vault.locked_utc.is_some(), &drift, agent)?;
    Ok(VaultView { vault, drift, runes, warnings, off })
}

/// `name: null` starts a copy (`copy-<utc>-<hex>`): of `from` (a vault at a hash) when it names one, else a
/// blank vault (the Vidar Runeset alone) plus the picks. Every call makes a new vault.
#[tauri::command]
pub fn rune_vault_create(name: Option<String>, from: Option<VaultFrom>, runesets: Vec<SetSource>, runes: Vec<RuneRef>, agent: Option<String>) -> Result<Vault, String> {
    let _ = agent; // the wire still sends it; a blank vault has no per-agent floor
    create_typed_at(&crate::paths::root(), name, from, &runesets, &runes)
}

/// The command's body against any root: a user-typed `name` must not repeat a named vault or template.
/// `create_at` itself keeps the id-suffix behaviour internal callers rely on.
pub(crate) fn create_typed_at(root: &std::path::Path, name: Option<String>, from: Option<VaultFrom>, runesets: &[SetSource], runes: &[RuneRef]) -> Result<Vault, String> {
    if let Some(n) = name.as_deref().filter(|n| !n.trim().is_empty()) {
        store::Store::open(root).refuse_taken_name(n)?;
    }
    create_at(root, name, from, runesets, runes)
}

/// `rune_vault_create` against any root (tests use a temp one). Every vault it makes carries the Vidar
/// Runeset at index 0: with `from: None` an empty copy of it (no optional slot on), with `from` a vault the
/// copy that vault holds, as is.
pub(crate) fn create_at(root: &std::path::Path, name: Option<String>, from: Option<VaultFrom>, runesets: &[SetSource], runes: &[RuneRef]) -> Result<Vault, String> {
    match name.filter(|n| !n.trim().is_empty()) {
        Some(n) => store::Store::open(root).create_in(&n, from, runesets, runes, true),
        None => match from {
            Some(VaultFrom::Vault { vault, hash }) => store::Store::open(root).start_copy_in(&vault, Some(&hash), runesets, runes, true),
            None => store::Store::open(root).start_blank(runesets, runes),
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
    /// The runesets the Rune Library groups by, each with its member refs (`library_sets.rs`).
    pub runesets: Vec<library_sets::LibraryRuneset>,
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
    Ok(LibraryRunes { runes, runesets: s.library_runesets(agent), warnings })
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

/// The pre-pick per agent; empty when the file is absent or does not parse.
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
    crate::fsx::write_json_pretty(&file, &Defaults { version: 1, last_vault }, true)
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
