//! src-tauri\src\paths.rs — the one runtime root and the subpath fns under it
//! `init()` runs first in `main()`: it takes `current_exe()` as returned
//! (never canonicalised, so no `\\?\` prefix leaks into cwds or display
//! strings) and `resolve_from` accepts exactly two fixed shapes, gated by the
//! marker `contracts\paths.json`:
//!   1. friend layout — the marker sits next to the exe;
//!   2. dev checkout — the exe is `<R>\src-tauri\<target-dir>\<profile>\vidar.exe`,
//!      with `src-tauri\tauri.conf.json` present and the marker under `<R>`.
//! Anything else is an `Err` naming the exe and the check each shape failed; `main()` shows
//! it in a dialog and exits 1 before anything touches disk. No walk up the
//! tree, no env override, no `--root` flag. State and resources both live
//! under this one root (no installer, so no second root).
//!
//! Under `cfg(test)` only, `root()` keeps the old compile-time derivation from
//! `CARGO_MANIFEST_DIR`, so the pinning tests and Default-constructed states in
//! other modules' tests need no `init()`. The pinning test below holds every
//! subpath fn to the literal it replaced, so drift is a test failure.
//! falcon.rs can't import this module (it is also compiled into src-falcon via
//! `#[path]`, which has no `paths`), so Vidar passes `paths::root()` to
//! `Falcon::new` and the host derives the root from `--registry`. The host's
//! mutex and pipe names carry a hash of that root (`falcon/host_names.rs`), so
//! each Vidar folder on a logon runs its own host; a second host for the SAME
//! folder exits at once. Clients take the pipe names from `registry.json`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

mod contract;

/// `id` from `contracts/paths.json` under the root: the contract rel, the same rule as
/// `tools/lib/paths.mjs` and `Paths.ps1`.
fn p(id: &str) -> PathBuf {
    contract::resolve(&root(), id)
}

/// `id` relative to any root: the contract rel (e.g. for `voice_slots::probe`).
pub fn rel(id: &str) -> PathBuf {
    contract::rel(id)
}

/// The marker that proves a directory is the Vidar root: the paths contract itself, the file
/// every root finder (this, `paths.mjs`, `Paths.ps1`) reads next.
const MARKER: &str = r"contracts\paths.json";

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the root from the running exe and store it. A second call is a
/// no-op returning `Ok`.
pub fn init() -> Result<(), String> {
    if ROOT.get().is_some() {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| format!("Vidar could not read its own exe path: {e}"))?;
    let root = resolve_from(&exe)?;
    let _ = ROOT.set(root);
    Ok(())
}

/// Pure: only `is_file` checks, no env, no argv. See the module header for
/// the two shapes.
fn resolve_from(exe: &Path) -> Result<PathBuf, String> {
    let dir = exe.parent();
    // 1. Friend layout: the marker next to the exe.
    if let Some(dir) = dir {
        if dir.join(MARKER).is_file() {
            return Ok(dir.to_path_buf());
        }
    }
    // 2. Dev checkout: <R>\src-tauri\<target-dir>\<profile>\vidar.exe.
    let st = dir.and_then(Path::parent).and_then(Path::parent);
    let dev_root = st.and_then(Path::parent);
    let dev_why = match (st, dev_root) {
        (Some(st), Some(r)) => {
            let named_src_tauri = st
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("src-tauri"));
            if !named_src_tauri {
                format!("it is not under a src-tauri\\<target-dir>\\<profile> folder (found {})", st.display())
            } else if !st.join("tauri.conf.json").is_file() {
                format!("{} has no tauri.conf.json", st.display())
            } else if !r.join(MARKER).is_file() {
                format!("{MARKER} is missing at {}", r.display())
            } else {
                return Ok(r.to_path_buf());
            }
        }
        _ => "the exe path is too short for a src-tauri\\<target-dir>\\<profile> layout".into(),
    };
    let friend_why = match dir {
        Some(d) => format!("{MARKER} is missing beside the exe in {}", d.display()),
        None => "the exe path has no parent folder".into(),
    };
    Err(format!(
        "Vidar is running from {}.\nNot a friend layout: {friend_why}.\nNot a dev checkout: {dev_why}.",
        exe.display()
    ))
}

/// The Vidar root (e.g. `C:\Work\Example\Vidar`), set once by `init()`.
#[cfg(not(test))]
pub fn root() -> PathBuf {
    ROOT.get().expect("paths::init not called").clone()
}

