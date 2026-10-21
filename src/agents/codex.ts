// Codex adapter: `codex app-server` (JSON-RPC 2.0 over stdio, one object per
// line) → protocol.ts events. Unlike the Claude sidecar this is a
// request/response protocol, so the adapter originates lines: the
// initialize/initialized handshake, thread/start or thread/resume, one
// turn/start per user message, turn/interrupt, and the client's answers to
// the server's requests. Shapes are pinned via
// `codex app-server generate-json-schema` (0.162.1, experimental). Every server request kind the
// schema names gets a schema-valid answer: approvals, permission escalations and user questions
// become shared Rendered cards, the rest are refused in their own response shape (a decline where
// the shape has one, a JSON-RPC error otherwise) so a turn never stalls on a
// prompt Vidar cannot draw. Anything off the schema's list
// becomes an `unknown` event.
//
// One instance per process generation: the body creates a fresh adapter on
// every spawn, so thread/turn ids and pending requests never outlive the
// process they belong to.
// Hosted (`{ hosted: true }`, wrapped by codex-hosted.ts): Falcon owns the app-server, so this
// view writes nothing, sends no handshake and keeps no pending request ids.

import type { AdapterStart, AgentAdapter, AgentEvent, Effort, LoginMethod, PermissionMode, Usage } from "./protocol";
import { codexStructured } from "./codex-diff";
import { CodexSettings } from "./codex-settings";
import { codexTurnPolicy, threadParams } from "./codex-permissions";
import { KNOWN_NOTIFICATIONS } from "./codex-methods";
import { CodexRequests } from "./codex-requests";
import { CodexProgress, codexPlan, rememberCodexPlan } from "./codex-progress";
import { CodexHistory } from "./codex-history";
import { codexPlans } from "./codex-plan-store";
import { downgradeEvents, reviewerDowngrade, reviewerError, reviewNotice } from "./codex-review";
import { CodexSkills } from "./codex-skills";
import { CodexLogin, EXITED_REASON } from "./codex-login";
import { pretty } from "../format";
type Decision = Parameters<AgentAdapter["encodePermission"]>[1];

type Json = Record<string, unknown>;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
interface Change { path: string; kind: string; diff: string }
interface ItemState {
  type: string;
  output: string;
  changes: Change[];
  thinking: boolean;
}

function parseChanges(v: unknown): Change[] {
  return arr(v).map((c) => {
    const o = obj(c) ?? {};
    // PatchChangeKind is an object: { type: "add"|"delete"|"update", move_path? }
    const k = obj(o.kind);
    const kind = k ? `${str(k.type, "change")}${str(k.move_path) ? ` → ${str(k.move_path)}` : ""}` : str(o.kind, "change");
    return { path: str(o.path), kind, diff: str(o.diff) };
  });
}

export class CodexAdapter implements AgentAdapter {
  private send: (line: string) => unknown = () => {};
  /** the outcome of the last request's write (a body send resolves false on a failed write) */
  private wrote: unknown;
  private nextId = 1;
  private pending = new Map<number, { method: string; text?: string; loginAttempt?: number }>();
  private requests = new CodexRequests((id, result) => this.respond(id, result), (id, message) => this.respondError(id, message));
  private progress = new CodexProgress();
  private threadId: string | null = null;
  private turnId: string | null = null;
  private completedTurns: string[] = [];
  private stopRequested = false;
  private sessionFailed = false;
  private mode: PermissionMode = "default";
  /** Auto Review rode the last turn/start, and its turn/started has arrived (gates thread/settings/updated) */
  private sentAuto = false;
  private reviewLive = false;
  private settings = new CodexSettings();
  private skills = new CodexSkills();
  private cwd = "";
  private resume: string | undefined;
  private queuedUser: string[] = [];
  private history = new CodexHistory();
  private items = new Map<string, ItemState>();
  private lastUsage: Usage | null = null;
  private contextWindow: number | null = null;
  private emit: (ev: AgentEvent) => void = () => {};
  private login = new CodexLogin();
  private readonly hosted: boolean;
  constructor(opts: { hosted?: boolean } = {}) { this.hosted = opts.hosted === true; }

  attach(send: (line: string) => unknown, emit?: (ev: AgentEvent) => void): void {
    this.send = this.hosted ? () => {} : send; // hosted: the host answers every server request
    if (emit) this.emit = emit;
  }

