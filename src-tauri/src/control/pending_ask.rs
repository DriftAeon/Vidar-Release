//! src-tauri\src\control\pending_ask.rs — pending asks: an agent posts a
//! question with named options (`ctl.pend`) and ends its turn; the question
//! waits in `pending-asks.json` (contract id `pendingAsks`) until the user
//! answers from Relay or the agent withdraws it (`ctl.unpend`, after the user
//! answered in the thread). Nothing blocks, nothing expires. Rust owns every write.
//!
//! The store is agent-writable. A store that cannot be read, does not parse or
//! is not an array is an error everywhere: `load_at` (and so the listing)
//! returns it, and mutations refuse without writing. Entries that fail to
//! deserialize or validate are hidden from listings and claims, and kept as raw
//! JSON written back verbatim after the valid entries; a duplicate id among
//! valid entries makes mutations refuse (the listing keeps the first).
//! Validation uses `ask::parse_ask`; it does not prove who wrote an entry.
//! A new entry's session comes from the authenticated requester, not the payload.
//!
//! Claims (one answer in flight per entry) live in memory only: a crash between
//! send and settle loses the claim and the item reappears, unanswered.
//!
//! The public fns use the real file; the `*_at` fns take the path so tests never
//! touch the runtime folder.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use super::ask::{check_context, parse_ask, parse_context};
use super::policy::Requester;

/// Open asks one session may hold.
const CAP_PER_SESSION: usize = 20;
/// Open asks across all sessions.
const CAP_TOTAL: usize = 100;

/// Serialises every store read-modify-write.
static STORE: Mutex<()> = Mutex::new(());
/// Entry ids with an answer in flight (shared by all windows).
static CLAIMS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub session: String,
    pub question: String,
    pub choices: Vec<String>,
    /// `details[i]` describes `choices[i]`; old records lack it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<String>,
    pub asked_at_ms: u64,
    /// Optional line saying what the ask is for; old records lack it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub session: String,
    pub question: String,
    pub choices: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<String>,
    pub asked_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    pub sha256: String,
}

#[derive(Serialize)]
pub struct Listing {
    pub items: Vec<Item>,
}

/// sha256 (lowercase hex) of the canonical JSON of the entry's fields; `context`
/// joins only when present, so records without it keep their old hash.
fn digest(e: &Entry) -> String {
    let mut canon = json!({
        "id": e.id,
        "session": e.session,
        "question": e.question,
        "choices": e.choices,
        "askedAtMs": e.asked_at_ms,
    });
    if let Some(c) = &e.context {
        canon["context"] = json!(c);
    }
    if !e.details.is_empty() {
        canon["details"] = json!(e.details);
    }
    let hash = Sha256::digest(canon.to_string().as_bytes());
    hash.iter().map(|b| format!("{b:02x}")).collect()
}

