// Codex ThreadItem types without a home in codex.ts's main switch (schema: runtime/bridge/codex-schema,
// 0.163.0). Each maps onto a renderer that already exists: a tool pill with readable input and output,
// or a notice line. Returns null for any other type, so the caller keeps its raw fallback.
// Pills open on item/started and settle on item/completed; a completed item that never started opens
// its pill first. Notices come once, on completion (history replays started + completed back to back).

import type { AgentEvent } from "./protocol";
import type { CodexProgress } from "./codex-progress";
import { codexStructured } from "./codex-diff";
import { asyncAskEvents, asyncAskQuestions } from "./codex-async-ask";
import { pretty } from "../format";

type Json = Record<string, unknown>;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const titleWord = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** milliseconds as a short duration: 900ms, 5s, 1.5s, 2m 5s */
export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  const m = Math.floor(s / 60), rest = Math.round(s - m * 60);
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

/** text of a content-item list: text parts verbatim, media as a short placeholder (never a data URL) */
function contentText(items: unknown): string {
  if (typeof items === "string") return items;
  if (!Array.isArray(items)) return "";
  return items.map((raw) => {
    const c = obj(raw);
    if (!c) return "";
    if (typeof c.text === "string") return c.text;
    if (c.type === "inputImage" || c.type === "input_image") return "[Image]";
    if (c.type === "inputAudio" || c.type === "input_audio") return "[Audio]";
    return "";
  }).filter(Boolean).join("\n");
}

const toolName = (ns: unknown, name: string): string => (str(ns) ? `${str(ns)}.${name}` : name);

/** the pill's name and input for a pill-shaped item, else null */
function pill(item: Json): { name: string; input: Json } | null {
  switch (str(item.type)) {
    case "dynamicToolCall":
      return { name: toolName(item.namespace, str(item.tool) || "tool"), input: obj(item.arguments) ?? { arguments: item.arguments } };
    case "imageView":
      return { name: "Read", input: { file_path: str(item.path) } };
    case "imageGeneration":
      return { name: "Image", input: { prompt: str(item.revisedPrompt), path: str(item.savedPath) } };
    case "sleep":
      return { name: "Sleep", input: { duration: shortDuration(typeof item.durationMs === "number" ? item.durationMs : NaN) } };
    case "subAgentActivity":
      return { name: "Subagent", input: { agent: str(item.agentPath), thread: str(item.agentThreadId), status: titleWord(str(item.kind)) } };
    case "functionCallOutput":
      return { name: toolName(item.namespace, str(item.name) || "function"), input: {} };
    default:
      return null;
  }
}

/** the pill's result text and error flag on completion */
function result(item: Json): { content: string; isError: boolean } {
  switch (str(item.type)) {
    case "dynamicToolCall":
      return { content: contentText(item.contentItems), isError: item.status === "failed" || item.success === false };
    case "imageView":
      return { content: str(item.path), isError: false };
    case "imageGeneration": {
      const failure = obj(item.failure);
      const why = failure ? `Image generation failed: ${failure.type === "usageLimitExceeded" ? `usage limit exceeded (${str(failure.limitId)})` : str(failure.type)}` : "";
      const lines = [why, str(item.savedPath), str(item.revisedPrompt)].filter(Boolean);
      return { content: lines.join("\n"), isError: !!failure || item.status === "failed" };
    }
    case "functionCallOutput":
      return { content: contentText(item.output), isError: false };
    default:
      return { content: "", isError: false };
  }
}

/** a notice-shaped item's notice, else null */
function notice(item: Json): AgentEvent | null {
  switch (str(item.type)) {
    case "contextCompaction":
      return { kind: "notice", text: "Context Compacted", level: "info" };
    case "hookPrompt": {
      const text = Array.isArray(item.fragments) ? item.fragments.map((f) => str(obj(f)?.text)).filter(Boolean).join("\n") : "";
      return { kind: "notice", text: text ? `Hook Prompt: ${text}` : "Hook Prompt", level: "info" };
    }
    case "enteredReviewMode":
      return { kind: "notice", text: str(item.review) ? `Review Started: ${str(item.review)}` : "Review Started", level: "info" };
    case "exitedReviewMode":
      return { kind: "notice", text: str(item.review) ? `Review Finished: ${str(item.review)}` : "Review Finished", level: "info" };
    default:
      return null;
  }
}

const NOTICE_TYPES = new Set(["contextCompaction", "hookPrompt", "enteredReviewMode", "exitedReviewMode"]);

/** item/started events for a type this module owns, else null */
export function codexItemStarted(item: Json): AgentEvent[] | null {
  if (NOTICE_TYPES.has(str(item.type))) return [];
  const p = pill(item);
  return p ? [{ kind: "tool_start", toolUseId: str(item.id), name: p.name, input: p.input, parentToolUseId: null }] : null;
}

