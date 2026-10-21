//! src-tauri\src\voice_slots\mod.rs — the voice slot resolver (voice slots plan §1, V1). Four
//! model slots (`stt`, `wake`, `rewrite`, `tts`), each filled by an adapter manifest from a
//! `packs\<id>\pack.json`. No code defaults: a slot is filled only by a pick, either
//! `voiceSlots.<slot>` in vidar.json or a legacy key present in the raw file; `voiceSlots` wins.
//! Legacy presence is read from the raw Value because `VoiceCfg`/`WakewordCfg` are
//! `serde(default)` and cannot tell an explicit key from the default.
//!
//! `manifest` parses and validates, `probe` checks presence, `pins` holds trust on first use.
//! `resolve` (`resolve_for` with the fill line) and `write_resolved` are the stage entry points;
//! `voice_slots_status` feeds the slot panel and `voice_slots_trust` is its Trust Current.

mod manifest;
pub(crate) mod pins; // also pins module gateway declarations (modules::scan)
mod probe;
pub(crate) mod write;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub use manifest::{ModelEntry, SuggestedModel};
use manifest::{Adapter, RunSpec, Scan, STOCK_PACK};
use pins::{Pin, Store, Verdict};
use probe::{Roots, Target};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    Stt,
    Wake,
    Rewrite,
    Tts,
}

impl Slot {
    pub const ALL: [Slot; 4] = [Slot::Stt, Slot::Wake, Slot::Rewrite, Slot::Tts];

    pub fn as_str(self) -> &'static str {
        match self {
            Slot::Stt => "stt",
            Slot::Wake => "wake",
            Slot::Rewrite => "rewrite",
            Slot::Tts => "tts",
        }
    }

    pub fn parse(s: &str) -> Option<Slot> {
        Slot::ALL.into_iter().find(|slot| slot.as_str() == s)
    }
}

/// Where a pick came from: `voiceSlots.<slot>` naming the stock pack or another pack, or a
/// legacy vidar.json key.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    Stock,
    Pack { pack: String },
    Legacy { key: String },
}

/// A lifecycle command (`warm`, `stop`, `status`) with its roots expanded; `{owner}` and the
/// slot tokens are filled by the caller.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cmd {
    pub command: PathBuf,
    pub args: Vec<String>,
}

/// A filled slot: roots and `{model}` expanded, per-call tokens (`{wav}`, `{out}`…) left for
/// the stage that runs it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub adapter: String,
    pub source: Source,
    pub command: PathBuf,
    pub args: Vec<String>,
    pub model: Option<ModelEntry>,
    pub warm: Option<Cmd>,
    pub stop: Option<Cmd>,
    pub status: Option<Cmd>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Filled,
    Missing,
    Empty,
    Broken,
}

/// Pin state of a filled slot: every pinnable file matches (`yes`), some are not pinned yet
/// (`not-yet`, recorded on first resolve), or nothing is pinnable (`never`: a PATH command, the
/// inline custom transcriber, an adapter made only of repo content).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Pinned {
    Yes,
    NotYet,
    Never,
}

/// Why a slot did not resolve. `adapter` is the picked id (or the vidar.json key at fault;
/// empty when nothing is picked). `state` tells an empty optional slot from a failure.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotError {
    pub adapter: String,
    pub state: State,
    pub reason: String,
}

impl std::fmt::Display for SlotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.adapter.is_empty() {
            write!(f, "{}", self.reason)
        } else {
            write!(f, "{}: {}", self.adapter, self.reason)
        }
    }
}

/// One panel row: a slot (`slot` set), or a pack or manifest that failed to parse (`slot`
/// None, or the slot it was listed under), which is never skipped.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotStatus {
    pub slot: Option<Slot>,
    pub required: bool,
    pub state: State,
    pub reason: Option<String>,
    pub adapter: Option<String>,
    pub label: Option<String>,
    pub model: Option<String>,
    pub bytes: Option<u64>,
    pub licence: Option<String>,
    pub source: Option<Source>,
    /// Set on a filled slot only.
    pub pinned: Option<Pinned>,
    pub recommended: Option<String>,
    pub recommended_model: Option<String>,
    pub fill: Option<String>,
    pub file: Option<String>,
    /// The pick list of the slot's adapter (or the stock recommendation when nothing resolves
    /// to an adapter): what a model picker may offer, and whether each file is on disk.
    pub models: Vec<ModelChoice>,
    /// The picked effort level (`voiceSlots.<slot>.effort`), as written.
    pub effort: Option<String>,
    /// Every adapter the scan found for this slot: what an adapter picker may offer.
    pub adapters: Vec<AdapterChoice>,
}

/// One pickable adapter of a slot, off its manifest.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterChoice {
    pub id: String,
    pub label: String,
    pub model_ids: bool,
    pub efforts: Vec<String>,
    pub suggested_models: Vec<SuggestedModel>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub id: String,
    pub label: Option<String>,
    pub installed: bool,
    pub recommended: bool,
}

/* ---- context ---- */

struct Ctx {
    vidar: PathBuf,
    packs: PathBuf,
    home: Option<PathBuf>,
    pins: PathBuf,
    raw: Result<Value, String>,
    /// `{lmstudioOrigin}`: vidar.json `lmstudioOrigin` as lmstudio.rs reads it (`fill_origin`).
    origin: String,
}

impl Ctx {
    fn live() -> Ctx {
        let vidar = crate::paths::root();
        Ctx {
            packs: crate::paths::packs_dir(),
            home: crate::paths::home(),
            pins: slots_dir().join("pins.json"),
            raw: read_raw(&crate::paths::config_path()),
            origin: crate::lmstudio::configured_origin().0,
            vidar,
        }
    }
}

fn slots_dir() -> PathBuf {
    crate::paths::voice_slots_dir()
}

/// vidar.json as a raw Value: absent is `{}` (nothing picked), unreadable or unparsable is an
/// error every slot reports.
fn read_raw(path: &Path) -> Result<Value, String> {
    match crate::fsx::read_text(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("vidar.json: {e}")),
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("vidar.json: {e}")),
    }
}

/* ---- picks ---- */

#[derive(Debug, PartialEq)]
enum PickKind {
    /// `<pack>/<adapter id>`
    Named(String),
    /// `voice.transcriber`: the custom command the user wrote, taken as is.
    Inline { command: String, args: Vec<String> },
}

#[derive(Debug, PartialEq)]
struct Pick {
    kind: PickKind,
    model: Option<String>,
    /// `voiceSlots.<slot>.effort`; legacy picks never carry one.
    effort: Option<String>,
    /// The legacy key it came from; None = `voiceSlots`.
    legacy: Option<&'static str>,
}

