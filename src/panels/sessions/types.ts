// Tab record and launch types shared by sessions.ts and its sessions/* modules;
// sessions.ts re-exports the public ones, so importers are unchanged.
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { RenderedBody } from "../rendered";
import type { Effort, PermissionMode } from "../../agents/protocol";
import type { RulesLaunch } from "../../rules/inject";

/** A tab has one BODY: an xterm over a pty (terminal), or a Rendered
 *  transcript over a headless agent (panels/rendered.ts). The body is fixed
 *  for the tab's life (the body-switch pathway was removed 2026-10-18).
 *  "page" is a frontend-only view (openPageTab): no pty, no agent,
 *  never restored. */
export type SessionBody = "terminal" | "rendered" | "page";

export interface TerminalSession {
  agent: SessionAgent;
  id: string;
  cwd: string;
  /** what the launcher passed to the shell — the review bridge checks it for `-a never` */
  launchArgs?: string[];
  /** the launcher row's shell wrapper (LaunchOpts.shell); the Astra arm check refuses any */
  shell?: string;
  model?: string;
  effort?: Effort;
  /** launcher role (LaunchOpts.role); the character reads it for raw desk tabs with no model string */
  role?: LaunchOpts["role"];
  body: SessionBody;
  /** terminal body */
  term?: Terminal;
  /** This terminal attachment's tag, chosen before spawn_pty and echoed as `gen` on its events. */
  ptyGen?: number;
  fit?: FitAddon;
  search?: SearchAddon;
  ro?: ResizeObserver;
  /** rendered body */
  rendered?: RenderedBody;
  /** page body: the PageSpec id (one tab per id) and the teardown its mount returned */
  pageId?: string;
  pageDispose?: () => void;
  /** Falcon host identity for an adopted durable session. */
  falconSession?: string;
  /** Falcon identity learned after a hosted spawn attaches. */
  tabOrderFalconSession?: string;
  /** Stable identity of an in-process Codex tab across a restore. */
  tabKey?: string;
  closeError?: string;
  permissionMode?: PermissionMode;
  /** rules prepared at launch, reused by Resume, Retry and body switches; its warnings are shown once */
  rules?: RulesLaunch;
  /** launch profile (LaunchOpts.profile); every spawn of this tab carries it, never a default line */
  profile?: string;
  /** the launching row's `key`: every spawn_pty of a profiled tab carries it, so Rust finds the row's sets */
  rowKey?: string;
  container: HTMLElement;
  button: HTMLButtonElement;
  alive: boolean;
  /** grid last sent to the pty — see syncPty */
  ptyCols: number;
  ptyRows: number;
}

export interface LaunchOpts {
  agent?: SessionAgent;
  /** roster identity for the tab art and gateway routing guard; gateway modules share
   *  the "claude" CLI kind. Defaults to the kind. */
  art?: string;
  shell?: string;
  cwd?: string;
  // A launcher-declared initial model. It is deliberately not treated as live
  // state: an in-session /model selection remains owned by Codex.
  model?: string;
  effort?: Effort;
  args?: string[];
  title?: string;
  /** "astra": arm this tab for review dispatch as soon as it's up (launcher pick = consent). */
  role?: "astra";
  /** background tab (the ask gate's Astra): open it but hand focus straight back to
   *  `returnTo`. For a rendered body there is no
   *  focus to hand back — the new tab is created without ever touching
   *  `visible`/`activeId`, so the old tab stays exactly where it was. */
  background?: boolean;
  returnTo?: string;
  /** "rendered": headless Claude/Codex drawn by Vidar; unsupported routes stay terminal. */
  body?: SessionBody;
  /** rendered tabs: starting permission mode (Rust refuses anything outside the allowlist) */
  permissionMode?: PermissionMode;
  /** rendered tabs: Claude session id to resume into the new tab */
  resume?: string;
  /** prepared once per fresh launch (rules/prepare.ts); an adopt seeds it from `summary.rules_file` */
  rules?: RulesLaunch;
  /** launch profile id from the row (AgentType.profile): spawn_pty gets it with no shell or args */
  profile?: string;
  /** the row's `key` (AgentType.key), sent as spawn_pty `rowKey` with a profile */
  rowKey?: string;
  /** adopt this existing Falcon-hosted Claude session; never spawns a second Claude */
  falconSession?: string;
  /** Internal startup restore identity; ordinary opens receive a fresh key. */
  tabKey?: string;
  /** Place this startup tab into its saved strip slot. */
  restoreSlot?: boolean;
  /** rendered tabs: composer text to preload (Jettison/Dock handoff) */
  draft?: string;
  /** rendered tabs: fires once the first spawn/adopt attempt settles (see
   *  rendered.ts's `RenderedOpts.onAdopted`) */
  onAdopted?: (ok: boolean, reason?: string) => void;
}

// "gemini" is a terminal-only kind: no Rendered adapter, no resume source;
// every Codex/Claude special case below compares literally, so it takes the generic path.
// "pi" is the same terminal-only kind as gemini.
export type SessionAgent = "claude" | "codex" | "gemini" | "pi" | "shell";

/** A frontend-only page shown as a tab (openPageTab). `mount` paints into the
 *  tab's `.page-host` and returns its teardown, called when the tab closes. */
export interface PageSpec {
  id: string;
  title: string;
  mount(root: HTMLElement): () => void;
}

