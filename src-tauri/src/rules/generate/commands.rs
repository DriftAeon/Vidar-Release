//! src-tauri\src\rules\generate\commands.rs — the `rules_generate*` IPC commands (docs/runs/2026-10-17-rune-generator
//! `ipc.md`; TS shapes `RulesGenerate*` in `src/ipc.ts`).
//! - `rules_generate`: one run, bound to no launcher row (model R5). Reads the ticked files, splits them into chunks
//!   (`chunk.rs`), builds the generator home (`home.rs`) and runs the tab's agent once per chunk, up to `pipeline::CAP`
//!   at a time, each call in its own call home under its own Job (`run.rs`, `pipeline.rs`). More than one chunk then
//!   takes a merge call (`merge.rs`), or lands unmerged with a warning when it fails twice. Ticked local skills,
//!   agents and hooks become item runes (`items.rs`) without an agent call. The result is prepared
//!   (`prepare_envelope`: render, validate) and lands as the library `gen-<runId>` with the set
//!   `generated-<yyyymmdd>` (`land.rs`); nothing else is written. Progress goes out as
//!   `rules-generate-progress` events (`progress.rs`). Errors are strings with one prefix:
//!   `cancelled | timeout | stale: | login: | spawn: | output: | invalid: | busy:`.
//! - `rules_generate_cancel {runId}`: ends every Job of the run while it has not reached commit; a no-op after.
//! One run at a time app-wide (`busy:`), because two would share the one generator home and the agent's meter.
//! Cancel and commit meet at one mutex: the commit step flips `committing` under it, and a cancel after that is
//! ignored, so a landed library is never reported as cancelled and a cancelled run never lands. The slot holds
//! every call's Job (`register` refuses once the run is cancelled or halted by a failed chunk).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use super::envelope::{self, Envelope};
use super::items::{self, Pick};
use super::land::{self, LandEnv};
use super::pipeline;
use super::progress::{self, Event, MergeState, Part, PlanChunk, PlanFile, ProgressEvent};
use super::render::Meta;
use super::run::{self, Raw, Spec};
use super::validate::PayloadCtx;
use super::{chunk, chunk_text, home, merge, payload, prepare_envelope, Input, Span};
use crate::bare::home::Guard;
use crate::job::Job;
use crate::rules::import::local::LocalFile;
use crate::rules::import::sources;

/// What the frontend sends (`RulesGenerateArgs`).
#[derive(Clone, Debug)]
pub struct Request {
    /// 8 lowercase hex, made by the frontend; the library is `gen-<runId>`.
    pub run_id: String,
    pub agent: String,
    pub model: String,
    pub effort: String,
    /// The merge call's effort, chosen by the frontend from the model's effort list; `low` when absent.
    pub merge_effort: Option<String>,
    /// Ticked rules and memory files the agent reads.
    pub paths: Vec<String>,
    /// Ticked local skills, agents and hooks, landed as item runes.
    pub items: Vec<Pick>,
}

/// `RulesGenerated`.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RulesGenerated {
    pub library: String,
    /// `generated-<yyyymmdd>`, the set Add to Vault puts in a vault.
    pub set: String,
    pub runes: usize,
    pub on: usize,
    pub encoded_chars: Option<usize>,
    pub cost_usd: Option<f64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub duration_ms: u64,
    pub warnings: Vec<String>,
}

/// Everything a run reads from the machine, explicit so tests run on temp roots.
pub struct Ctx<'a> {
    pub land: &'a LandEnv<'a>,
    /// The Vidar install root (`profiles\bare\*.json` and the sets payloads live under it).
    pub root: &'a Path,
    /// The usage ledger the generator calls are logged to (tests point it into a temp dir).
    pub ledger: &'a Path,
    /// This install's Bare home (`bare::home::resolve`); the generator homes sit inside it.
    pub bare_home: &'a Path,
    /// `profiles\bare\rune-create\SKILL.md`.
    pub skill: &'a Path,
    /// The merge pass's skill (`paths::rune_merge_skill`).
    pub merge_skill: &'a Path,
    pub guard: &'a Guard,
    /// `USERPROFILE`, for the profile-path check on rendered files.
    pub profile: Option<&'a str>,
    /// `YYYY-MM-DD`.
    pub date: &'a str,
    /// The environment the child's is derived from.
    pub parent_env: Vec<(OsString, OsString)>,
    /// The offered local files (`import::local::discover` for the tab's cwd); item picks must match one.
    pub offered: &'a (dyn Fn() -> Vec<LocalFile> + Sync),
}

