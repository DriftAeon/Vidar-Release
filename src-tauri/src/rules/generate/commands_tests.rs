//! Tests for `commands.rs`: the run end to end on temp roots with a fake runner (no real `claude` or `codex`).

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use super::super::envelope::{Envelope, RuneOut, Section, Source};
use super::super::progress::ChunkState;
use super::*;

const ROW: &str = "claude-rendered-bare";
const CODEX_ROW: &str = "codex-rendered-bare";
const PATH: &str = r"~\.claude\CLAUDE.md";
const PATH_A: &str = r"~\.claude\a.md";
const PATH_B: &str = r"~\.claude\b.md";
const RUN: &str = "0a1b2c3d";

struct Fx {
    base: PathBuf,
    root: PathBuf,
    /// The fixture's own usage ledger, under `base`: generator calls never log into the repo's.
    ledger: PathBuf,
    imports: PathBuf,
    index: PathBuf,
    home: PathBuf,
    config: PathBuf,
    bare: PathBuf,
    skill: PathBuf,
    merge_skill: PathBuf,
    guard: Guard,
    /// The local files the run offers for item picks.
    offered: Vec<LocalFile>,
}

impl Fx {
    fn new(tag: &str) -> Fx {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("vidar-gencmd-{tag}-{}-{nanos}", std::process::id()));
        let (home, bare, imports) = (base.join("home"), base.join("bare"), base.join("imports"));
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude").join("CLAUDE.md"), "Line 1.\nLine 2.\nLine 3.\n").unwrap();
        // Two files of about 4.6K rendered characters each: with CLAUDE.md the first two fill one chunk, b.md the next.
        for name in ["a.md", "b.md"] {
            let text: String = (1..=100).map(|n| format!("Rule number {n} is stated in this line.\n")).collect();
            std::fs::write(home.join(".claude").join(name), text).unwrap();
        }
        for (folder, file) in [("claude-config", ".credentials.json"), ("codex-home", "auth.json")] {
            std::fs::create_dir_all(bare.join(folder)).unwrap();
            std::fs::write(bare.join(folder).join(file), "fake-login").unwrap();
        }
        // The repo's own profiles and skills: read-only here.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let skill = root.join("profiles").join("bare").join("rune-create").join("SKILL.md");
        let merge_skill = root.join("profiles").join("bare").join("rune-create").join("MERGE.md");
        let fx = Fx {
            config: base.join("config.json"),
            ledger: base.join("usage-ledger.jsonl"),
            index: imports.join("gen-index.json"),
            guard: Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) },
            base,
            root,
            imports,
            home,
            bare,
            skill,
            merge_skill,
            offered: Vec::new(),
        };
        fx.write_config(json!([]));
        fx
    }

    fn land(&self) -> LandEnv<'_> {
        LandEnv { config: &self.config, imports: &self.imports, home: Some(&self.home), cwd: None }
    }

    fn write_config(&self, sets: Value) {
        let v = json!({ "agents": [{ "key": ROW, "sets": sets }, { "key": CODEX_ROW, "sets": [] }] });
        std::fs::write(&self.config, v.to_string()).unwrap();
    }

    fn config_text(&self) -> String {
        std::fs::read_to_string(&self.config).unwrap()
    }

    fn with<R>(&self, f: impl FnOnce(&Ctx) -> R) -> R {
        let land = self.land();
        let offered = || self.offered.clone();
        f(&Ctx {
            offered: &offered,
            land: &land,
            root: &self.root,
            ledger: &self.ledger,
            bare_home: &self.bare,
            skill: &self.skill,
            merge_skill: &self.merge_skill,
            guard: &self.guard,
            profile: Some(r"C:\Users\testuser"),
            date: "2026-10-17",
            parent_env: vec![("PATH".into(), "C:\\fake".into()), ("CLAUDE_CODE_OAUTH_TOKEN".into(), "x".into())],
        })
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn request(agent: &str) -> Request {
    Request {
        run_id: RUN.into(),
        agent: agent.into(),
        model: if agent == "claude" { "sonnet" } else { "gpt-5.5" }.into(),
        effort: "medium".into(),
        merge_effort: None,
        paths: vec![PATH.into()],
        items: vec![],
    }
}

/// The library every run in these tests lands as.
fn gen_lib() -> String {
    format!("gen-{RUN}")
}

/// Three files, which `chunk::split` cuts into two chunks: CLAUDE.md with a.md, then b.md.
fn multi_request() -> Request {
    Request { paths: vec![PATH.into(), PATH_A.into(), PATH_B.into()], ..request("claude") }
}

fn rune_in(path: &str, id: &str, body: &str, line: usize) -> RuneOut {
    RuneOut {
        id: id.into(),
        kind: "rule".into(),
        description: format!("About {id}"),
        body: body.into(),
        sources: vec![Source { path: path.into(), line }],
        ..Default::default()
    }
}

fn rune(id: &str, body: &str, line: usize) -> RuneOut {
    rune_in(PATH, id, body, line)
}

fn envelope_text(runes: Vec<RuneOut>) -> String {
    let ids = runes.iter().map(|r| r.id.clone()).collect();
    serde_json::to_string(&Envelope { runes, sections: vec![Section { heading: "Rules".into(), ids }], dropped: vec![] }).unwrap()
}

/// A reply that passes: two plain runes and one draft-locked.
fn reply() -> String {
    envelope_text(vec![rune("keep-a", "Never guess.", 1), rune("keep-b", "Always test.", 2), rune("braces", "Fill {{name}} in.", 3)])
}

/// The first chunk's reply (CLAUDE.md and a.md) and the second's (b.md); both use the id `shared`.
fn reply_first() -> String {
    envelope_text(vec![rune("keep-a", "Never guess.", 1), rune_in(PATH_A, "shared", "Run the tests.", 1)])
}

fn reply_second() -> String {
    envelope_text(vec![rune_in(PATH_B, "shared", "Always run the tests.", 1), rune_in(PATH_B, "only-b", "Name things well.", 2)])
}

/// The merge reply for `reply_first` + `reply_second` once `shared-2` is renamed: one rune absorbs the other.
fn reply_merge() -> String {
    json!({
        "merge": [{ "into": "shared", "from": ["shared-2"], "body": "Run the tests always." }],
        "sections": [{ "heading": "Rules", "ids": ["keep-a", "shared", "only-b"] }],
    })
    .to_string()
}

fn claude_raw(result: &str) -> Raw {
    let out = json!({ "type": "result", "is_error": false, "result": result, "total_cost_usd": 0.01, "usage": { "input_tokens": 100, "output_tokens": 50 } });
    Raw { exit: Some(0), stdout: out.to_string().into_bytes(), ..Raw::default() }
}

fn codex_raw(result: &str) -> Raw {
    let item = json!({ "type": "item.completed", "item": { "type": "agent_message", "text": result } });
    let done = json!({ "type": "turn.completed", "usage": { "input_tokens": 200, "output_tokens": 60 } });
    Raw { exit: Some(0), stdout: format!("{item}\n{done}\n").into_bytes(), ..Raw::default() }
}

fn claude_exe(_: &str, _: &Path, _: &[(OsString, OsString)]) -> Result<(PathBuf, Vec<String>), String> {
    Ok((PathBuf::from("claude.exe"), Vec::new()))
}

fn codex_exe(_: &str, _: &Path, _: &[(OsString, OsString)]) -> Result<(PathBuf, Vec<String>), String> {
    Ok((PathBuf::from("node.exe"), vec!["codex.js".into()]))
}

/// A runner over the fake exe and `run`; every chunk call may start at once.
fn runner<'a>(
    exe: &'a (dyn Fn(&str, &Path, &[(OsString, OsString)]) -> Result<(PathBuf, Vec<String>), String> + Sync),
    run: &'a (dyn Fn(&Spec, &Job, Duration, &(dyn Fn() -> bool + Sync)) -> Result<Raw, String> + Sync),
) -> Runner<'a> {
    Runner { exe, run, fanout: Duration::ZERO }
}

