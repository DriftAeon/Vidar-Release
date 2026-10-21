// Claude adapter: Agent SDK messages (as forwarded verbatim by
// tools\claude-sidecar.mjs, one JSON per line) → protocol.ts events.
//
// Streaming shape (main session only): stream_event message_start →
// content_block_start/delta/stop … → the complete `assistant` message, which
// is authoritative — text_done and tool_start come from it, deltas only paint
// ahead. Block ids and the match of a complete block back to its streamed one live in
// claude-blocks.ts; an id is never handed out twice, so a record the stream never opened
// cannot overwrite a drawn block.
// Subagent messages (parent_tool_use_id set) draw from their complete records only: their
// stream events are dropped, their thinking blocks too, and they go straight to tool_start/tool_done. Anything unrecognised is an `unknown` event, never
// dropped; the sidecar's own envelope ({type:"sidecar"}) becomes a notice.

import type { AdapterStart, AgentAdapter, AgentEvent, Effort, PermissionMode, PermissionSuggestion, Usage } from "./protocol";
import { isPermissionMode } from "./protocol";
import { BlockIds, type Streamed } from "./claude-blocks";
import { TaskOwners } from "./claude-task-owners";

type Json = Record<string, unknown>;

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** tool_result content → plain text (string, or the text blocks joined) */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const b of arr(content)) {
    const o = obj(b);
    if (!o) continue;
    if (o.type === "text") parts.push(str(o.text));
    else if (o.type === "image") parts.push("[image]");
    else parts.push(`[${str(o.type, "block")}]`);
  }
  return parts.join("\n");
}

/** a background-agent completion block from the bare-string `<task-notification>`
 *  path: between-turn user messages and peer hand-back still use this; the
 *  typed completion is the SDK's `system/task_notification` (sdk.d.ts
 *  SDKTaskNotificationMessage, 0.3.266), handled in `system()`. Never throws:
 *  a malformed block falls back to the caller's quiet notice. */
/** The harness's stand-in when an agent handed back through SubagentHandback: a pointer at that
 *  message, never the report. It comes as `<result>` on the bare-string path and as `summary` on the
 *  typed `system/task_notification` (journal s890235d4, seq 3503, 2026-10-06: drawn inline). */
const HANDBACK_POINTER = /^This agent's report was delivered to you as a message from/;

function parseTaskNotification(content: string): AgentEvent | null {
  // the harness may put a "[SYSTEM NOTIFICATION …]" preamble in front of the block
  if (!content.startsWith("<task-notification>") && !(content.startsWith("[SYSTEM NOTIFICATION") && content.includes("<task-notification>"))) return null;
  try {
    const id = /<task-id>([^<]*)<\/task-id>/.exec(content)?.[1];
    if (!id) return null;
    const status = /<status>([^<]*)<\/status>/.exec(content)?.[1];
    const summary = /<summary>([^<]*)<\/summary>/.exec(content)?.[1];
    const toolUseId = /<tool-use-id>([^<]*)<\/tool-use-id>/.exec(content)?.[1];
    // <result> is the agent's final text, unless it handed back through SubagentHandback: then it is
    // only a pointer at that message, and the report arrives with the hand-back string instead
    const result = /<result>([\s\S]*)<\/result>/.exec(content)?.[1]?.trim();
    const report = result && !HANDBACK_POINTER.test(result) ? result : undefined;
    const tokens = Number(/<subagent_tokens>(\d+)<\/subagent_tokens>/.exec(content)?.[1]) || undefined;
    return { kind: "task", phase: "done", taskId: id, toolUseId: toolUseId || undefined, status, summary, report, tokens };
  } catch {
    return null;
  }
}

/** The `resumedAgentId` of a SendMessage tool_result, e.g.
 *  `{"success":true,"message":"Resuming agent ac9c67b","resumedAgentId":"ac9c67b6325e383f1",...}`;
 *  undefined for any other text. Never throws. */
