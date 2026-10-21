//! src-tauri\src\voice_slots\manifest.rs — the slot contract (`contracts\voice-slots.json`), the
//! `packs\<id>\pack.json` and `voice\<adapter>.json` parse and validation, and the pack scan.
//! Pure over the directory it is handed: no pins, no probes. A folder or manifest that fails
//! any rule becomes a `Broken` row naming the file; it is never skipped (plan §2).

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Slot;

const CONTRACT_JSON: &str = include_str!("../../../contracts/voice-slots.json");
pub const STOCK_PACK: &str = "voice-stock";
const PACK_JSON_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
pub struct SlotSpec {
    pub required: bool,
    pub tokens: Vec<String>,
}

#[derive(Deserialize)]
pub struct Lifecycle {
    pub tokens: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub manifest_bytes: u64,
    pub id_chars: usize,
    pub label_chars: usize,
    pub args: usize,
    pub arg_chars: usize,
    pub models: usize,
    pub files: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub slots: BTreeMap<String, SlotSpec>,
    pub lifecycle: Lifecycle,
    pub roots: Vec<String>,
    pub fill_tokens: Vec<String>,
    pub limits: Limits,
}

/// The compiled-in contract. It ships with the binary, so a parse failure is a build defect;
/// every `voice_slots` test goes through here.
pub fn contract() -> &'static Contract {
    static C: OnceLock<Contract> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(CONTRACT_JSON).expect("contracts/voice-slots.json parses"))
}

pub fn slot_spec(slot: Slot) -> &'static SlotSpec {
    contract().slots.get(slot.as_str()).expect("every Slot is in contracts/voice-slots.json")
}

/* ---- model id pattern (contracts/modules.json voice.modelIdPattern) ---- */

const MODULES_JSON: &str = include_str!("../../../contracts/modules.json");

/// One `[class]` with its repeat range: `{min,max}`, or exactly once without one.
struct Atom {
    ranges: Vec<(char, char)>,
    min: usize,
    max: usize,
}

/// The pattern as `^` then `[class]` atoms with optional `{min,max}`, then `$`: the only regex
/// shape the contract uses, so no regex engine is linked for it. Any other shape is an Err.
fn parse_id_pattern(p: &str) -> Result<Vec<Atom>, String> {
    let body = p.strip_prefix('^').and_then(|s| s.strip_suffix('$')).ok_or("Pattern Must Be Anchored")?;
    let mut chars = body.chars().peekable();
    let mut atoms = Vec::new();
    while let Some(c) = chars.next() {
        if c != '[' {
            return Err(format!("Unsupported {c:?} in Pattern"));
        }
        let mut ranges = Vec::new();
        loop {
            let lo = match chars.next().ok_or("Unclosed [")? {
                ']' => break,
                '\\' => chars.next().ok_or("Dangling \\")?,
                ch => ch,
            };
            let mut ahead = chars.clone();
            match (ahead.next(), ahead.next()) {
                (Some('-'), Some(hi)) if hi != ']' => {
                    chars.next();
                    chars.next();
                    ranges.push((lo, hi));
                }
                _ => ranges.push((lo, lo)),
            }
        }
        let (mut min, mut max) = (1, 1);
        if chars.peek() == Some(&'{') {
            chars.next();
            let spec: String = chars.by_ref().take_while(|&ch| ch != '}').collect();
            let (a, b) = spec.split_once(',').ok_or("Expected {min,max}")?;
            min = a.trim().parse().map_err(|_| "Bad Repeat")?;
            max = b.trim().parse().map_err(|_| "Bad Repeat")?;
        }
        atoms.push(Atom { ranges, min, max });
    }
    Ok(atoms)
}

