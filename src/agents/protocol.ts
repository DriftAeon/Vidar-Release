// Vidar's own event vocabulary for a Rendered session. The renderer
// (panels/rendered.ts and its panels/rendered/* modules) sees ONLY these; each agent has an adapter that turns
// its wire format into them (agents/claude.ts for the Agent SDK sidecar, a
// agents/codex.ts for Codex app-server). The rule that keeps drift visible: an
// adapter never drops a line it does not understand — it becomes `unknown`
// and the renderer shows it collapsed with a counter.

import permissionModes from "../../contracts/permission-modes.json" with { type: "json" };

/** auto = Claude Code's classifier or Codex Auto Review, according to the agent.
 *  The union is the type-level mirror of contracts/permission-modes.json (JSON imports widen
 *  to string[], so it cannot be derived); change both together. */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto";
/** Mirror of contracts/effort-levels.json; the only runtime value, everything else imports the type. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = typeof EFFORT_LEVELS[number];
/** The runtime allowlist, single-sourced with Falcon (protocol.rs) and launch. */
export const PERMISSION_MODES: readonly PermissionMode[] = permissionModes as PermissionMode[];
export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as readonly string[]).includes(v);
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface PermissionSuggestion {
  /** opaque to Vidar; echoed back verbatim when the user picks "allow for session" */
  raw: unknown;
  destination?: string;
}

export type PlanStatus = "completed" | "inProgress" | "pending";
/** An agent's step checklist: the explanation line and each step with its status. */
export interface PlanView {
  explanation: string;
  steps: { text: string; status: PlanStatus }[];
}

export type AgentEvent =
  | { kind: "session"; sessionId: string; model: string; commands: string[]; terminalCommands: string[]; tools: string[]; permissionMode: string; cwd: string; version?: string }
  | { kind: "turn_start" }
  /** a user message from history (resume replay), drawn as a user block */
  | { kind: "user_echo"; text: string }
  /** history replay boundaries: the body batches scrolling and, at the end, finalises tools that never got a result */
  | { kind: "replay"; phase: "start" | "end"; count: number; truncated?: number }
  | { kind: "text_delta"; blockId: string; text: string }
  /** `plan`: a checklist (Codex turn/plan/updated) the renderer draws as a card; `markdown` stays its text form */
  | { kind: "text_done"; blockId: string; markdown: string; parentToolUseId: string | null; plan?: PlanView }
  /** a Codex async ask (request_user_input_async): drawn as a Question card that answers with
   *  the next user message; it never holds the composer */
  | { kind: "ask_async"; blockId: string; questions: { title: string; options: string[] }[] }
  | { kind: "thinking"; blockId: string; done: boolean }
  /** the model started emitting a tool call; input not complete yet */
  | { kind: "tool_pending"; toolUseId: string; name: string; parentToolUseId: string | null }
  /** complete tool call (authoritative input) */
  | { kind: "tool_start"; toolUseId: string; name: string; input: unknown; inputTruncated?: number; parentToolUseId: string | null }
  | { kind: "tool_done"; toolUseId: string; content: string; isError: boolean; structured?: unknown; truncated?: number; parentToolUseId: string | null }
  /** toolUseId links the request to its tool_pending/tool_start pill (absent for Codex) */
  | { kind: "approval"; requestId: string; toolUseId?: string; tool: string; input: unknown; inputBytes: number; suggestions: PermissionSuggestion[] }
  | { kind: "turn_done"; subtype: string; usage: Usage | null; costUsd: number | null; numTurns: number | null; denials: string[]; resultText: string; isError: boolean; contextWindow: number | null }
  /** account rate-limit window as the API reports it; utilization is 0–100 */
  | { kind: "rate_limit"; window: "five_hour" | "seven_day" | string; utilization: number | null; resetsAt: number | null; status: string }
  /** reasoning effort applied to the turn that just ended ("low" … "max"); Claude sidecar Stop hook */
  | { kind: "effort"; level: string }
  /** one muted line; a quiet notice is bookkeeping the renderer may drop (it does) */
  | { kind: "notice"; text: string; level: "info" | "warn" | "error"; quiet?: boolean }
  /** permission mode as the agent reports it. ack=true answers a set request
   *  (mode=null: it failed, see error); ack=false is an unsolicited report (system/status). */
  | { kind: "mode"; mode: PermissionMode | null; ack: boolean; error?: string }
  /** the model a fresh session is expected to use (from settings), before init confirms it */
  | { kind: "model_hint"; model: string }
  /** answer to a set-model request: model=null means it failed (see error) */
  | { kind: "model_set"; model: string | null; error?: string }
  /** the agent's own list of selectable models, for the status-bar picker; `partial` while more pages follow */
  | { kind: "models"; models: { value: string; label: string; resolved?: string; effortLevels?: readonly Effort[] }[]; partial?: true }
  /** asynchronously refreshed slash palette catalog (Codex skills/list) */
  | { kind: "commands"; commands: string[] }
  /** prompt-cache TTL in ms; a model switch also forfeits the cache, so this resets the clock */
  | { kind: "cache_ttl"; ttlMs: number }
  | { kind: "exit"; code: number | null }
  /** a user message could not be delivered (session failed to open, request rejected): the body restores the draft */
  | { kind: "send_failed"; text: string; reason: string }
  /** the agent resolved or withdrew an approval on its own (turn ended, request superseded) */
  | { kind: "approval_done"; requestId: string; reason: string }
  /** a background subagent's lifecycle: "launched" from the Agent tool's own result text
   *  (taskId = agentId), "done" from the SDK's typed `system/task_notification` (sdk.d.ts
   *  SDKTaskNotificationMessage, 0.3.266 — see claude.ts `system()`); the bare-string
   *  `<task-notification>` and peer hand-back paths remain for between-turn user messages.
   *  toolUseId links "launched" to its pill; report is the agent's final report (hand-back string or the
   *  bare-string <result>), tokens its total from the notification's usage. "resumed" is a SendMessage
   *  tool_result carrying `resumedAgentId` (taskId = that id, toolUseId = the SendMessage call): a finished
   *  agent running again; a SendMessage to a live peer has no such field and emits nothing */
  | { kind: "task"; phase: "launched" | "resumed" | "done"; taskId: string; toolUseId?: string; status?: string; summary?: string; report?: string; tokens?: number;
      /** "done" from a terminal task_updated (failed/killed), not a notification: agent rows only */
      fromUpdate?: true }
  /** SDK level signal: every live background task id after a membership change (REPLACE semantics);
   *  subagentOwned is the subset a subagent started (task_started owned_by_subagent, not ambient);
   *  subagentOwners maps those whose owner resolved to the owning Agent call's tool_use_id */
  | { kind: "tasks_live"; taskIds: string[]; subagentOwned?: string[]; subagentOwners?: Record<string, string> }
  /** the agent's own account state (Codex account/read, account/login/completed): drives the Not Logged In pill */
  | { kind: "auth"; loggedIn: boolean }
  /** a login the agent started wants this page opened in the browser (only https://auth.openai.com/ links) */
  | { kind: "login_url"; url: string }
  | { kind: "unknown"; type: string; raw: string };