function resumedAgentId(text: string): string | undefined {
  const s = text.trim();
  if (!s.startsWith("{") || !s.includes("\"resumedAgentId\"")) return undefined;
  try {
    const id = (JSON.parse(s) as Record<string, unknown>).resumedAgentId;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The report body of a peer hand-back string: what follows the harness frame's "The report follows:"
 *  up to `</agent-message>`, with the harness's own `[harness: …]` notes dropped and its two-space
 *  indent taken off every line. Undefined when nothing is left. */
function handbackReport(content: string): string | undefined {
  const open = content.indexOf(">", content.indexOf("<agent-message"));
  if (open < 0) return undefined;
  let body = content.slice(open + 1);
  const end = body.lastIndexOf("</agent-message>");
  if (end >= 0) body = body.slice(0, end);
  const marker = "The report follows:";
  const at = body.indexOf(marker);
  if (at >= 0) body = body.slice(at + marker.length);
  const lines = body.split(/\r?\n/).map((l) => (l.startsWith("  ") ? l.slice(2) : l));
  while (lines.length && (!lines[0].trim() || /^\[harness:[^\]]*\]\s*$/.test(lines[0].trim()))) lines.shift();
  const text = lines.join("\n").trim();
  return text || undefined;
}

/* The CLI writes its own bookkeeping into `user` transcript entries: a slash
 * command's record and output, the caveat that wraps them, hook output, `!`
 * bash lines and system reminders. Replaying those verbatim drew a bare
 * "/config" block in a resumed body — they are not the user's
 * words. Stripped from the echo; a command record left with nothing else
 * becomes one notice line, so the history still shows that it was run. */
const ANSI = /\[[0-9;]*[A-Za-z]/g;
const WRAPPERS: RegExp[] = [
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<command-contents>[\s\S]*?<\/command-contents>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<bash-input>[\s\S]*?<\/bash-input>/g,
  /<bash-stdout>[\s\S]*?<\/bash-stdout>/g,
  /<bash-stderr>[\s\S]*?<\/bash-stderr>/g,
  /^Caveat: The messages below were generated by the user while running local commands\.[^\n]*\n?/gm,
  // one-line harness markers and attachments, only ever whole lines (a user's own line never has this shape)
  /^\[Request interrupted by user[^\]\n]*\]$/gm,
  /^\[Your previous response had no visible output\.[^\]\n]*\]$/gm,
  /^\[handback-send-enforce\][^\n]*$/gm,
  /^\[Cross-session idle notice\][^\n]*$/gm,
  /^\[Image: source: [^\]\n]*\]$/gm,
  /^<skill-format>true<\/skill-format>$/gm,
];

/** Harness-injected blocks that open a user-role message and carry no user words: loaded skill
 *  bodies, hook feedback, orchestrator and cross-session messages, the compaction summary, a
 *  `/context` report, a task notification of any shape. Anchored on the harness's own opening
 *  line, so a prompt that merely mentions one never matches. */
const FURNITURE: RegExp[] = [
  /^Base directory for this skill: /,
  /^# Workflow authoring reference\n/,
  /^Stop hook feedback:\s*\n/,
  /^The coordinator sent a message while you were working:\s*\n/,
  /^Another Claude session sent a message:\s*\n<cross-session-message /,
  /^This session is being continued from a previous conversation that ran out of context\./,
  /^## Context Usage\n+\*\*Model:\*\*/,
  /^(\[SYSTEM NOTIFICATION[^\n]*\]\s*)?<task-notification>/,
];

/** a replayed user entry → the user's own text, plus any slash commands it recorded */
function unwrapUserText(text: string): { text: string; commands: string[] } {
  const commands: string[] = [];
  let s = text.replace(/<command-name>([\s\S]*?)<\/command-name>/g, (_all, name: string) => {
    const n = name.trim();
    if (n) commands.push(n);
    return "";
  });
  for (const re of WRAPPERS) s = s.replace(re, "");
  return { text: s.replace(ANSI, "").replace(/\n{3,}/g, "\n\n").trim(), commands };
}

/** replayed user text → the block the body draws, if the entry held any user words.
 * A record with nothing but the command is bookkeeping like the rest of the CLI's
 * transcript furniture: kept as a quiet notice (visible in raw, drawn nowhere).
 * The visible "Local command: /model" line was the same clutter one step in. */
