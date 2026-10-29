//! src-tauri\src\bare\vault\store.rs — the single writer of the vaults folder.
//! One process-wide mutex covers create, edit and lock. Lock compares-and-swaps on the hash, is
//! idempotent for the same hash, and copies the resolved rune bodies into `revs/<hash>/` so a locked
//! vault never changes without `EditMode::Variant` or `EditMode::Invalidate`; a later library edit
//! reads as drift (a sha12 compare against `pins`). Bodies are rune files read whole, never rendered.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{content_sha, sha12, vault_hash, Listed, LockedBy, MemberEdit, RuneRef, RunesetCopy, SetSource, Template, Vault, VaultFrom};
use crate::rules::library::Library;
use crate::rules::rune::{self, State};

/// Serializes every vault write in the process (D-d).
static WRITER: Mutex<()> = Mutex::new(());

/// Ids a user name never slugs to: the sessions folder, the launcher pre-pick file, the stock
/// templates and Custom vaults.
const RESERVED: &[&str] = &["sessions", "defaults"];
const RESERVED_PREFIXES: &[&str] = &["stock-", "custom-"];

/// One vault edit. Wire: `{"op":"addRune","ref":{"library":"stock","id":"x"}}`; `member` carries a
/// `MemberEdit`: `{"op":"member","ref":{"library":"kit","runeset":"kit","rune":{..},"on":false}}`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "op", content = "ref", rename_all = "camelCase")]
pub enum Op {
    AddRune(RuneRef),
    RemoveRune(RuneRef),
    AddRuneset(SetSource),
    RemoveRuneset(SetSource),
    Member(MemberEdit),
}

/// Unlocked: edit in place, refused once locked. Variant: a new vault with `from`. Invalidate: rewrite a
/// locked vault in place (its loaded state stays in `revs/<hash>/`) and clear the lock.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EditMode {
    Unlocked,
    Variant,
    Invalidate,
}

/// A rune the vault loads: its library file text, and whether it joined through `<?recall?>` (or is a
/// one-off whose header says `activate: recall`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ResolvedRune {
    pub library: String,
    pub id: String,
    pub body: String,
    pub recall: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Resolved {
    pub runes: Vec<ResolvedRune>,
    pub drift: Vec<RuneRef>,
    pub warnings: Vec<String>,
}

pub struct Store {
    root: PathBuf,
    dir: PathBuf,
}

/// A vault's content before it is written: snapshot copies with their bytes, and one-off refs.
struct Draft {
    sets: Vec<(RunesetCopy, Vec<u8>)>,
    runes: Vec<RuneRef>,
    /// One-offs switched off (`Vault::off`); outside the hash.
    off: Vec<RuneRef>,
    /// Whole runesets switched off (`Vault::off_sets`); outside the hash.
    off_sets: Vec<SetSource>,
}

impl Draft {
    fn hash(&self) -> String {
        let sets: Vec<(SetSource, String)> = self.sets.iter().map(|(c, b)| (c.source.clone(), content_sha(b))).collect();
        vault_hash(&sets, &self.runes)
    }
}

fn now() -> String {
    crate::runlog::utc_stamp()
}

fn writer() -> std::sync::MutexGuard<'static, ()> {
    WRITER.lock().unwrap_or_else(|e| e.into_inner())
}

fn check_hash(hash: &str) -> Result<(), String> {
    if hash.len() == 12 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(())
    } else {
        Err(format!("{hash:?} is not a vault hash (12 lowercase hex)"))
    }
}

/// A user name as a vault id: lowercase letters and digits, single hyphens.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// The id a variant of vault `id` is based on: `id` itself unless it is reserved (`stock-`, `custom-`), then
/// the variant's name slug with any reserved prefix removed ("Stock Claude Variant" -> `claude-variant`),
/// `variant` when nothing is left.
fn variant_base(id: &str, name: &str) -> String {
    if !RESERVED_PREFIXES.iter().any(|p| id.starts_with(p)) {
        return id.to_string();
    }
    let mut s = slug(name);
    while let Some(rest) = RESERVED_PREFIXES.iter().find_map(|p| s.strip_prefix(p)) {
        s = rest.to_string();
    }
    if s.is_empty() || RESERVED.contains(&s.as_str()) {
        "variant".to_string()
    } else {
        s
    }
}

/// The value of `key:` in a rune file's `---` header, if any.
pub(crate) fn header_value(text: &str, key: &str) -> Option<String> {
    let mut lines = text.lines().map(|l| l.trim_end_matches('\r'));
    if lines.next()? != "---" {
        return None;
    }
    for l in lines {
        if l == "---" {
            return None;
        }
        if let Some(v) = l.strip_prefix(key).and_then(|r| r.strip_prefix(':')) {
            return Some(v.trim().to_string());
        }
    }
    None
}

fn is_recall(text: &str) -> bool {
    header_value(text, "activate").as_deref() == Some("recall")
}

/// A copied body in a revision folder: `<rev>\runes\<library>\<id>.md`.
pub(crate) fn rev_body(rev: &Path, lib: &str, id: &str) -> PathBuf {
    rev.join(format!("runes/{lib}/{id}.md"))
}

fn snapshot_file(s: &SetSource) -> String {
    format!("sets/{}--{}.md", s.library, s.set)
}

/// A set line's slot as (library, id): `lib/id` names its library, a bare id is the set's own
/// (`layer::slot_in`, the one slot grammar).
fn slot_ref(line: &str, own: &str) -> Option<(String, String)> {
    crate::bare::layer::slot_in(line, own).map(|(lib, id)| (lib.to_string(), id.to_string()))
}

fn set_body(bytes: &[u8]) -> (String, Vec<String>) {
    let text = String::from_utf8_lossy(bytes).replace('\r', "");
    match rune::parse(&text) {
        Ok(r) => (r.body, r.scope),
        Err(_) => (text, Vec::new()),
    }
}

pub(crate) use super::store_header::{recall_off, slot_off, SLOT_OFF};
use super::store_header::{header_list, with_header_list, with_recall_off};