/// Test-only: the compile-time checkout root, the one place
/// `CARGO_MANIFEST_DIR` survives.
#[cfg(test)]
pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("CARGO_MANIFEST_DIR has a parent")
        .to_path_buf()
}

// STATE: config, window state, bridge\*.
// ---- config.rs ----
pub fn config_path() -> PathBuf {
    p("config")
}
pub fn config_path_in(root: &Path) -> PathBuf {
    contract::resolve(root, "config")
}

// ---- state.rs ----
pub fn window_state_path() -> PathBuf {
    p("windowState")
}

// ---- bridge.rs ----
pub fn bridge_dir() -> PathBuf {
    p("bridge")
}
pub fn clips_dir() -> PathBuf {
    p("clips")
}
pub fn display_dir() -> PathBuf {
    p("display")
}
pub fn display_archive_dir() -> PathBuf {
    p("displayArchive")
}
pub fn display_reviews_dir() -> PathBuf {
    p("displayReviews")
}
/// `archive\shown\<yyyy-mm>\` holds cleared and swept display files (bridge/display_sweep.rs).
pub fn display_archive_shown_dir() -> PathBuf {
    p("displayArchiveShown")
}
pub fn display_archive_reviews_dir() -> PathBuf {
    p("displayArchiveReviews")
}
/// The display sweep's move log: append-only JSONL, one `{at_ms, from, to}` line per moved file (bridge/display_sweep.rs).
pub fn display_sweep_journal_path() -> PathBuf {
    p("displaySweepJournal")
}
pub fn workbench_dir() -> PathBuf {
    p("workbench")
}
pub fn close_lock_path() -> PathBuf {
    p("closeLock")
}
/// `<session>.json` per Falcon session (driver_mode.rs).
pub fn driver_mode_dir() -> PathBuf {
    p("driverMode")
}
pub fn auto_speak_path() -> PathBuf {
    p("autoSpeak")
}

pub fn auto_send_path() -> PathBuf {
    p("autoSend")
}
/// `{ "<falcon session>": "<32 hex>" }` (control/secrets.rs).
pub fn ctl_secrets_path() -> PathBuf {
    p("ctlSecrets")
}
/// `[{ id, session, question, choices, askedAtMs }]` (control/pending_ask.rs).
pub fn pending_asks_path() -> PathBuf {
    p("pendingAsks")
}
// DEV: docs\* (absent from a friend zip; readers tolerate that).
pub fn runs_dir() -> PathBuf {
    p("runs")
}
pub fn inbox_dir() -> PathBuf {
    p("inbox")
}
pub fn docs_dir() -> PathBuf {
    p("docs")
}

// DEV: review, launch and open dispatch bridges (desks tooling).
// ---- review.rs ----
pub fn review_dir() -> PathBuf {
    p("review")
}
pub fn review_dispatch_dir() -> PathBuf {
    p("reviewDispatch")
}
pub fn review_stale_dir() -> PathBuf {
    p("reviewStale")
}

// ---- open.rs ----
pub fn open_dir() -> PathBuf {
    p("open")
}
pub fn open_dispatch_dir() -> PathBuf {
    p("openDispatch")
}
pub fn open_stale_dir() -> PathBuf {
    p("openStale")
}

// STATE: ui state, characters, bridge\voice.
// ---- settings/state.rs ----
pub fn ui_state_path() -> PathBuf {
    p("uiState")
}

// ---- flow_store.rs ----
/// Flow's graphs, templates and runs, one `<key>.json` per storage key plus `writer.lock`.
pub fn flow_store_dir() -> PathBuf {
    p("flowStore")
}

// ---- bare/mod.rs ----
/// Codex versions Vidar has checked against the pinned protocol: `{"<version>": {pinned, same, atMs}}`,
/// written by `tools/codex-schema/verify.mjs --out`.
pub fn codex_accepted_path() -> PathBuf {
    p("codexAccepted")
}

// ---- usage_ledger.rs ----
/// One JSON line per finished agent call (`usage_ledger.rs`); read by `tools/usage/window-report.mjs`.
pub fn usage_ledger_path() -> PathBuf {
    p("usageLedger")
}
/// `usage_ledger_path` under an explicit root (rune generation takes its root as an argument).
pub fn usage_ledger_path_in(root: &Path) -> PathBuf {
    contract::resolve(root, "usageLedger")
}