fn silent(_: Event) {}

/// The states chunk `index` went through, in order.
fn chunk_states(events: &[ProgressEvent], index: usize) -> Vec<ChunkState> {
    events.iter().filter_map(|e| if let ProgressEvent::Chunk { index: i, state, .. } = e { (*i == index).then_some(*state) } else { None }).collect()
}

/// What a fake agent answers to a multi-chunk run: each chunk its reply, the merge call `merge` (or junk).
fn answer(stdin: &str, second_ok: bool, merge: Option<&str>) -> Raw {
    if stdin.contains("=== FILE") {
        if !stdin.contains(PATH_B) {
            claude_raw(&reply_first())
        } else if second_ok {
            claude_raw(&reply_second())
        } else {
            claude_raw("garbage")
        }
    } else {
        claude_raw(merge.unwrap_or("not a merge reply"))
    }
}

#[test]
fn a_claude_run_lands_the_library_and_frees_the_slot() {
    let fx = Fx::new("claude-ok");
    let slot = Slot::new();
    let seen: Mutex<Option<(Vec<String>, String, PathBuf, Vec<String>)>> = Mutex::new(None);
    let run = |s: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| {
        let env = s.env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        *seen.lock().unwrap() = Some((s.args.clone(), s.stdin.clone(), s.cwd.clone(), env));
        assert!(s.cwd.is_dir(), "the empty cwd exists while the agent runs");
        Ok(claude_raw(&reply()))
    };
    let before = fx.config_text();
    let out = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &request("claude"), &silent)).unwrap();
    assert_eq!((out.library.as_str(), out.set.as_str()), (gen_lib().as_str(), "generated-20261017"));
    assert_eq!((out.runes, out.on), (3, 2));
    assert_eq!((out.cost_usd, out.input_tokens, out.output_tokens), (Some(0.01), Some(100), Some(50)));
    assert_eq!(out.encoded_chars, None);
    let (args, stdin, cwd, env) = seen.lock().unwrap().take().unwrap();
    assert!(args.windows(2).any(|w| w[0] == "--system-prompt-file" && w[1].ends_with("skill.md")), "{args:?}");
    assert!(stdin.starts_with("Target agent: claude\n") && stdin.contains("=== FILE ~\\.claude\\CLAUDE.md (3 lines)"), "{stdin}");
    assert!(env.iter().any(|k| k == "CLAUDE_CONFIG_DIR") && !env.iter().any(|k| k == "CLAUDE_CODE_OAUTH_TOKEN"), "{env:?}");
    assert!(!cwd.exists(), "the working folder is removed after the run");
    assert_eq!(fx.config_text(), before, "vidar.json is never written");
    assert!(!fx.index.exists(), "no gen-index entry");
    assert!(fx.imports.join(&out.library).join("generate.json").is_file());
    assert!(fx.imports.join(&out.library).join("sets").join("generated-20261017.md").is_file());
    assert!(slot.begin("ffffffff").is_ok(), "the slot is free");
}