fn id_pattern() -> &'static [Atom] {
    static P: OnceLock<Vec<Atom>> = OnceLock::new();
    P.get_or_init(|| {
        let v: Value = serde_json::from_str(MODULES_JSON).expect("contracts/modules.json parses");
        let p = v.pointer("/voice/modelIdPattern").and_then(Value::as_str).expect("contracts/modules.json voice.modelIdPattern");
        parse_id_pattern(p).expect("voice.modelIdPattern has the supported shape")
    })
}

/// A `modelIds` adapter's `{model}`: matches contracts/modules.json `voice.modelIdPattern`
/// (a leading `-` would read as a flag on the adapter's command line).
pub fn model_id_ok(id: &str) -> bool {
    let mut rest = id.chars().peekable();
    for atom in id_pattern() {
        let mut n = 0;
        while n < atom.max {
            match rest.peek() {
                Some(&c) if atom.ranges.iter().any(|&(lo, hi)| (lo..=hi).contains(&c)) => {
                    rest.next();
                    n += 1;
                }
                _ => break,
            }
        }
        if n < atom.min {
            return false;
        }
    }
    rest.next().is_none()
}

/* ---- shapes ---- */

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PackJson {
    id: String,
    version: u32,
    #[serde(default)]
    #[allow(dead_code)] // loader 2a validates it against capabilities.json; voice only requires the shape
    provides: Vec<String>,
    #[serde(default)]
    slots: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    ui: Value,
    /// The pack's module declaration (contracts/modules.json); the module registry reads it,
    /// voice ignores it.
    #[serde(default)]
    #[allow(dead_code)]
    module: Value,
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct RunSpec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub file: String,
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub recommended: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SuggestedModel {
    pub id: String,
    pub label: String,
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct FileEntry {
    pub file: String,
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub sha256: Option<String>,
}

/// A `files[]` item: a rooted path (a `*` is allowed in its last segment, trust on first use)
/// or `{file, bytes, sha256}` with the hash declared by the manifest.
#[derive(Deserialize, Clone)]
#[serde(untagged)]
pub enum FileSpec {
    Path(String),
    Entry(FileEntry),
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub id: String,
    pub slot: String,
    pub label: String,
    pub run: RunSpec,
    #[serde(default)]
    pub warm: Option<RunSpec>,
    #[serde(default)]
    pub stop: Option<RunSpec>,
    #[serde(default)]
    pub status: Option<RunSpec>,
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    /// `{model}` is a server model id passed verbatim (contract `modelIds`), checked against
    /// `model_id_ok`; `models` must then be empty.
    #[serde(default, rename = "modelIds")]
    pub model_ids: bool,
    /// Rewrite slot: the effort levels `{effort}` may take (contract `efforts`). Non-empty means
    /// a pick must name one of them.
    #[serde(default)]
    pub efforts: Vec<String>,
    /// Rewrite slot: model ids a picker may offer. A hint, never validation.
    #[serde(default, rename = "suggestedModels")]
    pub suggested_models: Vec<SuggestedModel>,
    #[serde(default)]
    pub files: Vec<FileSpec>,
    #[serde(default)]
    pub licence: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub fill: Option<String>,
}

pub struct Adapter {
    pub pack: String,
    pub pack_dir: PathBuf,
    pub file: PathBuf,
    pub slot: Slot,
    pub m: Manifest,
}

impl Adapter {
    pub fn qid(&self) -> String {
        format!("{}/{}", self.pack, self.m.id)
    }
}

pub struct Broken {
    /// `<pack>/<file stem>` when the row came from a listed manifest, so a pick can name it.
    pub adapter: Option<String>,
    pub slot: Option<Slot>,
    pub file: PathBuf,
    pub reason: String,
}

#[derive(Default)]
pub struct Scan {
    pub adapters: Vec<Adapter>,
    pub broken: Vec<Broken>,
    /// Stock `pack.json` `ui.recommended`: slot -> adapter id inside the stock pack.
    pub recommended: BTreeMap<Slot, String>,
    /// `packs\` itself is missing or unreadable; also pushed to `broken` as a row naming it.
    pub packs_error: Option<String>,
}

/* ---- scan ---- */

fn read_capped(path: &Path, limit: u64) -> Result<Vec<u8>, std::io::Error> {
    let f = std::fs::File::open(path)?;
    let mut buf = Vec::new();
    f.take(limit + 1).read_to_end(&mut buf)?;
    Ok(buf)
}

fn read_limited(path: &Path, limit: u64, what: &str) -> Result<Vec<u8>, String> {
    let buf = read_capped(path, limit).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("No {what}"),
        _ => format!("{what}: {e}"),
    })?;
    if buf.len() as u64 > limit {
        return Err(format!("{what} Is Over {} KiB", limit / 1024));
    }
    Ok(buf)
}