// ---- characters ----
/// One pack folder per character (`<id>\character.json`); gitignored, the user's own.
pub fn characters_dir() -> PathBuf {
    p("characters")
}
/// One stage pack folder per stage (`<id>\stage.json`, data only); gitignored, the user's own.
pub fn stages_dir() -> PathBuf {
    p("stages")
}

// ---- voice.rs ----
pub fn voice_dir() -> PathBuf {
    p("voice")
}
// ---- voice_slots: resolved.json and pins.json live in the first; voice packs in the second ----
pub fn voice_slots_dir() -> PathBuf {
    p("voiceSlots")
}
pub fn packs_dir() -> PathBuf {
    p("packs")
}
/// The approved gateway snapshot `modules_list` writes; the gateway launcher reads it.
pub fn gateway_snapshot_path() -> PathBuf {
    p("gatewaySnapshot")
}
// RESOURCE: shipped binaries, venv and scripts (whisper, local-voice, sidecar).
pub fn whisper_dir() -> PathBuf {
    p("whisper")
}

// ---- speak.rs / listen.rs: both shell out to the same local-voice
// venv, just a different script ----
#[allow(dead_code)] // only the pin test reads it now that local_voice_python goes through the contract
pub fn local_voice_dir()-> PathBuf {
    p("localVoice")
}
pub fn local_voice_python() -> PathBuf {
    p("localVoicePython")
}
pub fn speak_script() -> PathBuf {
    p("speakScript")
}
// STATE: the speak journal (stays under local-voice; a future split is a one-line move).
pub fn speak_journal_dir() -> PathBuf {
    p("speakJournal")
}

// ---- flow.rs: the Claude sidecar path is the claude pack's `agent.flow.script`
// (flow/claude.rs `spec`), not a layout id; repo_root() itself goes through root() ----

// STATE: bridge\logs, bridge\sessions.
// ---- agent.rs ----
pub fn agent_log_dir() -> PathBuf {
    p("agentLog")
}

// ---- rules/: `built\<hash12>.md` and `last-good.json` ----
pub fn rules_dir() -> PathBuf {
    p("rules")
}

// ---- rules/catalog.rs: the Vidar rune library, and the user's global one ----
pub fn runes_dir() -> PathBuf {
    p("runes")
}
// The global library: `~\.claude\runes` when `~\.claude` is a directory (even without `runes\`),
// else `<CODEX_HOME or ~\.codex>\runes`. Never creates either folder. Twin: tools/lib/paths.mjs.
pub fn global_runes_dir() -> Option<PathBuf> {
    let home = home()?;
    let codex = crate::rules::codex::codex_home_from(std::env::var_os("CODEX_HOME"), Some(home.clone()));
    global_runes_dir_in(&home, codex)
}
pub fn global_runes_dir_in(home: &Path, codex_home: Option<PathBuf>) -> Option<PathBuf> {
    let claude = home.join(".claude");
    if claude.is_dir() {
        return Some(claude.join("runes"));
    }
    codex_home.map(|c| c.join("runes"))
}
// ---- bare/layer.rs: imported rune libraries, one `<library>\` folder each (onboarding D1) ----
#[allow(dead_code)] // the onboarding importer (W2) writes here; layer.rs resolves through `rune_imports_dir_in`
pub fn rune_imports_dir() -> PathBuf {
    p("runeImports")
}
/// `runtime\runes\load-history.json`: last-seen dates of rune uses across sessions (`rules/load_history.rs`).
pub fn rune_load_history() -> PathBuf {
    p("runeLoadHistory")
}
/// The retired `runtime\runes\gen-index.json` (row key -> generated library): only the vault
/// migration reads it, then deletes it (`bare/vault/migrate.rs`).
pub fn legacy_rune_gen_index_in(root: &Path) -> PathBuf {
    contract::resolve(root, "legacyRuneGenIndex")
}
/// `profiles\bare\rune-create\SKILL.md`: the skill the rune generator's agent runs under (`rules/generate/commands.rs`).
pub fn rune_create_skill() -> PathBuf {
    p("runeCreateSkill")
}
/// `profiles\bare\rune-create\MERGE.md`: the skill the generator's merge pass runs under (`rules/generate/merge.rs`).
pub fn rune_merge_skill() -> PathBuf {
    p("runeMergeSkill")
}
/// `rune_imports_dir` under an explicit root (the Bare layer takes its root as an argument).
pub fn rune_imports_dir_in(root: &Path) -> PathBuf {
    contract::resolve(root, "runeImports")
}
/// `runtime\vaults`: one `<vault-id>\vault.json` per Rune Vault plus `sessions\` records (`bare/vault/store.rs`).
pub fn rune_vaults_dir_in(root: &Path) -> PathBuf {
    contract::resolve(root, "runeVaults")
}
/// `profiles\bare\stock-runes`: the tracked read-only `stock` rune library (`bare/vault/store.rs`).
pub fn rune_stock_dir_in(root: &Path) -> PathBuf {
    contract::resolve(root, "runeStock")
}
/// `profiles\bare\templates`: stock vault templates, copied into `runtime\vaults` on create.
pub fn rune_templates_dir_in(root: &Path) -> PathBuf {
    contract::resolve(root, "runeTemplates")
}
/// Content-addressed on-demand rune skills under the install's runtime directory.
pub fn rune_skills_dir_in(root: &Path) -> PathBuf {
    contract::resolve(root, "runeSkills")
}
/// The retired tracked-set overrides (`<lib>\<set>.json` per set of `rulesLibrary`): only the vault
/// migration reads them, then deletes them (`bare/vault/migrate.rs`).
pub fn legacy_rune_overrides_dir_in(root: &Path) -> PathBuf {
    contract::resolve(root, "legacyRuneOverrides")
}
/// `runtime\migrations\`: one backup folder per startup migration that wrote (`bare/vault/migrate.rs`).
pub fn migrations_dir_in(root: &Path) -> PathBuf {
    contract::resolve(root, "migrations")
}