#[test]
fn a_run_logs_to_the_fixture_ledger_and_not_the_repos() {
    let fx = Fx::new("ledger");
    let run = |_: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| Ok(claude_raw(&reply()));
    fx.with(|ctx| generate_at(ctx, &Slot::new(), &runner(&claude_exe, &run), &request("claude"), &silent)).unwrap();
    assert!(fx.ledger.starts_with(std::env::temp_dir()), "{:?}", fx.ledger);
    assert_ne!(fx.ledger, crate::paths::usage_ledger_path_in(&fx.root));
    let text = std::fs::read_to_string(&fx.ledger).unwrap();
    assert!(text.contains("\"source\":\"rune-gen\""), "{text}");
}

#[test]
fn a_codex_run_puts_skill_and_input_on_stdin_and_reports_the_size() {
    let fx = Fx::new("codex-ok");
    let slot = Slot::new();
    let seen: Mutex<Option<(PathBuf, Vec<String>, String)>> = Mutex::new(None);
    let run = |s: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| {
        *seen.lock().unwrap() = Some((s.program.clone(), s.args.clone(), s.stdin.clone()));
        Ok(codex_raw(&reply()))
    };
    let out = fx.with(|ctx| generate_at(ctx, &slot, &runner(&codex_exe, &run), &request("codex"), &silent)).unwrap();
    assert_eq!(out.library, gen_lib());
    assert_eq!((out.cost_usd, out.input_tokens), (None, Some(200)));
    assert!(out.encoded_chars.is_some_and(|n| n > 0 && n < 12000), "{:?}", out.encoded_chars);
    let (program, args, stdin) = seen.lock().unwrap().take().unwrap();
    assert_eq!(program, PathBuf::from("node.exe"));
    assert_eq!(args[..2], ["codex.js", "exec"]);
    assert_eq!(args.last().map(String::as_str), Some("-"));
    assert!(stdin.contains("\n\n---\nTarget agent: codex\n"), "{}", &stdin[stdin.len().min(200)..]);
}