/// Every `packs\<folder>\` (folders starting `_` or `.` are parked, as for characters), sorted
/// by folder name. A folder without `pack.json` is an error row; a pack with
/// no `slots` contributes nothing to voice. Junctions and symlinks are followed
/// (`fs::metadata`); a link that cannot be followed is an error row. A missing or unreadable
/// `packs\` is one error row naming it.
pub fn scan(packs_dir: &Path) -> Scan {
    let mut out = Scan::default();
    let rd = match std::fs::read_dir(packs_dir) {
        Ok(rd) => rd,
        Err(e) => {
            let reason = match e.kind() {
                std::io::ErrorKind::NotFound => format!("No packs Folder: {}", packs_dir.display()),
                _ => format!("Cannot Read packs Folder {}: {e}", packs_dir.display()),
            };
            out.packs_error = Some(reason.clone());
            out.broken.push(Broken { adapter: None, slot: None, file: packs_dir.to_path_buf(), reason });
            return out;
        }
    };
    let mut dirs: Vec<(String, PathBuf)> = Vec::new();
    for e in rd.filter_map(|e| e.ok()) {
        let (name, path) = (e.file_name().to_string_lossy().into_owned(), e.path());
        if name.starts_with('_') || name.starts_with('.') {
            continue;
        }
        match std::fs::metadata(&path) {
            Ok(md) if md.is_dir() => dirs.push((name, path)),
            Ok(_) => {}
            Err(err) => out.broken.push(Broken { adapter: None, slot: None, file: path, reason: format!("Cannot Follow Pack Folder: {err}") }),
        }
    }
    dirs.sort();
    for (folder, dir) in dirs {
        scan_pack(&folder, &dir, &mut out);
    }
    out
}

fn scan_pack(folder: &str, dir: &Path, out: &mut Scan) {
    let pack_file = dir.join("pack.json");
    let broken = |file: &Path, reason: String| Broken { adapter: None, slot: None, file: file.to_path_buf(), reason };
    let pack = match read_limited(&pack_file, PACK_JSON_BYTES, "pack.json")
        .and_then(|b| serde_json::from_slice::<PackJson>(&b).map_err(|e| format!("Invalid pack.json: {e}")))
    {
        Ok(p) => p,
        Err(reason) => {
            let at = if reason == "No pack.json" { dir } else { &pack_file };
            return out.broken.push(broken(at, reason));
        }
    };
    if pack.version != 1 {
        return out.broken.push(broken(&pack_file, format!("Unknown pack.json Version {}", pack.version)));
    }
    if !valid_id(&pack.id) || pack.id != folder {
        return out.broken.push(broken(&pack_file, format!("Pack id {:?} Does Not Match Folder {folder:?}", pack.id)));
    }
    let limits = &contract().limits;
    for (key, files) in &pack.slots {
        let Some(slot) = Slot::parse(key) else {
            out.broken.push(broken(&pack_file, format!("Unknown Slot {key:?} in pack.json")));
            continue;
        };
        if files.len() > limits.files {
            out.broken.push(broken(&pack_file, format!("More Than {} Adapters for {key}", limits.files)));
            continue;
        }
        for rel in files {
            let Some(stem) = manifest_stem(rel) else {
                out.broken.push(broken(&pack_file, format!("Bad Adapter Path {rel:?}: Expected voice/<id>.json")));
                continue;
            };
            let file = dir.join("voice").join(format!("{stem}.json"));
            let parsed = read_limited(&file, limits.manifest_bytes, "manifest")
                .and_then(|b| serde_json::from_slice::<Manifest>(&b).map_err(|e| format!("Invalid Manifest: {e}")))
                .and_then(|m| validate(&m, slot, stem).map(|()| m));
            match parsed {
                Ok(m) => out.adapters.push(Adapter { pack: pack.id.clone(), pack_dir: dir.to_path_buf(), file, slot, m }),
                Err(reason) => out.broken.push(Broken { adapter: Some(format!("{}/{stem}", pack.id)), slot: Some(slot), file, reason }),
            }
        }
    }
    if pack.id == STOCK_PACK {
        recommended(&pack, &pack_file, out);
    }
}