/// A placed runeset copy's bytes with `m.rune`'s slot line taken out (`on: false`) or put back (`on: true`,
/// after the last slot line, with that line's list prefix; at the end when the copy has none). The bytes
/// are the vault's own `sets/` copy, never the library file. A `<?recall?>` member has no slot line: off
/// adds its id to the copy's `recall-off` header and on takes it out (`recall_member` says whether the
/// rune joins the copy through recall). A slot taken out records its token in the `slot-off` header
/// (`SLOT_OFF`) and on takes it back out. Off refuses a rune that is neither; on is a no-op when slotted.
fn toggle_member(bytes: &[u8], m: &MemberEdit, recall_member: &dyn Fn() -> Result<bool, String>) -> Result<Vec<u8>, String> {
    let r = &m.rune;
    rune::check_id(&r.library).and(rune::check_id(&r.id)).map_err(|e| format!("rune {}: {e}", r.key()))?;
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| format!("runeset {}/{} copy is not UTF-8", m.library, m.runeset))?;
    let own = m.library.as_str();
    let label = format!("{}/{}", m.library, m.runeset);
    let bare = |l: &str| l.trim_end_matches(['\n', '\r']).to_string();
    let is_it = |l: &str| slot_ref(&bare(l), own).is_some_and(|(lib, id)| lib == r.library && id == r.id);
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let has = lines.iter().any(|l| is_it(l));
    let held = recall_off(bytes);
    let recalls = r.library == own && lines.iter().any(|l| bare(l) == "<?recall?>");
    let token = if r.library == own { r.id.clone() } else { r.key() };
    // the copy's switched-off slot tokens, raw, and whether `r` is one of them
    let slot_held = header_list(bytes, SLOT_OFF);
    let slot_is_r = |t: &String| match t.split_once('/') {
        Some((lib, id)) => lib == r.library && id == r.id,
        None => own == r.library && t == &r.id,
    };
    if !m.on {
        if has {
            let out = lines.into_iter().filter(|l| !is_it(l)).collect::<String>().into_bytes();
            // the slot's token goes to `slot-off`, so the view still lists the rune off; a copy without
            // a header (none placed today) just loses the line, as before
            let mut tokens: Vec<String> = slot_held.into_iter().filter(|t| !slot_is_r(t)).collect();
            tokens.push(token);
            return Ok(with_header_list(&out, SLOT_OFF, &tokens, &label).unwrap_or(out));
        }
        if held.contains(&r.id) || slot_held.iter().any(slot_is_r) {
            return Ok(bytes.to_vec());
        }
        if recalls && recall_member()? {
            return with_recall_off(bytes, &[held, vec![r.id.clone()]].concat(), &label);
        }
        return Err(format!("`{}` is neither slotted in runeset {label} nor one of its recall members", r.key()));
    }
    if r.library == own && held.contains(&r.id) {
        let rest: Vec<String> = held.into_iter().filter(|i| i != &r.id).collect();
        return with_recall_off(bytes, &rest, &label);
    }
    let text = if slot_held.iter().any(slot_is_r) {
        let rest: Vec<String> = slot_held.iter().filter(|t| !slot_is_r(t)).cloned().collect();
        String::from_utf8(with_header_list(bytes, SLOT_OFF, &rest, &label)?).map_err(|_| format!("runeset {label} copy is not UTF-8"))?
    } else {
        text
    };
    if has {
        return Ok(text.into_bytes());
    }
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    let last = lines.iter().rposition(|l| slot_ref(&bare(l), own).is_some());
    let (at, prefix) = match last {
        Some(i) => {
            let l = bare(lines[i]);
            (i + 1, l[..l.find("<?rune ").unwrap_or(0)].to_string())
        }
        None => (out.len(), String::new()),
    };
    if at > 0 && !out[at - 1].ends_with('\n') {
        out[at - 1].push_str(eol);
    }
    out.insert(at, format!("{prefix}<?rune {token}?>{eol}"));
    Ok(out.concat().into_bytes())
}

/// A runeset copy that loads nothing: its state is not Active (Disabled, or a Draft). Resolve skips
/// its slots and `<?recall?>` before any member is read, so a later active set still loads them.
fn set_is_off(bytes: &[u8]) -> bool {
    rune::parse(&String::from_utf8_lossy(bytes).replace('\r', "")).is_ok_and(|r| r.state != State::Active)
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    crate::fsx::atomic_write(path, bytes)
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{} is not readable: {e}", path.display()))
}

impl Store {
    pub fn open(root: &Path) -> Store {
        Store { root: root.to_path_buf(), dir: crate::paths::rune_vaults_dir_in(root) }
    }

    fn vault_dir(&self, id: &str) -> Result<PathBuf, String> {
        rune::check_id(id).map_err(|e| format!("vault id {id:?}: {e}"))?;
        if RESERVED.contains(&id) {
            return Err(format!("{id:?} is a reserved name, not a vault"));
        }
        Ok(self.dir.join(id))
    }

    fn rev_dir(&self, id: &str, hash: &str) -> Result<PathBuf, String> {
        check_hash(hash)?;
        Ok(self.vault_dir(id)?.join("revs").join(hash))
    }

    pub fn get(&self, id: &str) -> Result<Vault, String> {
        let path = self.vault_dir(id)?.join("vault.json");
        if !path.is_file() {
            return Err(format!("no vault {id:?}"));
        }
        crate::fsx::read_json(&path)
    }

    fn save_at(&self, path: &Path, v: &Vault) -> Result<(), String> {
        let json = serde_json::to_string_pretty(v).map_err(|e| e.to_string())? + "\n";
        write_file(path, json.as_bytes())
    }

    fn save(&self, v: &Vault) -> Result<(), String> {
        self.save_at(&self.vault_dir(&v.id)?.join("vault.json"), v)
    }