/// Where the program comes from and how it runs, so tests substitute both.
pub struct Runner<'a> {
    pub exe: &'a (dyn Fn(&str, &Path, &[(OsString, OsString)]) -> Result<(PathBuf, Vec<String>), String> + Sync),
    /// Runs one call under its Job for at most the timeout, ending it as soon as the stop check is true.
    pub run: &'a (dyn Fn(&Spec, &Job, Duration, &(dyn Fn() -> bool + Sync)) -> Result<Raw, String> + Sync),
    /// How long the first chunk call runs alone before the rest start (`pipeline::FANOUT_DELAY`).
    pub fanout: Duration,
}

/// Receives every progress event of a run.
pub type Emit<'a> = &'a (dyn Fn(Event) + Sync);

struct Active {
    run_id: String,
    /// Every call's Job so far; a cancel or halt ends them all.
    jobs: Vec<Arc<Job>>,
    cancelled: bool,
    /// A chunk failed for good: its siblings end and nothing new starts.
    halted: bool,
    committing: bool,
}

/// The single in-flight run.
/// The second field remembers one cancel that arrived before its run began (the frontend cancels on its own clock).
pub struct Slot(Mutex<Option<Active>>, Mutex<Option<String>>);

impl Slot {
    pub const fn new() -> Slot {
        Slot(Mutex::new(None), Mutex::new(None))
    }

    fn lock(&self) -> MutexGuard<'_, Option<Active>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Lock order: the active run first, then this.
    fn pending(&self) -> MutexGuard<'_, Option<String>> {
        self.1.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn begin(&self, run_id: &str) -> Result<Lease<'_>, String> {
        let mut g = self.lock();
        if self.pending().take_if(|p| p == run_id).is_some() {
            return Err("cancelled".into());
        }
        if g.is_some() {
            return Err("busy: another generation is running".into());
        }
        *g = Some(Active { run_id: run_id.to_string(), jobs: Vec::new(), cancelled: false, halted: false, committing: false });
        Ok(Lease(self))
    }

    /// Takes a call's Job, so a cancel or halt reaches its child; refused once either has happened (the child would
    /// otherwise start after the terminate and run on).
    fn register(&self, job: Arc<Job>) -> Result<(), String> {
        let mut g = self.lock();
        match g.as_mut() {
            Some(a) if !a.cancelled && !a.halted => {
                a.jobs.push(job);
                Ok(())
            }
            _ => Err("cancelled".into()),
        }
    }

    /// Ends the run `run_id` if it has not reached commit.
    pub fn cancel(&self, run_id: &str) {
        let mut g = self.lock();
        match g.as_mut() {
            Some(a) if a.run_id == run_id && !a.committing => {
                a.cancelled = true;
                a.jobs.iter().for_each(|j| j.terminate());
            }
            Some(_) => {}
            // No run yet: `begin` for this id will refuse.
            None => *self.pending() = Some(run_id.to_string()),
        }
    }

    /// A chunk failed: ends every call and refuses new ones.
    fn halt(&self) {
        if let Some(a) = self.lock().as_mut() {
            a.halted = true;
            a.jobs.iter().for_each(|j| j.terminate());
        }
    }

    fn cancelled(&self) -> bool {
        self.lock().as_ref().is_some_and(|a| a.cancelled)
    }

    /// The live stop check: a cancel or a halt.
    fn stopped(&self) -> bool {
        self.lock().as_ref().is_some_and(|a| a.cancelled || a.halted)
    }

    /// The point of no return: `Err("cancelled")` when a cancel got in first, else cancels stop applying.
    fn enter_commit(&self) -> Result<(), String> {
        let mut g = self.lock();
        match g.as_mut() {
            Some(a) if a.cancelled => Err("cancelled".into()),
            Some(a) => {
                a.committing = true;
                Ok(())
            }
            None => Err("cancelled".into()),
        }
    }
}

