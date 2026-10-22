/* Single seam between the UI and the Tauri backend. Inside Tauri (detected
   via the __TAURI_INTERNALS__ global the runtime always injects) this
   re-exports the real invoke/listen untouched. In a plain browser it swaps
   in the mocks from ipc-mock.ts — canned config/status/display data and a fake
   pty that plays scrollback — so the UI renders for visual iteration via `npm run dev`.
   This is the ONLY file allowed to import @tauri-apps/api: everything else
   goes through here, or the browser mode silently breaks again.
   Fidelity is "renders", not "behaves" — mocks return what a caller needs
   to paint; anything unreachable in a browser (drag-drop, voice, OCR,
   adopt) is left to the undefined default (which warns once per name).

   `invoke` is generic
   over the hand-typed `Commands` map below, so a wrong command name or argument
   shape is a tsc error against that map. Argument keys are the Rust parameter
   names camelCased (Tauri's default), copied by hand: nothing checks them
   against Rust, so a Rust parameter rename is only caught at runtime. `COMMAND_HOSTS` (ipc-hosts.ts) tags each command with the backend that
   registers it; tests/ipc-commands.test.mjs fails when it drifts from the
   `generate_handler!` lists in src-tauri/src/main.rs and src-falcon/src/main.rs. */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWebview as tauriGetCurrentWebview } from "@tauri-apps/api/webview";
import type { ConfigResult, Location } from "./config";
import type { WakewordCfg } from "./panels/listen";
import type { DocEntry } from "./panels/document";
import type { CommentsFile } from "./panels/comments";
import type { DisplayUpdate, DisplayFile, DisplayPng, DecisionView } from "./panels/display-render";
import type { RecentSession } from "./launcher/recent";
import type { RunesCatalog, RunesLoaded, RuneLibraryKey } from "./runes/types";
import type { LabItem } from "./lab/types";
import type { ExternalSession } from "./launcher/locations";
import type { Loadout } from "./panels/loadout";
import type { McpRack, McpTool } from "./panels/rack";
import type { BackendStatus } from "./panels/backend-status";
import type { LmStatus } from "./panels/lmstudio";
import type { VoiceCommands } from "./ipc-voice";
import type { JiraCommands } from "./jira/ipc";
import type { NotionCommands } from "./notion/ipc";
import type { SlackCommands } from "./slack/ipc";
import type { SettingsCommands } from "./ipc-settings";
import type { CharacterList } from "./character/catalog";
import type { DepReport } from "./deps/types";
import type { COMMAND_HOSTS } from "./ipc-hosts";
import { mockInvoke, mockListen } from "./ipc-mock";

// core.js invoke is literally window.__TAURI_INTERNALS__.invoke(...): the
// runtime injects it regardless of withGlobalTauri, so its absence is the
// browser.
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** One past Codex thread (`list_codex_threads`, codex_threads.rs `ThreadRow`, camelCase). */
export interface CodexThreadRow { id: string; label: string; cwd: string; ageSecs: number; model: string | null }

/** `read_codex_limits` (status/codex.rs): the rollout model and the 5H/7D windows; `resets_at` epoch seconds, `observed_ms` epoch ms. */
export interface CodexLimits {
  model?: string | null;
  five_hour?: { used_percentage: number; resets_at: number } | null;
  seven_day?: { used_percentage: number; resets_at: number } | null;
  observed_ms: number;
}

export interface CodexLoadout {
  home: string | null;
  instructions: import("./panels/loadout").KbFile[];
  developerInstructionsChars: number | null;
  skills: { name: string; description: string }[];
  /** `<home>\agents\*.toml` of the tab's Codex home; `[]` when none. `readOnlyByPrompt`: the role opens
   *  with Vidar's read-only marker (derived from a read-only Claude agent; held by prompt, not sandboxed). */
  agents: { name: string; model: string | null; readOnlyByPrompt: boolean }[];
  model: string | null;
  effort: string | null;
  sandbox: string | null;
  approval: string | null;
  reviewer: string | null;
  network: boolean | null;
  notify: string[];
  rulesFiles: number;
  notes: string[];
}