export interface AdapterStart {
  cwd: string;
  model?: string;
  effort?: Effort;
  permissionMode: PermissionMode;
  /** agent session / thread id to resume */
  resume?: string;
  /** Codex Bare rune payload, sent as developerInstructions on every thread/start (never thread/resume) */
  developerInstructions?: string;
}

/** What the renderer sends back through an adapter. An adapter that speaks a
 *  request/response protocol (Codex app-server) originates lines of its own:
 *  the body hands it `attach(send)` once the process is up, then `start()`.
 *  The encode* methods return the line to send, or `null` when the adapter
 *  already sent (or queued) it itself. */
/** How a logged-out tab logs in through its own agent process (Codex account/login/start). */
export type LoginMethod = "chatgpt" | { apiKey: string };

export interface AgentAdapter {
  /** one wire line in, zero or more events out; never throws */
  feed(line: string): AgentEvent[];
  /** `emit` carries events an encode* call produces outside feed (Codex: a turn refused while logged out);
   *  `send` may return its write's outcome (the body's resolves false on a failed write) */
  attach(send: (line: string) => unknown, emit?: (ev: AgentEvent) => void): void;
  start(opts: AdapterStart): void;
  encodeUser(content: string): string | null;
  encodePermission(requestId: string, decision: { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message?: string }): string | null;
  /** Codex only: why this decision would be refused unsent (a misfit form answer), so the card stays open; else null. */
  permissionRefusal?(requestId: string, decision: { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message?: string }): string | null;
  encodeInterrupt(): string | null;
  encodeSetPermissionMode(mode: PermissionMode): string | null;
  /** null can mean applied locally for the next turn (Codex); other agents send a setter. */
  encodeSetModel(model: string): string | null;
  /** Session-scoped effort; Codex applies locally for the next turn. */
  encodeSetEffort(level: Effort): string | null;
  /** Codex only: start a login in the agent's own process. An API key goes on the wire once and
   *  nowhere else (no event, notice or error text carries it). */
  encodeLogin?(method: LoginMethod): string | null;
  /** Codex only: the initialize reply has landed, so a login request can be answered. */
  loginReady?(): boolean;
  /** The process exited: events for drafts it never took (Codex: send_failed per queued or
   *  login-held draft). Called once from the body's onExit. */
  exited?(): AgentEvent[];
  /** Hosted only: one journal record the host broadcast (the unwrapped body), `gen` the backend
   *  generation it arrived under. Events for setters another client or a replay applied. */
  hostRecord?(body: Record<string, unknown>, gen?: number): AgentEvent[];
}