fn named(id: &str, model: Option<&str>, legacy: Option<&'static str>) -> Pick {
    Pick { kind: PickKind::Named(id.to_string()), model: some_model(model), effort: None, legacy }
}

/// A picked model id; a trimmed-empty one is no pick.
fn some_model(model: Option<&str>) -> Option<String> {
    model.map(str::trim).filter(|m| !m.is_empty()).map(String::from)
}

fn bad(adapter: &str, reason: impl Into<String>) -> SlotError {
    SlotError { adapter: adapter.to_string(), state: State::Broken, reason: reason.into() }
}

/// The pick for `slot`: `voiceSlots.<slot>` first, then the slot's legacy key. None = no pick.
fn pick(raw: &Value, slot: Slot) -> Result<Option<Pick>, SlotError> {
    let key = format!("voiceSlots.{}", slot.as_str());
    match raw.get("voiceSlots").and_then(|v| v.get(slot.as_str())) {
        None | Some(Value::Null) => {}
        Some(Value::Object(o)) => {
            let known = o.keys().all(|k| k == "adapter" || k == "model" || k == "effort");
            let model = o.get("model").map(|m| m.as_str().ok_or(())).transpose();
            let effort = o.get("effort").map(|m| m.as_str().ok_or(())).transpose();
            return match (o.get("adapter").and_then(Value::as_str), model, effort, known) {
                (Some(a), Ok(m), Ok(e), true) => {
                    let mut p = named(a, m, None);
                    p.effort = some_model(e);
                    Ok(Some(p))
                }
                _ => Err(bad(&key, "Expected {\"adapter\": \"<pack>/<id>\", \"model\": \"<id>\", \"effort\": \"<level>\"}")),
            };
        }
        Some(_) => return Err(bad(&key, "Expected an Object")),
    }
    let s = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
    Ok(match slot {
        Slot::Stt => match raw.get("voice") {
            Some(voice @ Value::Object(_)) => {
                let model = some_model(s(voice.get("model")).as_deref());
                match voice.get("transcriber") {
                    None | Some(Value::Null) => Some(Pick { kind: PickKind::Named(format!("{STOCK_PACK}/whisper-cli")), model, effort: None, legacy: Some("voice") }),
                    Some(Value::Object(t)) => Some(Pick { kind: inline(t)?, model, effort: None, legacy: Some("voice.transcriber") }),
                    Some(_) => return Err(bad("voice.transcriber", "Expected an Object")),
                }
            }
            _ => None,
        },
        Slot::Wake => match raw.get("wakeword").and_then(|w| w.get("model")) {
            None | Some(Value::Null) => None,
            Some(Value::String(m)) if m.trim().is_empty() => None,
            Some(Value::String(m)) => Some(named(&format!("{STOCK_PACK}/openwakeword"), Some(m), Some("wakeword.model"))),
            Some(_) => return Err(bad("wakeword.model", "Expected a String")),
        },
        // Retired: the slot is picked only through `voiceSlots.rewrite`. "none" still means empty.
        Slot::Rewrite => match raw.get("speakRewrite") {
            None | Some(Value::Null) => None,
            Some(Value::String(v)) if v == "none" => None,
            Some(_) => return Err(bad("speakRewrite", "speakRewrite Is Retired: Use voiceSlots.rewrite")),
        },
        Slot::Tts => None,
    })
}

/// `voice.transcriber` as written; a missing or non-string command, non-array args or a
/// non-string arg is broken, never a silent fallback.
fn inline(t: &Map<String, Value>) -> Result<PickKind, SlotError> {
    let key = "voice.transcriber";
    let command = match t.get("command") {
        Some(Value::String(c)) => c.clone(),
        None | Some(Value::Null) => return Err(bad(key, "No command")),
        Some(_) => return Err(bad(key, "command Must Be a String")),
    };
    let args = match t.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(String::from)).collect::<Option<_>>().ok_or_else(|| bad(key, "Every args Entry Must Be a String"))?,
        Some(_) => return Err(bad(key, "args Must Be an Array")),
    };
    Ok(PickKind::Inline { command, args })
}

/* ---- evaluation ---- */

struct Eval<'a> {
    state: State,
    reason: Option<String>,
    adapter_id: Option<String>,
    adapter: Option<&'a Adapter>,
    source: Option<Source>,
    model: Option<String>,
    effort: Option<String>,
    resolved: Option<Resolved>,
    unpinned: Vec<(PathBuf, Pin)>,
    pinned: Option<Pinned>,
}

type Fail = (State, String);

const NO_MODEL: &str = "No Model Picked";
const NO_EFFORT: &str = "No Effort Picked";

fn missing(reason: String) -> Fail {
    (State::Missing, reason)
}

/// A probe failure: `missing`, except a path escaping its root, which is `broken`.
fn probe_fail(reason: String) -> Fail {
    if reason.starts_with(probe::ESCAPES) {
        (State::Broken, reason)
    } else {
        missing(reason)
    }
}

/// A command's args expanded; rooted ones that name an existing file join the pin targets.
fn args_of(args: &[String], roots: &Roots, pins: &mut Vec<Target>) -> Result<Vec<String>, Fail> {
    for a in args {
        pins.extend(probe::arg_file(a, roots).map_err(probe_fail)?);
    }
    args.iter().map(|a| probe::expand_arg(a, roots)).collect::<Result<_, _>>().map_err(probe_fail)
}

/// `{model}` in expanded args: the model file, or a `modelIds` adapter's server model id;
/// `{effort}`: the picked level (already checked against the manifest's `efforts`).
fn fill_model(args: Vec<String>, model: Option<&str>, effort: Option<&str>) -> Vec<String> {
    args.into_iter()
        .map(|mut x| {
            if let Some(m) = model {
                x = x.replace("{model}", m);
            }
            if let Some(e) = effort {
                x = x.replace("{effort}", e);
            }
            x
        })
        .collect()
}

fn lifecycle(spec: &Option<RunSpec>, roots: &Roots, pins: &mut Vec<Target>, model: Option<&str>, effort: Option<&str>) -> Result<Option<Cmd>, Fail> {
    let Some(spec) = spec else { return Ok(None) };
    let (command, pin) = probe::command(&spec.command, roots).map_err(probe_fail)?;
    if pin {
        pins.push(Target::tofu(command.clone()));
    }
    let args = fill_model(args_of(&spec.args, roots, pins)?, model, effort);
    Ok(Some(Cmd { command, args }))
}