/** One changed path (changes.rs `ChangedFile`). x/y are porcelain v2 status letters ("." = unchanged,
 *  "?" = untracked); a count is null for a binary file and 0 for a side with no change. */
export interface ChangedFile {
  path: string; origPath?: string; x: string; y: string; untracked: boolean;
  stagedAdds: number | null; stagedDels: number | null; workAdds: number | null; workDels: number | null;
}
export type ChangesStatus =
  | { repo: false }
  | { repo: true; root: string; branch: string | null; detached: boolean; head: string | null; upstream: string | null;
      ahead: number | null; behind: number | null; files: ChangedFile[] };
/** `unreal_status` (src-tauri/src/unreal): `at` is epoch ms or null; a read error rejects with a string. */
export interface UnrealDiag {
  file: string | null; line: number | null; severity: "error" | "warning"; text: string; source: "log" | "ubt";
}
export interface UnrealStatus {
  project: { name: string; root: string; uproject: string } | null;
  editor: "running" | "closed" | "unclean";
  build: { result: "succeeded" | "failed" | "unknown"; at: number | null } | null;
  liveCoding: { result: "succeeded" | "failed"; at: number | null } | null;
  diags: UnrealDiag[];
}
export interface ChangesSyncResult { pulled: boolean; pushed: boolean; output: string }
/** `syncError` set = the commit landed and the requested sync failed. */
export interface ChangesCommitResult { sha: string; stderr: string; sync: ChangesSyncResult | null; syncError: string | null; warning: string | null }

/* ---------------- command map ---------------- */

/** One command: `args` is the invoke payload (`undefined` = takes none), `ret` the resolved value.
 *  `Result<(), String>` and bare `()` are `void`. */
export interface Cmd<A, R> { args: A; ret: R }

/** Rules import (docs/projects/bare/onboarding-plan.md, IPC Contract; src-tauri/src/rules/import/commands.rs). */
export interface RulesImportSource { path: string; shown: string; agent: string; library: string; imported: boolean }
export type RulesBrickStatus = "new" | "known" | "gone" | "duplicate" | "profilePath";
export interface RulesImportBrick {
  id: string; section: string[]; body: string; line: number; studs: number;
  status: RulesBrickStatus; kept: boolean; rows: string[];
}
export interface RulesImportScan { library: string; bricks: RulesImportBrick[] }
export interface RulesImportApplied { library: string; written: number; rows: string[] }
/** src-tauri/src/rules/generate/commands.rs (run 2026-10-17-rune-generator ipc.md). */
export interface RulesGenerateArgs {
  runId: string; rowKey: string; agent: "claude" | "codex"; model: string; effort: string;
  mergeEffort?: string;
  paths: string[]; cwd: string | null; budget: number | null;
}
export interface RulesGenerated {
  library: string; runes: number; on: number; encodedChars: number | null;
  costUsd: number | null; inputTokens: number | null; outputTokens: number | null; durationMs: number; warnings: string[];
}
/** Bare Runes tab local files (src-tauri/src/rules/import/local.rs; run 2026-10-17-bare-runes-flow fold.md). */
export type BareFileKind = "rules" | "memory" | "skill" | "agent" | "hook" | "mcp";
export interface BareLocalFile {
  path: string; shown: string; kind: BareFileKind; library?: string; section?: string;
  scope: "global" | "project"; ticked: boolean; pickable: boolean;
  reason?: "pathScoped" | "notMjs" | "guardDriver"
    | "tooLarge" | "shadowed" | "summaryOnly" | "notHosted" | "stdio";
  guard?: { event: string; matcher?: string; run: string[] };
  /** Absent = a Claude row; mcp rows carry the hosted server name and its pinned url. */
  agent?: "claude" | "codex"; hosted?: string; url?: string;
}
export interface BareLocalSources { files: BareLocalFile[]; memoryDir: string | null; guardsKey: boolean }
/** A row's actives (src-tauri/src/bare/actives.rs; fold.md § Pinned shapes). `source` null: not imported, read-only. */
export interface BareGuard { event: string; matcher?: string; run: string[] }
export interface BareActiveLibrary {
  library: string; source: string | null; scope: "global" | "project"; sourceGone: boolean;
  /** `path` is the rune file; a missing file gives "" and kind rule, activate always. */
  bricks: {
    id: string; section: string[]; studs: number; on: boolean;
    path: string; kind: string; activate: string; description: string; body: string;
  }[];
  /** Absent for import libraries (run 2026-10-17-rune-generator, ipc.md). */
  generated?: {
    agent: "claude" | "codex"; model: string; effort: string; date: string;
    inputs: string[]; warnings: string[]; encodedChars: number | null;
  };
  /** Each set the row names here, with its layer sidecar (actives.rs `ActiveSetLayer`, run 2026-10-20-rune-sets W4). */
  sets?: BareSetLayer[];
}
export interface BareSetLayer {
  set: string; editable: boolean;
  skills: string[]; agents: string[]; guards: (BareGuard & { open?: string[] })[]; codexSkills: string[]; warnings: string[];
}
/** bare_set_layer_write: a present key replaces the sidecar's, an absent one stays (bare/set_layer.rs `write_set`). */
export interface BareSetLayerWrite {
  skills?: string[]; agents?: string[]; guards?: (BareGuard & { open?: string[] })[]; codexSkills?: string[];
}
export interface BareActives {
  rowKey: string; libraries: BareActiveLibrary[];
  skills: string[]; agents: string[]; guards: BareGuard[]; guardsKey: boolean;
  /** bareCodexSkills, bareCodexAgents and bareCodexMcp (additive; actives.rs; absent from an older build = none). */
  codexSkills?: string[]; codexAgents?: string[]; codexMcp?: string[];
}
/** `bare_launch`: what a tab's newest Bare manifest carried (bare/manifest.rs `LaunchRecord`);
 *  `warnings` are the binary's, then the payload's, then the manifest's. */