/// Frees the slot when the run ends, however it ends.
struct Lease<'a>(&'a Slot);

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        *self.0.lock() = None;
    }
}

/// Removes the run's call homes on the way out, however the run ends.
struct CallsGuard<'a>(&'a home::RunHome);

impl Drop for CallsGuard<'_> {
    fn drop(&mut self) {
        home::remove_calls(self.0);
    }
}

/// Cost and tokens over every call that answered, retries and the merge included; `None` while none reported one.
#[derive(Default)]
struct Totals {
    cost_usd: Option<f64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

impl Totals {
    fn add(&mut self, r: &run::Reply) {
        fn plus<T: std::ops::Add<Output = T>>(a: Option<T>, b: Option<T>) -> Option<T> {
            match (a, b) {
                (Some(a), Some(b)) => Some(a + b),
                (a, b) => a.or(b),
            }
        }
        self.cost_usd = plus(self.cost_usd, r.cost_usd);
        self.input_tokens = plus(self.input_tokens, r.input_tokens);
        self.output_tokens = plus(self.output_tokens, r.output_tokens);
    }
}

/// What a chunk is called in an error: its paths, each with ` L<a>-<b>` when only part of the file, joined ", ".
fn part_label(spans: &[Span]) -> String {
    let shown: Vec<String> = spans
        .iter()
        .map(|s| if s.first == 1 && s.last == s.total { s.path.clone() } else { format!("{} L{}-{}", s.path, s.first, s.last) })
        .collect();
    shown.join(", ")
}

/// Puts the chunk's name into an `output:` or `timeout:` error: `output: <part>: <errors>`,
/// `timeout: <part> after <s> s; <what the child printed>`. Other errors are not about one part.
fn name_part(e: String, part: &str, begun: Instant) -> String {
    if let Some(rest) = e.strip_prefix("output: ") {
        format!("output: {part}: {rest}")
    } else if let Some(rest) = e.strip_prefix("timeout: ") {
        format!("timeout: {part} after {} s; {rest}", begun.elapsed().as_secs())
    } else {
        e
    }
}

/// The plan event: per chunk its files, a file cut across chunks as `Part K of N`.
fn plan_event(chunks: &[Vec<Span>]) -> ProgressEvent {
    let of = |path: &str| chunks.iter().flatten().filter(|s| s.path == path).count();
    let mut seen: Vec<(&str, usize)> = Vec::new();
    let chunks = chunks
        .iter()
        .map(|spans| PlanChunk {
            files: spans
                .iter()
                .map(|s| {
                    let n = of(&s.path);
                    let k = seen.iter().filter(|(p, _)| *p == s.path).count() + 1;
                    seen.push((s.path.as_str(), k));
                    PlanFile { path: s.path.clone(), part: (n > 1).then_some(Part { k, of: n }) }
                })
                .collect(),
        })
        .collect();
    ProgressEvent::Plan { chunks }
}

fn plain(s: &str, extra: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b) || extra.as_bytes().contains(&b))
}

