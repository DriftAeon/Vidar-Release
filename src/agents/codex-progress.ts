// Codex plan snapshots and collaboration items reuse existing text and agent components.
// A plan rides a text_done: `plan` is what the Rendered checklist card draws, `markdown` its text form.
import type { AgentEvent, PlanStatus, PlanView } from "./protocol";
import { codexPlans, type CodexPlanStore } from "./codex-plan-store";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

export function codexPlan(p: Json): AgentEvent[] {
  const steps = arr(p.plan).map((raw) => {
    const step = obj(raw), s = str(step.status);
    const status: PlanStatus = s === "completed" || s === "inProgress" ? s : "pending";
    return { text: str(step.step), status };
  });
  const lines = steps.map(({ text, status }) => {
    const label = status === "completed" ? "Completed" : status === "inProgress" ? "In Progress" : "Pending";
    return `- ${label}: ${text}`;
  });
  const plan: PlanView = { explanation: str(p.explanation), steps };
  return [{ kind: "text_done", blockId: `plan:${str(p.turnId)}`, parentToolUseId: null, plan,
    markdown: ["**Plan**", plan.explanation, ...lines].filter(Boolean).join("\n\n") }];
}

/** Live-notification hook: use the adapter's verified parent thread, never a child id. */
export function rememberCodexPlan(threadId: string, p: Json): Promise<void> {
  return codexPlans.remember(threadId, p);
}

/** Call inside the history turn loop, before advancing to the next turn. */
export function replayCodexPlan(threadId: string, turnId: string, store: CodexPlanStore = codexPlans): AgentEvent[] {
  const saved = store.get(threadId, turnId);
  return saved ? codexPlan({ ...saved }) : [];
}

export class CodexProgress {
  private agents = new Map<string, { status: string; toolUseId: string }>();
  started(item: Json): AgentEvent[] {
    const tool = str(item.tool);
    const name = tool === "spawnAgent" ? "Agent" : ["sendInput", "sendMessage", "followupTask", "resumeAgent"].includes(tool) ? "SendMessage"
      : tool === "wait" ? "Wait" : tool === "closeAgent" ? "CloseAgent" : tool === "interruptAgent" ? "InterruptAgent" : "ListAgents";
    return [{ kind: "tool_start", toolUseId: str(item.id), name, parentToolUseId: null,
      input: { ...item, description: str(item.prompt), subagent_type: "Codex", to: arr(item.receiverThreadIds).map(str).join(", "), summary: str(item.prompt) } }];
  }
  completed(item: Json, live = true): AgentEvent[] {
    const toolUseId = str(item.id), tool = str(item.tool), states = obj(item.agentsStates);
    const out: AgentEvent[] = [{ kind: "tool_done", toolUseId, parentToolUseId: null,
      content: JSON.stringify(states, null, 2), isError: ["failed", "interrupted"].includes(str(item.status)) }];
    if (!live) return out; // Historical running states do not prove a child is still running.
    for (const id of new Set([...arr(item.receiverThreadIds).map(str), ...Object.keys(states)])) {
      if (!id) continue;
      const state = obj(states[id]), status = str(state.status), previous = this.agents.get(id);
      const link = previous?.toolUseId ?? toolUseId;
      // A completed spawn/send call is not a completed child. Only reported child state settles it.
      const live = status === "running" || status === "pendingInit";
      const terminal = ["completed", "errored", "interrupted", "shutdown", "notFound"].includes(status);
      if (!previous && (live || terminal || (tool === "spawnAgent" && item.status === "completed"))) {
        out.push({ kind: "task", phase: "launched", taskId: id, toolUseId: link });
      } else if (previous && live && !["running", "pendingInit"].includes(previous.status)) {
        out.push({ kind: "task", phase: "resumed", taskId: id, toolUseId });
      }
      if (terminal && (previous?.status !== status || str(state.message))) {
        out.push({ kind: "task", phase: "done", taskId: id, toolUseId: link, status,
          report: str(state.message) || undefined });
      }
      if (live || terminal || (!previous && tool === "spawnAgent" && item.status === "completed")) {
        this.agents.set(id, { status: status || "running", toolUseId: link });
      }
    }
    return out;
  }
}