/// The pick's model and effort against the adapter's manifest: the one rule set `resolve_named`
/// and the `voice_slots_pick` write share, so a write and a resolve cannot disagree. Returns the
/// listed model entry, if the adapter has model files.
fn check_pick<'a>(a: &'a Adapter, model: Option<&str>, effort: Option<&str>) -> Result<Option<&'a ModelEntry>, Fail> {
    let entry = match (model, a.m.models.is_empty()) {
        (Some(id), false) => Some(a.m.models.iter().find(|m| m.id == id).ok_or((State::Broken, format!("Model Not Listed: {id}")))?),
        (Some(id), true) if a.m.model_ids => {
            if !manifest::model_id_ok(id) {
                return Err((State::Broken, format!("Bad Model Id {id:?}")));
            }
            None
        }
        (Some(_), true) => return Err((State::Broken, "Adapter Takes No Model".into())),
        (None, false) => return Err(missing(NO_MODEL.into())),
        (None, true) if a.m.model_ids => return Err(missing(NO_MODEL.into())),
        (None, true) => None,
    };
    match (effort, a.m.efforts.is_empty()) {
        (Some(e), false) => {
            if !manifest::model_id_ok(e) {
                return Err((State::Broken, format!("Bad Effort {e:?}")));
            }
            if !a.m.efforts.iter().any(|x| x == e) {
                return Err((State::Broken, format!("Effort Not Listed: {e}")));
            }
        }
        (Some(_), true) => return Err((State::Broken, "Adapter Takes No Effort".into())),
        (None, false) => return Err(missing(NO_EFFORT.into())),
        (None, true) => {}
    }
    Ok(entry)
}

/// A named adapter to its resolved form, pins checked against `store`. Targets without a
/// declared sha256 are kept only when `probe::pinnable` (fetched artefacts, non-stock packs).
fn resolve_named(ctx: &Ctx, a: &Adapter, pick: &Pick, source: Source, store: &Store) -> Result<(Resolved, Vec<(PathBuf, Pin)>, Pinned), Fail> {
    let roots = Roots { vidar: ctx.vidar.clone(), pack: a.pack_dir.clone(), home: ctx.home.clone() };
    let entry = check_pick(a, pick.model.as_deref(), pick.effort.as_deref())?;
    let mut targets = vec![Target::tofu(a.file.clone())];
    let (command, pin_cmd) = probe::command(&a.m.run.command, &roots).map_err(probe_fail)?;
    if pin_cmd {
        targets.push(Target::tofu(command.clone()));
    }
    targets.extend(probe::files(&a.m.files, &roots).map_err(probe_fail)?);
    let model = match entry {
        Some(e) => {
            let (resolved, target) = probe::model(e, &roots).map_err(probe_fail)?;
            targets.push(target);
            Some(resolved)
        }
        None => None,
    };
    // A model file, or a `modelIds` adapter's id verbatim; the same value in every command.
    let model_fill = match &model {
        Some(m) => Some(m.file.clone()),
        None if a.m.model_ids => pick.model.clone(),
        None => None,
    };
    let fill = model_fill.as_deref();
    let effort = pick.effort.as_deref();
    let warm = lifecycle(&a.m.warm, &roots, &mut targets, fill, effort)?;
    let stop = lifecycle(&a.m.stop, &roots, &mut targets, fill, effort)?;
    let status = lifecycle(&a.m.status, &roots, &mut targets, fill, effort)?;
    let args = fill_model(args_of(&a.m.run.args, &roots, &mut targets)?, fill, effort);
    let stock = a.pack == STOCK_PACK;
    targets.retain(|t| t.sha256.is_some() || probe::pinnable(&t.path, &roots, stock));
    targets.sort_by(|x, y| x.path.cmp(&y.path));
    targets.dedup_by(|x, y| x.path == y.path);
    let pinned = if targets.is_empty() { Pinned::Never } else { Pinned::Yes };
    let mut unpinned = Vec::new();
    for t in targets {
        match pins::verdict(store, &t).map_err(|e| (State::Broken, e))? {
            Verdict::Match => {}
            Verdict::Unpinned(pin) => unpinned.push((t.path, pin)),
            Verdict::Changed => return Err((State::Broken, format!("Changed Since Pinned: {} - Trust Current In Voice Slots Accepts It", t.path.display()))),
        }
    }
    let pinned = if unpinned.is_empty() { pinned } else { Pinned::NotYet };
    Ok((Resolved { adapter: a.qid(), source, command, args, model, warm, stop, status }, unpinned, pinned))
}

/// `voice.transcriber` as written: a bare name goes through PATH, a path must exist. Not pinned
/// (the user wrote it); `{model}` resolves through `voice.model` as today, and that file must exist.
fn resolve_inline(command: &str, args: &[String], model: Option<&str>) -> Result<Resolved, Fail> {
    let path = if command.contains(['\\', '/']) {
        let p = PathBuf::from(command);
        p.is_file().then_some(p).ok_or_else(|| missing(format!("Not Found: {command}")))?
    } else {
        crate::which::find_on_path_exact(command).ok_or_else(|| missing(format!("Not On PATH: {command}")))?
    };
    let uses_model = args.iter().any(|a| a.contains("{model}"));
    let entry = match crate::voice::model_path(model) {
        Ok(file) => Some(ModelEntry { id: model.unwrap_or_default().trim().to_string(), file, bytes: None, sha256: None, label: None, recommended: false }),
        Err(e) if uses_model => return Err(missing(format!("Unresolved {{model}}: {e}"))),
        Err(_) => None,
    };
    if let Some(e) = entry.as_ref().filter(|_| uses_model) {
        if !Path::new(&e.file).is_file() {
            return Err(missing(format!("Not Found: {}", e.file)));
        }
    }
    let args = args.iter().map(|a| match &entry { Some(e) => a.replace("{model}", &e.file), None => a.clone() }).collect();
    Ok(Resolved {
        adapter: "custom (vidar.json)".into(),
        source: Source::Legacy { key: "voice.transcriber".into() },
        command: path,
        args,
        model: entry,
        warm: None,
        stop: None,
        status: None,
    })
}