function echo(raw: string): AgentEvent[] {
  const { text, commands } = unwrapUserText(raw);
  // furniture stays a quiet notice, the same outcome the live path gives every string user message
  if (text && FURNITURE.some((re) => re.test(text))) return [{ kind: "notice", text: text.slice(0, 200), level: "info", quiet: true }];
  if (text) return [{ kind: "user_echo", text }];
  // a recorded /catapult is drawn as the hop row (rendered/catapult-block.ts), so it is echoed back as its prompt
  if (commands.includes("/catapult")) return [{ kind: "user_echo", text: `/catapult ${/<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim() ?? ""}`.trim() }];
  if (commands.length) return [{ kind: "notice", text: `Local command: ${commands.join(" ")}`, level: "info", quiet: true }];
  // a marker line (interrupt, idle notice, image path) stripped to nothing: keep it as a quiet notice
  if (raw.trim()) return [{ kind: "notice", text: raw.trim().slice(0, 200), level: "info", quiet: true }];
  return [];
}

function usageOf(v: unknown): Usage | null {
  const u = obj(v);
  if (!u) return null;
  return {
    inputTokens: num(u.input_tokens) ?? 0,
    outputTokens: num(u.output_tokens) ?? 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheCreate: num(u.cache_creation_input_tokens) ?? 0,
  };
}

function modeOf(v: unknown): PermissionMode | null {
  return isPermissionMode(v) ? v : null;
}

function suggestionsOf(v: unknown): PermissionSuggestion[] {
  return arr(v).map((s) => ({ raw: s, destination: str(obj(s)?.destination) || undefined }));
}

/** streamed blocks that will never complete: an empty text_done removes the preview, a done
 *  thinking settles the thought (a repeat of a settled one is ignored by the renderer) */
function closeAbandoned(blocks: Streamed[]): AgentEvent[] {
  return blocks.map((b): AgentEvent => (b.type === "text"
    ? { kind: "text_done", blockId: b.id, markdown: "", parentToolUseId: null }
    : { kind: "thinking", blockId: b.id, done: true }));
}

export class ClaudeAdapter implements AgentAdapter {
  private ids = new BlockIds();
  /** usage of the last top-level assistant message: the current context size */
  private lastCallUsage: Usage | null = null;
  private inTurn = false;
  private owners = new TaskOwners(); // background tasks a subagent started, and which one