fn check_request(r: &Request) -> Result<(), String> {
    if r.run_id.len() != 8 || !r.run_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(format!("invalid: run id `{}` is not 8 lowercase hex", r.run_id));
    }
    if r.agent != "claude" && r.agent != "codex" {
        return Err(format!("invalid: agent `{}` is not claude or codex", r.agent));
    }
    // Both go into an argument (Codex inside a quoted `-c` value): no quote, space or control character.
    if !plain(&r.model, "[]:") {
        return Err(format!("invalid: model `{}` is not a plain model name", r.model));
    }
    if !plain(&r.effort, "") {
        return Err(format!("invalid: effort `{}` is not a plain effort name", r.effort));
    }
    if r.merge_effort.as_deref().is_some_and(|m| !plain(m, "")) {
        return Err("invalid: merge effort is not a plain effort name".into());
    }
    if r.paths.is_empty() && r.items.is_empty() {
        return Err("invalid: no files were ticked".into());
    }
    Ok(())
}

fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The ticked files as the agent sees them: `~` path and text (a memory folder reads as its joined notes).
fn collect_inputs(home: Option<&Path>, paths: &[String]) -> Result<Vec<Input>, String> {
    let mut out: Vec<Input> = Vec::new();
    for p in paths {
        let full = sources::expand(p, home);
        let shown = sources::tilde(&full, home);
        if out.iter().any(|i| i.path.eq_ignore_ascii_case(&shown)) {
            continue;
        }
        let text = sources::read(&full).map_err(|e| format!("invalid: {e}"))?;
        out.push(Input { path: shown, text });
    }
    Ok(out)
}

/// Keeps an error that already carries a prefix; anything else from the landing code is `invalid:`.
fn prefixed(e: String) -> String {
    const KNOWN: [&str; 8] = ["cancelled", "timeout", "stale:", "login:", "spawn:", "output:", "invalid:", "busy:"];
    if KNOWN.iter().any(|k| e.starts_with(k)) {
        e
    } else {
        format!("invalid: {e}")
    }
}

/// The merge call's effort when the request names none (older callers). Rust has no model catalog, so the
/// frontend picks `low` or the request's effort per model and sends it as `mergeEffort`.
const MERGE_EFFORT: &str = "low";

fn run_one(ctx: &Ctx, slot: &Slot, rt: &Runner, req: &Request, emit: Emit, started: Instant) -> Result<RulesGenerated, String> {
    let inputs = collect_inputs(ctx.land.home, &req.paths)?;
    let read_skill = |p: &Path| crate::fsx::read_text(p).map_err(|e| format!("invalid: skill {} not readable ({e})", p.display()));
    let skill_text = read_skill(ctx.skill)?;
    let library = format!("gen-{}", req.run_id);
    if !land::is_generated_library(&library) {
        return Err(format!("invalid: `{library}` is not a generation library name"));
    }
    let set = generated_set(ctx.date);
    let picked = if req.items.is_empty() { (Vec::new(), Vec::new()) } else { items::resolve(&req.items, &(ctx.offered)(), ctx.land.home, &[])? };
    let (env, notes, totals) = if inputs.is_empty() {
        (Envelope { runes: Vec::new(), sections: Vec::new(), dropped: Vec::new() }, Vec::new(), Totals::default())
    } else {
        agent_runes(ctx, slot, rt, req, emit, &inputs, &skill_text)?
    };
    // Item ids give way to the agent's rune ids.
    let taken: Vec<String> = env.runes.iter().map(|r| r.id.clone()).collect();
    let (item_specs, item_warnings) = if picked.0.iter().any(|i| taken.contains(&i.id)) {
        items::resolve(&req.items, &(ctx.offered)(), ctx.land.home, &taken)?
    } else {
        picked
    };

    let parts = payload::parts(&req.agent, ctx.root, ctx.bare_home, ctx.land)?;
    let root_text = ctx.root.to_string_lossy();
    let home_text = ctx.bare_home.to_string_lossy();
    let pctx = PayloadCtx { agent: &req.agent, template: &parts.template, row: None, root: &root_text, home: &home_text, guard: ctx.guard };
    let skill_sha = sha_hex(skill_text.as_bytes());
    let meta = Meta {
        library: &library,
        set: &set,
        items: &item_specs,
        agent: &req.agent,
        model: &req.model,
        effort: &req.effort,
        skill_sha256: &skill_sha,
        date: ctx.date,
        profile: ctx.profile,
    };
    let mut prepared = prepare_envelope(&env, &inputs, &meta, &pctx).map_err(|errs| format!("output: {}", errs.join("; ")))?;
    let mut notes = notes;
    notes.extend(item_warnings);
    if !notes.is_empty() {
        // The merge pass's and the items' warnings ride into generate.json too.
        prepared.warnings.splice(0..0, notes);
        prepared.manifest.warnings = prepared.warnings.clone();
        if let Some(last) = prepared.files.last_mut().filter(|f| f.0 == "generate.json") {
            last.1 = super::render::generate_json_text(&prepared.manifest);
        }
    }

    slot.enter_commit()?;
    let landed = land::commit_at(ctx.land, &prepared).map_err(prefixed)?;
    Ok(RulesGenerated {
        library: landed.library,
        set: landed.set,
        runes: prepared.runes + item_specs.len(),
        on: prepared.on,
        encoded_chars: prepared.encoded_chars,
        cost_usd: totals.cost_usd,
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        duration_ms: started.elapsed().as_millis() as u64,
        warnings: prepared.warnings,
    })
}