fn valid_id(id: &str) -> bool {
    id.len() == 8 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn valid(e: &Entry) -> bool {
    valid_id(&e.id)
        && !e.session.is_empty()
        && parse_ask(&json!({ "question": e.question, "choices": e.choices, "details": e.details })).is_ok()
        && e.context.as_deref().map_or(true, |c| check_context(c) == Ok(Some(c)))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mint_id() -> Result<String, String> {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).map_err(|e| format!("no OS randomness: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// A parsed store: valid entries (1-based array index beside each) plus the raw
/// values that failed deserialization or `valid()`, kept to be written back verbatim.
struct Parsed {
    entries: Vec<(usize, Entry)>,
    invalid: Vec<Value>,
}

/// Refuses only what makes the file unreadable as a store: a read error other
/// than NotFound, a parse error, or a top level that is not an array.
fn parse_store(path: &Path) -> Result<Parsed, String> {
    let empty = Parsed { entries: Vec::new(), invalid: Vec::new() };
    let text = match crate::fsx::read_text(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty),
        Err(e) => return Err(format!("pending asks read {}: {e}", path.display())),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| format!("pending asks parse {}: {e}", path.display()))?;
    let Value::Array(items) = value else {
        return Err(format!("pending asks store {} must be an array", path.display()));
    };
    let mut parsed = empty;
    for (index, value) in items.into_iter().enumerate() {
        match serde_json::from_value::<Entry>(value.clone()) {
            Ok(entry) if valid(&entry) => parsed.entries.push((index + 1, entry)),
            _ => parsed.invalid.push(value),
        }
    }
    Ok(parsed)
}

/// The store a mutation works on; `invalid` rides along untouched on every write.
struct Store {
    entries: Vec<Entry>,
    invalid: Vec<Value>,
}

impl Store {
    /// True when `id` is taken by a valid entry or by a raw invalid one.
    fn id_taken(&self, id: &str) -> bool {
        self.entries.iter().any(|e| e.id == id)
            || self.invalid.iter().any(|v| v.get("id").and_then(Value::as_str) == Some(id))
    }
}

fn read_unlocked(path: &Path) -> Result<Store, String> {
    let parsed = parse_store(path)?;
    let mut seen = HashSet::new();
    let mut entries = Vec::with_capacity(parsed.entries.len());
    for (index, entry) in parsed.entries {
        if !seen.insert(entry.id.clone()) {
            return Err(format!("pending asks {} entry {index} has a duplicate id", path.display()));
        }
        entries.push(entry);
    }
    Ok(Store { entries, invalid: parsed.invalid })
}

/// Listing view: invalid entries hidden, a duplicate id keeps its first entry.
fn read_listing_unlocked(path: &Path) -> Result<Vec<Entry>, String> {
    let parsed = parse_store(path)?;
    let mut seen = HashSet::new();
    Ok(parsed
        .entries
        .into_iter()
        .map(|(_, e)| e)
        .filter(|e| seen.insert(e.id.clone()))
        .collect())
}

/// Writes the valid entries, then the invalid raw values verbatim.
fn write_unlocked(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("pending asks dir {}: {e}", parent.display()))?;
    }
    let mut out = Vec::with_capacity(store.entries.len() + store.invalid.len());
    for e in &store.entries {
        out.push(serde_json::to_value(e).map_err(|e| format!("pending asks {}: {e}", path.display()))?);
    }
    out.extend(store.invalid.iter().cloned());
    let text = serde_json::to_string_pretty(&out).map_err(|e| format!("pending asks {}: {e}", path.display()))?;
    crate::fsx::atomic_write(path, text.as_bytes())
}

fn lock_store() -> std::sync::MutexGuard<'static, ()> {
    STORE.lock().unwrap_or_else(|p| p.into_inner())
}

fn with_claims<T>(f: impl FnOnce(&mut HashSet<String>) -> T) -> T {
    let mut guard = CLAIMS.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(HashSet::new))
}

pub(crate) fn load_at(path: &Path) -> Result<Vec<Entry>, String> {
    let _g = lock_store();
    read_listing_unlocked(path)
}

/// Appends an entry for `requester`'s session; returns its id.
pub(crate) fn post_at(path: &Path, requester: &Requester, payload: &Value, asked_at_ms: u64) -> Result<String, String> {
    let Requester::FalconSession { session, .. } = requester else {
        return Err("pending needs a hosted tab".to_string());
    };
    let (question, choices, details) = parse_ask(payload)?;
    let context = parse_context(payload)?.map(str::to_string);
    let _g = lock_store();
    let mut store = read_unlocked(path)?;
    if store.entries.len() >= CAP_TOTAL {
        return Err("too many pending asks".to_string());
    }
    if store.entries.iter().filter(|e| &e.session == session).count() >= CAP_PER_SESSION {
        return Err("too many pending asks for this tab".to_string());
    }
    let mut id = mint_id()?;
    while store.id_taken(&id) {
        id = mint_id()?;
    }
    store.entries.push(Entry {
        id: id.clone(),
        session: session.clone(),
        question: question.to_string(),
        choices: choices.iter().map(|s| s.to_string()).collect(),
        details: details.iter().map(|s| s.to_string()).collect(),
        asked_at_ms,
        context,
    });
    write_unlocked(path, &store)?;
    Ok(id)
}