#[test]
fn a_multi_chunk_run_lands_the_merged_library_with_summed_cost_and_ordered_events() {
    let fx = Fx::new("multi-ok");
    let slot = Slot::new();
    let stdins: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let run = |s: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| {
        stdins.lock().unwrap().push(s.stdin.clone());
        Ok(answer(&s.stdin, true, Some(&reply_merge())))
    };
    let events: Mutex<Vec<Event>> = Mutex::new(Vec::new());
    let emit = |e: Event| events.lock().unwrap().push(e);
    let out = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &multi_request(), &emit)).unwrap();
    assert_eq!((out.runes, out.library.as_str()), (3, gen_lib().as_str()));
    // Two chunk calls and the merge call, each reporting $0.01 and 100 + 50 tokens.
    assert!(out.cost_usd.is_some_and(|c| (c - 0.03).abs() < 1e-9), "{:?}", out.cost_usd);
    assert_eq!((out.input_tokens, out.output_tokens), (Some(300), Some(150)));
    assert!(!out.warnings.iter().any(|w| w.starts_with("Merge pass failed")), "{:?}", out.warnings);
    assert!(fx.imports.join(&out.library).is_dir());

    let stdins = stdins.into_inner().unwrap();
    assert_eq!(stdins.len(), 3);
    assert!(stdins.iter().filter(|s| s.contains("=== FILE")).all(|s| s.starts_with("Target agent: claude\n")));
    let merge_in = stdins.iter().find(|s| !s.contains("=== FILE")).unwrap();
    assert!(merge_in.contains("shared | rule |") && merge_in.contains("shared-2 | rule |"), "{merge_in}");

    let events = events.into_inner().unwrap();
    assert!(events.iter().all(|e| e.run_id == RUN));
    let events: Vec<ProgressEvent> = events.into_iter().map(|e| e.event).collect();
    let file = |path: &str| PlanFile { path: path.into(), part: None };
    let plan = ProgressEvent::Plan { chunks: vec![PlanChunk { files: vec![file(PATH), file(PATH_A)] }, PlanChunk { files: vec![file(PATH_B)] }] };
    assert_eq!(events.first(), Some(&plan));
    assert_eq!(events[events.len() - 2..], [ProgressEvent::Merge { state: MergeState::Running }, ProgressEvent::Merge { state: MergeState::Done }]);
    assert!(events[1..events.len() - 2].iter().all(|e| matches!(e, ProgressEvent::Chunk { .. })), "{events:?}");
    assert_eq!(chunk_states(&events, 0), [ChunkState::Running, ChunkState::Done]);
    assert_eq!(chunk_states(&events, 1), [ChunkState::Running, ChunkState::Done]);
    assert!(events.contains(&ProgressEvent::Chunk { index: 0, state: ChunkState::Done, runes: Some(2) }));
    assert!(!fx.bare.join("gen-claude").join("calls").exists(), "the call homes are removed");
}

#[test]
fn a_merge_that_fails_twice_lands_the_chunks_unmerged_with_the_warning() {
    let fx = Fx::new("multi-unmerged");
    let slot = Slot::new();
    let merges = AtomicUsize::new(0);
    let run = |s: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| {
        if !s.stdin.contains("=== FILE") {
            merges.fetch_add(1, Ordering::SeqCst);
        }
        Ok(answer(&s.stdin, true, None))
    };
    let events: Mutex<Vec<Event>> = Mutex::new(Vec::new());
    let emit = |e: Event| events.lock().unwrap().push(e);
    let out = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &multi_request(), &emit)).unwrap();
    assert_eq!(merges.load(Ordering::SeqCst), 2, "one retry, then unmerged");
    assert_eq!(out.runes, 4, "all four chunk runes, the colliding id renamed");
    assert!(out.warnings.iter().any(|w| w.starts_with("Merge pass failed (") && w.ends_with("runes from separate parts were not merged.")), "{:?}", out.warnings);
    let manifest = std::fs::read_to_string(fx.imports.join(&out.library).join("generate.json")).unwrap();
    assert!(manifest.contains("Merge pass failed"), "the warning is in generate.json too");
    let events: Vec<ProgressEvent> = events.into_inner().unwrap().into_iter().map(|e| e.event).collect();
    let merge_states: Vec<MergeState> = events.iter().filter_map(|e| if let ProgressEvent::Merge { state } = e { Some(*state) } else { None }).collect();
    assert_eq!(merge_states, [MergeState::Running, MergeState::Failed]);
}