fn eval<'a>(ctx: &Ctx, scan: &'a Scan, store: &Result<Store, String>, slot: Slot) -> Eval<'a> {
    let mut ev = Eval { state: State::Broken, reason: None, adapter_id: None, adapter: None, source: None, model: None, effort: None, resolved: None, unpinned: Vec::new(), pinned: None };
    let fail = |mut ev: Eval<'a>, (state, reason): Fail| {
        ev.state = state;
        ev.reason = Some(reason);
        ev
    };
    let raw = match &ctx.raw {
        Ok(v) => v,
        Err(e) => return fail(ev, (State::Broken, e.clone())),
    };
    let pick = match pick(raw, slot) {
        Ok(Some(p)) => p,
        Ok(None) if manifest::slot_spec(slot).required => return fail(ev, missing("No Pick".into())),
        Ok(None) => {
            ev.state = State::Empty;
            return ev;
        }
        Err(e) => {
            ev.adapter_id = Some(e.adapter);
            return fail(ev, (e.state, e.reason));
        }
    };
    ev.model = pick.model.clone();
    ev.effort = pick.effort.clone();
    let result = match &pick.kind {
        PickKind::Inline { command, args } => {
            ev.adapter_id = Some("custom (vidar.json)".into());
            resolve_inline(command, args, pick.model.as_deref()).map(|r| (r, Vec::new(), Pinned::Never))
        }
        PickKind::Named(id) => {
            ev.adapter_id = Some(id.clone());
            // A moved manifest and runner have new pin paths. Keep the old pick broken
            // until the user explicitly selects the Claude pack adapter.
            if slot == Slot::Rewrite && id == "voice-stock/claude-p" {
                return fail(ev, (State::Broken, "Adapter Moved To claude/claude-p: Set voiceSlots.rewrite.adapter To claude/claude-p".into()));
            }
            match scan.adapters.iter().find(|a| &a.qid() == id) {
                None => Err(match (scan.broken.iter().find(|b| b.adapter.as_deref() == Some(id)), &scan.packs_error) {
                    (Some(b), _) => (State::Broken, b.reason.clone()),
                    (None, Some(e)) => (State::Broken, e.clone()),
                    (None, None) => (State::Broken, format!("Unknown Pick: {id}")),
                }),
                Some(a) if a.slot != slot => Err((State::Broken, format!("{id} Is a {} Adapter", a.slot.as_str()))),
                Some(a) => {
                    ev.adapter = Some(a);
                    let source = match pick.legacy {
                        Some(key) => Source::Legacy { key: key.into() },
                        None if a.pack == STOCK_PACK => Source::Stock,
                        None => Source::Pack { pack: a.pack.clone() },
                    };
                    ev.source = Some(source.clone());
                    match store {
                        Ok(store) => resolve_named(ctx, a, &pick, source, store),
                        Err(e) => Err((State::Broken, e.clone())),
                    }
                }
            }
        }
    };
    if ev.source.is_none() {
        ev.source = pick.legacy.map(|key| Source::Legacy { key: key.into() });
    }
    // Filled here, not at write time, so the status row and the resolved file agree: a
    // non-loopback origin shows broken in the slot panel with the reason Speak would give.
    let result = result.and_then(|(r, unpinned, pinned)| match fill_origin(r, &ctx.origin) {
        Ok(r) => Ok((r, unpinned, pinned)),
        Err(e) => Err((e.state, e.reason)),
    });
    match result {
        Ok((resolved, unpinned, pinned)) => {
            ev.state = State::Filled;
            ev.resolved = Some(resolved);
            ev.unpinned = unpinned;
            ev.pinned = Some(pinned);
            ev
        }
        // An optional slot with an adapter but no model is not filled, not failing.
        Err((State::Missing, r)) if pick.model.is_none() && r == NO_MODEL && !manifest::slot_spec(slot).required => {
            ev.state = State::Empty;
            ev
        }
        Err(f) => fail(ev, f),
    }
}

fn resolve_in(ctx: &Ctx, slot: Slot) -> Result<Resolved, SlotError> {
    let scan = manifest::scan(&ctx.packs);
    let ev = eval(ctx, &scan, &pins::load(&ctx.pins), slot);
    let adapter = ev.adapter_id.clone().unwrap_or_default();
    match ev.resolved {
        Some(resolved) => {
            pins::record(&ctx.pins, ev.unpinned, false).map_err(|reason| SlotError { adapter, state: State::Broken, reason })?;
            Ok(resolved)
        }
        None => Err(SlotError { adapter, state: ev.state, reason: ev.reason.unwrap_or_else(|| "Empty (Optional)".into()) }),
    }
}

/// One slot's row: the per-slot half of `status_in`, alone for `status_one`.
fn slot_row(ctx: &Ctx, scan: &Scan, store: &Result<Store, String>, slot: Slot) -> SlotStatus {
    let stock_rec = |slot: Slot| -> Option<&Adapter> {
        let id = scan.recommended.get(&slot)?;
        scan.adapters.iter().find(|a| a.pack == STOCK_PACK && &a.m.id == id && a.slot == slot)
    };
    {
        let ev = eval(ctx, scan, store, slot);
        let rec = stock_rec(slot);
        let rec_model = rec.and_then(|a| a.m.models.iter().find(|m| m.recommended)).map(|m| m.id.clone());
        let fill_from = ev.adapter.or(rec);
        let models = fill_from.map(|a| {
            let roots = Roots { vidar: ctx.vidar.clone(), pack: a.pack_dir.clone(), home: ctx.home.clone() };
            a.m.models
                .iter()
                .map(|m| ModelChoice {
                    id: m.id.clone(),
                    label: m.label.clone(),
                    installed: probe::expand_rooted(&m.file, &roots).is_ok_and(|p| p.is_file()),
                    recommended: m.recommended,
                })
                .collect()
        });
        let fill = fill_from.and_then(|a| {
            let roots = Roots { vidar: ctx.vidar.clone(), pack: a.pack_dir.clone(), home: ctx.home.clone() };
            // The picked model, else this adapter's recommended one, else its first: never a
            // bare `-Model ` or a literal `{model}`.
            let model = ev
                .model
                .clone()
                .filter(|m| !m.trim().is_empty())
                .or_else(|| a.m.models.iter().find(|m| m.recommended).or(a.m.models.first()).map(|m| m.id.clone()))
                .or_else(|| rec_model.clone());
            let line = probe::fill(a.m.fill.as_deref()?, &roots, model.as_deref());
            Some(if a.pack == STOCK_PACK { line } else { format!("from {}, unverified: {line}", a.pack) })
        });
        let model_entry = ev.resolved.as_ref().and_then(|r| r.model.clone()).or_else(|| {
            let (a, id) = (ev.adapter?, ev.model.as_ref()?);
            a.m.models.iter().find(|m| &m.id == id).cloned()
        });
        let bytes = model_entry.as_ref().and_then(|m| std::fs::metadata(&m.file).ok().map(|md| md.len()).or(m.bytes));
        SlotStatus {
            slot: Some(slot),
            required: manifest::slot_spec(slot).required,
            state: ev.state,
            reason: ev.reason,
            adapter: ev.adapter_id,
            label: ev.adapter.map(|a| a.m.label.clone()),
            model: ev.model,
            bytes,
            licence: ev.adapter.and_then(|a| a.m.licence.clone()),
            source: ev.source,
            pinned: ev.pinned,
            recommended: rec.map(Adapter::qid),
            recommended_model: rec_model,
            fill,
            file: ev.adapter.map(|a| a.file.to_string_lossy().into_owned()),
            models: models.unwrap_or_default(),
            effort: ev.effort,
            adapters: scan
                .adapters
                .iter()
                .filter(|a| a.slot == slot)
                .map(|a| AdapterChoice {
                    id: a.qid(),
                    label: a.m.label.clone(),
                    model_ids: a.m.model_ids,
                    efforts: a.m.efforts.clone(),
                    suggested_models: a.m.suggested_models.clone(),
                })
                .collect(),
        }
    }
}