/// Stock `ui.recommended`: each entry must name an adapter the pack lists under that slot
/// (parsed or broken); anything else is an error row.
fn recommended(pack: &PackJson, pack_file: &Path, out: &mut Scan) {
    let Some(rec) = pack.ui.get("recommended").and_then(Value::as_object) else { return };
    for (k, v) in rec {
        let (slot, id) = (Slot::parse(k), v.as_str());
        let listed = |slot: Slot, id: &str| {
            let qid = format!("{}/{id}", pack.id);
            out.adapters.iter().any(|a| a.pack == pack.id && a.m.id == id && a.slot == slot)
                || out.broken.iter().any(|b| b.slot == Some(slot) && b.adapter.as_deref() == Some(qid.as_str()))
        };
        match (slot, id) {
            (Some(slot), Some(id)) if listed(slot, id) => {
                out.recommended.insert(slot, id.to_string());
            }
            _ => out.broken.push(Broken {
                adapter: None,
                slot,
                file: pack_file.to_path_buf(),
                reason: format!("ui.recommended {k:?}: {v} Matches No Listed Adapter"),
            }),
        }
    }
}

/// `voice/<id>.json` with a plain id: no other folder, no `..`, no backslash.
fn manifest_stem(rel: &str) -> Option<&str> {
    let stem = rel.strip_prefix("voice/")?.strip_suffix(".json")?;
    valid_id(stem).then_some(stem)
}

/* ---- validation ---- */

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= contract().limits.id_chars
        && !id.starts_with('.')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `{name}` tokens with their byte offsets. An unclosed `{` or an empty/nested name is an error.
pub fn tokens(s: &str) -> Result<Vec<(usize, &str)>, String> {
    let mut out = Vec::new();
    let mut rest = s;
    let mut base = 0;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let close = after.find('}').ok_or_else(|| format!("Unclosed {{ in {s:?}"))?;
        let name = &after[..close];
        if name.is_empty() || name.contains('{') {
            return Err(format!("Bad Token in {s:?}"));
        }
        out.push((base + open, name));
        base += open + close + 2;
        rest = &after[close + 1..];
    }
    Ok(out)
}

fn is_root(name: &str) -> bool {
    contract().roots.iter().any(|r| r == name)
}

/// `{vidar}`, `{pack}` or `{home}` first, then `/segments` with no `..`, no other token and no
/// `:` or `\` (a drive or UNC prefix would replace the root when pushed).
pub fn check_rooted(s: &str) -> Result<(), String> {
    let toks = tokens(s)?;
    let Some(&(0, root)) = toks.first() else { return Err(format!("Bad Root in {s:?}: Must Start With {{vidar}}, {{pack}} or {{home}}")) };
    if !is_root(root) || toks.len() > 1 {
        return Err(format!("Bad Root in {s:?}"));
    }
    let tail = &s[root.len() + 2..];
    if !(tail.is_empty() || tail.starts_with('/')) || tail.contains([':', '\\']) || tail.split('/').any(|seg| seg == "..") {
        return Err(format!("Bad Root in {s:?}"));
    }
    Ok(())
}

