/* The TS owner of vidar.json:
   the hand-written `VidarConfig` shape, one memoized `read_config` for every consumer
   (main.ts's config-gated init, the character panel's saved views), the `settings-changed`
   fan-out that `patch_settings` emits (src-tauri/src/settings/commands.rs), and the
   `reload_config` hook for hand edits, and `resolveDefaultCwd` over `read_default_cwd`.
   No other module invokes read_config. */
import { invoke, listen } from "./ipc";
import type { Effort, PermissionMode } from "./agents/protocol";
import type { Macro } from "./panels/macros";
import type { VoiceCfg } from "./voice";
import type { WakewordCfg } from "./panels/listen";
import type { AgentId } from "./agents/id";

// WHAT a tab runs. `id` is the SessionAgent kind (tab colour, agent-scoped
// controls); gateway pack ids are `claude`, anything else is treated as a plain shell.
export interface AgentType {
  id: string;
  label?: string;
  shell?: string;
  args?: string[];
  model?: string;
  effort?: Effort;
  /** "astra": the tab arms itself for review dispatch (sessions.ts bridge). */
  role?: "astra";
  /** Agent-level cwd that overrides the picked location — Astra's workspace-write
   *  sandbox is scoped by cwd, so a reviewer gets bridge\display, not the repo. */
  cwd?: string;
  /** Variant: render as a row in the flyout of the first top-level type whose
   *  `id` matches, not as a top-level row. Needs a non-blank `cwd` (a variant
   *  has no location step). An `under` naming no top-level id is promoted to a
   *  top-level row with a console warning, so a typo stays visible. */
  under?: string;
  /** "rendered": headless agent drawn by Vidar (panels/rendered.ts). Claude only. */
  body?: "rendered";
  /** Rendered tabs only; Rust refuses anything outside the protocol's PermissionMode set. */
  permissionMode?: PermissionMode;
  /** Stable overlay identity (config-agents.ts). Every built-in carries a unique one; a
   *  vidar.json entry with `key` matches that row (and may relabel or move it), one without
   *  matches by id/under/label. */
  key?: string;
  /** vidar.json only: `true` removes the matching built-in row (a root takes its variants
   *  along). Warned about when nothing matches. */
  disabled?: boolean;
  /** Dependency ids from the catalog (contracts\dependencies.json) this row needs to launch.
   *  A missing one hides the row from the launcher (a root takes its variants with it);
   *  unknown ids and a not-yet-loaded report hide nothing (launcher\roster-shown.ts). */
  requires?: string[];
  /** Rule module ids injected into a tab launched from this row (src/rules/). Needs a `key`;
   *  a row without one, and vendor rows, launch without rules and say so in the tab. */
  rules?: string[];
  /** Launch profile id ("bare": profiles/bare/claude.json). The backend owns that row's spawn line,
   *  so a profiled row sends no shell or args, ignores `rules`, and needs no cwd as a variant. */
  profile?: string;
  /** Rune sets this Bare row (Raw or Rendered) loads into its payload (Rust reads them from vidar.json by `key`).
   *  Needs a `key`; Claude and Codex Bare rows both carry the key; the launcher refuses a row carrying `sets` that is keyless or not Bare (roster.ts spawnFrom). */
  sets?: unknown[];
}

// WHERE it runs.
export interface Location {
  label: string;
  cwd: string;
}

export interface VidarConfig {
  // Absent = schema v0; settings::migrate stamps the current version on
  // every read_config. Informational only — nothing here branches on it yet.
  configVersion?: number;
  fontSize?: number;
  defaultCwd?: string;
  /** Legacy file-link editor (Rider); read only when `editor.exe` is blank or absent. */
  riderPath?: string;
  /** File-link editor: exe plus argv array; `{file}`/`{line}` replaced per element (editor.rs). */
  editor?: { exe?: string; args?: string[] };
  /** App for Open Externally on a document (an .exe); absent = the Windows default app. */
  documentApp?: string;
  /** Primary agent (agents/primary.ts); absent or invalid = unset. */
  primaryAgent?: AgentId;
  /** Flow canvas grid-line opacity, whole percent 0-100; absent = 55 (src/flow/grid-opacity.ts). */
  flowGridOpacity?: number;
  agents?: AgentType[];
  locations?: Location[];
  macros?: Macro[];
  // shortcut id -> chord; only overrides of the built-in defaults are stored
  shortcuts?: Record<string, string>;
  // always filled in by Rust (defaults applied); absent only if read_config itself failed
  voice?: VoiceCfg;
  // same "always filled in by Rust" contract as voice, above
  wakeword?: WakewordCfg;
  /**
   * Retired pick for the `rewrite` voice slot (use `voiceSlots.rewrite`): "none" = empty, any
   * other value makes the slot broken, so the raw file may hold any string. Absent = empty
   * (verbatim, no model). Rust reads it raw per Speak press (voice_slots); what the slot
   * resolved to comes from `voice_slots_status`, never from this field.
   */
  speakRewrite?: string;
  /** Per-character saved default camera view: id -> `{ position, target, zoom }`. Untrusted
   *  JSON — character/view.ts validates shape before applying one. Written by
   *  `save_character_view`, which does not emit settings-changed. */
  characterViews?: Record<string, unknown>;
  /** Character window stage: a `content\stages\` id; absent = the built-in default stage.
   *  Untrusted (opaque in Rust's read): character/stage-pick.ts `chooseStage` decides. */
  characterStage?: unknown;
  /** Capability overlay: `false` switches a capability off; any other value is ignored,
   *  so it can never turn on what the registry's facts leave off (capabilities/registry.ts). */
  capabilities?: Record<string, unknown>;
  /** Folder of the rule-module library (relative = under the Vidar root); read by Rust `rules_prepare`. */
  rulesLibrary?: string;
  /** Which body row leads the launcher's body column: "bare" puts the preferred Bare row first, "raw"
   *  keeps Raw first; absent or any other value = the build default (launcher/body-order.ts). Hand-edit
   *  only; read once at start. */
  launcherLead?: "bare" | "raw";
  /** Falcon options. `hostedCodex: true` lets Codex Rendered tabs run in the Falcon host when it can
   *  (opt-in until the live journeys pass); read once at start (launcher/readopt.ts). Untrusted shape. */
  falcon?: unknown;
  /** User module names, module id -> name. Untrusted shape: src/modules/names.ts cleans it and owns the
   *  save; patch_settings validates against the same rules (tests/fixtures/module-names.json). */
  moduleNames?: unknown;
  /** Tray behaviour `{ closeToTray, summonHotkey }`, read once at start by Rust `tray::install`.
   *  Untrusted shape: settings/window-tray.ts reads fields defensively; patch_settings validates. */
  window?: unknown;
}