#[test]
fn a_chunk_that_fails_twice_with_output_fails_the_run_naming_its_part() {
    let fx = Fx::new("multi-reject");
    let slot = Slot::new();
    let before = fx.config_text();
    let seconds = AtomicUsize::new(0);
    let run = |s: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| {
        if s.stdin.contains(PATH_B) {
            seconds.fetch_add(1, Ordering::SeqCst);
        }
        Ok(answer(&s.stdin, false, Some(&reply_merge())))
    };
    let events: Mutex<Vec<Event>> = Mutex::new(Vec::new());
    let emit = |e: Event| events.lock().unwrap().push(e);
    let err = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &multi_request(), &emit)).unwrap_err();
    assert!(err.starts_with(&format!("output: {PATH_B}: reply is not one JSON object")), "{err}");
    assert_eq!(seconds.load(Ordering::SeqCst), 2, "tried, retried, then failed");
    assert_eq!(fx.config_text(), before);
    let events: Vec<ProgressEvent> = events.into_inner().unwrap().into_iter().map(|e| e.event).collect();
    assert_eq!(chunk_states(&events, 1), [ChunkState::Running, ChunkState::Retrying, ChunkState::Failed]);
    assert!(!events.iter().any(|e| matches!(e, ProgressEvent::Merge { .. })), "a failed chunk never reaches the merge");
}

#[test]
fn a_cancel_mid_run_ends_every_registered_job_and_lands_nothing() {
    let fx = Fx::new("multi-cancel");
    let slot = Slot::new();
    let before = fx.config_text();
    let (started, ended) = (AtomicUsize::new(0), AtomicUsize::new(0));
    // Each call runs a real child in its Job; the second call to start cancels the run, which must end both.
    let run = |_: &Spec, job: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| {
        let mut child = std::process::Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        job.assign(&child).unwrap();
        if started.fetch_add(1, Ordering::SeqCst) == 1 {
            slot.cancel(RUN);
        }
        let begun = std::time::Instant::now();
        while child.try_wait().unwrap().is_none() {
            if begun.elapsed() > Duration::from_secs(10) {
                let _ = child.kill();
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if begun.elapsed() <= Duration::from_secs(10) {
            ended.fetch_add(1, Ordering::SeqCst);
        }
        Ok(claude_raw(&reply_first()))
    };
    let err = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &multi_request(), &silent)).unwrap_err();
    assert_eq!(err, "cancelled");
    assert_eq!((started.load(Ordering::SeqCst), ended.load(Ordering::SeqCst)), (2, 2), "both children ended by the cancel, not the timeout");
    assert_eq!(fx.config_text(), before);
    assert!(!fx.imports.join(gen_lib()).exists());
}

fn empty_envelope() -> String {
    serde_json::to_string(&Envelope { runes: vec![], sections: vec![], dropped: vec![] }).unwrap()
}

/// The `--effort` value of each call, chunk calls and merge calls apart.
fn efforts_seen(request: Request, merge: Option<&str>) -> (Vec<String>, Vec<String>) {
    let fx = Fx::new("merge-effort");
    let slot = Slot::new();
    let seen: Mutex<(Vec<String>, Vec<String>)> = Mutex::new((Vec::new(), Vec::new()));
    let run = |s: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| {
        let effort = s.args.windows(2).find(|w| w[0] == "--effort").map(|w| w[1].clone()).unwrap();
        let mut g = seen.lock().unwrap();
        if s.stdin.contains("=== FILE") { g.0.push(effort) } else { g.1.push(effort) }
        drop(g);
        Ok(answer(&s.stdin, true, merge))
    };
    fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &request, &silent)).unwrap();
    seen.into_inner().unwrap()
}

#[test]
fn the_merge_call_takes_the_requests_merge_effort_else_low() {
    let (chunks, merges) = efforts_seen(Request { merge_effort: Some("high".into()), ..multi_request() }, Some(&reply_merge()));
    assert_eq!((chunks, merges), (vec!["medium".to_string(); 2], vec!["high".to_string()]));
    let (_, merges) = efforts_seen(multi_request(), Some(&reply_merge()));
    assert_eq!(merges, ["low"], "an old caller sends none");
}