/// `generated-<yyyymmdd>` from `YYYY-MM-DD`.
pub fn generated_set(date: &str) -> String {
    format!("generated-{}", date.replace('-', ""))
}

/// The agent stage: chunk calls, then the merge call when more than one chunk holds runes. Returns the envelope,
/// the merge pass's warnings and the cost totals.
fn agent_runes(
    ctx: &Ctx,
    slot: &Slot,
    rt: &Runner,
    req: &Request,
    emit: Emit,
    inputs: &[Input],
    skill_text: &str,
) -> Result<(Envelope, Vec<String>, Totals), String> {
    let inputs = inputs.to_vec();
    let skill_text = skill_text.to_string();
    let read_skill = |p: &Path| crate::fsx::read_text(p).map_err(|e| format!("invalid: skill {} not readable ({e})", p.display()));
    let merge_text = read_skill(ctx.merge_skill)?;
    let run_home = home::build_run(&req.agent, ctx.bare_home, &req.run_id, &skill_text, Some(&merge_text))?;
    let _clean = CallsGuard(&run_home);

    let spans = chunk::split(&inputs, chunk::CHUNK_CHARS);
    let n = spans.len();
    let base_env = run::child_env(ctx.parent_env.iter().cloned(), &req.agent, &run_home.dir);
    let (program, lead_args) = (rt.exe)(&req.agent, ctx.root, &base_env)?;
    let totals = Mutex::new(Totals::default());
    let say = |event: ProgressEvent| emit(Event { run_id: req.run_id.clone(), event });

    // One agent call in a home of its own and under its own Job. `merge` picks the merge skill over the create skill.
    let invoke = |name: &str, merge: bool, input: String, effort: &str, timeout: Duration| -> Result<run::Reply, String> {
        if slot.stopped() {
            return Err("cancelled".into());
        }
        let gen_home = home::call(&run_home, name)?;
        home::assert_clean(&gen_home)?;
        let env = run::child_env(ctx.parent_env.iter().cloned(), &req.agent, &gen_home.dir);
        let (system_path, system_text) = if merge {
            (run_home.merge_skill.as_ref().ok_or("spawn: generator home holds no merge skill copy")?, merge_text.as_str())
        } else {
            (&run_home.skill, skill_text.as_str())
        };
        let mut args = lead_args.clone();
        let stdin = if req.agent == "claude" {
            args.extend(run::claude_argv(&req.model, effort, system_path));
            input
        } else {
            args.extend(run::codex_argv(&req.model, effort, &gen_home.cwd));
            format!("{system_text}\n\n---\n{input}")
        };
        let spec = Spec { program: program.clone(), args, env, cwd: gen_home.cwd.clone(), config: Some(gen_home.config.clone()), stdin };
        let job = Arc::new(Job::new().map_err(|e| format!("spawn: job object not made ({e})"))?);
        slot.register(job.clone())?;
        let ran = (rt.run)(&spec, &job, timeout, &|| slot.stopped());
        // A login the CLI refreshed into the call's own file outlives the call (`remove_calls`).
        home::hand_back(&run_home, &gen_home);
        let raw = ran?;
        if slot.stopped() {
            return Err("cancelled".into());
        }
        // Logged before classification: a reply that reported an error still spent the tokens.
        if let Some(entry) = crate::usage_ledger::from_rune_gen(&req.agent, &raw.stdout, &req.model) {
            crate::usage_ledger::append(ctx.ledger, &entry);
        }
        let reply = run::classify(&req.agent, &raw)?;
        totals.lock().unwrap_or_else(|e| e.into_inner()).add(&reply);
        Ok(reply)
    };

    // One chunk: its call, then its reply read against the parts that call was shown. A single chunk is the whole
    // library, so its errors need no part name.
    let attempt = |k: usize, t: usize| -> Result<Envelope, String> {
        let begun = Instant::now();
        let label = if n > 1 { part_label(&spans[k]) } else { String::new() };
        let input = chunk_text(&inputs, &spans[k], &req.agent);
        let named = |e: String| if n > 1 { name_part(e, &label, begun) } else { e };
        let reply = invoke(&format!("c{:02}-{t}", k + 1), false, input, &req.effort, run::CHUNK_TIMEOUT).map_err(named)?;
        envelope::parse_in(&reply.text, &inputs, &spans[k], n > 1).map_err(|errs| {
            if n > 1 {
                format!("output: {label}: {}", errs.join("; "))
            } else {
                format!("output: {}", errs.join("; "))
            }
        })
    };

    say(plan_event(&spans));
    let mut envs = pipeline::run(n, pipeline::CAP, rt.fanout, attempt, |e: &Envelope| e.runes.len(), || slot.stopped(), || slot.halt(), &say)?;
    if slot.cancelled() {
        return Err("cancelled".into());
    }

    let holding: Vec<usize> = (0..envs.len()).filter(|&k| !envs[k].runes.is_empty()).collect();
    if holding.is_empty() {
        // Nothing to merge, and the same text `envelope::check` gives an empty reply.
        return Err("output: runes: empty; a reply needs at least one rune".into());
    }
    let mut notes: Vec<String> = Vec::new();
    let env = if holding.len() == 1 {
        // One part holds every rune: nothing to merge, so no merge call.
        envs.swap_remove(holding[0])
    } else {
        merge::rename_collisions(&mut envs);
        let all = merge::unmerged(&envs, "").0;
        say(ProgressEvent::Merge { state: MergeState::Running });
        let mut failure = String::new();
        let mut merged = None;
        for t in 0..2 {
            let input = merge::input_text(&all, &req.agent);
            let tried = invoke(&format!("merge-{t}"), true, input, req.merge_effort.as_deref().unwrap_or(MERGE_EFFORT), run::MERGE_TIMEOUT)
                .and_then(|reply| merge::apply(&all, &reply.text, &inputs));
            match tried {
                Ok(done) => {
                    merged = Some(done);
                    break;
                }
                Err(e) if e == "cancelled" || slot.stopped() => return Err("cancelled".into()),
                Err(e) => failure = e,
            }
        }
        match merged {
            Some((env, warnings)) => {
                say(ProgressEvent::Merge { state: MergeState::Done });
                notes.extend(warnings);
                env
            }
            None => {
                say(ProgressEvent::Merge { state: MergeState::Failed });
                let reason = failure.split_whitespace().collect::<Vec<_>>().join(" ");
                let (env, warning) = merge::unmerged(&envs, &reason);
                envelope::check(&env, &inputs).map_err(|errs| format!("output: {}", errs.join("; ")))?;
                notes.push(warning);
                env
            }
        }
    };
    let totals = totals.into_inner().unwrap_or_else(|e| e.into_inner());
    Ok((env, notes, totals))
}