fn status_in(ctx: &Ctx) -> Vec<SlotStatus> {
    let scan = manifest::scan(&ctx.packs);
    let store = pins::load(&ctx.pins);
    let mut rows: Vec<SlotStatus> = Slot::ALL.into_iter().map(|slot| slot_row(ctx, &scan, &store, slot)).collect();
    let shown: Vec<String> = rows.iter().filter_map(|r| r.adapter.clone()).collect();
    for b in &scan.broken {
        if b.adapter.as_ref().is_some_and(|id| shown.contains(id)) {
            continue;
        }
        rows.push(SlotStatus {
            slot: b.slot,
            required: false,
            state: State::Broken,
            reason: Some(b.reason.clone()),
            adapter: b.adapter.clone(),
            label: None,
            model: None,
            bytes: None,
            licence: None,
            source: None,
            pinned: None,
            recommended: None,
            recommended_model: None,
            fill: None,
            file: Some(b.file.to_string_lossy().into_owned()),
            models: Vec::new(),
            effort: None,
            adapters: Vec::new(),
        });
    }
    rows
}

/* ---- entry points ---- */

/// The slot's adapter, ready to run. First use records pins for what it has not seen; a
/// changed file is an `Err`, never a warning.
pub fn resolve(slot: Slot) -> Result<Resolved, SlotError> {
    resolve_in(&Ctx::live(), slot)
}

/// `resolve` for a stage that reports to the user: a failure becomes one line naming the slot,
/// the adapter and the reason, plus the fill line the slot panel shows when there is one.
pub fn resolve_for(slot: Slot) -> Result<Resolved, String> {
    resolve(slot).map_err(|e| {
        let name = match slot {
            Slot::Stt => "STT",
            Slot::Wake => "Wake",
            Slot::Rewrite => "Rewrite",
            Slot::Tts => "TTS",
        };
        // Empty is a choice left open, not a failure: no fill line to act on.
        if e.state == State::Empty {
            return match slot {
                Slot::Wake => "Pick a Wake Word".into(),
                _ => format!("{name} Slot: {}", e.reason),
            };
        }
        let fill = status_all().into_iter().find(|r| r.slot == Some(slot)).and_then(|r| r.fill);
        match fill {
            Some(line) => format!("{name} Slot: {e}. Fill: {line}"),
            None => format!("{name} Slot: {e}"),
        }
    })
}

/// Every slot's row, then one row per broken pack or manifest. Read-only: records no pins.
pub fn status_all() -> Vec<SlotStatus> {
    status_in(&Ctx::live())
}

/// One slot's row, evaluating only that slot: a pill that needs one slot never hashes another
/// slot's model. Read-only like `status_all`.
pub fn status_one(slot: Slot) -> SlotStatus {
    let ctx = Ctx::live();
    let scan = manifest::scan(&ctx.packs);
    slot_row(&ctx, &scan, &pins::load(&ctx.pins), slot)
}

/// `{lmstudioOrigin}` in every command of a resolved slot. The one source is vidar.json
/// `lmstudioOrigin` as `lmstudio.rs` reads it (absent or invalid = its default origin).
/// Trust boundary: a slot that uses the token gets it only for a loopback http origin, the
/// rule lmstudio.rs already applies; anything else breaks the slot
/// with the origin named, so no reply text is ever posted off the machine.
fn fill_origin(mut r: Resolved, origin: &str) -> Result<Resolved, SlotError> {
    const TOKEN: &str = "{lmstudioOrigin}";
    let cmds = || [&r.warm, &r.stop, &r.status].into_iter().flatten().flat_map(|c| c.args.iter());
    let uses = r.args.iter().chain(cmds()).any(|a| a.contains(TOKEN));
    if uses && !crate::lmstudio::is_loopback_http(origin) {
        return Err(bad(&r.adapter, format!("LM Studio Origin Not Loopback: {origin} (vidar.json lmstudioOrigin)")));
    }
    let fill = |args: &mut Vec<String>| args.iter_mut().for_each(|a| *a = a.replace(TOKEN, origin));
    fill(&mut r.args);
    for cmd in [&mut r.warm, &mut r.stop, &mut r.status].into_iter().flatten() {
        fill(&mut cmd.args);
    }
    Ok(r)
}

/// Resolves `which` slots and writes `bridge\voice-slots\resolved.json`
/// (`{version, slots: {<slot>: Resolved}, errors: {<slot>: SlotError}}`, camelCase) for
/// `speak.py --slots-file` and `speak.ps1`; a slot not asked for is in neither map. Speak asks
/// for `rewrite` only, so a press never hashes the stt model. Install tokens
/// (`{lmstudioOrigin}`) are filled (in `eval`); per-call tokens (`{budget}`, `{wav}`…) are
/// left for the stage.
pub fn write_resolved(which: &[Slot]) -> Result<PathBuf, String> {
    let ctx = Ctx::live();
    let (mut slots, mut errors) = (Map::new(), Map::new());
    for &slot in which {
        match resolve_in(&ctx, slot) {
            Ok(r) => slots.insert(slot.as_str().into(), serde_json::to_value(r).map_err(|e| e.to_string())?),
            Err(e) => errors.insert(slot.as_str().into(), serde_json::to_value(e).map_err(|e| e.to_string())?),
        };
    }
    let path = slots_dir().join("resolved.json");
    std::fs::create_dir_all(slots_dir()).map_err(|e| e.to_string())?;
    let body = json!({ "version": 1, "slots": slots, "errors": errors });
    crate::fsx::atomic_write(&path, &serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?)?;
    Ok(path)
}

/// Trust Current: re-records every pin the slot's adapter uses from the files as they are now.
/// The only writer that replaces a pin. A hash the manifest declares still has to match.
pub fn trust_current(slot: Slot) -> Result<(), String> {
    let ctx = Ctx::live();
    let scan = manifest::scan(&ctx.packs);
    let ev = eval(&ctx, &scan, &Ok(Store::default()), slot);
    if ev.resolved.is_none() {
        return Err(ev.reason.unwrap_or_else(|| "Empty (Optional)".into()));
    }
    pins::record(&ctx.pins, ev.unpinned, true)
}