#[test]
fn chunks_holding_no_runes_fail_the_run_with_no_merge_call() {
    let fx = Fx::new("multi-empty");
    let slot = Slot::new();
    let before = fx.config_text();
    let merges = AtomicUsize::new(0);
    let run = |s: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| {
        if !s.stdin.contains("=== FILE") {
            merges.fetch_add(1, Ordering::SeqCst);
        }
        Ok(claude_raw(&empty_envelope()))
    };
    let err = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &multi_request(), &silent)).unwrap_err();
    assert_eq!(err, "output: runes: empty; a reply needs at least one rune");
    assert_eq!(merges.load(Ordering::SeqCst), 0);
    assert_eq!(fx.config_text(), before);
}

#[test]
fn one_chunk_holding_runes_lands_without_a_merge_call() {
    let fx = Fx::new("multi-one");
    let slot = Slot::new();
    let merges = AtomicUsize::new(0);
    let run = |s: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| {
        if s.stdin.contains("=== FILE") {
            Ok(if s.stdin.contains(PATH_B) { claude_raw(&empty_envelope()) } else { claude_raw(&reply_first()) })
        } else {
            merges.fetch_add(1, Ordering::SeqCst);
            Ok(claude_raw("not a merge reply"))
        }
    };
    let events: Mutex<Vec<Event>> = Mutex::new(Vec::new());
    let emit = |e: Event| events.lock().unwrap().push(e);
    let out = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &multi_request(), &emit)).unwrap();
    assert_eq!(out.runes, 2);
    assert_eq!(merges.load(Ordering::SeqCst), 0);
    assert!(!events.into_inner().unwrap().iter().any(|e| matches!(e.event, ProgressEvent::Merge { .. })));
    assert!(fx.imports.join(&out.library).is_dir());
}

#[test]
fn a_cancel_before_the_run_begins_lands_nothing_and_spawns_nothing() {
    let fx = Fx::new("cancel-early");
    let slot = Slot::new();
    let before = fx.config_text();
    slot.cancel(RUN);
    let run = |_: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| -> Result<Raw, String> { panic!("must not spawn") };
    let err = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &request("claude"), &silent)).unwrap_err();
    assert_eq!(err, "cancelled");
    assert_eq!(fx.config_text(), before);
    assert!(slot.begin(RUN).is_ok(), "the memory is spent: the same id may run again");
    // A cancel for another id waits for that id only.
    let other = Slot::new();
    other.cancel("ffffffff");
    assert!(other.begin(RUN).is_ok());
}

#[test]
fn a_halt_ends_registered_jobs_and_refuses_later_ones() {
    let slot = Slot::new();
    let _lease = slot.begin(RUN).unwrap();
    let job = Arc::new(Job::new().unwrap());
    let mut child = std::process::Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
    job.assign(&child).unwrap();
    slot.register(job).unwrap();
    assert!(!slot.stopped());
    slot.halt();
    assert!(slot.stopped() && !slot.cancelled(), "a halt stops the run without being the user's cancel");
    let begun = std::time::Instant::now();
    while child.try_wait().unwrap().is_none() {
        assert!(begun.elapsed() < Duration::from_secs(10), "the halt left the child running");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(slot.register(Arc::new(Job::new().unwrap())).is_err(), "no Job joins a halted run");
    // A cancel refuses too, and so does a slot with no run.
    let other = Slot::new();
    assert!(other.register(Arc::new(Job::new().unwrap())).is_err());
}

#[test]
fn part_names_go_into_output_and_timeout_errors_only() {
    let spans = [
        Span { path: r"~\x.md".into(), first: 1, last: 40, total: 40 },
        Span { path: r"~\y.md".into(), first: 120, last: 240, total: 300 },
    ];
    assert_eq!(part_label(&spans), r"~\x.md, ~\y.md L120-240");
    let begun = Instant::now();
    assert_eq!(name_part("output: bad".into(), "p", begun), "output: p: bad");
    assert_eq!(name_part("timeout: no output".into(), "p", begun), "timeout: p after 0 s; no output");
    assert_eq!(name_part("login: Claude is not logged in".into(), "p", begun), "login: Claude is not logged in");
}

#[test]
fn a_file_cut_across_chunks_is_planned_as_parts() {
    let span = |path: &str, first, last| Span { path: path.into(), first, last, total: 90 };
    let chunks = vec![vec![span("~\\a.md", 1, 40)], vec![span("~\\a.md", 41, 90), Span { path: "~\\b.md".into(), first: 1, last: 5, total: 5 }]];
    let ProgressEvent::Plan { chunks } = plan_event(&chunks) else { panic!("not a plan") };
    let parts: Vec<Vec<Option<(usize, usize)>>> = chunks.iter().map(|c| c.files.iter().map(|f| f.part.as_ref().map(|p| (p.k, p.of))).collect()).collect();
    assert_eq!(parts, [vec![Some((1, 2))], vec![Some((2, 2)), None]]);
}

#[test]
fn a_second_run_while_one_is_active_is_busy() {
    let fx = Fx::new("busy");
    let slot = Slot::new();
    let _held = slot.begin("ffffffff").unwrap();
    let run = |_: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| -> Result<Raw, String> { panic!("must not spawn") };
    let err = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &request("claude"), &silent)).unwrap_err();
    assert!(err.starts_with("busy: "), "{err}");
}