export interface BareLaunch {
  createdUtc: string; agent: string; sets: string[]; skills: string[]; guards: string[]; warnings: string[];
}
/** `cwd` overrides vidar.json `defaultCwd` for library naming. bare_layer_set leaves an omitted key
 *  untouched; `written` names the arg keys it changed. bare_launch is `null` when the tab has no manifest. */
export interface RulesImportCommands {
  rules_import_sources: Cmd<undefined, RulesImportSource[]>;
  rules_import_scan: Cmd<{ path: string; cwd?: string }, RulesImportScan>;
  rules_import_apply: Cmd<{ path: string; kept: string[]; rows: Record<string, string[]>; cwd?: string }, RulesImportApplied>;
  rules_generate: Cmd<RulesGenerateArgs, RulesGenerated>;
  rules_generate_cancel: Cmd<{ runId: string }, null>;
  rules_generate_toggle: Cmd<{ library: string; rowKey: string; id: string; on: boolean }, RulesImportApplied>;
  bare_local_sources: Cmd<{ cwd: string }, BareLocalSources>;
  bare_actives: Cmd<{ rowKey: string }, BareActives>;
  bare_layer_set: Cmd<{ guards?: BareGuard[]; skills?: string[]; agents?: string[]; codexSkills?: string[]; codexAgents?: string[]; codexMcp?: string[] }, { written: string[] }>;
  bare_set_layer_write: Cmd<{ library: string; set: string; layer: BareSetLayerWrite }, null>;
  bare_launch: Cmd<{ tab: string }, BareLaunch | null>;
}

/** Raw-body commands (`tauri::ipc::Request`) take the bytes as the whole payload. */
type RawBody = ArrayBuffer | Uint8Array;