/// Removes `requester`'s own session entries (all, or only `id`); skips claimed
/// entries and never touches another session's. Returns how many were removed.
pub(crate) fn withdraw_at(path: &Path, requester: &Requester, id: Option<&str>) -> Result<usize, String> {
    let Requester::FalconSession { session, .. } = requester else {
        return Err("pending needs a hosted tab".to_string());
    };
    let _g = lock_store();
    let mut store = read_unlocked(path)?;
    if let Some(id) = id {
        if !store.entries.iter().any(|e| e.id == id && &e.session == session) {
            return Err("pending ask not found".to_string());
        }
    }
    let claimed = with_claims(|c| c.clone());
    let mut removed: Vec<String> = Vec::new();
    store.entries.retain(|e| {
        let mine = &e.session == session && id.map_or(true, |i| i == e.id);
        if mine && !claimed.contains(&e.id) {
            removed.push(e.id.clone());
            false
        } else {
            true
        }
    });
    if removed.is_empty() {
        return Ok(0);
    }
    write_unlocked(path, &store)?;
    with_claims(|c| {
        for r in &removed {
            c.remove(r);
        }
    });
    Ok(removed.len())
}

/// Removes `id` only if its content hash still equals `sha256`.
pub(crate) fn settle_at(path: &Path, id: &str, sha256: &str) -> Result<(), String> {
    let _g = lock_store();
    let mut store = read_unlocked(path)?;
    let Some(pos) = store.entries.iter().position(|e| e.id == id) else {
        return Err("pending ask not found".to_string());
    };
    if digest(&store.entries[pos]) != sha256 {
        return Err("pending ask changed".to_string());
    }
    store.entries.remove(pos);
    write_unlocked(path, &store)?;
    with_claims(|c| c.remove(id));
    Ok(())
}

/// Takes the in-memory claim on `id` if it exists, matches `sha256` and is unclaimed.
pub(crate) fn claim_at(path: &Path, id: &str, sha256: &str) -> Result<(), String> {
    let _g = lock_store();
    let store = read_unlocked(path)?;
    let Some(entry) = store.entries.iter().find(|e| e.id == id) else {
        return Err("pending ask not found".to_string());
    };
    if digest(entry) != sha256 {
        return Err("pending ask changed".to_string());
    }
    if with_claims(|c| c.insert(id.to_string())) {
        Ok(())
    } else {
        Err("pending ask already being answered".to_string())
    }
}

fn changed(app: &AppHandle) {
    let _ = app.emit("pending-ask-update", json!({}));
}

/// `ctl.pend`: posts and returns the reply line.
pub fn post(app: &AppHandle, requester: &Requester, payload: &Value) -> Result<String, String> {
    let id = post_at(&crate::paths::pending_asks_path(), requester, payload, now_ms())?;
    changed(app);
    Ok(format!("ok pending {id}"))
}

/// `ctl.unpend`: withdraws the requester's own pending asks (all, or the optional `id`).
pub fn withdraw(app: &AppHandle, requester: &Requester, payload: &Value) -> Result<String, String> {
    let id = match payload.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if valid_id(s) => Some(s.as_str()),
        Some(_) => return Err("id must be an 8-char hex pending ask id".to_string()),
    };
    let n = withdraw_at(&crate::paths::pending_asks_path(), requester, id)?;
    if n > 0 {
        changed(app);
    }
    Ok(format!("ok withdrew {n}"))
}

/// `list_pending_asks() -> { items: [{ id, session, question, choices, askedAtMs, sha256 }] }`
#[tauri::command]
pub fn list_pending_asks() -> Result<Listing, String> {
    let items = load_at(&crate::paths::pending_asks_path())?
        .into_iter()
        .map(|e| {
            let sha256 = digest(&e);
            Item {
                id: e.id,
                session: e.session,
                question: e.question,
                choices: e.choices,
                details: e.details,
                asked_at_ms: e.asked_at_ms,
                context: e.context,
                sha256,
            }
        })
        .collect();
    Ok(Listing { items })
}

/// `claim_pending_ask({ id, sha256 }) -> ()`; errors when gone, changed or already claimed.
#[tauri::command]
pub fn claim_pending_ask(id: String, sha256: String) -> Result<(), String> {
    claim_at(&crate::paths::pending_asks_path(), &id, &sha256)
}

/// `release_pending_ask({ id }) -> ()`; drops the claim after a failed send.
#[tauri::command]
pub fn release_pending_ask(id: String) {
    with_claims(|c| c.remove(&id));
}