/** item/completed events for a type this module owns, else null; `started` says item/started was seen */
export function codexItemCompleted(item: Json, started: boolean): AgentEvent[] | null {
  const n = notice(item);
  if (n) return [n];
  const p = pill(item);
  if (!p) return null;
  const { content, isError } = result(item);
  const done: AgentEvent = { kind: "tool_done", toolUseId: str(item.id), content, isError, parentToolUseId: null };
  return started ? [done] : [...(codexItemStarted(item) ?? []), done];
}

export interface Change { path: string; kind: string; diff: string }
export interface ItemState {
  type: string;
  output: string;
  changes: Change[];
  thinking: boolean;
  asyncAsk?: boolean; // codex-async-ask.ts: its deltas are the flattened questions, never drawn
}

export function parseChanges(v: unknown): Change[] {
  return arr(v).map((c) => {
    const o = obj(c) ?? {};
    // PatchChangeKind is an object: { type: "add"|"delete"|"update", move_path? }
    const k = obj(o.kind);
    const kind = k ? `${str(k.type, "change")}${str(k.move_path) ? ` → ${str(k.move_path)}` : ""}` : str(o.kind, "change");
    return { path: str(o.path), kind, diff: str(o.diff) };
  });
}

/** The adapter's item/started and item/completed switch: `it` is the adapter's per-item state
 *  (created by the caller on start, looked up on completion), `live` is false while history replays. */
export const codexItemEvents = {
  started(item: Json, it: ItemState, progress: CodexProgress): AgentEvent[] {
    const id = str(item.id);
    const type = str(item.type);
    switch (type) {
      case "collabAgentToolCall": return progress.started(item);
      case "agentMessage": it.asyncAsk = asyncAskQuestions(item) !== null; return [];
      case "userMessage": case "plan": return [];
      case "reasoning":
        if (it.thinking) return [];
        it.thinking = true;
        return [{ kind: "thinking", blockId: id, done: false }];
      case "commandExecution":
        return [{ kind: "tool_start", toolUseId: id, name: "Command", input: { command: str(item.command), cwd: str(item.cwd) }, parentToolUseId: null }];
      case "fileChange": {
        it.changes = parseChanges(item.changes);
        return [{ kind: "tool_start", toolUseId: id, name: "Edit", input: { changes: it.changes.map((c) => ({ path: c.path, kind: c.kind })) }, parentToolUseId: null }];
      }
      case "mcpToolCall":
        return [{ kind: "tool_start", toolUseId: id, name: `${str(item.server, "mcp")}.${str(item.tool, "tool")}`, input: item.arguments, parentToolUseId: null }];
      case "webSearch":
        return [{ kind: "tool_start", toolUseId: id, name: "WebSearch", input: { query: str(item.query) }, parentToolUseId: null }];
      default:
        return codexItemStarted(item) ?? [{ kind: "tool_start", toolUseId: id, name: type || "item", input: item, parentToolUseId: null }];
    }
  },

  completed(item: Json, it: ItemState | undefined, progress: CodexProgress, live: boolean): AgentEvent[] {
    const id = str(item.id);
    const type = str(item.type);
    const status = str(item.status, "completed");
    const failed = status !== "completed" && status !== "inProgress";
    switch (type) {
      case "collabAgentToolCall": return progress.completed(item, live);
      case "userMessage": return [];
      case "agentMessage": return asyncAskEvents(item) ?? [{ kind: "text_done", blockId: id, markdown: str(item.text), parentToolUseId: null }];
      case "plan":
        return [{ kind: "text_done", blockId: id, markdown: str(item.text), parentToolUseId: null }];
      case "reasoning":
        return [{ kind: "thinking", blockId: id, done: true }];
      case "commandExecution": {
        const content = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : it?.output ?? "";
        return [{ kind: "tool_done", toolUseId: id, content, isError: failed, structured: { status, exitCode: item.exitCode ?? null, durationMs: item.durationMs ?? null }, parentToolUseId: null }];
      }
      case "fileChange": {
        const changes = parseChanges(item.changes);
        const list = changes.length ? changes : it?.changes ?? [];
        return [{ kind: "tool_done", toolUseId: id, content: list.map((c) => `${c.kind} ${c.path}\n${c.diff}`).join("\n\n"), isError: failed, structured: codexStructured(list, status), parentToolUseId: null }];
      }
      case "mcpToolCall": {
        const error = obj(item.error);
        return [{ kind: "tool_done", toolUseId: id, content: pretty(error ?? item.result ?? ""), isError: failed || !!error, parentToolUseId: null }];
      }
      case "webSearch":
        return [{ kind: "tool_done", toolUseId: id, content: pretty(item.results ?? item.action ?? ""), isError: false, parentToolUseId: null }];
      default:
        return codexItemCompleted(item, !!it) ?? [{ kind: "tool_done", toolUseId: id, content: pretty(item), isError: failed, parentToolUseId: null }];
    }
  },
};
