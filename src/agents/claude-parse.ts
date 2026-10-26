// Claude record parsing: pure helpers that turn the SDK's records and the CLI's transcript text
// into protocol events. No state; claude.ts owns the adapter that calls them.

import type { AgentEvent, PermissionMode, PermissionSuggestion, Usage } from "./protocol";
import { isPermissionMode } from "./protocol";
import type { Streamed } from "./claude-blocks";

export type Json = Record<string, unknown>;

export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
export function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** tool_result content → plain text (string, or the text blocks joined) */
export function resultText(content: unknown): string {
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
export const HANDBACK_POINTER = /^This agent's report was delivered to you as a message from/;

export function parseTaskNotification(content: string): AgentEvent | null {
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
export function resumedAgentId(text: string): string | undefined {
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
export function handbackReport(content: string): string | undefined {
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
export function echo(raw: string): AgentEvent[] {
  const { text, commands } = unwrapUserText(raw);
  // furniture stays a quiet notice, the same outcome the live path gives every string user message
  if (text && FURNITURE.some((re) => re.test(text))) return [{ kind: "notice", text: text.slice(0, 200), level: "info", quiet: true }];
  if (text) return [{ kind: "user_echo", text }];
  if (commands.length) return [{ kind: "notice", text: `Local command: ${commands.join(" ")}`, level: "info", quiet: true }];
  // a marker line (interrupt, idle notice, image path) stripped to nothing: keep it as a quiet notice
  if (raw.trim()) return [{ kind: "notice", text: raw.trim().slice(0, 200), level: "info", quiet: true }];
  return [];
}

export function usageOf(v: unknown): Usage | null {
  const u = obj(v);
  if (!u) return null;
  return {
    inputTokens: num(u.input_tokens) ?? 0,
    outputTokens: num(u.output_tokens) ?? 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheCreate: num(u.cache_creation_input_tokens) ?? 0,
  };
}

export function modeOf(v: unknown): PermissionMode | null {
  return isPermissionMode(v) ? v : null;
}

export function suggestionsOf(v: unknown): PermissionSuggestion[] {
  return arr(v).map((s) => ({ raw: s, destination: str(obj(s)?.destination) || undefined }));
}

/** streamed blocks that will never complete: an empty text_done removes the preview, a done
 *  thinking settles the thought (a repeat of a settled one is ignored by the renderer) */
export function closeAbandoned(blocks: Streamed[]): AgentEvent[] {
  return blocks.map((b): AgentEvent => (b.type === "text"
    ? { kind: "text_done", blockId: b.id, markdown: "", parentToolUseId: null }
    : { kind: "thinking", blockId: b.id, done: true }));
}