/// `settle_pending_ask({ id, sha256 }) -> ()`; removes the entry, errors on a stale hash.
#[tauri::command]
pub fn settle_pending_ask(app: AppHandle, id: String, sha256: String) -> Result<(), String> {
    settle_at(&crate::paths::pending_asks_path(), &id, &sha256)?;
    changed(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(std::path::PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp(tag: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!("vidar-pending-asks-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn hosted(session: &str) -> Requester {
        Requester::FalconSession { session: session.into(), tab: None }
    }

    fn assert_mutations_refuse_unchanged(path: &Path, bytes: &[u8], entry: &Entry) {
        std::fs::write(path, bytes).unwrap();
        let requester = hosted(&entry.session);
        let payload = json!({ "question": "Another question", "choices": ["a"] });
        let sha = digest(entry);
        let error = post_at(path, &requester, &payload, 6).unwrap_err();
        assert!(error.starts_with("pending asks "), "{error}");
        assert!(error.contains(&path.display().to_string()), "{error}");
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        let error = withdraw_at(path, &requester, None).unwrap_err();
        assert!(error.starts_with("pending asks "), "{error}");
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        let error = settle_at(path, &entry.id, &sha).unwrap_err();
        assert!(error.starts_with("pending asks "), "{error}");
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        let error = claim_at(path, &entry.id, &sha).unwrap_err();
        assert!(error.starts_with("pending asks "), "{error}");
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert!(!with_claims(|c| c.contains(&entry.id)));
    }

    #[test]
    fn mutations_preserve_unreadable_or_invalid_stores() {
        let dir = temp("invalid-store");
        let path = dir.0.join("pending-asks.json");
        let good = json!({ "id": "a123abcd", "session": "s-1", "question": "Which one", "choices": ["a"], "askedAtMs": 5 });
        let entry: Entry = serde_json::from_value(good.clone()).unwrap();
        for bytes in [b"[broken".as_slice(), b"{}".as_slice(), b"\xff".as_slice()] {
            assert_mutations_refuse_unchanged(&path, bytes, &entry);
        }
        for bytes in [b"[broken".as_slice(), b"{}".as_slice(), b"\xff".as_slice()] {
            std::fs::write(&path, bytes).unwrap();
            let error = load_at(&path).unwrap_err();
            assert!(error.contains(&path.display().to_string()), "{error}");
        }
        let bytes = serde_json::to_vec_pretty(&json!([good, good])).unwrap();
        assert_mutations_refuse_unchanged(&path, &bytes, &entry);
        std::fs::write(&path, &bytes).unwrap();
        let error = claim_at(&path, &entry.id, &digest(&entry)).unwrap_err();
        assert!(error.contains(&path.display().to_string()) && error.contains("entry 2 "), "{error}");
        assert_eq!(load_at(&path).unwrap().len(), 1, "the listing keeps the first of a duplicate id");
        let bytes = serde_json::to_vec(&json!([good])).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(post_at(&path, &hosted("s-1"), &json!({ "question": "Another question" }), 6).is_ok());
        assert_eq!(load_at(&path).unwrap().len(), 2);
    }

    #[test]
    fn invalid_entries_survive_mutations_and_stay_hidden() {
        let dir = temp("keep-invalid");
        let path = dir.0.join("pending-asks.json");
        let good = json!({ "id": "a123abcd", "session": "s-1", "question": "Which one", "choices": ["a"], "askedAtMs": 5 });
        let mut bad_id = good.clone();
        bad_id["id"] = json!("INVALID");
        let wrong_shape = json!({ "id": "a123abce", "extra": [1, { "k": null }] });
        std::fs::write(&path, serde_json::to_vec(&json!([wrong_shape, good, bad_id, 7])).unwrap()).unwrap();
        let listed: Vec<String> = load_at(&path).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(listed, vec!["a123abcd".to_string()]);
        assert_eq!(claim_at(&path, "a123abce", "x"), Err("pending ask not found".to_string()));
        let id = post_at(&path, &hosted("s-2"), &json!({ "question": "Another question" }), 6).unwrap();
        assert!(id != "a123abce");
        let listed: Vec<String> = load_at(&path).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(listed, vec!["a123abcd".to_string(), id.clone()]);
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let stored = stored.as_array().unwrap();
        assert_eq!(stored.len(), 5);
        assert_eq!(stored[0]["id"], json!("a123abcd"));
        assert_eq!(stored[1]["id"], json!(id));
        assert_eq!(&stored[2..], &[wrong_shape.clone(), bad_id.clone(), json!(7)]);
        assert_eq!(withdraw_at(&path, &hosted("s-2"), None), Ok(1));
        let sha = digest(&load_at(&path).unwrap()[0]);
        settle_at(&path, "a123abcd", &sha).unwrap();
        assert!(load_at(&path).unwrap().is_empty());
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(stored, json!([wrong_shape, bad_id, 7]));
    }

    #[cfg(windows)]
    #[test]
    fn post_preserves_a_locked_store() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = temp("locked-store");
        let path = dir.0.join("pending-asks.json");
        let bytes = b"[ ]\r\n";
        std::fs::write(&path, bytes).unwrap();
        // Something else (a scanner) may hold the file; skip rather than fail.
        let Ok(locked) = std::fs::OpenOptions::new().read(true).share_mode(0).open(&path) else {
            eprintln!("skipped: could not open the store exclusively");
            return;
        };
        let error = post_at(&path, &hosted("s-1"), &json!({ "question": "Which one" }), 1).unwrap_err();
        assert!(error.starts_with("pending asks read "), "{error}");
        drop(locked);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn load_drops_malformed_entries() {
        let dir = temp("load");
        let path = dir.0.join("pending-asks.json");
        let good = json!({ "id": "0123abcd", "session": "s-1", "question": "Which one", "choices": ["a", "b"], "askedAtMs": 5 });
        let bad_id = json!({ "id": "XYZ", "session": "s-1", "question": "Which one", "choices": [], "askedAtMs": 5 });
        let bad_choice = json!({ "id": "0123abce", "session": "s-1", "question": "Which one", "choices": ["é"], "askedAtMs": 5 });
        let no_session = json!({ "id": "0123abcf", "session": "", "question": "Which one", "choices": [], "askedAtMs": 5 });
        let wrong_shape = json!({ "id": "0123abc0", "question": 7 });
        let text = json!([good, bad_id, bad_choice, no_session, wrong_shape, 7]).to_string();
        std::fs::write(&path, text).unwrap();
        let loaded = load_at(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "0123abcd");
    }

    #[test]
    fn context_validates_and_old_records_still_load() {
        let dir = temp("context");
        let path = dir.0.join("pending-asks.json");
        let r = hosted("s-1");
        let id = post_at(&path, &r, &json!({ "question": "Which one", "context": "  picking a build  " }), 1).unwrap();
        assert_eq!(load_at(&path).unwrap()[0].context.as_deref(), Some("picking a build"));
        assert!(valid_id(&id));
        assert!(post_at(&path, &r, &json!({ "question": "Which one", "context": "x".repeat(81) }), 1).is_err());
        assert!(post_at(&path, &r, &json!({ "question": "Which one", "context": "caf\u{e9}" }), 1).is_err());
        let blank = post_at(&path, &r, &json!({ "question": "Which one", "context": "  " }), 1).unwrap();
        assert!(load_at(&path).unwrap().iter().find(|e| e.id == blank).unwrap().context.is_none());
        let old = json!([{ "id": "0123abcd", "session": "s-1", "question": "Which one", "choices": [], "askedAtMs": 5 }]);
        std::fs::write(&path, old.to_string()).unwrap();
        assert_eq!(load_at(&path).unwrap()[0].context, None);
    }

    #[test]
    fn details_round_trip_validate_and_old_records_still_load() {
        let dir = temp("details");
        let path = dir.0.join("pending-asks.json");
        let r = hosted("s-1");
        let id = post_at(&path, &r, &json!({ "question": "Which one", "choices": ["a", "b"], "details": ["first"] }), 1).unwrap();
        let loaded = load_at(&path).unwrap();
        assert_eq!(loaded[0].details, vec!["first".to_string()]);
        let plain = json!([{ "id": "0123abcd", "session": "s-1", "question": "Which one", "choices": ["a"], "askedAtMs": 5 }]);
        std::fs::write(&path, plain.to_string()).unwrap();
        assert!(load_at(&path).unwrap()[0].details.is_empty());
        std::fs::write(&path, "[]").unwrap();
        assert!(post_at(&path, &r, &json!({ "question": "Which one", "details": ["x"] }), 1).is_err());
        assert!(post_at(&path, &r, &json!({ "question": "Which one", "choices": ["a"], "details": ["x".repeat(121)] }), 1).is_err());
        assert!(post_at(&path, &r, &json!({ "question": "Which one", "choices": ["a"], "details": ["x", "y"] }), 1).is_err());
        let bad = json!([{ "id": "0123abce", "session": "s-1", "question": "Which one", "choices": ["a"], "details": ["x", "y"], "askedAtMs": 5 }]);
        std::fs::write(&path, bad.to_string()).unwrap();
        assert!(load_at(&path).unwrap().is_empty(), "a stored record with too many details is dropped");
        assert!(valid_id(&id));
    }

    #[test]
    fn pend_from_a_token_requester_is_refused() {
        let dir = temp("token");
        let path = dir.0.join("pending-asks.json");
        let r = post_at(&path, &Requester::Token("tab-1".into()), &json!({ "question": "Which one" }), 1);
        assert_eq!(r, Err("pending needs a hosted tab".to_string()));
        assert!(load_at(&path).unwrap().is_empty());
        let id = post_at(&path, &hosted("s-1"), &json!({ "question": "Which one", "choices": ["a"] }), 1).unwrap();
        assert!(valid_id(&id));
        assert_eq!(load_at(&path).unwrap()[0].session, "s-1");
    }

    #[test]
    fn withdraw_removes_own_entries_only() {
        let dir = temp("withdraw");
        let path = dir.0.join("pending-asks.json");
        let q = json!({ "question": "Which one", "choices": ["a"] });
        let a1 = post_at(&path, &hosted("s-1"), &q, 1).unwrap();
        let a2 = post_at(&path, &hosted("s-1"), &q, 2).unwrap();
        let b1 = post_at(&path, &hosted("s-2"), &q, 3).unwrap();
        assert_eq!(withdraw_at(&path, &hosted("s-1"), Some(&a1)), Ok(1));
        assert_eq!(withdraw_at(&path, &hosted("s-1"), Some(&b1)), Err("pending ask not found".to_string()));
        assert_eq!(withdraw_at(&path, &hosted("s-1"), Some("00000000")), Err("pending ask not found".to_string()));
        assert_eq!(withdraw_at(&path, &Requester::Token("t".into()), None), Err("pending needs a hosted tab".to_string()));
        assert_eq!(withdraw_at(&path, &hosted("s-1"), None), Ok(1));
        let left: Vec<String> = load_at(&path).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(left, vec![b1]);
        assert!(!left.contains(&a2));
        assert_eq!(withdraw_at(&path, &hosted("s-1"), None), Ok(0));
    }

    #[test]
    fn withdraw_keeps_a_claimed_entry() {
        let dir = temp("withdraw-claimed");
        let path = dir.0.join("pending-asks.json");
        let q = json!({ "question": "Which one", "choices": ["a"] });
        let kept = post_at(&path, &hosted("s-9"), &q, 1).unwrap();
        let other = post_at(&path, &hosted("s-9"), &q, 2).unwrap();
        let sha = digest(load_at(&path).unwrap().iter().find(|e| e.id == kept).unwrap());
        claim_at(&path, &kept, &sha).unwrap();
        assert_eq!(withdraw_at(&path, &hosted("s-9"), None), Ok(1));
        let left: Vec<String> = load_at(&path).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(left, vec![kept.clone()]);
        assert!(!left.contains(&other));
        with_claims(|c| c.remove(&kept));
    }

    #[test]
    fn claim_is_exclusive_and_settle_with_a_stale_sha_refuses() {
        let dir = temp("claim");
        let path = dir.0.join("pending-asks.json");
        let id = post_at(&path, &hosted("s-1"), &json!({ "question": "Which one", "choices": ["a"] }), 1).unwrap();
        let sha = digest(&load_at(&path).unwrap()[0]);
        assert!(claim_at(&path, &id, "stale").is_err());
        claim_at(&path, &id, &sha).unwrap();
        assert!(claim_at(&path, &id, &sha).is_err(), "second claim of the same id fails");
        assert!(settle_at(&path, &id, "stale").is_err());
        assert_eq!(load_at(&path).unwrap().len(), 1, "a stale settle removes nothing");
        settle_at(&path, &id, &sha).unwrap();
        assert!(load_at(&path).unwrap().is_empty());
    }
}