#[test]
fn a_cancel_before_commit_ends_the_run_and_lands_nothing() {
    let fx = Fx::new("cancel");
    let slot = Slot::new();
    let before = fx.config_text();
    let run = |_: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| {
        slot.cancel(RUN);
        Ok(claude_raw(&reply()))
    };
    let err = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &request("claude"), &silent)).unwrap_err();
    assert_eq!(err, "cancelled");
    assert_eq!(fx.config_text(), before);
    assert!(!fx.imports.join(gen_lib()).exists());
    assert!(slot.begin("ffffffff").is_ok(), "the slot is free");
}

#[test]
fn a_cancel_wins_over_a_runner_error() {
    let fx = Fx::new("cancel-error");
    let slot = Slot::new();
    let run = |_: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| -> Result<Raw, String> {
        slot.cancel(RUN);
        Err("spawn: the child was killed".into())
    };
    let err = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &request("claude"), &silent)).unwrap_err();
    assert_eq!(err, "cancelled");
}

#[test]
fn a_cancel_for_another_run_or_after_commit_does_nothing() {
    let slot = Slot::new();
    let _lease = slot.begin(RUN).unwrap();
    slot.cancel("ffffffff");
    assert!(!slot.cancelled());
    slot.enter_commit().unwrap();
    slot.cancel(RUN);
    assert!(!slot.cancelled());
    Slot::new().cancel(RUN);
}

#[test]
fn a_cancel_that_got_in_first_stops_the_commit() {
    let slot = Slot::new();
    let _lease = slot.begin(RUN).unwrap();
    slot.cancel(RUN);
    assert_eq!(slot.enter_commit(), Err("cancelled".to_string()));
}

/// An offered local skill folder under the fixture home, with a header description.
fn offered_skill(fx: &mut Fx) -> String {
    let dir = fx.home.join(".claude").join("skills").join("keep-a");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: keep-a\ndescription: Keep things tidy\n---\nBody.\n").unwrap();
    let path = dir.to_string_lossy().into_owned();
    fx.offered = vec![LocalFile {
        path: path.clone(),
        shown: r"~\.claude\skills\keep-a".into(),
        kind: "skill",
        library: None,
        section: None,
        scope: "global",
        ticked: false,
        pickable: true,
        reason: None,
        guard: None,
        codex_supported: None,
        agent: None,
        hosted: None,
        url: None,
    }];
    path
}

