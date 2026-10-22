// Hosted Codex adapter: a Rendered view of a Codex session Falcon hosts. Falcon owns the
// app-server: it initializes it, opens the thread, starts turns, pages history and answers every
// server request, and journals the inbound wire, which reaches this adapter verbatim. The
// translation into AgentEvents is the in-process one (codex.ts), run passive, so the same wire
// draws the same transcript either way. What the user does goes out in the sidecar vocabulary
// (user, interrupt, permission_response, set_*), which src-tauri/src/falcon/ops.rs already maps
// to Falcon operations: the bridge stays provider-neutral and never carries renderer-authored
// JSON-RPC. Login stays in-process: there is no encodeLogin, so a hosted tab offers none.

import { isPermissionMode, type AdapterStart, type AgentAdapter, type AgentEvent, type Effort, type PermissionMode } from "./protocol";
import { CodexAdapter } from "./codex";

type Json = Record<string, unknown>;
type Decision = { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message?: string };

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}
/** The line as a JSON-RPC reply (an id and no method), else null: everything else is the view's. */
function reply(line: string): Json | null {
  let m: Json | null;
  try { m = obj(JSON.parse(line)); } catch { return null; }
  return m && m.id !== undefined && m.id !== null && typeof m.method !== "string" ? m : null;
}

export class HostedCodexAdapter implements AgentAdapter {
  /** writes nothing (hosted seam); kept for its local state: thread, turn, cards, mode, model */
  private readonly view = new CodexAdapter({ hosted: true });
  private resumeRequested = false;

  attach(_send: (line: string) => void, emit?: (ev: AgentEvent) => void): void {
    // every outbound line is an encode* return value; the view itself is given nowhere to write
    this.view.attach(() => {}, emit);
  }
  start(opts: AdapterStart): void {
    this.resumeRequested = Boolean(opts.resume);
    this.view.start(opts);
  }
  feed(line: string): AgentEvent[] {
    let message: Json | null = null;
    try { message = obj(JSON.parse(line)); } catch { /* ordinary feed reports malformed lines */ }
    if (message?.method === "falcon/thread") {
      const params = obj(message.params) ?? {};
      return this.view.reply(params.resumed === true ? "thread/resume" : "thread/start", obj(params.result) ?? {});
    }
    if (message?.method === "falcon/history") {
      const params = obj(message.params) ?? {};
      return this.view.hostedHistory(typeof params.phase === "string" ? params.phase : "", params);
    }
    if (message?.method === "falcon/models") {
      // a model/list page the Rust client asked for on attach (src-tauri falcon/events.rs
      // ModelCatalog); the view's own reply builds the same `models` event in-process does
      return this.view.reply("model/list", obj(obj(message.params)?.result) ?? {});
    }
    if (message?.method === "falcon/skills") {
      // the skills/list reply the Rust client asked for on attach and on skills/changed
      // (falcon/events.rs CodexQueries); the view's reply builds the in-process `commands` event
      return this.view.reply("skills/list", obj(obj(message.params)?.result) ?? {});
    }
    const m = reply(line);
    if (!m) return this.view.feed(line);
    // a reply answers the host's own request, so no pending id names it: its shape does (the
    // thread the host opened, the turn it started); initialize, acks and history pages are the
    // host's. A failed request is the host's to settle as a record, so it stays quiet here.
    const error = obj(m.error);
    if (error) return [{ kind: "notice", text: `Codex: ${typeof error.message === "string" ? error.message : "error"}`, level: "info", quiet: true }];
    const result = obj(m.result) ?? {};
    try {
      return this.view.reply(obj(result.thread) ? (this.resumeRequested ? "thread/resume" : "thread/start") : obj(result.turn) ? "turn/start" : "", result);
    } catch (e) {
      return [{ kind: "unknown", type: `adapter-threw:${String(e)}`, raw: line }];
    }
  }

  encodeUser(content: string): string {
    // a skill prompt leaves as items (text + skill); the host validates and forwards them
    const items = this.view.skills.input(content);
    return JSON.stringify({ type: "user", content: items.length > 1 ? items : content });
  }
  encodePermission(requestId: string, decision: Decision): string {
    this.view.encodePermission(requestId, decision); // settles the card here; the host writes the answer
    return JSON.stringify({ type: "permission_response", id: requestId, ...decision });
  }
  permissionRefusal(requestId: string, decision: Decision): string | null {
    return this.view.permissionRefusal(requestId, decision);
  }
  encodeInterrupt(): string {
    return JSON.stringify({ type: "interrupt" });
  }
  // The setters store into the view only when the host applied them (hostRecord): a Failed one
  // must leave the view as it was.
  encodeSetPermissionMode(mode: PermissionMode): string {
    return JSON.stringify({ type: "set_permission_mode", mode });
  }
  encodeSetModel(model: string): string {
    return JSON.stringify({ type: "set_model", model });
  }
  encodeSetEffort(level: Effort): string {
    return JSON.stringify({ type: "set_effort", level });
  }

  /** setter commands accepted but not yet settled, keyed by generation and command id */
  private readonly accepted = new Map<string, { kind: string; payload: Json }>();

  /** The host's journal records for the three setters: an applied one (this client's, another
   *  client's, or a replay's) becomes the event the panel's pills settle on; a failed or unknown
   *  one stays silent (the panel's send() result and the host notice cover it). */
  hostRecord(body: Json, gen = 0): AgentEvent[] {
    const key = (command: unknown) => `${gen}:${String(command)}`;
    if (body.record === "permission-mode-changed") {
      if (!isPermissionMode(body.mode)) return [];
      this.view.encodeSetPermissionMode(body.mode);
      return [{ kind: "mode", mode: body.mode, ack: true }];
    }
    if (body.record === "command-accepted") {
      const kind = body.kind;
      if (kind === "set_model" || kind === "set_effort" || kind === "set_permission_mode") {
        this.accepted.set(key(body.command), { kind, payload: obj(body.payload) ?? {} });
      }
      return [];
    }
    if (body.record !== "command-settled") return [];
    const k = key(body.command);
    const held = this.accepted.get(k);
    this.accepted.delete(k);
    if (!held || body.outcome !== "applied") return [];
    const { kind, payload } = held;
    if (kind === "set_model" && typeof payload.model === "string" && payload.model) {
      this.view.encodeSetModel(payload.model);
      return [{ kind: "model_set", model: payload.model }];
    }
    if (kind === "set_permission_mode" && isPermissionMode(payload.mode)) {
      this.view.encodeSetPermissionMode(payload.mode);
      return [{ kind: "mode", mode: payload.mode, ack: true }];
    }
    if (kind === "set_effort" && typeof payload.level === "string" && payload.level) {
      this.view.encodeSetEffort(payload.level as Effort);
      return [{ kind: "effort", level: payload.level }];
    }
    return [];
  }
}