    /// Vaults in the vaults folder by id, then the stock templates.
    pub fn list(&self) -> Result<Vec<Listed>, String> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            let mut ids: Vec<String> = rd.flatten().filter(|e| e.path().join("vault.json").is_file()).filter_map(|e| e.file_name().into_string().ok()).collect();
            ids.sort();
            for id in ids {
                if let Ok(v) = self.get(&id) {
                    out.push(Listed { id: v.id, name: v.name, template: false, hash: v.hash, locked_utc: v.locked_utc });
                }
            }
        }
        if let Ok(rd) = std::fs::read_dir(crate::paths::rune_templates_dir_in(&self.root)) {
            let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
            files.sort();
            for f in files {
                if let Ok(t) = crate::fsx::read_json::<Template>(&f) {
                    out.push(Listed { id: t.id, name: t.name, template: true, hash: String::new(), locked_utc: None });
                }
            }
        }
        Ok(out)
    }

    pub(crate) fn template(&self, id: &str) -> Result<Template, String> {
        rune::check_id(id).map_err(|e| format!("template id {id:?}: {e}"))?;
        crate::fsx::read_json(&crate::paths::rune_templates_dir_in(&self.root).join(format!("{id}.json")))
    }

    /// The vault as it was at `hash`: the vault itself when its hash matches, else `revs/<hash>/vault.json`.
    pub fn load_at(&self, id: &str, hash: &str) -> Result<Vault, String> {
        check_hash(hash)?;
        let v = self.get(id)?;
        if v.hash == hash {
            return Ok(v);
        }
        let path = self.rev_dir(id, hash)?.join("vault.json");
        if !path.is_file() {
            return Err(format!("vault {id:?} has no revision {hash}"));
        }
        crate::fsx::read_json(&path)
    }

    /// A placed runeset's snapshot body (header stripped, CR dropped) and its scope, as resolve reads it
    /// (the spawn renders the set's own lines around its slots).
    pub fn snapshot_body(&self, v: &Vault, c: &RunesetCopy) -> Result<(String, rune::State), String> {
        let dir = self.vault_dir(&v.id)?;
        let bytes = match v.locked_utc {
            Some(_) => read(&self.rev_dir(&v.id, &v.hash)?.join(&c.file)).or_else(|_| read(&dir.join(&c.file)))?,
            None => read(&dir.join(&c.file))?,
        };
        let state = rune::parse(&String::from_utf8_lossy(&bytes).replace('\r', "")).map(|r| r.state).unwrap_or(rune::State::Active);
        Ok((set_body(&bytes).0, state))
    }

    // ---- libraries (runes stored once; resolved where they live today by `layer::library_dir_named`) ----

    pub(crate) fn library(&self, name: &str) -> Result<Library, String> {
        Library::open(&crate::bare::layer::library_dir_named(&self.root, name)?)
    }

    /// Whether `id` joins a copy of library `own` with `scope` through `<?recall?>`, as resolve takes it:
    /// active, `activate: recall`, scope met, not tombstoned.
    pub(crate) fn is_recall_member(&self, own: &str, id: &str, scope: &[String]) -> Result<bool, String> {
        let lib = self.library(own)?;
        Ok(lib.tombstone(id).is_none()
            && lib.all_runes().0.iter().any(|(r, _)| r.id == id && r.activate == "recall" && r.state == State::Active && r.meets(scope)))
    }

    /// The stock vault for template `id` (`stock-claude`, `stock-codex`), vault id = template id; written
    /// from the template only when absent. Edits to this vault use `edit`'s variant/original choice.
    pub fn ensure_stock(&self, id: &str) -> Result<Vault, String> {
        if !id.starts_with("stock-") {
            return Err(format!("{id:?} is not a stock vault"));
        }
        let _w = writer();
        if let Ok(v) = self.get(id) {
            return Ok(v);
        }
        if self.vault_dir(id)?.exists() {
            return Err(format!("stock vault {id:?} exists but is unreadable"));
        }
        let t = self.template(id)?;
        let d = self.draft_from(&t.runesets, &t.runes)?;
        self.write(id, &t.name, now(), Some(VaultFrom::Template { template: t.id }), d)
    }

    /// The file for `id` in `lib`: the library's own kind folders, else any sub-folder (item kinds the
    /// library index does not list yet); canonical and inside the library root.
    fn locate(lib: &Library, id: &str) -> Result<Option<PathBuf>, String> {
        if lib.tombstone(id).is_some() {
            return Ok(None);
        }
        if let Some(e) = lib.entry(id)? {
            return Ok(Some(e.path));
        }
        fn walk(dir: &Path, name: &str, out: &mut Vec<PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                let hidden = e.file_name().to_string_lossy().starts_with('.');
                if e.file_type().is_ok_and(|t| t.is_dir()) && !hidden {
                    walk(&p, name, out);
                } else if p.file_name().is_some_and(|n| n == name) {
                    out.push(p);
                }
            }
        }
        let mut hits = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&lib.root) {
            for e in rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with('.')) {
                walk(&e.path(), &format!("{id}.md"), &mut hits);
            }
        }
        match hits.len() {
            0 => Ok(None),
            1 => {
                let canon = hits[0].canonicalize().map_err(|e| e.to_string())?;
                if canon.starts_with(&lib.root) { Ok(Some(canon)) } else { Err(format!("`{id}` content path leaves the library")) }
            }
            _ => Err(format!("`{id}` exists more than once in the library")),
        }
    }

    fn snapshot(&self, s: &SetSource) -> Result<(RunesetCopy, Vec<u8>), String> {
        rune::check_id(&s.set).map_err(|e| format!("set {:?}: {e}", s.set))?;
        let lib = self.library(&s.library)?;
        if lib.tombstone(&s.set).is_some() {
            return Err(format!("`{}/{}` is tombstoned", s.library, s.set));
        }
        let entry = lib.entry(&s.set)?.ok_or_else(|| format!("library {:?} has no set {:?}", s.library, s.set))?;
        if entry.kind != "set" {
            return Err(format!("`{}/{}` is a {}, not a runeset", s.library, s.set, entry.kind));
        }
        let bytes = read(&entry.path)?;
        let copy = RunesetCopy { file: snapshot_file(s), source: s.clone(), copied_utc: now(), source_hash: content_sha(&bytes) };
        Ok((copy, bytes))
    }

    // ---- drafts ----

    /// The draft of a stored vault state; snapshot bytes from `dir` (the vault folder or a revision).
    fn draft_of(&self, dir: &Path, v: &Vault) -> Result<Draft, String> {
        let mut sets = Vec::new();
        for c in &v.runesets {
            sets.push((c.clone(), read(&dir.join(&c.file))?));
        }
        Ok(Draft { sets, runes: v.runes.clone(), off: v.off.clone(), off_sets: v.off_sets.clone() })
    }

    fn state_dir(&self, v: &Vault, hash: &str) -> Result<PathBuf, String> {
        let current = self.get(&v.id)?;
        if current.hash == hash { self.vault_dir(&v.id) } else { self.rev_dir(&v.id, hash) }
    }

    fn apply(&self, d: &mut Draft, ops: &[Op]) -> Result<(), String> {
        for op in ops {
            match op {
                Op::AddRune(r) => {
                    rune::check_id(&r.library).and(rune::check_id(&r.id)).map_err(|e| format!("rune {}: {e}", r.key()))?;
                    if !d.runes.contains(r) {
                        d.runes.push(r.clone());
                    }
                    d.off.retain(|x| x != r);
                }
                Op::RemoveRune(r) => {
                    let i = d.runes.iter().position(|x| x == r).ok_or_else(|| format!("rune {} is not in the vault", r.key()))?;
                    d.runes.remove(i);
                    // switched off, not forgotten: the view still lists it off (Vault::off)
                    if !d.off.contains(r) {
                        d.off.push(r.clone());
                    }
                }
                Op::AddRuneset(s) => {
                    if !d.sets.iter().any(|(c, _)| &c.source == s) {
                        d.sets.push(self.snapshot(s)?);
                    }
                    d.off_sets.retain(|x| x != s);
                }
                Op::RemoveRuneset(s) => {
                    let i = d.sets.iter().position(|(c, _)| &c.source == s).ok_or_else(|| format!("runeset {}/{} is not in the vault", s.library, s.set))?;
                    d.sets.remove(i);
                    // switched off, not forgotten: the view still lists its runes off (Vault::off_sets)
                    if !d.off_sets.contains(s) {
                        d.off_sets.push(s.clone());
                    }
                }
                Op::Member(m) => {
                    let (_, bytes) = d
                        .sets
                        .iter_mut()
                        .find(|(c, _)| c.source.library == m.library && c.source.set == m.runeset)
                        .ok_or_else(|| format!("runeset {}/{} is not in the vault", m.library, m.runeset))?;
                    let scope = set_body(bytes).1;
                    let member = || self.is_recall_member(&m.library, &m.rune.id, &scope);
                    *bytes = toggle_member(bytes, m, &member)?;
                }
            }
        }
        Ok(())
    }

    fn draft_from(&self, runesets: &[SetSource], runes: &[RuneRef]) -> Result<Draft, String> {
        let mut d = Draft { sets: Vec::new(), runes: Vec::new(), off: Vec::new(), off_sets: Vec::new() };
        let ops: Vec<Op> = runesets.iter().cloned().map(Op::AddRuneset).chain(runes.iter().cloned().map(Op::AddRune)).collect();
        self.apply(&mut d, &ops)?;
        Ok(d)
    }

    /// Writes `d` as vault `id` (snapshots, stale snapshot files removed, then `vault.json`).
    fn write(&self, id: &str, name: &str, created_utc: String, from: Option<VaultFrom>, d: Draft) -> Result<Vault, String> {
        let dir = self.vault_dir(id)?;
        let hash = d.hash();
        let keep: HashSet<String> = d.sets.iter().map(|(c, _)| c.file.clone()).collect();
        for (c, bytes) in &d.sets {
            write_file(&dir.join(&c.file), bytes)?;
        }
        if let Ok(rd) = std::fs::read_dir(dir.join("sets")) {
            for e in rd.flatten() {
                let rel = format!("sets/{}", e.file_name().to_string_lossy());
                if !keep.contains(&rel) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let v = Vault {
            version: 1,
            id: id.to_string(),
            name: name.to_string(),
            created_utc,
            from,
            runesets: d.sets.into_iter().map(|(c, _)| c).collect(),
            runes: d.runes,
            locked_utc: None,
            locked_by: None,
            hash,
            pins: BTreeMap::new(),
            off: d.off,
            off_sets: d.off_sets,
        };
        self.save(&v)?;
        Ok(v)
    }

    /// `base`, or `base-2`, `base-3`, … whichever has no folder yet.
    fn free_id(&self, base: &str) -> Result<String, String> {
        for n in 1..1000 {
            let id = if n == 1 { base.to_string() } else { format!("{base}-{n}") };
            if !self.vault_dir(&id)?.exists() {
                return Ok(id);
            }
        }
        Err(format!("no free vault id for {base:?}"))
    }

    // ---- create, edit, lock ----

    /// A named vault: from a template, a vault at a hash, or nothing, plus `runesets` (copied now) and one-off runes.
    pub fn create(&self, name: &str, from: Option<VaultFrom>, runesets: &[SetSource], runes: &[RuneRef]) -> Result<Vault, String> {
        let base = slug(name);
        if base.is_empty() {
            return Err(format!("vault name {name:?} has no letters or digits"));
        }
        if RESERVED.contains(&base.as_str()) || RESERVED_PREFIXES.iter().any(|p| base.starts_with(p)) {
            return Err(format!("vault name {name:?} takes a reserved id ({base})"));
        }
        let _w = writer();
        let mut d = match &from {
            None => Draft { sets: Vec::new(), runes: Vec::new(), off: Vec::new(), off_sets: Vec::new() },
            Some(VaultFrom::Template { template }) => {
                let t = self.template(template)?;
                self.draft_from(&t.runesets, &t.runes)?
            }
            Some(VaultFrom::Vault { vault, hash }) => {
                let v = self.load_at(vault, hash)?;
                self.draft_of(&self.state_dir(&v, hash)?, &v)?
            }
        };
        let ops: Vec<Op> = runesets.iter().cloned().map(Op::AddRuneset).chain(runes.iter().cloned().map(Op::AddRune)).collect();
        self.apply(&mut d, &ops)?;
        let id = self.free_id(&base)?;
        self.write(&id, name.trim(), now(), from, d)
    }

    /// A Custom vault, `custom-<content hash6>`; an identical pick (same snapshots, same runes) reuses it (D-i, D-g).
    pub fn create_custom(&self, runesets: &[SetSource], runes: &[RuneRef]) -> Result<Vault, String> {
        let _w = writer();
        let d = self.draft_from(runesets, runes)?;
        let hash = d.hash();
        for at in 0..=6 {
            let id = format!("custom-{}", &hash[at..at + 6]);
            match self.get(&id) {
                Ok(v) if v.hash == hash => return Ok(v),
                Ok(_) => continue,
                Err(_) => return self.write(&id, "Custom", now(), None, d),
            }
        }
        Err("no free Custom vault id".into())
    }

    /// Edits vault `id`. A locked vault refuses `Unlocked`; `Variant` writes a new vault whose `from` names
    /// this one at its hash; `Invalidate` keeps the loaded state in `revs/<hash>/` and rewrites in place.
    pub fn edit(&self, id: &str, ops: &[Op], mode: EditMode) -> Result<Vault, String> {
        let _w = writer();
        let v = self.get(id)?;
        let dir = self.vault_dir(id)?;
        let locked = v.locked_utc.is_some();
        let mut d = self.draft_of(&dir, &v)?;
        self.apply(&mut d, ops)?;
        match mode {
            EditMode::Unlocked if locked => Err(format!(
                "vault {id:?} is locked; make a variant or edit the original (earlier sessions on it become invalid)"
            )),
            EditMode::Variant => {
                let name = format!("{} Variant", v.name);
                let new_id = self.free_id(&variant_base(id, &name))?;
                let from = Some(VaultFrom::Vault { vault: v.id.clone(), hash: v.hash.clone() });
                self.write(&new_id, &name, now(), from, d)
            }
            EditMode::Unlocked | EditMode::Invalidate => {
                if locked {
                    self.keep_rev_state(&v)?;
                }
                self.write(id, &v.name, v.created_utc.clone(), v.from.clone(), d)
            }
        }
    }

    /// A library rune (`rune` is its id) or a whole library (`None`) is gone: drops it from every vault's off
    /// bookkeeping, locked or not (`Vault::off`, `Vault::off_sets`, each copy's `slot-off` header). A locked
    /// vault keeps its loaded text (`revs/`, its runes and copies); an unlocked one's hash follows its copies.
    /// Returns the names of the vaults that changed.
    pub fn prune_off(&self, library: &str, rune: Option<&str>) -> Result<Vec<String>, String> {
        let _w = writer();
        let hit = |lib: &str, id: &str| lib == library && rune.map_or(true, |r| r == id);
        let mut changed = Vec::new();
        for listed in self.list()?.into_iter().filter(|l| !l.template) {
            let Ok(mut v) = self.get(&listed.id) else { continue };
            let dir = self.vault_dir(&v.id)?;
            let before = (v.off.len(), v.off_sets.len());
            v.off.retain(|r| !hit(&r.library, &r.id));
            v.off_sets.retain(|s| !hit(&s.library, &s.set));
            let mut dirty = before != (v.off.len(), v.off_sets.len());
            let mut copies = false;
            for c in &v.runesets {
                let path = dir.join(&c.file);
                let Ok(bytes) = read(&path) else { continue };
                let own = c.source.library.as_str();
                let held = header_list(&bytes, SLOT_OFF);
                let kept: Vec<String> = held
                    .iter()
                    .filter(|t| {
                        let (l, i) = t.split_once('/').unwrap_or((own, t.as_str()));
                        !hit(l, i)
                    })
                    .cloned()
                    .collect();
                if kept.len() != held.len() {
                    write_file(&path, &with_header_list(&bytes, SLOT_OFF, &kept, &c.source.set)?)?;
                    dirty = true;
                    copies = true;
                }
            }
            if copies && v.locked_utc.is_none() {
                v.hash = self.draft_of(&dir, &v)?.hash();
            }
            if dirty {
                self.save(&v)?;
                changed.push(v.name.clone());
            }
        }
        Ok(changed)
    }

    /// Locks vault `id` at `expect_hash` (the hash the session loaded). Same hash on a locked vault: the
    /// first lock stands. Any other hash refuses. Copies the resolved bodies into `revs/<hash>/` (D-e).
    pub fn lock(&self, id: &str, by: LockedBy, expect_hash: &str) -> Result<Vault, String> {
        let _w = writer();
        let mut v = self.get(id)?;
        if v.hash != expect_hash {
            return Err(format!("vault {id:?} is at hash {} but the session loaded hash {expect_hash}; lock refused", v.hash));
        }
        if v.locked_utc.is_some() {
            return Ok(v);
        }
        let resolved = self.resolve_unlocked(&v)?;
        let rev = self.rev_dir(id, &v.hash)?;
        let mut pins = BTreeMap::new();
        for r in &resolved.runes {
            let body = read(&rev_body(&rev, &r.library, &r.id))?;
            pins.insert(format!("{}/{}", r.library, r.id), sha12(&body));
        }
        v.locked_utc = Some(now());
        v.locked_by = Some(by);
        v.pins = pins;
        self.save(&v)?;
        self.save_at(&rev.join("vault.json"), &v)?;
        Ok(v)
    }

    // ---- revisions ----

    /// Writes `revs/<hash>/` for vault `id` where absent: each body at `runes/<library>/<id>.md`, and, when
    /// the vault is at `hash` now, its snapshots and `vault.json`. Spawn (via `resolve`) and lock call it.
    pub fn write_rev(&self, id: &str, hash: &str, bodies: &[ResolvedRune]) -> Result<(), String> {
        let rev = self.rev_dir(id, hash)?;
        for b in bodies {
            rune::check_id(&b.library).and(rune::check_id(&b.id)).map_err(|e| format!("rune {}/{}: {e}", b.library, b.id))?;
            let path = rev_body(&rev, &b.library, &b.id);
            if !path.is_file() {
                write_file(&path, b.body.as_bytes())?;
            }
        }
        let v = self.get(id)?;
        if v.hash == hash {
            self.keep_rev_state(&v)?;
        }
        Ok(())
    }

    /// Copies the vault's snapshots and `vault.json` into `revs/<hash>/` where absent.
    fn keep_rev_state(&self, v: &Vault) -> Result<(), String> {
        let (dir, rev) = (self.vault_dir(&v.id)?, self.rev_dir(&v.id, &v.hash)?);
        for c in &v.runesets {
            let to = rev.join(&c.file);
            if !to.is_file() {
                write_file(&to, &read(&dir.join(&c.file))?)?;
            }
        }
        if !rev.join("vault.json").is_file() {
            self.save_at(&rev.join("vault.json"), v)?;
        }
        Ok(())
    }

    // ---- resolve and drift ----

    /// The runes vault `id` loads, in order: each runeset's slots and `<?recall?>` members, then the
    /// one-offs. Unlocked reads the libraries (and writes `revs/<hash>/` if absent); locked reads only
    /// `revs/<hash>/` and the pins, and reports drift.
    pub fn resolve(&self, id: &str) -> Result<Resolved, String> {
        let v = self.get(id)?;
        if v.locked_utc.is_some() {
            let mut r = self.resolve_locked(&v)?;
            r.drift = self.drift_of(&v)?;
            Ok(r)
        } else {
            self.resolve_unlocked(&v)
        }
    }

    fn resolve_unlocked(&self, v: &Vault) -> Result<Resolved, String> {
        let dir = self.vault_dir(&v.id)?;
        let mut libs: HashMap<String, Result<Library, String>> = HashMap::new();
        let mut body_of = |lib: &str, id: &str| -> Result<Option<String>, String> {
            let l = libs.entry(lib.to_string()).or_insert_with(|| self.library(lib));
            let l = l.as_ref().map_err(Clone::clone)?;
            match Self::locate(l, id)? {
                Some(p) => Ok(Some(String::from_utf8_lossy(&read(&p)?).into_owned())),
                None => Ok(None),
            }
        };
        let (mut out, mut seen, mut warnings) = (Vec::new(), HashSet::new(), Vec::new());
        for c in &v.runesets {
            let bytes = read(&dir.join(&c.file))?;
            if set_is_off(&bytes) {
                continue;
            }
            let (body, scope) = set_body(&bytes);
            let own = c.source.library.as_str();
            let off = recall_off(&bytes);
            for line in body.lines() {
                if line == "<?recall?>" {
                    let lib = match self.library(own) {
                        Ok(l) => l,
                        Err(e) => {
                            warnings.push(e);
                            continue;
                        }
                    };
                    let mut members: Vec<(rune::Rune, PathBuf)> = lib
                        .all_runes()
                        .0
                        .into_iter()
                        .filter(|(r, _)| r.activate == "recall" && r.state == State::Active && r.meets(&scope) && lib.tombstone(&r.id).is_none() && !off.contains(&r.id))
                        .collect();
                    members.sort_by(|a, b| a.0.id.cmp(&b.0.id));
                    for (r, path) in members {
                        if seen.insert(format!("{own}/{}", r.id)) {
                            let body = String::from_utf8_lossy(&read(&path)?).into_owned();
                            out.push(ResolvedRune { library: own.to_string(), id: r.id, body, recall: true });
                        }
                    }
                } else if let Some((lib, id)) = slot_ref(line, own) {
                    if seen.contains(&format!("{lib}/{id}")) {
                        continue;
                    }
                    match body_of(&lib, &id) {
                        Ok(Some(body)) => {
                            seen.insert(format!("{lib}/{id}"));
                            out.push(ResolvedRune { library: lib, id, body, recall: false });
                        }
                        Ok(None) => warnings.push(format!("`{lib}/{id}` slotted in runeset {}/{} is not in its library; skipped", own, c.source.set)),
                        Err(e) => warnings.push(format!("`{lib}/{id}`: {e}; skipped")),
                    }
                }
            }
        }
        for r in &v.runes {
            if !seen.insert(r.key()) {
                continue;
            }
            match body_of(&r.library, &r.id) {
                Ok(Some(body)) => out.push(ResolvedRune { library: r.library.clone(), id: r.id.clone(), recall: is_recall(&body), body }),
                Ok(None) => warnings.push(format!("rune {} is not in its library; skipped", r.key())),
                Err(e) => warnings.push(format!("rune {}: {e}; skipped", r.key())),
            }
        }
        self.write_rev(&v.id, &v.hash, &out)?;
        Ok(Resolved { runes: out, drift: Vec::new(), warnings })
    }

    fn resolve_locked(&self, v: &Vault) -> Result<Resolved, String> {
        let (dir, rev) = (self.vault_dir(&v.id)?, self.rev_dir(&v.id, &v.hash)?);
        let body_at = |lib: &str, id: &str| -> Option<String> {
            if rune::check_id(lib).is_err() || rune::check_id(id).is_err() || !v.pins.contains_key(&format!("{lib}/{id}")) {
                return None;
            }
            std::fs::read(rev_body(&rev, lib, id)).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
        };
        let (mut out, mut seen, mut warnings) = (Vec::new(), HashSet::new(), Vec::new());
        for c in &v.runesets {
            let bytes = read(&rev.join(&c.file)).or_else(|_| read(&dir.join(&c.file)))?;
            if set_is_off(&bytes) {
                continue;
            }
            let (body, _) = set_body(&bytes);
            let own = c.source.library.as_str();
            let off = recall_off(&bytes);
            let slotted: HashSet<String> = body.lines().filter_map(|l| slot_ref(l, own)).map(|(l, i)| format!("{l}/{i}")).collect();
            for line in body.lines() {
                if line == "<?recall?>" {
                    for key in v.pins.keys() {
                        let Some((lib, id)) = key.split_once('/') else { continue };
                        if lib != own || slotted.contains(key) || seen.contains(key) || off.iter().any(|o| o == id) {
                            continue;
                        }
                        if let Some(body) = body_at(lib, id).filter(|b| is_recall(b)) {
                            seen.insert(key.clone());
                            out.push(ResolvedRune { library: lib.to_string(), id: id.to_string(), body, recall: true });
                        }
                    }
                } else if let Some((lib, id)) = slot_ref(line, own) {
                    let key = format!("{lib}/{id}");
                    if seen.contains(&key) {
                        continue;
                    }
                    match body_at(&lib, &id) {
                        Some(body) => {
                            seen.insert(key);
                            out.push(ResolvedRune { library: lib, id, body, recall: false });
                        }
                        None => warnings.push(format!("`{key}` has no copied body in revision {}; skipped", v.hash)),
                    }
                }
            }
        }
        for r in &v.runes {
            if !seen.insert(r.key()) {
                continue;
            }
            match body_at(&r.library, &r.id) {
                Some(body) => out.push(ResolvedRune { library: r.library.clone(), id: r.id.clone(), recall: is_recall(&body), body }),
                None => warnings.push(format!("rune {} has no copied body in revision {}; skipped", r.key(), v.hash)),
            }
        }
        Ok(Resolved { runes: out, drift: Vec::new(), warnings })
    }

    /// Pinned runes of a locked vault whose library body now differs (or is gone); empty when unlocked.
    pub fn drift(&self, id: &str) -> Result<Vec<RuneRef>, String> {
        self.drift_of(&self.get(id)?)
    }

    fn drift_of(&self, v: &Vault) -> Result<Vec<RuneRef>, String> {
        let mut libs: HashMap<String, Option<Library>> = HashMap::new();
        let mut out = Vec::new();
        for (key, pin) in &v.pins {
            let Some((lib, id)) = key.split_once('/') else { continue };
            let l = libs.entry(lib.to_string()).or_insert_with(|| self.library(lib).ok());
            let now = l.as_ref().and_then(|l| Self::locate(l, id).ok().flatten()).and_then(|p| std::fs::read(p).ok()).map(|b| sha12(&b));
            if now.as_deref() != Some(pin.as_str()) {
                out.push(RuneRef { library: lib.to_string(), id: id.to_string() });
            }
        }
        Ok(out)
    }
}

// ---- the Runes View read ----

/// A text kind's body may show; an item kind's never does (its view is `rune_items` redacted).
const TEXT_KINDS: &[&str] = &["rule", "fact", "procedure", "set"];

impl Store {
    /// Drift of `v` as read (a session's earlier revision carries its own pins); empty unless locked.
    pub fn view_drift(&self, v: &Vault) -> Result<Vec<RuneRef>, String> {
        if v.locked_utc.is_none() {
            return Ok(Vec::new());
        }
        self.drift_of(v)
    }

    /// The runes `v` loads, as the Runes View draws them: each runeset's slots in order, its
    /// `<?recall?>` members after them (sorted by id), then the one-offs, each once. `from_rev` reads the
    /// bodies and snapshots copied into `revs/<hash>/` (a locked vault, or a session's earlier
    /// revision); otherwise the libraries. Writes nothing. Item runes come back redacted; a missing copy
    /// or a file that does not parse is left out with a warning that names only its ref. The third list is
    /// what the vault holds switched off (never loaded), so Modify can draw them off: a copy's
    /// `recall-off` and `slot-off` members, then `Vault::off`; a body missing from the revision is read
    /// from its library.
    #[allow(clippy::type_complexity)]
    pub fn view_runes(&self, v: &Vault, from_rev: bool, drift: &[RuneRef]) -> Result<(Vec<super::ViewRune>, Vec<String>, Vec<super::ViewRune>), String> {
        let (dir, rev) = (self.vault_dir(&v.id)?, self.rev_dir(&v.id, &v.hash)?);
        let rev = from_rev.then_some(rev.as_path());
        let drifted: HashSet<String> = drift.iter().map(RuneRef::key).collect();
        let mut libs: HashMap<String, Option<Library>> = HashMap::new();
        let mut sections: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();
        let (mut out, mut seen, mut warnings, mut off) = (Vec::new(), HashSet::new(), Vec::new(), Vec::new());
        let mut push = |set: Option<&SetSource>, lib: &str, id: &str, text: Option<String>, recall: bool, libs: &mut HashMap<String, Option<Library>>, out: &mut Vec<super::ViewRune>, warnings: &mut Vec<String>| {
            let Some(text) = text else {
                warnings.push(format!("rune {lib}/{id} has no readable copy; left out"));
                return;
            };
            let section = sections.entry(lib.to_string()).or_insert_with(|| import_sections(libs.entry(lib.to_string()).or_insert_with(|| self.library(lib).ok()).as_ref())).get(id).cloned().unwrap_or_default();
            match view_rune(set, lib, id, &text, recall, section, drifted.contains(&format!("{lib}/{id}"))) {
                Some(r) => out.push(r),
                None => warnings.push(format!("rune {lib}/{id} does not parse; left out")),
            }
        };
        for c in &v.runesets {
            let bytes = match rev {
                Some(r) => read(&r.join(&c.file)).or_else(|_| read(&dir.join(&c.file)))?,
                None => read(&dir.join(&c.file))?,
            };
            let (body, scope) = set_body(&bytes);
            let own = c.source.library.as_str();
            let slotted: Vec<(String, String)> = body.lines().filter_map(|l| slot_ref(l, own)).collect();
            for (lib, id) in &slotted {
                if seen.insert(format!("{lib}/{id}")) {
                    let text = self.view_body(&mut libs, rev, lib, id);
                    push(Some(&c.source), lib, id, text, false, &mut libs, &mut out, &mut warnings);
                }
            }
            if body.lines().any(|l| l == "<?recall?>") {
                let held = recall_off(&bytes);
                for (id, text) in self.view_recall(&mut libs, rev, v, own, &scope) {
                    if !held.contains(&id) && seen.insert(format!("{own}/{id}")) {
                        push(Some(&c.source), own, &id, Some(text), true, &mut libs, &mut out, &mut warnings);
                    }
                }
                for id in &held {
                    let text = self.view_body(&mut libs, rev, own, id).or_else(|| self.view_body(&mut libs, None, own, id));
                    push(Some(&c.source), own, id, text, true, &mut libs, &mut off, &mut warnings);
                }
            }
            // slot members the copy switched off; one whose library rune is gone (Delete Rune) drops quietly
            for (lib, id) in slot_off(&bytes, own) {
                if slotted.iter().any(|(l, i)| l == &lib && i == &id) {
                    continue;
                }
                if let Some(text) = self.view_body(&mut libs, rev, &lib, &id).or_else(|| self.view_body(&mut libs, None, &lib, &id)) {
                    push(Some(&c.source), &lib, &id, Some(text), false, &mut libs, &mut off, &mut warnings);
                }
            }
        }
        for r in &v.runes {
            if seen.insert(r.key()) {
                let text = self.view_body(&mut libs, rev, &r.library, &r.id);
                push(None, &r.library, &r.id, text, false, &mut libs, &mut out, &mut warnings);
            }
        }
        // one-offs switched off (Vault::off): listed off, never loaded; a rune gone from its library drops quietly
        for r in &v.off {
            if v.runes.contains(r) {
                continue;
            }
            if let Some(text) = self.view_body(&mut libs, rev, &r.library, &r.id).or_else(|| self.view_body(&mut libs, None, &r.library, &r.id)) {
                push(None, &r.library, &r.id, Some(text), false, &mut libs, &mut off, &mut warnings);
            }
        }
        // runesets switched off whole (Vault::off_sets): the library runeset's runes listed off under its head;
        // one gone from its library, or placed again, drops quietly
        for s in &v.off_sets {
            if v.runesets.iter().any(|c| &c.source == s) {
                continue;
            }
            let Ok((_, bytes)) = self.snapshot(s) else { continue };
            let (body, scope) = set_body(&bytes);
            let own = s.library.as_str();
            for (lib, id) in body.lines().filter_map(|l| slot_ref(l, own)) {
                if let Some(text) = self.view_body(&mut libs, None, &lib, &id) {
                    push(Some(s), &lib, &id, Some(text), false, &mut libs, &mut off, &mut warnings);
                }
            }
            if body.lines().any(|l| l == "<?recall?>") {
                for (id, text) in self.view_recall(&mut libs, None, v, own, &scope) {
                    push(Some(s), own, &id, Some(text), true, &mut libs, &mut off, &mut warnings);
                }
            }
        }
        Ok((out, warnings, off))
    }

    /// A rune file's text: the revision's copy when `rev` is set, else the library's file.
    fn view_body(&self, libs: &mut HashMap<String, Option<Library>>, rev: Option<&Path>, lib: &str, id: &str) -> Option<String> {
        if rune::check_id(lib).is_err() || rune::check_id(id).is_err() {
            return None;
        }
        let path = match rev {
            Some(r) => rev_body(r, lib, id),
            None => Self::locate(libs.entry(lib.to_string()).or_insert_with(|| self.library(lib).ok()).as_ref()?, id).ok().flatten()?,
        };
        std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
    }

    /// The `<?recall?>` members of library `own` not slotted elsewhere, sorted by id. From a revision:
    /// the copies under `runes/<own>/` (a locked vault's pinned ones only). Else, as `resolve` takes them:
    /// active recall runes whose scope meets the set's, tombstones out.
    fn view_recall(&self, libs: &mut HashMap<String, Option<Library>>, rev: Option<&Path>, v: &Vault, own: &str, scope: &[String]) -> Vec<(String, String)> {
        let mut found: Vec<(String, String)> = Vec::new();
        if let Some(r) = rev {
            let Ok(rd) = std::fs::read_dir(r.join(format!("runes/{own}"))) else { return found };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let Some(id) = name.strip_suffix(".md") else { continue };
                if v.locked_utc.is_some() && !v.pins.contains_key(&format!("{own}/{id}")) {
                    continue;
                }
                if let Ok(b) = std::fs::read(e.path()) {
                    let text = String::from_utf8_lossy(&b).into_owned();
                    if is_recall(&text) {
                        found.push((id.to_string(), text));
                    }
                }
            }
        } else if let Some(lib) = libs.entry(own.to_string()).or_insert_with(|| self.library(own).ok()).as_ref() {
            for (r, path) in lib.all_runes().0 {
                if r.activate == "recall" && r.state == State::Active && r.meets(scope) && lib.tombstone(&r.id).is_none() {
                    if let Ok(b) = std::fs::read(&path) {
                        found.push((r.id, String::from_utf8_lossy(&b).into_owned()));
                    }
                }
            }
        }
        found.sort_by(|a, b| a.0.cmp(&b.0));
        found
    }

    /// The library names a vault can use (`layer::library_dir_named`): `stock`, each folder under the
    /// imports folder (the overrides folder excepted), then the rules library by its folder name.
    pub(crate) fn library_names(&self) -> Vec<String> {
        let mut names = vec!["stock".to_string()];
        let (imports, overrides) = (crate::paths::rune_imports_dir_in(&self.root), crate::paths::legacy_rune_overrides_dir_in(&self.root));
        if let Ok(rd) = std::fs::read_dir(&imports) {
            let mut dirs: Vec<String> = rd
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && e.path() != overrides)
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| !n.starts_with('.') && rune::check_id(n).is_ok())
                .collect();
            dirs.sort();
            names.extend(dirs);
        }
        let mut ignored = Vec::new();
        if let Some(rel) = crate::bare::set_loadout::rules_library(&crate::paths::config_path_in(&self.root), &mut ignored) {
            names.push(crate::bare::layer::library_name(&rel));
        }
        let mut seen = HashSet::new();
        names.retain(|n| seen.insert(n.clone()));
        names
    }

    /// Every active, untombstoned rune (sets excluded) in the libraries a vault can use, for the Add Rune
    /// picker: runes marked for another agent are left out, item kinds
    /// come back redacted (`view_rune`), and a library that does not open is a warning. Writes nothing.
    pub fn library_runes(&self, agent: &str) -> (Vec<super::ViewRune>, Vec<String>) {
        let (mut out, mut warnings) = (Vec::new(), Vec::new());
        for name in self.library_names() {
            let lib = match self.library(&name) {
                Ok(l) => l,
                Err(e) => {
                    warnings.push(e);
                    continue;
                }
            };
            let sections = import_sections(Some(&lib));
            for (r, path) in lib.all_runes().0 {
                if r.kind == "set" || r.state != State::Active || lib.tombstone(&r.id).is_some() || r.agent.as_deref().is_some_and(|a| a != agent) {
                    continue;
                }
                let Ok(bytes) = std::fs::read(&path) else { continue };
                let section = sections.get(&r.id).cloned().unwrap_or_default();
                match view_rune(None, &name, &r.id, &String::from_utf8_lossy(&bytes), r.activate == "recall", section, false) {
                    Some(v) => out.push(v),
                    None => warnings.push(format!("rune {name}/{} does not parse; left out", r.id)),
                }
            }
        }
        (out, warnings)
    }
}