interface Commands extends VoiceCommands, SettingsCommands, RulesImportCommands, JiraCommands, NotionCommands, SlackCommands {
  // settings::commands / state (switches and context_gate: ipc-settings.ts)
  patch_settings: Cmd<{ key: string; value: unknown }, void>;
  reload_config: Cmd<undefined, ConfigResult>;
  read_state: Cmd<undefined, Record<string, unknown>>;
  patch_state: Cmd<{ entries: Record<string, unknown> }, void>;
  // config
  read_config: Cmd<undefined, ConfigResult>;
  read_default_cwd: Cmd<undefined, string | null>;
  codex_cwd_refused: Cmd<{ cwd: string }, boolean>;
  save_locations: Cmd<{ locations: Location[] }, void>;
  save_shortcuts: Cmd<{ shortcuts: Record<string, string> }, void>;
  save_voice: Cmd<{ hotkey: string; mode: string; device: string; prompt: string; model: string }, void>;
  save_character_view: Cmd<{ id: string; view: unknown }, void>;
  save_wakeword: Cmd<{ cfg: WakewordCfg }, void>;
  // bridge: clips, workbench, drops, character
  save_clip: Cmd<{ content: string }, string>;
  save_clip_image: Cmd<RawBody, string>;
  write_workbench_entry: Cmd<{ name: string; json: string }, void>;
  delete_workbench_entry: Cmd<{ name: string }, void>;
  archive_workbench_entry: Cmd<{ name: string }, void>;
  list_workbench_entries: Cmd<undefined, string[]>;
  write_workbench_png: Cmd<RawBody, void>;
  read_workbench_png: Cmd<{ name: string }, ArrayBuffer>;
  read_drop_text: Cmd<{ path: string }, { name: string; bytes: number; text: string; lossy: boolean; truncated: boolean }>;
  read_drop_png: Cmd<{ path: string }, ArrayBuffer>;
  read_character_model: Cmd<{ id?: string | null }, ArrayBuffer>;
  // characters (src-tauri\src\characters): packs; add/repin open the native .glb picker in Rust
  list_characters: Cmd<{ refresh: boolean }, CharacterList>;
  add_character: Cmd<undefined, string | null>;
  // target: a valid pack's id, else `folder:<name>` (characters\store.rs)
  repin_character: Cmd<{ target: string; pick: boolean }, boolean>;
  update_character: Cmd<{ target: string; patch: Record<string, unknown> }, void>;
  remove_character: Cmd<{ target: string }, void>;
  set_default_character: Cmd<{ id: string | null }, void>;
  // bridge: documents and comments
  list_documents: Cmd<undefined, DocEntry[]>;
  read_document: Cmd<{ path: string }, { name: string; bytes: number; mtimeMs: number; text: string; lossy: boolean }>;
  stat_document: Cmd<{ path: string }, number | null>;
  create_document: Cmd<{ name: string }, string>;
  write_document: Cmd<{ path: string; text: string; expectedMtime: number }, number>;
  read_comments: Cmd<{ docPath: string }, CommentsFile>;
  save_comments: Cmd<{ docPath: string; json: string }, number>;
  // bridge: display
  read_display_file: Cmd<{ path: string }, DisplayFile>;
  read_display_png: Cmd<{ path: string }, DisplayPng>;
  list_display: Cmd<undefined, DisplayUpdate>;
  // pending asks (control/pending_ask.rs); sha256 binds a claim or settle to the content painted
  list_pending_asks: Cmd<undefined, { items: { id: string; session: string; question: string; choices: string[]; details?: string[]; askedAtMs: number; context?: string; sha256: string }[] }>;
  claim_pending_ask: Cmd<{ id: string; sha256: string }, void>;
  release_pending_ask: Cmd<{ id: string }, void>;
  settle_pending_ask: Cmd<{ id: string; sha256: string }, void>;
  save_display_decision: Cmd<{ path: string; sha256: string; verdict: string; comment: string }, number>;
  read_display_decision: Cmd<{ path: string }, DecisionView | null>;
  archive_display_file: Cmd<{ path: string }, string>;
  delete_display_file: Cmd<{ path: string }, void>;
  // pty
  spawn_pty: Cmd<{ id: string; cols: number; rows: number; shell?: string | null; cwd?: string | null; args?: string[] | null; tabName?: string | null; ptyGen: number; profile?: string | null; rowKey?: string | null; agent?: string | null }, void>;
  write_pty: Cmd<{ id: string; data: string }, void>;
  pty_has_descendant: Cmd<{ id: string; exe: string }, boolean>;
  resize_pty: Cmd<{ id: string; cols: number; rows: number }, void>;
  pty_flow: Cmd<{ id: string; paused: boolean }, void>;
  kill_pty: Cmd<{ id: string; close?: boolean }, void>;
  adopt_session: Cmd<{ pid: number; sessionId: string }, { cwd: string; sessionId: string }>;
  // desk dispatch handshakes (review.rs, open.rs, control)
  review_ready: Cmd<undefined, void>;
  review_result: Cmd<{ id: string; ok: boolean; tab?: string | null; reason?: string | null; tabCwd?: string | null }, void>;
  open_ready: Cmd<undefined, void>;
  open_result: Cmd<{ id: string; ok: boolean; tab?: string | null; verdict: string; comment?: string | null; reason?: string | null }, void>;
  control_result: Cmd<{ id: string; ok: boolean; line: string; cardId?: string | null }, void>;
  // agent (Codex app-server)
  spawn_codex_appserver: Cmd<{ id: string; cwd: string; rulesFile?: string | null; tabName?: string | null; profile?: string | null; rowKey?: string | null; agent?: string | null }, { gen: number; developerInstructions: string | null; bareWarnings?: string[] }>;
  // the Trust Folder action on a Bare Codex tab (bare/codex_trust.rs)
  codex_trust_offer: Cmd<{ id: string }, { folder: string; text: string } | null>;
  codex_trust_folder: Cmd<{ id: string; folder: string }, void>;
  // rules (src-tauri/src/rules/mod.rs `RulesPrepared`, camelCase)
  rules_prepare: Cmd<{ key: string; ids: string[]; client: "claude" | "codex" }, {
    file: string | null;
    codex: { mode: "c"; value: string } | { mode: "profile"; name: string } | null;
    warnings: string[];
  }>;
  // rune libraries and what a tab loaded (rules/catalog.rs, rules/loaded.rs; types in src/runes/types.ts)
  runes_catalog: Cmd<undefined, RunesCatalog>;
  runes_loaded: Cmd<{ tab: string; agent: string; sessionId?: string | null; profile?: string | null }, RunesLoaded>;
  // one rune's eval cases and Lab runs (lab.rs; types in src/lab/types.ts)
  lab_item: Cmd<{ library: RuneLibraryKey; id: string }, LabItem>;
  agent_send: Cmd<{ id: string; gen: number; line: string }, void>;
  kill_agent: Cmd<{ id: string; gen: number }, void>;
  agent_reap_all: Cmd<undefined, number>;
  /** Raw `model/list` pages (each page's `data`) from a short-lived Bare Codex app-server (codex_models.rs). */
  codex_list_models: Cmd<undefined, unknown[]>;
  list_codex_threads: Cmd<{ cwd: string; profile?: string }, CodexThreadRow[]>;
  // status, sessions, handoffs
  list_external_sessions: Cmd<undefined, ExternalSession[]>;
  list_recent_sessions: Cmd<{ cwd: string; profile?: string | null }, RecentSession[]>;
  read_session_meta: Cmd<{ cwd: string; sessionId: string; profile?: string | null }, { model: string | null; effort: string | null }>;
  read_codex_model: Cmd<{ cwd: string; tab?: string | null }, string | null>;
  read_codex_limits: Cmd<{ cwd: string; tab?: string | null; profile?: string | null },CodexLimits | null>;
  /** status/codex.rs: a cwd's rollouts in a Raw Codex tab's own home, newest first (codex-thread.ts). */
  codex_rollout_threads: Cmd<{ cwd: string; profile: string | null }, { id: string; mtimeMs: number }[]>;
  status_snapshot: Cmd<undefined, { tab: string; age_secs: number; mtime_ms: number; payload: Record<string, unknown> }[]>;
  claude_installed_version: Cmd<undefined, string | null>;
  claude_auth_status: Cmd<undefined, boolean | null>;
  claude_auth_status_bare: Cmd<undefined, boolean | null>;
  claude_login_run: Cmd<{ tab: string; profile: string | null }, { code: number | null; cancelled: boolean; timedOut: boolean }>;
  claude_login_cancel: Cmd<{ tab: string }, boolean>;
  review_workspace: Cmd<{ cwd: string }, { path: string; files: number; truncated: boolean }>;
  // Changes bench tab (changes.rs): git runs from the repo root; act paths must be in a fresh status
  changes_status: Cmd<{ cwd: string }, ChangesStatus>;
  changes_act: Cmd<{ cwd: string; verb: "stage" | "unstage" | "revert"; paths: string[] }, void>;
  changes_commit: Cmd<{ cwd: string; message: string; sync: boolean }, ChangesCommitResult>;
  changes_sync: Cmd<{ cwd: string; mode: "sync" | "pull" | "push" }, ChangesSyncResult>;
  changes_rename_branch: Cmd<{ cwd: string; name: string }, void>;
  unreal_status: Cmd<{ cwd: string }, UnrealStatus>;
  // Jira, Notion and Slack bench tabs: JiraCommands, NotionCommands, SlackCommands (src/<module>/ipc.ts)
  bang_run: Cmd<{ cwd: string; command: string }, { stdout: string; stderr: string; code: number | null; timedOut: boolean; truncated: boolean }>;
  // chrome, editor
  open_folder: Cmd<{ path: string }, void>;
  pick_folder: Cmd<{ title?: string; start?: string }, string | null>;
  open_document: Cmd<{ path: string }, string | null>;
  open_in_browser: Cmd<{ path: string }, void>;
  set_caption_color: Cmd<{ r: number; g: number; b: number; tr: number; tg: number; tb: number }, void>;
  open_url: Cmd<{ url: string }, void>;
  build_stamp: Cmd<undefined, { head: string; dirty: boolean; builtUtc: string; local: boolean } | null>;
  open_in_editor: Cmd<{ path: string; line: number }, void>;
  // falcon (falcon.rs; the dock_* four only exist in the Falcon shell)
  falcon_available: Cmd<undefined, boolean>;
  falcon_spawn: Cmd<{ id: string; cwd: string; model?: string | null; effort?: string | null; permissionMode: string; resume?: string | null; rulesFile?: string | null; tabName?: string | null; gateway?: string | null; profile?: string | null; agent?: FalconAgent | null; rowKey?: string | null }, number | { view_generation: number; bare_warnings?: string[] }>;
  falcon_send: Cmd<{ id: string; gen: number; line: string }, void>;
  falcon_kill: Cmd<{ id: string; gen: number }, void>;
  falcon_list: Cmd<undefined, FalconList>;
  falcon_adopt: Cmd<{ id: string; session: string }, number>;
  falcon_detach: Cmd<{ id: string; gen: number }, void>;
  falcon_retract: Cmd<{ id: string; gen: number; prompt: string }, void>;
  falcon_steer: Cmd<{ id: string; gen: number; prompt: string }, void>;
  falcon_handoff_write: Cmd<{ session: string; draft: string; direction: string }, void>;
  falcon_handoff_peek: Cmd<{ direction: string }, FalconHandoff | null>;
  falcon_handoff_clear: Cmd<{ direction: string; session?: string }, void>;
  falcon_show: Cmd<undefined, boolean | null>;
  falcon_hosted_session: Cmd<{ id: string }, string | null>;
  falcon_hosted_held: Cmd<undefined, FalconHeldView[]>;
  driver_mode_get: Cmd<{ session: string }, boolean>;
  driver_mode_set: Cmd<{ session: string; on: boolean }, void>;
  falcon_dock_ask: Cmd<{ session: string }, string>;
  falcon_dock_request_claim: Cmd<undefined, { session: string; id: string; fresh: boolean } | null>;
  falcon_dock_request_release: Cmd<undefined, void>;
  falcon_dock_result_write: Cmd<{ session: string; id: string; ok: boolean; reason?: string | null }, void>;
  falcon_theme: Cmd<undefined, string | null>;
  falcon_frontend_status: Cmd<undefined, FalconFrontendStatus>;
  falcon_frontend_reload: Cmd<undefined, FalconFrontendStatus>;
  falcon_frontend_booted: Cmd<undefined, void>;
  // logs, loadout
  read_loadout: Cmd<{ cwd: string; settingsPaths: string[]; pluginDir?: string | null; profile?: string | null }, Loadout>;
  file_kb: Cmd<{ path: string }, number | null>;
  read_codex_loadout: Cmd<{ tab: string | null; profile: string | null; cwd: string }, CodexLoadout>;
  // mcp, lm studio, ports
  read_mcp_servers: Cmd<{ project: string | null; profile?: string | null }, McpRack>;
  read_codex_mcp_servers: Cmd<{ tab: string | null; profile: string | null }, McpRack>;
  list_mcp_tools: Cmd<{ url: string }, McpTool[]>;
  list_mcp_tools_stdio: Cmd<{ name: string; scope: string; project: string | null; profile: string | null; tab: string | null }, McpTool[]>;
  proxy_status: Cmd<{ url: string }, BackendStatus[]>;
  lmstudio_status: Cmd<undefined, LmStatus>;
  // dependencies (deps.rs): one DepStatus per contracts\dependencies.json entry, catalog order
  detect_dependencies: Cmd<undefined, DepReport>;
  // modules (docs/reference/modules.md): core declarations plus validated packs
  modules_list: Cmd<undefined, import("./modules/types").ModulesList>;
  module_art: Cmd<{ id: string }, ArrayBuffer>;
  // Trust Current on a gateway pack broken by "Changed Since Pinned": re-pins it, rewrites the snapshot
  module_trust_current: Cmd<{ folder: string }, import("./modules/types").ModulesList>;
  check_cli_updates: Cmd<{ fresh?: boolean }, import("./startup-updates/core").CliUpdate[]>;
  update_cli: Cmd<{ id: string; version: string }, void>;
  // hosted vs new-tab Codex versions when they differ (deps/updates/skew.rs)
  codex_skew: Cmd<undefined, import("./startup-updates/codex-skew").CodexSkew | null>;
  // ocr
  ocr_begin: Cmd<undefined, void>;
  ocr_cancel: Cmd<{ blur?: boolean }, void>;
  ocr_capture: Cmd<{ x: number; y: number; w: number; h: number; viewportWidth: number; viewportHeight: number }, void>;
  colour_sample: Cmd<{ viewportWidth: number; viewportHeight: number; clientX?: number; clientY?: number }, { rgb: [number, number, number]; clientX: number; clientY: number } | null>;
  // voice, speak, listen, voice slots: VoiceCommands in ipc-voice.ts
  // flow
  flow_run_node: Cmd<{
    runId: string; nodeId: string; attempt: number; backend: string; model: string;
    prompt: string; cwd: string; toolAllowlist: string[]; permissionMode: string;
  }, number>;
  flow_permission_modes: Cmd<{ models: string[] }, Record<string, string>>;
  flow_answer_permission: Cmd<{ runId: string; nodeId: string; permissionId: string; allow: boolean }, void>;
  flow_cancel_node: Cmd<{ runId: string; nodeId: string }, void>;
  flow_cancel_run: Cmd<{ runId: string }, void>;
  // flow_store.rs: one file per Flow storage key; `false` from write = a stale batch, ignored
  flow_store_open: Cmd<undefined, { writable: boolean; entries: Record<string, string>; page: number; seq: number; lockError: string | null }>;
  flow_store_write: Cmd<{ page: number; seq: number; entries: [string, string | null][] }, boolean>;
  // flow_output.rs: a node's full final text, `null` when no file was written
  flow_output_read: Cmd<{ runId: string; nodeId: string }, string | null>;
}