/// `{path:<name>}` names a bare executable found on PATH; anything else must be rooted.
pub fn path_command(cmd: &str) -> Option<&str> {
    let name = cmd.strip_prefix("{path:")?.strip_suffix('}')?;
    let ok = !name.is_empty()
        && name.len() <= contract().limits.id_chars
        && !name.contains(['/', '\\', ':', '{', '}', ' ']);
    ok.then_some(name)
}

fn check_run(what: &str, run: &RunSpec, allowed: &BTreeSet<&str>) -> Result<(), String> {
    let limits = &contract().limits;
    if path_command(&run.command).is_none() {
        check_rooted(&run.command).map_err(|e| format!("{what}.command: {e}"))?;
    }
    if run.args.len() > limits.args {
        return Err(format!("{what}.args Has More Than {} Entries", limits.args));
    }
    for arg in &run.args {
        if arg.chars().count() > limits.arg_chars {
            return Err(format!("{what}.args Entry Over {} Chars", limits.arg_chars));
        }
        for (at, name) in tokens(arg)? {
            if is_root(name) {
                if at != 0 {
                    return Err(format!("{what}.args: Bad Root in {arg:?}"));
                }
                check_rooted(arg).map_err(|e| format!("{what}.args: {e}"))?;
            } else if !allowed.contains(name) {
                return Err(format!("{what}.args: Unknown Token {{{name}}}"));
            }
        }
    }
    Ok(())
}

fn check_sha(sha: &Option<String>) -> Result<(), String> {
    match sha {
        Some(s) if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => {
            Err(format!("Bad sha256 {s:?}: Expected 64 Lowercase Hex"))
        }
        _ => Ok(()),
    }
}