  start(opts: AdapterStart): void {
    this.cwd = opts.cwd;
    this.settings.start(opts);
    this.mode = opts.permissionMode;
    this.resume = opts.resume;
    if (this.hosted) return; // the host initialized the app-server and opens the thread
    this.request("initialize", { clientInfo: { name: "vidar", title: "Vidar", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  }

  private request(method: string, params: Json, text?: string, loginAttempt?: number): number {
    if (this.hosted) return 0; // no pending id a host reply could be matched to
    const id = this.nextId++;
    this.pending.set(id, { method, text, loginAttempt });
    this.wrote = this.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return id;
  }
  private notify(method: string, params: Json) {
    this.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }
  private respond(id: unknown, result: Json) {
    this.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
  private respondError(id: unknown, message: string) {
    this.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }));
  }

  feed(line: string): AgentEvent[] {
    line = this.login.mask(line); // a server line echoing an API key in flight never reaches an event
    let m: Json;
    try {
      const o = obj(JSON.parse(line));
      if (!o) return [{ kind: "unknown", type: "non-object", raw: line }];
      m = o;
    } catch {
      return [{ kind: "unknown", type: "parse-error", raw: line }];
    }
    try {
      const hasId = m.id !== undefined && m.id !== null;
      if (hasId && typeof m.method === "string") return this.serverRequest(m, line);
      if (hasId) return this.response(m, line);
      if (typeof m.method === "string") return this.notification(m, line);
      return [{ kind: "unknown", type: "no-method", raw: line }];
    } catch (e) {
      return [{ kind: "unknown", type: `adapter-threw:${String(e)}`, raw: line }];
    }
  }

  /* ---- responses to our requests ---- */

  private response(m: Json, raw: string): AgentEvent[] {
    const id = num(m.id);
    const req = id === null ? undefined : this.pending.get(id);
    if (id !== null) this.pending.delete(id);
    if (!req) return [{ kind: "unknown", type: "response-for-unknown-id", raw }];
    const { method } = req;
    const err = obj(m.error);
    if (err && method === "thread/resume" && this.resume) {
      // a deleted or empty thread cannot be resumed: keep the tab and start a new thread, naming the old one
      const old = this.resume;
      this.resume = undefined;
      this.request("thread/start", threadParams(this.cwd, this.mode, this.settings.model, this.settings.developerInstructions));
      return [{ kind: "notice", text: `Thread ${old} could not be resumed; started a new one`, level: "warn" }];
    }
    // an unanswered account read leaves the state unknown (turns go as before); a refused login names the failure
    if (err && method === "account/read") return [{ kind: "notice", text: `${method}: ${str(err.message, "error")}`, level: "info", quiet: true }, ...this.login.settle(null, (t) => this.startTurn(t))];
    if (err && method === "account/login/start") return req.loginAttempt === this.login.loginAttempt ? this.login.failed(str(err.message, "error")) : [];
    if (err) {
      const reason = `${method}: ${str(err.message, "error")}`;
      if (method === "thread/turns/list") return this.failHistory(reason);
      const out: AgentEvent[] = [{ kind: "notice", text: reason, level: "error" }];
      const downgrade = (method === "turn/start" || method === "thread/start") && this.mode === "auto" && reviewerError(str(err.message));
      if (downgrade) { this.mode = "default"; out.push(...downgradeEvents()); }
      if (downgrade && method === "thread/start") {
        // fail safe toward the user: one retry as Default; a second error fails the session as before
        this.request("thread/start", threadParams(this.cwd, this.mode, this.settings.model, this.settings.developerInstructions));
        return out;
      }
      if (method === "initialize" || method === "thread/start" || method === "thread/resume") {
        // the session never opened: hand every queued draft back
        this.sessionFailed = true;
        for (const text of [...this.queuedUser.splice(0), ...this.login.drain()]) out.push({ kind: "send_failed", text, reason });
        out.push({ kind: "turn_done", subtype: "failed", usage: null, costUsd: null, numTurns: null, denials: [], resultText: reason, isError: true, contextWindow: this.contextWindow });
      } else if (method === "turn/start") {
        this.stopRequested = false;
        out.push({ kind: "send_failed", text: req.text ?? "", reason });
      } else if (method === "turn/interrupt" || method === "skills/list") {
        // interrupting an already-finished turn is harmless; a server without skills support is not an alarm
        return [{ kind: "notice", text: reason, level: "info", quiet: true }];
      }
      return out;
    }
    return this.reply(method, obj(m.result) ?? {}, req.loginAttempt);
  }
  /** A successful reply to `method`; hosted (codex-hosted.ts) names the method by the reply's shape. */
  reply(method: string, result: Record<string, unknown>, loginAttempt?: number): AgentEvent[] {
    switch (method) {
      case "initialize": {
        this.notify("initialized", {});
        // login state first; replies need not come in order, so a draft flushed before it waits for it
        this.login.ask(() => this.request("account/read", {}));
        const params = threadParams(this.cwd, this.mode, this.settings.model);
        // excludeTurns: history comes from thread/turns/list below; full-history hydration on
        // resume is deprecated (codex-cli 0.162.1 deprecationNotice)
        if (this.resume) this.request("thread/resume", { ...params, threadId: this.resume, excludeTurns: true });
        else this.request("thread/start", { ...params, ...(this.settings.developerInstructions ? { developerInstructions: this.settings.developerInstructions } : {}) });
        this.request("model/list", {});
        this.request("skills/list", { cwds: [this.cwd] });
        return [];
      }
      case "model/list": {
        const models = this.settings.catalog(result.data);
        if (typeof result.nextCursor !== "string") return [{ kind: "models", models }];
        this.request("model/list", { cursor: result.nextCursor });
        return [{ kind: "models", models, partial: true }];
      }
      case "skills/list":
        return [{ kind: "commands", commands: this.skills.catalog(result.data) }];
      case "account/read": return this.login.settle(result, (t) => this.startTurn(t));
      case "account/login/start": return this.login.started(result, loginAttempt ?? this.login.loginAttempt, (loginId) => { this.request("account/login/cancel", { loginId }); });
      case "thread/start":
      case "thread/resume": {
        const thread = obj(result.thread) ?? {};
        this.threadId = str(thread.id) || null;
        // the response names the reviewer the thread really got: a plain user one in Auto Review is a downgrade
        const downgrade = reviewerDowngrade(result, this.mode);
        if (downgrade) this.mode = "default";
        const ev: AgentEvent[] = [{
          kind: "session",
          sessionId: this.threadId ?? "",
          model: str(result.model) || str(thread.model) || this.settings.model || "",
          commands: this.skills.commands,
          terminalCommands: [],
          tools: [],
          permissionMode: this.mode,
          cwd: str(result.cwd) || this.cwd,
        }, ...(downgrade ? downgradeEvents() : [])];
        this.settings.model ??= str(result.model) || str(thread.model) || undefined;
        const effort = this.settings.turn.effort ?? str(result.reasoningEffort);
        if (effort) ev.push({ kind: "effort", level: effort });
        // Resume replays full history oldest-first. Queued drafts wait for the last page;
        // failed-page and pagination ordering are covered in codex-recovery.test.mjs.
        if (method === "thread/resume" && this.threadId && !this.hosted) {
          ev.push(this.history.start(this.threadId)); this.request("thread/turns/list", { threadId: this.threadId, itemsView: "full", sortDirection: "asc", limit: 200 }); return ev;
        }
        for (const text of this.queuedUser.splice(0)) ev.push(...this.startTurn(text));
        return ev;
      }
      case "thread/turns/list": {
        const live = this.items;
        this.items = new Map();
        try {
          const page = this.history.page(result, (item) => [...this.itemStarted(item), ...this.itemCompleted(item)]);
          const out: AgentEvent[] = [...page.events];
          if (page.cursor && this.threadId) {
            this.request("thread/turns/list", { threadId: this.threadId, itemsView: "full", sortDirection: "asc", limit: 200, cursor: page.cursor });
          } else {
            // a draft held by the login gate comes back as events, after the replay's end marker
            for (const text of this.queuedUser.splice(0)) out.push(...this.startTurn(text));
          }
          return out;
        } catch (error) {
          return this.failHistory(String(error));
        } finally {
          this.items = live;
        }
      }
      case "turn/start": {
        const turn = obj(result.turn);
        const tid = turn ? str(turn.id) : "";
        // Notifications may outrun this reply: retain the newer active/completed state.
        if (tid && !this.completedTurns.includes(tid) && (!this.turnId || this.turnId === tid)) {
          this.turnId = tid;
          this.flushStop();
        }
        return [];
      }
      default:
        return [];
    }
  }

  /** Falcon owns resume paging; the passive view only translates its durable envelopes. */
  hostedHistory(phase: string, params: Record<string, unknown>): AgentEvent[] {
    const live = this.items; if (phase === "turn") this.items = new Map();
    try { return this.history.hosted(phase, params, this.threadId ?? "", (item) => [...this.itemStarted(item), ...this.itemCompleted(item)]); }
    catch (error) { return this.failHistory(String(error)); }
    finally { this.items = live; }
  }

  private failHistory(reason: string): AgentEvent[] {
    const out: AgentEvent[] = [{ kind: "notice", text: `History could not be restored: ${reason}`, level: "error" }, this.history.end(true)];
    this.stopRequested = false;
    const text = [...this.queuedUser.splice(0), ...this.login.drain()].join("\n");
    if (text) out.push({ kind: "send_failed", text, reason });
    return out;
  }

  /** The process died: queued and login-held drafts were never sent, so each comes back (C5). */
  exited(): AgentEvent[] {
    const drafts = [...this.queuedUser.splice(0), ...this.login.drain()].map((text) => ({ kind: "send_failed" as const, text, reason: EXITED_REASON }));
    return [...drafts, ...this.login.exited()]; // a login still out fails into its card
  }

  /* ---- server → client requests ---- */

  private serverRequest(m: Json, raw: string): AgentEvent[] {
    const params = obj(m.params) ?? {};
    return this.requests.request(m, raw, this.items.get(str(params.itemId))?.changes ?? []);
  }

  /* ---- notifications ---- */

  private notification(m: Json, raw: string): AgentEvent[] {
    const method = str(m.method);
    const p = obj(m.params) ?? {};
    // turn/*, item/* and token usage carry threadId (schema 0.162.1). With subagents on, a
    // child thread's events share this connection: they never touch the parent's turn,
    // items or transcript (the parent's collabAgentToolCall items carry child state)
    const child = str(p.threadId);
    if (child && this.threadId && child !== this.threadId
      && (method.startsWith("turn/") || method.startsWith("item/") || method === "thread/tokenUsage/updated")) {
      if (method !== "turn/completed") return [];
      // the child's turn is over: only its own cards go
      return this.requests.end(`turn ${str(obj(p.turn)?.status, "completed")}`, child);
    }
    const eventTurn = str(p.turnId);
    if (eventTurn && (this.completedTurns.includes(eventTurn) || (this.turnId && eventTurn !== this.turnId))
      && (method.startsWith("item/") || method === "turn/plan/updated" || method === "thread/tokenUsage/updated")) return [];
    switch (method) {
      case "skills/changed":
        this.request("skills/list", { cwds: [this.cwd], forceReload: true });
        return [];
      case "turn/started": {
        const turn = obj(p.turn);
        const tid = turn ? str(turn.id) : "";
        if (tid && this.completedTurns.includes(tid)) return [];
        if (tid) {
          this.turnId = tid;
          this.flushStop();
        }
        if (!str(p.threadId) || str(p.threadId) === this.threadId) this.reviewLive = this.sentAuto;
        return [{ kind: "turn_start" }];
      }
      case "thread/settings/updated":
        // honoured only once a turn sent with Auto Review has started: staged picks never revert
        if (this.reviewLive && str(p.threadId) === this.threadId && reviewerDowngrade(p.threadSettings, this.mode)) {
          this.mode = "default";
          return downgradeEvents();
        }
        return [{ kind: "notice", text: method, level: "info", quiet: true }];
      case "item/autoApprovalReview/completed":
        // autoApprovalReview/strictReviewRequired and .../started stay quiet method notices (default arm)
        return [reviewNotice(p) ?? { kind: "notice", text: method, level: "info", quiet: true }];
      case "turn/plan/updated":
        if (this.threadId) void rememberCodexPlan(this.threadId, p);
        return codexPlan(p);
      case "thread/archived":
      case "thread/deleted":
        // closing a view keeps plans for Resume; only archive/delete forgets
        if (str(p.threadId)) void codexPlans.forget(str(p.threadId));
        return [{ kind: "notice", text: method, level: "info", quiet: true }];
      case "item/started": return this.itemStarted(obj(p.item) ?? {});
      case "item/completed": return this.itemCompleted(obj(p.item) ?? {});
      case "item/agentMessage/delta":
      case "item/plan/delta":
        return [{ kind: "text_delta", blockId: str(p.itemId), text: str(p.delta) }];
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const it = this.item(str(p.itemId), "commandExecution");
        it.output += str(p.delta);
        return [];
      }
      case "item/fileChange/patchUpdated": {
        // keeps the approval card's diff current; shape checked defensively
        const it = this.item(str(p.itemId), "fileChange");
        const changes = parseChanges(p.changes ?? obj(p.item)?.changes);
        if (changes.length) it.changes = changes;
        return [];
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded": {
        const id = str(p.itemId);
        const it = this.item(id, "reasoning");
        if (it.thinking) return [];
        it.thinking = true;
        return [{ kind: "thinking", blockId: id, done: false }];
      }
      case "serverRequest/resolved": {
        // the server withdrew or auto-resolved a request: settle the card silently
        const rid = p.requestId ?? p.id;
        if (rid === undefined) return [];
        return this.requests.resolved(rid, "resolved by Codex");
      }
      case "thread/tokenUsage/updated": {
        const tu = obj(p.tokenUsage) ?? {};
        const last = obj(tu.last) ?? {};
        // inputTokens is the prompt side of the last request (INFERRED to include
        // the cached part; cacheRead/cacheCreate stay 0 so the body does not
        // double count) — checked against the TUI's gauge at implementation
        this.lastUsage = {
          inputTokens: num(last.inputTokens) ?? 0,
          outputTokens: num(last.outputTokens) ?? 0,
          cacheRead: 0,
          cacheCreate: 0,
        };
        this.contextWindow = num(tu.modelContextWindow) ?? this.contextWindow;
        return [];
      }
      case "account/rateLimits/updated": {
        const rl = obj(p.rateLimits) ?? {};
        const out: AgentEvent[] = [];
        for (const k of ["primary", "secondary"]) {
          const w = obj(rl[k]);
          if (!w) continue;
          const mins = num(w.windowDurationMins);
          const window = mins === 300 ? "five_hour" : mins === 10080 ? "seven_day" : `other-${mins ?? k}`;
          out.push({ kind: "rate_limit", window, utilization: num(w.usedPercent), resetsAt: num(w.resetsAt), status: "allowed" });
        }
        return out;
      }
      case "turn/completed": {
        const turn = obj(p.turn) ?? {};
        const status = str(turn.status, "completed");
        const error = obj(turn.error);
        const tid = str(turn.id);
        if (tid && (this.completedTurns.includes(tid) || (this.turnId && tid !== this.turnId))) return [];
        if (tid) {
          this.completedTurns.push(tid);
          if (this.completedTurns.length > 16) this.completedTurns.shift();
        }
        if (!tid || tid === this.turnId) this.turnId = null;
        this.stopRequested = false;
        this.items.clear();
        const out: AgentEvent[] = [];
        // any card still up belongs to a turn that is over
        out.push(...this.requests.end(`turn ${status}`, this.threadId ?? undefined));
        out.push({
          kind: "turn_done",
          subtype: status === "completed" ? "success" : status, // the protocol's clean value
          usage: this.lastUsage,
          costUsd: null,
          numTurns: null,
          denials: [],
          resultText: error ? str(error.message) : "",
          isError: status !== "completed",
          contextWindow: this.contextWindow,
        });
        return out;
      }
      case "error": {
        const e = obj(p.error) ?? {};
        return [{ kind: "notice", text: `Codex error: ${str(e.message, "?")}${p.willRetry === true ? " (retrying)" : ""}`, level: "error" }];
      }
      case "account/login/completed":
      case "account/updated":
        return this.login.notification(method, p);
      case "thread/compacted":
        return [{ kind: "notice", text: "Context compacted", level: "info" }];
      case "warning":
      case "guardianWarning":
      case "deprecationNotice":
      case "configWarning":
        // schema v2: deprecationNotice and configWarning carry summary (+ details); the others carry message
        return [{ kind: "notice", text: `${method}: ${str(p.summary) || str(p.details) || str(p.message) || pretty(p).slice(0, 200)}`, level: "warn" }];
      default:
        if (KNOWN_NOTIFICATIONS.has(method)) return [{ kind: "notice", text: method, level: "info", quiet: true }];
        return [{ kind: "unknown", type: method || "(no method)", raw }];
    }
  }