  feed(line: string): AgentEvent[] {
    let m: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      const o = obj(parsed);
      if (!o) return [{ kind: "unknown", type: "non-object", raw: line }];
      m = o;
    } catch {
      return [{ kind: "unknown", type: "parse-error", raw: line }];
    }
    try {
      return this.route(m, line);
    } catch (e) {
      return [{ kind: "unknown", type: `adapter-threw:${String(e)}`, raw: line }];
    }
  }

  private route(m: Json, raw: string): AgentEvent[] {
    const type = str(m.type);
    switch (type) {
      // a subagent's stream (parent_tool_use_id set) would restart the main message's block
      // state and paint into the main reply; its complete records carry everything shown
      case "stream_event": return str(m.parent_tool_use_id) ? [] : this.streamEvent(obj(m.event) ?? {});
      case "assistant": return this.assistant(m);
      case "user": return this.user(m);
      case "result": return this.result(m);
      case "system": return this.system(m, raw);
      case "permission_request": return [{
        kind: "approval",
        requestId: str(m.id),
        toolUseId: str(m.toolUseId) || undefined,
        tool: str(m.tool, "?"),
        input: m.input,
        inputBytes: num(m.inputBytes) ?? 0,
        suggestions: suggestionsOf(m.suggestions),
      }];
      case "sidecar": {
        const sub = str(m.subtype);
        if (sub === "ready") {
          const ready: AgentEvent = { kind: "notice", text: "Sidecar ready", level: "info", quiet: true };
          const hint = str(m.model);
          return hint ? [ready, { kind: "model_hint", model: hint }] : [ready];
        }
        if (sub === "closed") return [{ kind: "notice", text: "Sidecar closed", level: "info", quiet: true }];
        if (sub === "replaying") return [{ kind: "replay", phase: "start", count: num(m.count) ?? 0, truncated: num(m.truncated) ?? undefined }];
        if (sub === "replayed") return [{ kind: "replay", phase: "end", count: num(m.count) ?? 0, truncated: num(m.truncated) ?? undefined }];
        if (sub === "model") return [{ kind: "model_set", model: str(m.model) || null }];
        if (sub === "model_failed") return [{ kind: "model_set", model: null, error: str(m.message, "unknown") }];
        if (sub === "models") {
          const models = arr(m.models).map(obj).filter((o): o is Json => !!o && typeof o.value === "string")
            .map((o) => ({ value: str(o.value), label: str(o.label) || str(o.value), resolved: str(o.resolved) || undefined }));
          return [{ kind: "models", models }];
        }
        if (sub === "cache_ttl") {
          const ttl = str(m.ttl);
          if (ttl === "5m" || ttl === "1h") return [{ kind: "cache_ttl", ttlMs: ttl === "5m" ? 300_000 : 3_600_000 }];
          return [];
        }
        // The sidecar answers set_permission_mode once the SDK promise settles
        if (sub === "mode") return [{ kind: "mode", mode: modeOf(m.mode), ack: true }];
        if (sub === "mode_failed") return [{ kind: "mode", mode: null, ack: true, error: str(m.message, "unknown") }];
        return [{ kind: "notice", text: `Sidecar: ${str(m.message, sub || "?")}`, level: "error" }];
      }
      case "effort": // sidecar-made, from the SDK Stop hook's input.effort
        return str(m.level) ? [{ kind: "effort", level: str(m.level) }] : [];
      case "rate_limit_event": {
        const info = obj(m.rate_limit_info) ?? {};
        // the API reports a 0–1 fraction; tolerate a percentage if that ever changes
        const pct = (u: number | null) => (u === null ? null : u <= 1 ? Math.round(u * 100) : Math.round(u));
        const status = str(info.status, "allowed");
        // Current CLIs carry every window under `unifiedWindows` and no top-level
        // utilization (the old read got null and the panel
        // dropped the event, so Rendered tabs never showed 5H/7D). One event per
        // window; the legacy top-level fields remain the fallback.
        const windows = obj(info.unifiedWindows);
        if (windows) {
          const out: AgentEvent[] = [];
          for (const [window, raw] of Object.entries(windows)) {
            const w = obj(raw);
            if (!w) continue;
            out.push({ kind: "rate_limit", window, utilization: pct(num(w.utilization)), resetsAt: num(w.resetsAt), status });
          }
          if (out.length) return out;
        }
        return [{
          kind: "rate_limit",
          window: str(info.rateLimitType, "unknown"),
          utilization: pct(num(info.utilization)),
          resetsAt: num(info.resetsAt),
          status,
        }];
      }
      case "tool_progress":
      case "tool_use_summary":
      case "thinking_tokens":
      case "auth_status":
        return [{ kind: "notice", text: `${type}${m.subtype ? "/" + str(m.subtype) : ""}`, level: "info", quiet: true }];
      // CLI 2.1.263 (ahead of SDK 0.3.266's typings): a queued, uuid-stamped
      // command — e.g. a cross-session SendMessage into this tab — reports
      // started / completed / cancelled. Bookkeeping, not conversation.
      case "command_lifecycle":
        return [{ kind: "notice", text: `command ${str(m.state, "?")}`, level: "info", quiet: true }];
      default:
        return [{ kind: "unknown", type: type || "(no type)", raw }];
    }
  }

  private streamEvent(ev: Json): AgentEvent[] {
    const t = str(ev.type);
    if (t === "message_start") {
      // a retried stream: the abandoned attempt's preview and thoughts close (claude-blocks.ts)
      const out = closeAbandoned(this.ids.open(str(obj(ev.message)?.id) || null));
      if (!this.inTurn) { this.inTurn = true; out.push({ kind: "turn_start" }); }
      return out;
    }
    const index = num(ev.index);
    if (index === null) return [];
    if (t === "content_block_start") {
      const cb = obj(ev.content_block) ?? {};
      const cbType = str(cb.type);
      const id = this.ids.start(index, cbType);
      if (cbType === "thinking") return [{ kind: "thinking", blockId: id, done: false }];
      if (cbType === "tool_use") return [{ kind: "tool_pending", toolUseId: str(cb.id, id), name: str(cb.name, "?"), parentToolUseId: null }];
      return [];
    }
    if (t === "content_block_delta") {
      const d = obj(ev.delta) ?? {};
      const b = this.ids.streamed(index);
      if (!b) return [];
      if (d.type === "text_delta") return [{ kind: "text_delta", blockId: b.id, text: str(d.text) }];
      return []; // input_json_delta / thinking_delta: the complete message carries them
    }
    if (t === "content_block_stop") {
      const b = this.ids.streamed(index);
      if (b?.type === "thinking") return [{ kind: "thinking", blockId: b.id, done: true }];
      return [];
    }
    return []; // message_delta / message_stop carry nothing the renderer shows
  }

  private assistant(m: Json): AgentEvent[] {
    const parent = str(m.parent_tool_use_id) || null;
    const msg = obj(m.message) ?? {};
    const out: AgentEvent[] = [];
    // block ids: main records resolve to their streamed block (claude-blocks.ts); a subagent
    // record (text forwarded only with --forward-subagent-text) gets its own prefix
    const sub = parent ? this.ids.subRecord(parent) : null;
    const blockId = (type: string, index: number) => (sub ? `${sub}:${index}` : this.ids.resolve(type, index));
    // a replayed history message had no stream events: give it its own id space
    if (m.replay === true) this.ids.open(null);
    // A top-level assistant message's usage is ONE API call — input +
    // cache read + cache create is that call's context. result.usage sums the
    // whole turn (sdk.d.ts: "per-turn"), which read as 48% after an 8-tool turn.
    else if (!parent) {
      const u = usageOf(msg.usage); if (u) this.lastCallUsage = u;
      // a record of another message than the one streaming (a non-streaming retry, an error
      // record): fresh ids, and the abandoned stream's partial text closes empty (removed)
      out.push(...closeAbandoned(this.ids.adopt(str(msg.id))));
    }
    arr(msg.content).forEach((b, index) => {
      const o = obj(b);
      if (!o) return;
      const t = str(o.type);
      if (t === "text") {
        out.push({ kind: "text_done", blockId: blockId("text", index), markdown: str(o.text), parentToolUseId: parent });
      } else if (t === "tool_use") {
        const input = obj(o.input);
        const trunc = num(input?.__truncated);
        if (parent && str(o.id)) this.owners.noteCall(str(o.id), parent);
        out.push({
          kind: "tool_start",
          toolUseId: str(o.id),
          name: str(o.name, "?"),
          input: o.input,
          inputTruncated: trunc ?? undefined,
          parentToolUseId: parent,
        });
      } else if ((t === "thinking" || t === "redacted_thinking") && !parent) {
        // a child's thought has no parent field and would count a Thought in the main flow's group
        out.push({ kind: "thinking", blockId: blockId(t, index), done: true });
      }
    });
    return out;
  }

  private user(m: Json): AgentEvent[] {
    const parent = str(m.parent_tool_use_id) || null;
    const msg = obj(m.message) ?? {};
    const out: AgentEvent[] = [];
    const content = msg.content;
    const replay = m.replay === true;
    if (typeof content === "string") {
      // history: the user's own words; live: a synthetic user text (a slash
      // command's expansion) — those stay quiet
      // a completion block or peer hand-back is harness furniture, live or replayed: on replay it
      // closes the agent row like it did live instead of drawing its raw text as a user block
      // (2026-10-05: hand-back pointers showed inline after a reopen)
      const task = parseTaskNotification(content);
      if (task) return [task];
      if (replay && !/^Another Claude session sent a message:\s*\n<agent-message /.test(content)) return echo(content);
      // observed shape: a peer
      // hand-back arrives as isMeta=true, origin.kind="peer", origin.handback=true, and
      // this bare string — not the <task-notification> block parseTaskNotification expects.
      // It is the only signal `removeWaiting` (rendered.ts) is guaranteed to see, so it also
      // closes the wait; if a real task-notification later arrives for the same id,
      // removeWaiting's `!w` miss is a no-op, so there is no double-draw.
      const handback = /^Another Claude session sent a message:\s*\n<agent-message from="([a-z0-9]{8,})">/.exec(content);
      if (handback) {
        return [
          { kind: "task", phase: "done", taskId: handback[1], status: "completed", summary: undefined, report: handbackReport(content) },
          { kind: "notice", text: content.slice(0, 200), level: "info", quiet: true },
        ];
      }
      return [{ kind: "notice", text: content.slice(0, 200), level: "info", quiet: true }];
    }
    if (replay) {
      const texts = arr(content).map(obj).filter((o): o is Json => !!o && o.type === "text").map((o) => str(o.text)).filter(Boolean);
      if (texts.length) out.push(...echo(texts.join("\n")));
    }
    for (const b of arr(content)) {
      const o = obj(b);
      if (!o || o.type !== "tool_result") continue;
      const text = resultText(o.content);
      out.push({
        kind: "tool_done",
        toolUseId: str(o.tool_use_id),
        content: text,
        isError: o.is_error === true,
        structured: m.tool_use_result,
        truncated: num(o.__truncated) ?? undefined,
        parentToolUseId: parent,
      });
      // a background Agent launch: its tool_result carries the agentId, not a
      // separate event — the completion side is the SDK's typed
      // system/task_notification (see system()); the bare-string
      // `<task-notification>` block (parseTaskNotification) is the fallback path
      if (text.startsWith("Async agent launched successfully")) {
        const m2 = /agentId:\s*([a-z0-9]{8,})/.exec(text);
        if (m2) out.push({ kind: "task", phase: "launched", taskId: m2[1], toolUseId: str(o.tool_use_id) });
      }
      // a SendMessage that woke a finished background agent: its JSON result names it in
      // `resumedAgentId`; a message to a live peer or session has no such field
      const resumed = o.is_error === true ? undefined : resumedAgentId(text);
      if (resumed) out.push({ kind: "task", phase: "resumed", taskId: resumed, toolUseId: str(o.tool_use_id) });
    }
    return out;
  }

  private result(m: Json): AgentEvent[] {
    this.inTurn = false;
    this.ids.endTurn();
    const subtype = str(m.subtype, "?");
    // modelUsage: per-model totals for the turn; contextWindow is the model's size
    let contextWindow: number | null = null;
    for (const mu of Object.values(obj(m.modelUsage) ?? {})) {
      const cw = num(obj(mu)?.contextWindow);
      if (cw !== null) contextWindow = Math.max(contextWindow ?? 0, cw);
    }
    return [{
      kind: "turn_done",
      subtype,
      usage: this.lastCallUsage ?? usageOf(m.usage),
      costUsd: num(m.total_cost_usd),
      numTurns: num(m.num_turns),
      denials: arr(m.permission_denials).map((d) => `${str(obj(d)?.tool_name, "?")}`),
      resultText: str(m.result),
      isError: m.is_error === true || subtype !== "success",
      contextWindow,
    }];
  }

  private system(m: Json, raw: string): AgentEvent[] {
    const sub = str(m.subtype);
    switch (sub) {
      case "init":
        return [{
          kind: "session",
          sessionId: str(m.session_id),
          model: str(m.model),
          commands: arr(m.slash_commands).map((c) => str(c)).filter(Boolean),
          terminalCommands: arr(m.terminal_slash_commands).map((c) => str(c)).filter(Boolean),
          tools: arr(m.tools).map((c) => str(c)).filter(Boolean),
          permissionMode: str(m.permissionMode),
          cwd: str(m.cwd),
          version: str(m.claude_code_version) || undefined,
        }];
      case "compact_boundary": {
        const meta = obj(m.compact_metadata);
        return [{ kind: "notice", text: `Context compacted${meta ? ` (${str(meta.trigger, "?")}, ${num(meta.pre_tokens) ?? "?"} tokens before)` : ""}`, level: "info" }];
      }
      case "api_retry":
        return [{ kind: "notice", text: `API retry ${num(m.attempt) ?? "?"}/${num(m.max_retries) ?? "?"}: ${str(m.error, "unknown")}`, level: "warn" }];
      case "notification": {
        // CLI toast ({key, priority, text}); the " · ctrl+o to see" hint is TUI-only
        const text = str(m.text).replace(/\s*·\s*ctrl\+\w+ to \w+.*$/i, "");
        if (!text) return [{ kind: "notice", text: `system/${sub}`, level: "info", quiet: true }];
        return [{ kind: "notice", text, level: /error|fail/i.test(str(m.key) + text) ? "warn" : "info" }];
      }
      case "permission_denied":
        return []; // the denied tool row carries the one "Denied" line (2026-10-10)
      case "status": {
        // SDKStatusMessage may carry the live permissionMode: an unsolicited report
        const pm = modeOf(m.permissionMode);
        const quiet: AgentEvent = { kind: "notice", text: "system/status", level: "info", quiet: true };
        return pm ? [{ kind: "mode", mode: pm, ack: false }, quiet] : [quiet];
      }
      case "task_notification": {
        const taskId = str(m.task_id);
        if (taskId) this.owners.ended(taskId);
        if (m.ambient === true || !taskId) {
          return [{ kind: "notice", text: `system/${sub}`, level: "info", quiet: true }];
        }
        return [{
          kind: "task",
          phase: "done",
          taskId,
          toolUseId: str(m.tool_use_id) || undefined,
          status: str(m.status) || undefined,
          summary: (HANDBACK_POINTER.test(str(m.summary)) ? "" : str(m.summary)) || undefined,
          tokens: num(obj(m.usage)?.total_tokens) ?? undefined,
        }];
      }
      case "background_tasks_changed": {
        const tasks = arr(m.tasks);
        if (!Array.isArray(m.tasks)) return [{ kind: "notice", text: `system/${sub}`, level: "info", quiet: true }];
        const live = tasks.map((t) => obj(t)).filter((t): t is Json => !!t && !!str(t.task_id));
        // a subagent that ends its turn waiting on its own background tasks leaves this set
        // (CLI status "completed" while parked) while those children stay listed
        return [{ kind: "tasks_live", taskIds: live.map((t) => str(t.task_id)), ...this.owners.live(live.filter((t) => t.ambient !== true).map((t) => str(t.task_id))) }];
      }
      case "task_started":
        if (str(m.task_id) && m.owned_by_subagent === true && m.ambient !== true) this.owners.started(str(m.task_id), str(m.tool_use_id));
        return [{ kind: "notice", text: `system/${sub}`, level: "info", quiet: true }];
      case "task_updated": {
        // a parked subagent already sent its "completed" notification, so a later kill or failure
        // shows only here; "completed" is not terminal for it (it also marks the park)
        const taskId = str(m.task_id), status = str(obj(m.patch)?.status);
        if (!taskId || (status !== "failed" && status !== "killed")) return [{ kind: "notice", text: `system/${sub}`, level: "info", quiet: true }];
        return [{ kind: "task", phase: "done", taskId, status, fromUpdate: true }];
      }
      case "hook_started":
      case "hook_progress":
      case "hook_response":
      case "task_progress":
      case "session_state_changed":
      case "vcs_state_changed": // Git metadata; no conversation or turn-state change.
      case "commands_changed":
      case "informational":
      case "thinking_tokens":
      // 2.1.295: {tool_use_id, agent_id?, status: "checking"|"done"}; "checking" once a tool's
      // permission check has waited ~4 s, "done" when it settles. No surface for it yet.
      case "permission_check_status":
        return [{ kind: "notice", text: `system/${sub}`, level: "info", quiet: true }];
      default:
        // mod UI events (ui_invalidate, ...) have no surface in a Rendered tab
        if (sub.startsWith("ui_")) return [{ kind: "notice", text: `system/${sub}`, level: "info", quiet: true }];
        return [{ kind: "unknown", type: `system/${sub || "?"}`, raw }];
    }
  }

  // The sidecar takes cwd/model/mode/resume from argv and opens the session
  // itself, so there is no handshake to originate here.
  attach(_send: (line: string) => void): void {}
  start(_opts: AdapterStart): void {}

  encodeUser(content: string): string {
    return JSON.stringify({ type: "user", content });
  }
  encodePermission(requestId: string, decision: { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message?: string }): string {
    return JSON.stringify({ type: "permission_response", id: requestId, ...decision });
  }
  encodeInterrupt(): string {
    return JSON.stringify({ type: "interrupt" });
  }
  encodeSetPermissionMode(mode: PermissionMode): string {
    return JSON.stringify({ type: "set_permission_mode", mode });
  }
  encodeSetModel(model: string): string {
    return JSON.stringify({ type: "set_model", model });
  }
  encodeSetEffort(level: Effort): string {
    return JSON.stringify({ type: "set_effort", level });
  }
}