/** protocol.rs `Agent` (lowercase). falcon_spawn without one spawns Claude; a "codex" spawn or a
 *  codex adopt is refused, before any child, by a host that did not list `codex_turns`
 *  (falcon/ops.rs `agent_refusal`; the error contains "cannot run hosted Codex"). */
export type FalconAgent = "claude" | "codex";
/** One entry of falcon_list: src-falcon/src/protocol.rs `SessionSummary` (no rename_all, so
 *  snake_case; `degraded` is skip_serializing_if None, so absent rather than null; `last_holder` is absent from an older host, launcher/readopt.ts). */
export interface FalconSessionSummary {
  session: string; generation: number; agent: string; cwd: string;
  conversation: string | null; pid: number; model: string | null;
  permission_mode: string; attached: number; exited: number | null;
  queued_prompts: string[]; pending_permissions: string[]; degraded?: string; last_holder?: string | null;
  /** the built rules file the session launched with; absent when none (skip_serializing_if None) */
  rules_file?: string;
  /** the tab name the session was spawned with (`VIDAR_TAB_NAME`); absent from an older host or a spawn without one */
  tab_name?: string;
  gateway?: string;
  /** the launch profile the host built the session's env from ("bare"); absent for a default spawn */
  profile?: string;
  /** names (never values) of a profiled session's env, for its launch manifest */
  env_names?: string[];
  /** the built row payload the host passed as `--payload`; absent when the profile's own was used */
  payload_file?: string;
  /** the launcher row key a profiled session was spawned for; a re-adopted tab's /clear sends it again */
  row_key?: string;
}
/** falcon_list: the host's `{ sessions }` payload; `host_warning` is added by the Vidar build
 *  only (falcon/session_commands.rs `falcon_list_blocking`), so the Falcon shell never sees it. */