  private item(id: string, type: string): ItemState {
    let it = this.items.get(id);
    if (!it) { it = { type, output: "", changes: [], thinking: false }; this.items.set(id, it); }
    return it;
  }

  private itemStarted(item: Json): AgentEvent[] {
    const id = str(item.id);
    const type = str(item.type);
    const it = this.item(id, type);
    switch (type) {
      case "collabAgentToolCall": return this.progress.started(item);
      case "userMessage":
      case "agentMessage":
      case "plan":
        return [];
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
      case "contextCompaction":
        return [{ kind: "notice", text: "Context compacted", level: "info" }];
      default:
        return [{ kind: "tool_start", toolUseId: id, name: type || "item", input: item, parentToolUseId: null }];
    }
  }

  private itemCompleted(item: Json): AgentEvent[] {
    const id = str(item.id);
    const type = str(item.type);
    const it = this.items.get(id);
    const status = str(item.status, "completed");
    const failed = status !== "completed" && status !== "inProgress";
    switch (type) {
      case "collabAgentToolCall": return this.progress.completed(item, !this.history.active);
      case "userMessage":
      case "contextCompaction":
        return [];
      case "agentMessage":
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
        return [{ kind: "tool_done", toolUseId: id, content: pretty(item), isError: failed, parentToolUseId: null }];
    }
  }