/// Rune id -> heading path from a library's `import.json` `bricks` (absent file: none).
fn import_sections(lib: Option<&Library>) -> HashMap<String, Vec<String>> {
    let Some(lib) = lib else { return HashMap::new() };
    let Ok(json) = crate::fsx::read_json::<serde_json::Value>(&lib.root.join("import.json")) else { return HashMap::new() };
    let mut out = HashMap::new();
    for b in json.get("bricks").and_then(|b| b.as_array()).into_iter().flatten() {
        if let Some(id) = b.get("id").and_then(|i| i.as_str()) {
            let section = b.get("section").and_then(|s| s.as_array()).map(|s| s.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
            out.insert(id.to_string(), section);
        }
    }
    out
}

/// One view row; `None` when the text does not parse. An item kind's body is never sent (D-k).
fn view_rune(set: Option<&SetSource>, lib: &str, id: &str, text: &str, recall: bool, section: Vec<String>, drift: bool) -> Option<super::ViewRune> {
    let r = rune::parse(&text.replace('\r', "")).ok()?;
    let text_kind = TEXT_KINDS.contains(&r.kind.as_str());
    let item = if text_kind { None } else { Some(crate::bare::rune_items::redacted_rune(&r)?) };
    Some(super::ViewRune {
        set: set.cloned(),
        library: lib.to_string(),
        id: id.to_string(),
        body: if text_kind { r.body.trim_matches('\n').to_string() } else { String::new() },
        kind: r.kind,
        activate: r.activate,
        description: r.description,
        section,
        recall,
        origin: r.origin,
        closes_when: r.closes_when,
        why: r.why,
        example: r.example,
        paths: r.paths,
        item,
        drift,
    })
}