// ---- lab.rs: the run history, and the runner script whose presence gates the tab's commands ----
pub fn lab_history() -> PathBuf {
    adopt_bench_dir(&p("lab"));
    p("labHistory")
}
pub fn lab_runner() -> PathBuf {
    p("tools").join("lab").join("run.mjs")
}

/// The Lab tab's data folder was `runtime\bench` before the tab's rename (2026-10-17). The first
/// reader renames it to `lab` while `lab` is absent; never merged, never deleted. When both exist,
/// `lab` is used and `bench` is left alone. A failed rename changes nothing and the next read retries.
/// Twin of `adoptBenchDir` in `tools/lab/lab-dir.mjs`. Returns whether it renamed.
pub fn adopt_bench_dir(lab: &Path) -> bool {
    let Some(old) = lab.parent().map(|d| d.join("bench")) else { return false };
    if std::fs::symlink_metadata(lab).is_ok() || !old.is_dir() {
        return false;
    }
    std::fs::rename(&old, lab).is_ok()
}

// ---- status.rs ----
pub fn sessions_dir() -> PathBuf {
    p("sessions")
}

// ---- loadout.rs / handoff.rs / mcp.rs: one home()/claude_dir(),
// status.rs's own registry_dir() pattern (Option, no panic on a missing
// USERPROFILE) rather than the three copies' `unwrap_or_default()`, which
// silently resolved to the repo root on a missing env var instead of failing
// the lookup. ----
pub fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}
pub fn claude_dir() -> Option<PathBuf> {
    Some(home()?.join(".claude"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pins every fn above against the literal each mirrors today
    // (config.rs's CONFIG_PATH, state.rs's STATE_PATH, bridge.rs's
    // CLIPS_DIR/DISPLAY_DIR/.../DOCS_DIR, review.rs's REVIEW_DIR/.../STALE_DIR,
    // open.rs's equivalents). A literal changing in its own
    // module without a matching edit here fails this test rather than
    // drifting silently. Built off `root()` itself (not a hardcoded absolute
    // path) so this passes in another checkout too; `root_ends_with_repo_dir`
    // below is the separate check that `root()` resolved to the right place.
    fn lit(rel: &str) -> PathBuf {
        root().join(rel)
    }

    #[test]
    fn root_ends_with_repo_dir() {
        // The checkout folder can have any name (a clone, a worktree, an unzipped download): root() is
        // the folder that holds src-tauri, which is the check that matters.
        let root = root();
        assert!(root.file_name().is_some(), "{root:?}");
        assert!(root.join("src-tauri").join("Cargo.toml").is_file(), "{root:?}");
    }

    /// A moved id sits at `<under>\<rel>` under the root.
    fn moved(actual: PathBuf, rel: &str) {
        moved_to(actual, "runtime", rel);
    }

    fn moved_to(actual: PathBuf, under: &str, rel: &str) {
        assert!(
            actual == lit(&format!("{under}\\{rel}")),
            "{} is not {under}\\{rel}",
            actual.display()
        );
    }

    #[test]
    fn every_resolved_path_equals_the_old_literal() {
        assert_eq!(config_path(), lit("vidar.json"));
        moved(window_state_path(), "window-state.json");
        moved(bridge_dir(), "bridge");
        moved(clips_dir(), "bridge\\clips");
        moved(display_dir(), "bridge\\display");
        moved(display_archive_dir(), "bridge\\display\\archive");
        moved(display_reviews_dir(), "bridge\\display\\reviews");
        moved(display_archive_shown_dir(), "bridge\\display\\archive\\shown");
        moved(display_archive_reviews_dir(), "bridge\\display\\archive\\reviews");
        moved(display_sweep_journal_path(), "bridge\\display-sweep.jsonl");
        moved(workbench_dir(), "bridge\\workbench");
        moved(close_lock_path(), "bridge\\close-lock.json");
        moved(auto_speak_path(), "bridge\\auto-speak.json");
        moved(ctl_secrets_path(), "bridge\\ctl-secrets.json");
        moved(pending_asks_path(), "bridge\\pending-asks.json");
        assert_eq!(runs_dir(), lit("docs\\runs"));
        assert_eq!(inbox_dir(), lit("docs\\inbox"));
        assert_eq!(docs_dir(), lit("docs"));
        moved(review_dir(), "bridge\\review");
        moved(review_dispatch_dir(), "bridge\\review\\dispatch");
        moved(review_stale_dir(), "bridge\\review\\dispatch\\stale");
        moved(open_dir(), "bridge\\open");
        moved(open_dispatch_dir(), "bridge\\open\\dispatch");
        moved(open_stale_dir(), "bridge\\open\\dispatch\\stale");
        moved(ui_state_path(), "vidar-state.json");
        moved(flow_store_dir(), "state\\flow");
        moved(codex_accepted_path(), "state\\codex-accepted.json");
        moved(usage_ledger_path(), "state\\usage-ledger.jsonl");
        moved(voice_dir(), "bridge\\voice");
        moved(voice_slots_dir(), "bridge\\voice-slots");
        moved_to(packs_dir(), "content", "packs");
        moved_to(characters_dir(), "content", "characters");
        moved_to(stages_dir(), "content", "stages");
        moved(gateway_snapshot_path(), "bridge\\gateways.json");
        moved_to(whisper_dir(), "content", "vendor\\whisper");
        moved_to(local_voice_dir(), "content", "local-voice");
        moved_to(local_voice_python(), "content", "local-voice\\.venv\\Scripts\\python.exe");
        moved_to(speak_script(), "content", "local-voice\\speak.py");
        moved_to(speak_journal_dir(), "content", "local-voice\\.tmp");
        moved(agent_log_dir(), "bridge\\logs");
        moved(sessions_dir(), "bridge\\sessions");
        // pinned exactly: the Falcon host hardcodes `runtime\rules\built`
        assert_eq!(rules_dir(), lit("runtime\\rules"));
        assert_eq!(rune_imports_dir(), lit("runtime\\runes"));
        assert_eq!(migrations_dir_in(&root()), lit("runtime\\migrations"));
    }

    #[test]
    fn root_matches_the_original_absolute_literal_on_this_machine() {
        // `lit()` above builds off `root()` itself, so it pins the *relative*
        // shape but can't catch `root()` drifting to the wrong absolute
        // location. This checks against the literal `root()` replaced
        // (`C:\Apps\Vidar` style) — but only when that directory exists, so a
        // checkout elsewhere (a different machine, a different drive) skips
        // it instead of failing.
        let literal = PathBuf::from(r"C:\Apps\Vidar");
        if literal.is_dir() {
            assert_eq!(root(), literal);
        }
    }

    #[test]
    fn home_and_claude_dir_agree_with_userprofile() {
        let expected = std::env::var_os("USERPROFILE").map(PathBuf::from);
        assert_eq!(home(), expected);
        assert_eq!(claude_dir(), expected.map(|h| h.join(".claude")));
    }

    #[test]
    fn global_runes_dir_prefers_claude_then_codex_home() {
        let home = scratch("global-runes");
        let codex = home.join("codex-elsewhere");
        assert_eq!(
            global_runes_dir_in(&home, Some(codex.clone())),
            Some(codex.join("runes"))
        );
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        assert_eq!(
            global_runes_dir_in(&home, Some(codex)),
            Some(home.join(".claude").join("runes"))
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // ---- resolve_from. Trees under %TEMP%, one unique folder per test,
    // removed at the end (no tempfile dev-dep). ----

    fn scratch(name: &str) -> PathBuf {
        let t = std::env::temp_dir().join(format!("vidar-paths-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(&t).unwrap();
        t
    }

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"").unwrap();
    }

    #[test]
    fn lab_adopts_the_bench_dir_only_while_lab_is_absent() {
        // only bench: renamed whole, contents kept
        let t = scratch("lab-adopt-only");
        touch(&t.join("bench").join("history.jsonl"));
        touch(&t.join("bench").join("runs").join("r1").join("result.json"));
        assert!(adopt_bench_dir(&t.join("lab")));
        assert!(!t.join("bench").exists());
        assert!(t.join("lab").join("history.jsonl").is_file());
        assert!(t.join("lab").join("runs").join("r1").join("result.json").is_file());
        assert!(!adopt_bench_dir(&t.join("lab")), "a second read is a no-op");
        let _ = std::fs::remove_dir_all(&t);

        // both: lab used, bench left exactly as it was, nothing merged
        let t = scratch("lab-adopt-both");
        touch(&t.join("bench").join("history.jsonl"));
        touch(&t.join("lab").join("other.jsonl"));
        assert!(!adopt_bench_dir(&t.join("lab")));
        assert!(t.join("bench").join("history.jsonl").is_file());
        assert!(!t.join("lab").join("history.jsonl").exists());
        assert!(t.join("lab").join("other.jsonl").is_file());
        let _ = std::fs::remove_dir_all(&t);

        // neither, or bench is a file: nothing created
        let t = scratch("lab-adopt-none");
        assert!(!adopt_bench_dir(&t.join("lab")));
        assert!(!t.join("lab").exists());
        touch(&t.join("bench"));
        assert!(!adopt_bench_dir(&t.join("lab")));
        assert!(t.join("bench").is_file() && !t.join("lab").exists());
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn resolve_friend_layout_is_exe_dir() {
        let t = scratch("friend");
        touch(&t.join("vidar.exe"));
        touch(&t.join(MARKER));
        assert_eq!(resolve_from(&t.join("vidar.exe")), Ok(t.clone()));
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn resolve_dev_checkout_from_target_dirs() {
        let t = scratch("dev");
        touch(&t.join(r"src-tauri\tauri.conf.json"));
        touch(&t.join(MARKER));
        for sub in [r"src-tauri\target\release", r"src-tauri\target-staging\fast"] {
            let exe = t.join(sub).join("vidar.exe");
            touch(&exe);
            assert_eq!(resolve_from(&exe), Ok(t.clone()), "{sub}");
        }
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn resolve_bare_exe_is_err() {
        let t = scratch("bare");
        touch(&t.join(MARKER));
        let exe = t.join(r"a\b\vidar.exe");
        touch(&exe);
        let err = resolve_from(&exe).unwrap_err();
        assert!(err.contains(&exe.display().to_string()), "{err}");
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn resolve_src_tauri_without_marker_is_err() {
        let t = scratch("nomarker");
        touch(&t.join(r"src-tauri\tauri.conf.json"));
        let exe = t.join(r"src-tauri\target\release\vidar.exe");
        touch(&exe);
        assert!(resolve_from(&exe).is_err());
        std::fs::remove_dir_all(&t).unwrap();
    }

    // The two below put the marker AT the rule-2 root, so only the guard
    // named in each test stands between the tree and an `Ok`.
    #[test]
    fn resolve_dev_shape_not_named_src_tauri_is_err() {
        let t = scratch("wrongname");
        touch(&t.join(r"other\tauri.conf.json"));
        touch(&t.join(MARKER));
        let exe = t.join(r"other\target\release\vidar.exe");
        touch(&exe);
        let err = resolve_from(&exe).unwrap_err();
        assert!(err.contains("not under a src-tauri"), "{err}");
        assert!(err.contains(&exe.display().to_string()), "{err}");
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn resolve_src_tauri_without_conf_is_err() {
        let t = scratch("noconf");
        touch(&t.join(MARKER));
        let exe = t.join(r"src-tauri\target\release\vidar.exe");
        touch(&exe);
        let err = resolve_from(&exe).unwrap_err();
        assert!(err.contains("has no tauri.conf.json"), "{err}");
        assert!(err.contains(&exe.display().to_string()), "{err}");
        std::fs::remove_dir_all(&t).unwrap();
    }
}