/// One generation end to end on `ctx`, single-flight through `slot`.
pub fn generate_at(ctx: &Ctx, slot: &Slot, rt: &Runner, req: &Request, emit: Emit) -> Result<RulesGenerated, String> {
    check_request(req)?;
    let _lease = slot.begin(&req.run_id)?;
    // A cancel dominates any error from before the commit (setup or runner); after `enter_commit` it cannot be set.
    run_one(ctx, slot, rt, req, emit, Instant::now()).map_err(|e| if slot.cancelled() { "cancelled".to_string() } else { e })
}

/// UTC `YYYY-MM-DD` (as `rules/import/commands.rs` `today`).
fn today() -> String {
    let days = (crate::fsx::now_ms() / 86_400_000) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

static SLOT: Slot = Slot::new();

/// Runs `f` over the live machine: vidar.json, the install root, `runtime\runes\` and this install's Bare home.
/// `cwd`, when it names a folder, overrides vidar.json `defaultCwd` for import-library naming (the tab's cwd).
fn live<R>(cwd: Option<&str>, f: impl FnOnce(&Ctx) -> Result<R, String>) -> Result<R, String> {
    let (config, root, imports, home) = (crate::paths::config_path(), crate::paths::root(), crate::paths::rune_imports_dir(), crate::paths::home());
    let cfg: Value = crate::fsx::read_text(&config).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let text = |k: &str| cfg.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let cwd = cwd.map(str::trim).filter(|c| !c.is_empty()).map(PathBuf::from).filter(|p| p.is_dir()).or_else(|| text("defaultCwd").map(PathBuf::from).filter(|p| p.is_dir()));
    let land = LandEnv { config: &config, imports: &imports, home: home.as_deref(), cwd: cwd.as_deref() };
    let bare_home = crate::bare::home::resolve().map_err(|e| format!("spawn: {e}"))?;
    let skill = crate::paths::rune_create_skill();
    let merge_skill = crate::paths::rune_merge_skill();
    let guard = Guard::from_vidar_env();
    let profile = std::env::var("USERPROFILE").ok().filter(|v| !v.trim().is_empty());
    let date = today();
    let ledger = crate::paths::usage_ledger_path_in(&root);
    // The same discovery `bare_local_sources` serves the tab, for the tab's cwd.
    let shown_cwd = land.cwd.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let offered = move || crate::rules::import::local::bare_local_sources(shown_cwd.clone()).files;
    f(&Ctx { land: &land, root: &root, ledger: &ledger, bare_home: &bare_home, skill: &skill, merge_skill: &merge_skill, guard: &guard, profile: profile.as_deref(), date: &date, parent_env: std::env::vars_os().collect(), offered: &offered })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rules_generate(
    app: AppHandle,
    run_id: String,
    agent: String,
    model: String,
    effort: String,
    merge_effort: Option<String>,
    paths: Vec<String>,
    items: Option<Vec<Pick>>,
    cwd: Option<String>,
) -> Result<RulesGenerated, String> {
    let req = Request { run_id, agent, model, effort, merge_effort, paths, items: items.unwrap_or_default() };
    // No `settings-changed`: landing writes the library only, never vidar.json.
    let events = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let run = |s: &Spec, j: &Job, t: Duration, stop: &(dyn Fn() -> bool + Sync)| run::execute_until(s, j, t, run::OUT_CAP, stop);
        let rt = Runner { exe: &run::resolve_exe, run: &run, fanout: pipeline::FANOUT_DELAY };
        // Best-effort: a lost progress event only leaves a card stale.
        let emit = |e: Event| {
            let _ = events.emit(progress::EVENT, e);
        };
        live(cwd.as_deref(), |ctx| generate_at(ctx, &SLOT, &rt, &req, &emit))
    })
    .await
    .map_err(|e| format!("spawn: generator thread failed ({e})"))?
}

#[tauri::command]
pub fn rules_generate_cancel(run_id: String) {
    SLOT.cancel(&run_id);
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
