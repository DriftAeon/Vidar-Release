// Paginated Codex history. Keep page validation and replay state separate from live turn state.
import type { AgentEvent } from "./protocol";
import { replayCodexPlan } from "./codex-progress";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => v && typeof v === "object" && !Array.isArray(v) ? v as Json : null;

export class CodexHistory {
  active = false;
  private threadId = "";
  private count = 0;
  private pages = 0;
  private cursors = new Set<string>();
  private turns = new Set<string>();

  start(threadId: string): AgentEvent {
    this.active = true;
    this.threadId = threadId;
    this.count = this.pages = 0;
    this.cursors.clear();
    this.turns.clear();
    return { kind: "replay", phase: "start", count: 0 };
  }

  end(truncated = false): AgentEvent {
    this.active = false;
    return { kind: "replay", phase: "end", count: this.count, truncated: truncated ? 1 : undefined };
  }

  turn(raw: unknown, mapItem: (item: Json) => AgentEvent[]): AgentEvent[] {
    const turn = obj(raw);
    if (!this.active || !turn || typeof turn.id !== "string" || !turn.id || !Array.isArray(turn.items)) {
      throw new Error("Invalid Codex history turn");
    }
    if (this.turns.has(turn.id)) return [];
    this.turns.add(turn.id);
    this.count++;
    const events: AgentEvent[] = [];
    for (const rawItem of turn.items) {
      const item = obj(rawItem);
      if (!item) continue;
      if (item.type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content.map(obj).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c!.text).join("\n");
        if (text) events.push({ kind: "user_echo", text });
      } else if (item.type !== "reasoning") events.push(...mapItem(item));
    }
    events.push(...replayCodexPlan(this.threadId, turn.id));
    return events;
  }

  hosted(phase: string, params: Json, threadId: string, mapItem: (item: Json) => AgentEvent[]): AgentEvent[] {
    if (phase === "start") return [this.start(threadId)];
    if (phase === "turn") return this.turn(params.turn, mapItem);
    if (phase !== "end" || !this.active) return [];
    const error = typeof params.error === "string" ? params.error : "";
    return [...(error ? [{ kind: "notice" as const, text: `History could not be restored: ${error}`, level: "error" as const }] : []),
      this.end(Boolean(params.truncated))];
  }

  page(result: Json, mapItem: (item: Json) => AgentEvent[]): { events: AgentEvent[]; cursor: string | null } {
    if (!this.active || !Array.isArray(result.data)) throw new Error("Invalid Codex history page");
    const turns = result.data.map(obj);
    if (turns.some((t) => !t || typeof t.id !== "string" || !t.id || !Array.isArray(t.items))) {
      throw new Error("Invalid Codex history turn");
    }
    if (result.nextCursor != null && typeof result.nextCursor !== "string") throw new Error("Invalid Codex history cursor");
    const next = typeof result.nextCursor === "string" ? result.nextCursor : "";
    if (next && this.cursors.has(next)) throw new Error("Codex history cursor repeated");
    const events: AgentEvent[] = [];
    for (const turn of turns) events.push(...this.turn(turn, mapItem));
    this.pages++;
    if (next && this.pages < 10) {
      this.cursors.add(next);
      return { events, cursor: next };
    }
    events.push(this.end(Boolean(next)));
    return { events, cursor: null };
  }
}