export interface FalconList {
  sessions: FalconSessionSummary[];
  host_warning?: string | null;
  /** The host's negotiate capabilities (e.g. `codex_turns`), Vidar build only; null when the
   *  control connection dropped before they were read. Absent from an older Vidar build. */
  capabilities?: string[] | null;
}
/** A view this Vidar process still holds (falcon.rs `HeldView`); old tab id and its view generation. */
export interface FalconHeldView { tab: string; session: string; gen: number }
/** src-falcon/src/frontend.rs FrontendStatus: digests of the served and the staged shell frontend. */
interface FalconFrontendStatus { loaded: string | null; staged: string | null; compatible: boolean; reason: string | null }
/** falcon.rs `Handoff` (no rename_all). */
interface FalconHandoff { session: string; draft: string; direction: string; at_ms: number }

export type CommandName = keyof Commands;
// Every typed name must be registered: a Rust rename fails the drift test, and this
// makes the stale `Commands` key fail tsc instead of rejecting at runtime.
type AssertNever<T extends never> = T;
/** @public compile-time assert; nothing imports it */
export type _TypedNamesRegistered = AssertNever<Exclude<CommandName, keyof typeof COMMAND_HOSTS>>;
// ...and every registered name must be typed: a command added to COMMAND_HOSTS without
// a `Commands` entry fails tsc here instead of falling back to an untyped invoke.
/** @public compile-time assert; nothing imports it */
export type _RegisteredNamesTyped = AssertNever<Exclude<keyof typeof COMMAND_HOSTS, CommandName>>;
type CommandArgs<K extends CommandName> = Commands[K]["args"];
export type CommandRet<K extends CommandName> = Commands[K]["ret"];
type ArgsRest<K extends CommandName> = [CommandArgs<K>] extends [undefined]
  ? [args?: undefined, options?: InvokeOptions]
  : [args: CommandArgs<K>, options?: InvokeOptions];

const rawInvoke = (IS_TAURI ? tauriInvoke : mockInvoke) as
  (cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<unknown>;

export function invoke<K extends CommandName>(cmd: K, ...rest: ArgsRest<K>): Promise<CommandRet<K>>;
export function invoke(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<unknown> {
  return rawInvoke(cmd, args, options);
}
export const listen: typeof tauriListen = IS_TAURI
  ? tauriListen
  : (mockListen as unknown as typeof tauriListen);
// Only onDragDropEvent is used (workbench drop zone); the mock resolves to a
// no-op unlisten and never emits — drops can't happen in a browser tab anyway.
export const getCurrentWebview: typeof tauriGetCurrentWebview = IS_TAURI
  ? tauriGetCurrentWebview
  : (() => ({ onDragDropEvent: async () => () => {} }) as unknown as ReturnType<typeof tauriGetCurrentWebview>);