#[test]
fn an_items_only_run_lands_item_runes_without_calling_the_agent() {
    let mut fx = Fx::new("items-only");
    let path = offered_skill(&mut fx);
    let before = fx.config_text();
    let run = |_: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| -> Result<Raw, String> { panic!("must not spawn") };
    let req = Request { paths: vec![], items: vec![Pick { kind: "skill".into(), path }], ..request("claude") };
    let out = fx.with(|ctx| generate_at(ctx, &Slot::new(), &runner(&claude_exe, &run), &req, &silent)).unwrap();
    assert_eq!((out.library.as_str(), out.runes), (gen_lib().as_str(), 1));
    assert_eq!(fx.config_text(), before);
    let lib = fx.imports.join(gen_lib());
    let rune = std::fs::read_to_string(lib.join("skills").join("keep-a.md")).unwrap();
    assert!(rune.contains("kind: skill") && rune.contains(r#"source: "~\\.claude\\skills\\keep-a""#) && rune.contains("Keep things tidy"), "{rune}");
    let set = std::fs::read_to_string(lib.join("sets").join("generated-20261017.md")).unwrap();
    assert!(set.contains("keep-a"), "{set}");
}

#[test]
fn an_item_id_that_clashes_with_a_text_rune_is_renamed() {
    let mut fx = Fx::new("items-clash");
    let path = offered_skill(&mut fx);
    let run = |_: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| Ok(claude_raw(&reply()));
    let req = Request { items: vec![Pick { kind: "skill".into(), path }], ..request("claude") };
    let out = fx.with(|ctx| generate_at(ctx, &Slot::new(), &runner(&claude_exe, &run), &req, &silent)).unwrap();
    assert_eq!(out.runes, 4);
    assert!(fx.imports.join(gen_lib()).join("skills").join("keep-a-2.md").is_file());
}

#[test]
fn an_unoffered_item_is_invalid_and_lands_nothing() {
    let fx = Fx::new("items-bad");
    let run = |_: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| -> Result<Raw, String> { panic!("must not spawn") };
    let req = Request { paths: vec![], items: vec![Pick { kind: "skill".into(), path: r"C:\nowhere".into() }], ..request("claude") };
    let err = fx.with(|ctx| generate_at(ctx, &Slot::new(), &runner(&claude_exe, &run), &req, &silent)).unwrap_err();
    assert!(err.starts_with("invalid: "), "{err}");
    assert!(!fx.imports.join(gen_lib()).exists());
}

#[test]
fn a_rejected_reply_is_output_and_lands_nothing() {
    let fx = Fx::new("reject");
    let slot = Slot::new();
    let before = fx.config_text();
    let run = |_: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| Ok(claude_raw("here are your runes"));
    let err = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &request("claude"), &silent)).unwrap_err();
    assert!(err.starts_with("output: reply is not one JSON object"), "{err}");
    assert_eq!(fx.config_text(), before);
}

#[test]
fn a_runner_failure_and_a_missing_login_keep_their_prefix() {
    let fx = Fx::new("fail");
    let slot = Slot::new();
    let run = |_: &Spec, _: &Job, _: Duration, _: &(dyn Fn() -> bool + Sync)| -> Result<Raw, String> { Err("spawn: boom".into()) };
    let err = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &request("claude"), &silent)).unwrap_err();
    assert_eq!(err, "spawn: boom");
    std::fs::remove_file(fx.bare.join("claude-config").join(".credentials.json")).unwrap();
    let err = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &request("claude"), &silent)).unwrap_err();
    assert!(err.starts_with("login: "), "{err}");
    let err = fx.with(|ctx| generate_at(ctx, &slot, &runner(&claude_exe, &run), &Request { paths: vec![r"~\missing.md".into()], ..request("claude") }, &silent)).unwrap_err();
    assert!(err.starts_with("invalid: "), "{err}");
}

#[test]
fn bad_requests_are_invalid_before_anything_runs() {
    let ok = request("claude");
    assert!(check_request(&ok).is_ok());
    let bad = [
        Request { run_id: "XYZ".into(), ..ok.clone() },
        Request { run_id: "0A1B2C3D".into(), ..ok.clone() },
        Request { agent: "gemini".into(), ..ok.clone() },
        Request { model: "a\"b".into(), ..ok.clone() },
        Request { model: String::new(), ..ok.clone() },
        Request { effort: "high; rm".into(), ..ok.clone() },
        Request { paths: Vec::new(), ..ok.clone() },
    ];
    for r in bad {
        let e = check_request(&r).unwrap_err();
        assert!(e.starts_with("invalid: "), "{e}");
    }
}

#[test]
fn error_prefixes_pass_through_and_anything_else_is_invalid() {
    assert_eq!(prefixed("stale: Row Changed While Generating".into()), "stale: Row Changed While Generating");
    assert_eq!(prefixed("cancelled".into()), "cancelled");
    assert_eq!(prefixed("vidar.json is unreadable".into()), "invalid: vidar.json is unreadable");
}

#[test]
fn the_date_is_iso() {
    let d = today();
    assert!(d.len() == 10 && d.as_bytes()[4] == b'-' && d.starts_with("20"), "{d}");
}