/** `settings::schema::ConfigResult`. `error` is the alert banner, `notice` the neutral one. */
export interface ConfigResult {
  config: VidarConfig;
  error: string | null;
  notice: string | null;
}

/** Payload of `settings-changed` (commands.rs `patch_settings`). */
export interface SettingsChanged {
  keys: string[];
  tier: string;
}

let memo: Promise<ConfigResult> | null = null;

// An IPC failure (not a parse error, which Rust reports in `error`) becomes the banner text
// instead of an empty config with no explanation.
function settle(p: Promise<ConfigResult | undefined>): Promise<ConfigResult> {
  return p.then(
    (res) => ({ config: res?.config ?? {}, error: res?.error ?? null, notice: res?.notice ?? null }),
    (e) => ({ config: {}, error: String(e), notice: null }),
  );
}

/** The vidar.json config, read once and shared; a `settings-changed` event drops the memo
 *  so the next call reads the file again. Never rejects. */
export function loadConfig(): Promise<ConfigResult> {
  ensureListening();
  memo ??= settle(invoke("read_config"));
  return memo;
}

/** Re-read vidar.json after a hand edit (`reload_config`) and replace the memo. Callers that
 *  hold config-derived state decide themselves what to re-init; keys marked restartRequired
 *  still need a restart.
 *  @public kept unwired: the `reload_config` hook for hand edits, no trigger yet (capabilities/registry.ts) */
export function reloadConfig(): Promise<ConfigResult> {
  ensureListening();
  const p = settle(invoke("reload_config"));
  memo = p;
  void p.then((res) => { for (const cb of reloadListeners) cb(res); });
  return p;
}

const reloadListeners = new Set<(res: ConfigResult) => void>();

/** Subscribe to `reloadConfig()` (hand edits; it emits no `settings-changed`). `cb` gets the
 *  freshly read result. Returns the unsubscribe. */
export function onConfigReloaded(cb: (res: ConfigResult) => void): () => void {
  reloadListeners.add(cb);
  return () => { reloadListeners.delete(cb); };
}

/** The folder a tab with no location opens in, as the backend resolves it (config.rs
 *  `default_cwd`: vidar.json `defaultCwd` when it is an existing directory, else home) —
 *  the one source every TS site uses, so the frontend never invents a cwd. `undefined` only
 *  when neither resolves, or on an IPC failure. */
export async function resolveDefaultCwd(): Promise<string | undefined> {
  try {
    return (await invoke("read_default_cwd")) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Drops the memo without notifying subscribers, so the next `loadConfig()` reads the file.
 *  For writers that bypass `patch_settings` and emit no `settings-changed` (today
 *  `save_character_view`). */
export function invalidateConfig(): void {
  memo = null;
}

const changeListeners = new Set<(e: SettingsChanged) => void>();
let listening = false;

// One module-level listen() for the whole app, fanned out to subscribers — never one per
// subscriber (they leak and decode every event N times, same rule as sessions.ts).
function ensureListening(): void {
  if (listening) return;
  listening = true;
  void listen<SettingsChanged>("settings-changed", (e) => {
    memo = null;
    for (const cb of changeListeners) cb(e.payload);
  });
}

/** Subscribe to `settings-changed {keys, tier}`. The memo is already dropped when `cb` runs,
 *  so `loadConfig()` inside it sees the new file. Returns the unsubscribe. */
export function onSettingsChanged(cb: (e: SettingsChanged) => void): () => void {
  ensureListening();
  changeListeners.add(cb);
  return () => { changeListeners.delete(cb); };
}