/// Settings › Voice Slots: `status_all` off the UI thread (it may hash a model on first view).
#[tauri::command]
pub async fn voice_slots_status() -> Result<Vec<SlotStatus>, String> {
    tauri::async_runtime::spawn_blocking(status_all).await.map_err(|e| e.to_string())
}

/// One slot's `status_one` off the UI thread (voice-map's rewrite pill).
#[tauri::command]
pub async fn voice_slots_status_one(slot: Slot) -> Result<SlotStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status_one(slot)).await.map_err(|e| e.to_string())
}

/// Slot panel Trust Current: `trust_current` off the UI thread (it rehashes what the slot uses).
#[tauri::command]
pub async fn voice_slots_trust(slot: Slot) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trust_current(slot)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vidar-voice-slots-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn pack(root: &Path, id: &str, adapter: &str, manifest: &str) {
        put(&root.join(id).join("pack.json"), &json!({ "id": id, "version": 1, "slots": { "stt": [format!("voice/{adapter}.json")] } }).to_string());
        put(&root.join(id).join("voice").join(format!("{adapter}.json")), manifest);
    }

    fn stt(id: &str, slot: &str, command: &str) -> String {
        json!({ "version": 1, "id": id, "slot": slot, "label": "Test", "run": { "command": command, "args": ["-m", "{model}", "-f", "{wav}"] },
                "models": [{ "id": "m", "file": "{pack}/m.bin" }] }).to_string()
    }

    fn ctx(root: &Path, raw: Value) -> Ctx {
        Ctx { vidar: root.to_path_buf(), packs: root.join("packs"), home: None, pins: root.join("pins.json"), raw: Ok(raw), origin: "http://127.0.0.1:1234".into() }
    }

    #[test]
    fn voice_slots_untrusted_packs_come_back_broken_never_skipped() {
        let root = temp("broken");
        pack(&root, "p-big", "big", &format!("{{\"pad\":\"{}\"}}", "x".repeat(70 * 1024)));
        pack(&root, "p-slot", "odd", &stt("odd", "vad", "{pack}/x.exe"));
        pack(&root, "p-root", "abs", &stt("abs", "stt", "C:/Windows/System32/cmd.exe"));
        pack(&root, "p-dots", "up", &stt("up", "stt", "{pack}/../../x.exe"));
        pack(&root, "p-drive", "drive", &stt("drive", "stt", "{pack}/C:\\x.exe"));
        pack(&root, "p-unc", "unc", &stt("unc", "stt", "{vidar}/\\\\server\\x.exe"));
        std::fs::create_dir_all(root.join("p-none")).unwrap();
        let scan = manifest::scan(&root);
        assert!(scan.adapters.is_empty());
        let reason = |file_part: &str| {
            scan.broken.iter().find(|b| b.file.to_string_lossy().contains(file_part)).map(|b| b.reason.clone()).unwrap_or_default()
        };
        assert!(reason("big.json").contains("Over 64 KiB"), "{}", reason("big.json"));
        assert!(reason("odd.json").contains("Unknown Slot"), "{}", reason("odd.json"));
        assert!(reason("abs.json").contains("Bad Root"), "{}", reason("abs.json"));
        assert!(reason("up.json").contains("Bad Root"), "{}", reason("up.json"));
        assert!(reason("drive.json").contains("Bad Root"), "{}", reason("drive.json"));
        assert!(reason("unc.json").contains("Bad Root"), "{}", reason("unc.json"));
        assert_eq!(reason("p-none"), "No pack.json");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn voice_slots_pin_mismatch_makes_resolve_err() {
        let root = temp("pins");
        // a non-stock pack: all of its content is pinned (stock content under the root is repo content)
        pack(&root.join("packs"), "p-eng", "eng", &stt("eng", "stt", "{pack}/eng.exe"));
        let dir = root.join("packs").join("p-eng");
        put(&dir.join("eng.exe"), "engine");
        put(&dir.join("m.bin"), "model v1");
        let c = ctx(&root, json!({ "voiceSlots": { "stt": { "adapter": "p-eng/eng", "model": "m" } } }));
        let first = resolve_in(&c, Slot::Stt).expect("first use resolves and pins");
        assert_eq!(first.args[1], dir.join("m.bin").to_string_lossy());
        put(&dir.join("m.bin"), "model v2, swapped");
        let err = resolve_in(&c, Slot::Stt).expect_err("a changed model must not resolve");
        assert_eq!(err.state, State::Broken);
        assert!(err.reason.starts_with("Changed Since Pinned"), "{}", err.reason);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn voice_slots_pick_beats_legacy_and_absent_voice_is_missing() {
        let raw = json!({ "voiceSlots": { "stt": { "adapter": "voice-stock/whisper-cli", "model": "tiny.en-q8_0" } }, "voice": { "model": "base.en" } });
        assert_eq!(pick(&raw, Slot::Stt).unwrap(), Some(named("voice-stock/whisper-cli", Some("tiny.en-q8_0"), None)));
        let legacy = pick(&json!({ "voice": { "model": "base.en" } }), Slot::Stt).unwrap().unwrap();
        assert_eq!(legacy.legacy, Some("voice"));
        let root = temp("legacy");
        let rows = status_in(&ctx(&root, json!({ "wakeword": { "enabled": false } })));
        let stt_row = rows.iter().find(|r| r.slot == Some(Slot::Stt)).unwrap();
        assert_eq!((stt_row.state, stt_row.reason.as_deref()), (State::Missing, Some("No Pick")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn voice_slots_speak_rewrite_is_retired_except_none() {
        assert_eq!(pick(&json!({ "speakRewrite": "none" }), Slot::Rewrite).unwrap(), None);
        let root = temp("rewrite-retired");
        let err = resolve_in(&ctx(&root, json!({ "speakRewrite": "acme" })), Slot::Rewrite).expect_err("a retired speakRewrite must not resolve");
        assert_eq!((err.state, err.adapter.as_str(), err.reason.as_str()), (State::Broken, "speakRewrite", "speakRewrite Is Retired: Use voiceSlots.rewrite"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn voice_slots_claude_pack_move_requires_an_explicit_new_pick() {
        let root = temp("claude-pack-move");
        let packs = ctx(&root, Value::Null).packs;
        let old = packs.join(STOCK_PACK).join("voice").join("claude-p.json");
        put(&packs.join(STOCK_PACK).join("pack.json"), &json!({
            "id": STOCK_PACK, "version": 1, "slots": { "rewrite": [] }
        }).to_string());
        put(&old, "old trusted manifest"); // Present but no longer listed by voice-stock.
        let old_pin = pins::digest(&old).unwrap();
        pins::record(&root.join("pins.json"), vec![(old.clone(), old_pin.clone())], false).unwrap();

        let former = ctx(&root, json!({ "voiceSlots": { "rewrite": { "adapter": "voice-stock/claude-p" } } }));
        let err = resolve_in(&former, Slot::Rewrite).expect_err("old trusted id must not follow the move");
        assert_eq!((err.state, err.adapter.as_str()), (State::Broken, "voice-stock/claude-p"));
        assert!(err.reason.contains("claude/claude-p"), "{}", err.reason);
        assert_eq!(pins::load(&former.pins).unwrap().pins.get(&old.to_string_lossy().into_owned()), Some(&old_pin));

        let claude = packs.join("claude");
        put(&claude.join("pack.json"), &json!({
            "id": "claude", "version": 1, "slots": { "rewrite": ["voice/claude-p.json"] }
        }).to_string());
        let real = include_str!("../../../content/packs/claude/voice/claude-p.json");
        put(&claude.join("voice").join("claude-p.json"), real);
        put(&claude.join("voice").join("rewrite_claude.py"), "runner");
        // The interpreter the real manifest names, under the temp {vidar}.
        let m: manifest::Manifest = serde_json::from_str(real).unwrap();
        put(&root.join(m.run.command.strip_prefix("{vidar}/").expect("a {vidar}-rooted command")), "python");
        let selected = ctx(&root, json!({ "voiceSlots": { "rewrite": { "adapter": "claude/claude-p", "model": "claude-sonnet-5-5", "effort": "medium" } } }));
        let resolved = resolve_in(&selected, Slot::Rewrite).expect("Claude pack selection resolves");
        assert_eq!(resolved.adapter, "claude/claude-p");
        assert!(resolved.args.windows(2).any(|w| w[0] == "--model" && w[1] == "claude-sonnet-5-5"), "{:?}", resolved.args);
        assert!(resolved.args.windows(2).any(|w| w[0] == "--effort" && w[1] == "medium"), "{:?}", resolved.args);
        assert_eq!(resolved.source, Source::Pack { pack: "claude".into() });
        assert_eq!(resolved.args[0], claude.join("voice").join("rewrite_claude.py").to_string_lossy());
        assert_eq!(pins::load(&selected.pins).unwrap().pins.get(&old.to_string_lossy().into_owned()), Some(&old_pin));

        std::fs::remove_dir_all(&claude).unwrap();
        let err = resolve_in(&selected, Slot::Rewrite).expect_err("no-Claude set cannot resolve the pick");
        assert_eq!(err.state, State::Broken);
        assert!(err.reason.contains("Unknown Pick: claude/claude-p"), "{}", err.reason);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Trust boundary: a `modelIds` model id lands verbatim on the adapter's command line, in
    /// run and lifecycle args alike; one that reads as a flag is refused.
    #[test]
    fn voice_slots_model_ids_fill_run_and_warm_and_refuse_flags() {
        let root = temp("model-ids");
        let stock = ctx(&root, Value::Null).packs.join(STOCK_PACK);
        let real = include_str!("../../../content/packs/voice-stock/voice/openai-compat.json");
        put(&stock.join("pack.json"), &json!({ "id": STOCK_PACK, "version": 1, "slots": { "rewrite": ["voice/openai-compat.json"] } }).to_string());
        put(&stock.join("voice").join("openai-compat.json"), real);
        // The interpreter the real manifest names, under the temp {vidar}.
        let m: manifest::Manifest = serde_json::from_str(real).unwrap();
        put(&root.join(m.run.command.strip_prefix("{vidar}/").expect("a {vidar}-rooted command")), "python");
        let pick_model = |m: &str| ctx(&root, json!({ "voiceSlots": { "rewrite": { "adapter": "voice-stock/openai-compat", "model": m } } }));
        let r = resolve_in(&pick_model("m-1"), Slot::Rewrite).expect("a valid model id resolves");
        let has = |args: &[String]| args.windows(2).any(|w| w[0] == "--model" && w[1] == "m-1");
        assert!(has(&r.args), "run: {:?}", r.args);
        assert!(has(&r.warm.as_ref().expect("openai-compat has warm").args), "warm: {:?}", r.warm);
        let err = resolve_in(&pick_model("-x"), Slot::Rewrite).expect_err("a flag-shaped model id must not resolve");
        assert_eq!((err.state, err.reason.as_str()), (State::Broken, "Bad Model Id \"-x\""));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An `efforts` adapter: the pick's model and effort fill the run args; a missing, unlisted
    /// or flag-shaped effort is refused, and an adapter without `efforts` takes none.
    #[test]
    fn voice_slots_effort_fills_args_and_refuses_bad_values() {
        let root = temp("effort");
        let dir = root.join("packs").join("p-eff");
        put(&dir.join("pack.json"), &json!({ "id": "p-eff", "version": 1, "slots": { "rewrite": ["voice/eff.json", "voice/plain.json"] } }).to_string());
        let m = |id: &str, extra: Value| {
            let mut m = json!({ "version": 1, "id": id, "slot": "rewrite", "label": "E", "modelIds": true,
                "run": { "command": "{pack}/x.exe", "args": ["--model", "{model}", "--effort", "{effort}"] } });
            m.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            m.to_string()
        };
        put(&dir.join("voice").join("eff.json"), &m("eff", json!({ "efforts": ["low", "high"] })));
        put(&dir.join("voice").join("plain.json"), &m("plain", json!({})));
        put(&dir.join("x.exe"), "engine");
        let go = |adapter: &str, model: Option<&str>, effort: Option<&str>| {
            let mut p = json!({ "adapter": adapter });
            if let Some(v) = model { p["model"] = json!(v); }
            if let Some(v) = effort { p["effort"] = json!(v); }
            resolve_in(&ctx(&root, json!({ "voiceSlots": { "rewrite": p } })), Slot::Rewrite)
        };
        let r = go("p-eff/eff", Some("m-1"), Some("high")).expect("a listed effort resolves");
        assert_eq!(r.args, ["--model", "m-1", "--effort", "high"]);
        let err = |r: Result<Resolved, SlotError>| r.expect_err("must not resolve");
        let e = err(go("p-eff/eff", Some("m-1"), None));
        assert_eq!((e.state, e.reason.as_str()), (State::Missing, NO_EFFORT));
        let e = err(go("p-eff/eff", Some("m-1"), Some("medium")));
        assert_eq!((e.state, e.reason.as_str()), (State::Broken, "Effort Not Listed: medium"));
        for flag in ["--x", "-x"] {
            let e = err(go("p-eff/eff", Some("m-1"), Some(flag)));
            assert_eq!((e.state, e.reason.clone()), (State::Broken, format!("Bad Effort {flag:?}")));
        }
        let e = err(go("p-eff/plain", Some("m-1"), Some("low")));
        assert_eq!((e.state, e.reason.as_str()), (State::Broken, "Adapter Takes No Effort"));
        let e = err(resolve_in(&ctx(&root, json!({ "voiceSlots": { "rewrite": { "adapter": "p-eff/eff", "model": "m-1", "effort": 3 } } })), Slot::Rewrite));
        assert_eq!(e.state, State::Broken);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The shipped `claude/claude-p` manifest validates and resolves a Sonnet 5.5 / medium pick;
    /// its status row lists the adapter with efforts and suggested models.
    #[test]
    fn voice_slots_real_claude_pack_takes_model_and_effort() {
        let root = temp("real-claude");
        let claude = ctx(&root, Value::Null).packs.join("claude");
        put(&claude.join("pack.json"), &json!({ "id": "claude", "version": 1, "slots": { "rewrite": ["voice/claude-p.json"] } }).to_string());
        let real = include_str!("../../../content/packs/claude/voice/claude-p.json");
        put(&claude.join("voice").join("claude-p.json"), real);
        let m: manifest::Manifest = serde_json::from_str(real).unwrap();
        put(&root.join(m.run.command.strip_prefix("{vidar}/").expect("a {vidar}-rooted command")), "python");
        let scan = manifest::scan(&root.join("packs"));
        assert!(scan.broken.is_empty(), "{:?}", scan.broken.iter().map(|b| &b.reason).collect::<Vec<_>>());
        let c = ctx(&root, json!({ "voiceSlots": { "rewrite": { "adapter": "claude/claude-p", "model": "claude-sonnet-5-5", "effort": "medium" } } }));
        let r = resolve_in(&c, Slot::Rewrite).expect("the real pick resolves");
        assert!(r.args.windows(4).any(|w| w == ["--model", "claude-sonnet-5-5", "--effort", "medium"]), "{:?}", r.args);
        let row = status_in(&c).into_iter().find(|r| r.slot == Some(Slot::Rewrite)).unwrap();
        assert_eq!((row.state, row.effort.as_deref()), (State::Filled, Some("medium")));
        let wire = serde_json::to_value(&row).unwrap();
        println!("SlotStatus wire: {wire}");
        assert_eq!(wire["adapters"][0]["id"], "claude/claude-p");
        assert_eq!(wire["adapters"][0]["modelIds"], true);
        assert_eq!(wire["adapters"][0]["efforts"], json!(["low", "medium", "high"]));
        assert_eq!(wire["adapters"][0]["suggestedModels"][1], json!({ "id": "claude-sonnet-5-5", "label": "Sonnet 5.5" }));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The shipped `codex/codex-exec` manifest validates and resolves its first suggested model / medium.
    #[test]
    fn voice_slots_real_codex_pack_takes_model_and_effort() {
        let root = temp("real-codex");
        let codex = ctx(&root, Value::Null).packs.join("codex");
        put(&codex.join("pack.json"), &json!({ "id": "codex", "version": 1, "slots": { "rewrite": ["voice/codex-exec.json"] } }).to_string());
        let real = include_str!("../../../content/packs/codex/voice/codex-exec.json");
        put(&codex.join("voice").join("codex-exec.json"), real);
        let m: manifest::Manifest = serde_json::from_str(real).unwrap();
        put(&root.join(m.run.command.strip_prefix("{vidar}/").expect("a {vidar}-rooted command")), "python");
        let scan = manifest::scan(&root.join("packs"));
        assert!(scan.broken.is_empty(), "{:?}", scan.broken.iter().map(|b| &b.reason).collect::<Vec<_>>());
        let first = serde_json::from_str::<Value>(real).unwrap()["suggestedModels"][0]["id"].as_str().unwrap().to_string();
        let c = ctx(&root, json!({ "voiceSlots": { "rewrite": { "adapter": "codex/codex-exec", "model": first, "effort": "medium" } } }));
        let r = resolve_in(&c, Slot::Rewrite).expect("the real pick resolves");
        assert!(r.args.windows(4).any(|w| w[0] == "--model" && w[1] == first && w[2] == "--effort" && w[3] == "medium"), "{:?}", r.args);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Trust boundary: the reply transcript goes only to a loopback origin.
    #[test]
    fn voice_slots_origin_fills_only_on_loopback() {
        let r = || Resolved {
            adapter: "voice-stock/openai-compat".into(),
            source: Source::Stock,
            command: PathBuf::from("python.exe"),
            args: vec!["--origin".into(), "{lmstudioOrigin}".into()],
            model: None,
            warm: None,
            stop: None,
            status: None,
        };
        assert_eq!(fill_origin(r(), "http://127.0.0.1:1234").unwrap().args[1], "http://127.0.0.1:1234");
        for off in ["http://10.0.0.5:1234", "https://localhost:1234", "http://127.0.0.1:1234@evil"] {
            let err = fill_origin(r(), off).expect_err(off);
            assert_eq!(err.state, State::Broken, "{off}");
        }
    }

    #[test]
    fn voice_slots_empty_model_is_no_pick_not_broken() {
        let root = temp("empty-model");
        pack(&root.join("packs"), "p-eng", "eng", &stt("eng", "stt", "{pack}/eng.exe"));
        put(&root.join("packs").join("p-eng").join("eng.exe"), "engine");
        let c = ctx(&root, json!({ "voiceSlots": { "stt": { "adapter": "p-eng/eng", "model": " " } } }));
        let err = resolve_in(&c, Slot::Stt).expect_err("an empty model is no pick");
        assert_eq!((err.state, err.reason.as_str()), (State::Missing, NO_MODEL));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The shipped stock pack against the Rust validator (cross-language contract): tts is
    /// required, so a stock manifest that fails validation would break every Speak silently.
    #[test]
    fn voice_slots_real_stock_pack_validates() {
        // Under cfg(test) `paths::root()` is the checkout (CARGO_MANIFEST_DIR's parent).
        let packs = crate::paths::packs_dir();
        let scan = manifest::scan(&packs);
        let stock_broken: Vec<String> = scan.broken.iter()
            .filter(|b| b.file.to_string_lossy().contains(STOCK_PACK))
            .map(|b| format!("{}: {}", b.file.display(), b.reason)).collect();
        assert!(stock_broken.is_empty(), "{stock_broken:?}");
        for id in ["voice-stock/kokoro-kpipeline", "voice-stock/kokoro-onnx-int8"] {
            assert!(scan.adapters.iter().any(|a| a.qid() == id && a.slot == Slot::Tts), "{id} not a tts adapter");
        }
    }
}