  /* ---- outbound ---- */

  /** A turn waits on an unanswered account/read; one while it said logged out reads again and comes
   *  back as send_failed only if it still does (it would only 401 and retry). */
  private startTurn(text: string): AgentEvent[] {
    if (!this.threadId || this.history.active) { this.queuedUser.push(text); return []; }
    const held = this.login.gate(text, () => this.request("account/read", {}));
    if (held) return held;
    this.sentAuto = this.mode === "auto";
    this.request("turn/start", {
      threadId: this.threadId,
      input: this.skills.input(text),
      ...codexTurnPolicy(this.mode),
      ...this.settings.turn,
    }, text);
    return [];
  }
  /** a Stop pressed before the turn id was known is honoured as soon as it is */
  private flushStop() {
    if (this.stopRequested && this.threadId && this.turnId) {
      this.stopRequested = false;
      this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    }
  }

  encodeUser(content: string): string | null {
    if (this.sessionFailed) {
      // the body will show it as not sent; nothing can be delivered on a failed session
      this.queuedUser.push(content);
      return null;
    }
    for (const ev of this.startTurn(content)) this.emit(ev);
    return null;
  }
  encodeLogin(method: LoginMethod): string | null {
    return this.login.start(method, (params, attempt) => { this.request("account/login/start", params, undefined, attempt); return this.wrote; }, (ev) => this.emit(ev));
  }
  encodeLoginCancel(): string | null {
    return this.login.cancel((loginId) => { this.request("account/login/cancel", { loginId }); });
  }
  loginReady(): boolean { return this.login.ready; }
  // a refused answer (permissionRefusal: a misfit form) sends nothing and the request stays pending
  encodePermission(requestId: string, decision: Decision): string | null { this.requests.answer(requestId, decision); return null; }
  permissionRefusal(requestId: string, decision: Decision): string | null { return this.requests.refusal(requestId, decision); }
  encodeInterrupt(): string | null {
    if (this.threadId && this.turnId) this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    else this.stopRequested = true;
    return null;
  }
  encodeSetPermissionMode(mode: PermissionMode): string | null {
    this.mode = mode; // applies from the next turn/start (Codex has no mid-thread setter)
    return null;
  }
  encodeSetModel(model: string): string | null {
    this.settings.model = model;
    return null; // queued locally; turn/start carries the override
  }
  encodeSetEffort(level: Effort): string | null {
    this.settings.effort = level;
    return null; // queued locally; turn/start carries the override
  }
}