/// Every rule of plan §2 over one parsed manifest listed under `slot` as `voice/<stem>.json`.
pub fn validate(m: &Manifest, slot: Slot, stem: &str) -> Result<(), String> {
    let c = contract();
    if m.version != 1 {
        return Err(format!("Unknown Manifest Version {}", m.version));
    }
    if !valid_id(&m.id) || m.id != stem {
        return Err(format!("Manifest id {:?} Does Not Match File Name {stem:?}", m.id));
    }
    match Slot::parse(&m.slot) {
        None => return Err(format!("Unknown Slot {:?}", m.slot)),
        Some(s) if s != slot => return Err(format!("Slot {:?} Is Listed Under {}", m.slot, slot.as_str())),
        _ => {}
    }
    if m.label.trim().is_empty() || m.label.chars().count() > c.limits.label_chars {
        return Err(format!("label Must Be 1 to {} Chars", c.limits.label_chars));
    }
    let slot_tokens: BTreeSet<&str> = slot_spec(slot).tokens.iter().map(String::as_str).collect();
    let mut life_tokens = slot_tokens.clone();
    life_tokens.extend(c.lifecycle.tokens.iter().map(String::as_str));
    check_run("run", &m.run, &slot_tokens)?;
    for (what, cmd) in [("warm", &m.warm), ("stop", &m.stop), ("status", &m.status)] {
        if let Some(cmd) = cmd {
            check_run(what, cmd, &life_tokens)?;
        }
    }
    // stt `warm` is a stdio server held in a kill-on-close job; its stop is stdin EOF (contract).
    if m.warm.is_some() && m.stop.is_none() && slot != Slot::Stt {
        return Err("warm Without stop: a Warm Process Needs a stop".into());
    }
    if m.model_ids && !m.models.is_empty() {
        return Err("modelIds With models: a Server Model Id Adapter Lists No Model Files".into());
    }
    if (!m.efforts.is_empty() || !m.suggested_models.is_empty()) && slot != Slot::Rewrite {
        return Err("efforts and suggestedModels Belong to the rewrite Slot".into());
    }
    if m.efforts.len() > c.limits.models {
        return Err(format!("efforts Has More Than {} Entries", c.limits.models));
    }
    let mut seen_efforts = BTreeSet::new();
    for effort in &m.efforts {
        if !model_id_ok(effort) || !seen_efforts.insert(effort.as_str()) {
            return Err(format!("Bad or Duplicate Effort {effort:?}"));
        }
    }
    if m.suggested_models.len() > c.limits.models {
        return Err(format!("suggestedModels Has More Than {} Entries", c.limits.models));
    }
    for s in &m.suggested_models {
        if !model_id_ok(&s.id) || s.label.trim().is_empty() || s.label.chars().count() > c.limits.label_chars {
            return Err(format!("Bad suggestedModels Entry {:?}", s.id));
        }
    }
    if m.models.len() > c.limits.models {
        return Err(format!("models Has More Than {} Entries", c.limits.models));
    }
    let mut seen = BTreeSet::new();
    for model in &m.models {
        if !valid_id(&model.id) || !seen.insert(model.id.as_str()) {
            return Err(format!("Bad or Duplicate Model id {:?}", model.id));
        }
        check_rooted(&model.file).map_err(|e| format!("models[{}].file: {e}", model.id))?;
        check_sha(&model.sha256)?;
        if model.bytes == Some(0) || model.label.as_ref().is_some_and(|l| l.chars().count() > c.limits.label_chars) {
            return Err(format!("models[{}]: Bad bytes or label", model.id));
        }
    }
    if m.files.len() > c.limits.files {
        return Err(format!("files Has More Than {} Entries", c.limits.files));
    }
    for f in &m.files {
        match f {
            FileSpec::Path(p) => {
                check_rooted(p).map_err(|e| format!("files: {e}"))?;
                let (dir, _) = p.rsplit_once('/').unwrap_or((p, ""));
                if dir.contains('*') {
                    return Err(format!("files: {p:?} Has a * Outside Its Last Segment"));
                }
            }
            FileSpec::Entry(e) => {
                check_rooted(&e.file).map_err(|err| format!("files: {err}"))?;
                if e.file.contains('*') || e.bytes == Some(0) {
                    return Err(format!("files: {:?} Is Not a Single Pinned File", e.file));
                }
                check_sha(&e.sha256)?;
            }
        }
    }
    for text in [&m.licence, &m.source, &m.fill].into_iter().flatten() {
        if text.chars().count() > c.limits.arg_chars {
            return Err(format!("Text Field Over {} Chars", c.limits.arg_chars));
        }
    }
    if let Some(fill) = &m.fill {
        for (_, name) in tokens(fill)? {
            if !c.fill_tokens.iter().any(|t| t == name) {
                return Err(format!("fill: Unknown Token {{{name}}}"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(slot: &str, warm: bool) -> Manifest {
        let warm = if warm { r#","warm":{"command":"{vidar}/x.exe","args":["--serve"]}"# } else { "" };
        let json = format!(
            r#"{{"version":1,"id":"a","slot":"{slot}","label":"A","run":{{"command":"{{vidar}}/x.exe"}}{warm}}}"#
        );
        serde_json::from_str(&json).expect("test manifest parses")
    }

    #[test]
    fn warm_without_stop_is_allowed_for_stt_only() {
        let e = validate(&manifest("tts", true), Slot::Tts, "a").expect_err("tts warm without stop is refused");
        assert!(e.contains("warm Without stop"), "{e}");
        assert!(validate(&manifest("tts", false), Slot::Tts, "a").is_ok());
        assert!(validate(&manifest("stt", true), Slot::Stt, "a").is_ok());
        assert!(validate(&manifest("stt", false), Slot::Stt, "a").is_ok());
    }
}
