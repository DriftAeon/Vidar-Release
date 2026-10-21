// Armed/ended decision of a pill whose tool returns at once while its task runs on (pure;
// monitor-run.ts owns the DOM and the clock). Two kinds share it:
// - a Monitor: its tool_result reads "Monitor started (task <id>, ..."; it also has a deadline
//   (timeout_ms, default 5 min, cap 1 h, plus a grace);
// - a background shell (Bash / PowerShell with run_in_background, or one the CLI moved to the
//   background at its timeout): the result reads "Command running in background with ID: <id>." or
//   "Command did not complete within its 120s timeout and was moved to the background (ID: <id>)."
//   (transcripts, 2026-10-16); no deadline, it runs until it ends.
// Armed from that result until: a task `done` event (any status) matches the tool_use_id or the task
// id; the task leaves `background_tasks_changed` after having been listed there; the deadline passes;
// or the session ends.

const MONITOR_DEFAULT_MS = 300_000;
const MONITOR_MAX_MS = 3_600_000;
const MONITOR_GRACE_MS = 30_000;

export type WatchKind = "monitor" | "shell";

export interface MonitorWatch {
  toolUseId: string;
  taskId: string | null;
  /** the pill's tool name (Monitor, Bash, PowerShell): the title's head */
  tool: string;
  kind: WatchKind;
  deadline: number;
  /** the task id has appeared in a tasks_live set: only then does its absence end the watch */
  seenLive: boolean;
  ended: boolean;
  status?: string;
}

/** the task id out of the Monitor tool_result text, or null when it is not a start line */
function parseMonitorTaskId(text: string): string | null {
  return /^\s*Monitor started \(task ([^\s,)]+)/.exec(text)?.[1] ?? null;
}

/** the task id out of a shell tool_result that went to the background, or null */
export function parseShellTaskId(text: string): string | null {
  return /^\s*Command running in background with ID: ([A-Za-z0-9_-]+)/.exec(text)?.[1]
    ?? /^\s*Command did not complete within .*? moved to the background \(ID: ([A-Za-z0-9_-]+)\)/.exec(text)?.[1]
    ?? null;
}

/** deadline (epoch ms) from the Monitor input's timeout_ms: default, capped, plus the grace */
export function monitorDeadline(input: unknown, now: number): number {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>).timeout_ms : undefined;
  const ms = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.min(raw, MONITOR_MAX_MS) : MONITOR_DEFAULT_MS;
  return now + ms + MONITOR_GRACE_MS;
}

/** a watch from a successful Monitor tool_result; null for an error or a result that is not a start line */
export function armMonitor(toolUseId: string, input: unknown, resultText: string, isError: boolean, now: number): MonitorWatch | null {
  if (isError) return null;
  const taskId = parseMonitorTaskId(resultText);
  if (!taskId) return null;
  return { toolUseId, taskId, tool: "Monitor", kind: "monitor", deadline: monitorDeadline(input, now), seenLive: false, ended: false };
}

/** a watch from a shell tool_result that went to the background; null for anything else */
export function armShell(toolUseId: string, tool: string, resultText: string, isError: boolean): MonitorWatch | null {
  if (isError) return null;
  const taskId = parseShellTaskId(resultText);
  if (!taskId) return null;
  return { toolUseId, taskId, tool, kind: "shell", deadline: Number.POSITIVE_INFINITY, seenLive: false, ended: false };
}

function end(w: MonitorWatch, status: string): boolean {
  if (w.ended) return false;
  w.ended = true;
  w.status = status;
  return true;
}

/** a task `done` event; true when it ended this watch or named the outcome of one that had only
 *  left the live set ("gone") */
export function monitorTaskDone(w: MonitorWatch, ev: { taskId: string; toolUseId?: string; status?: string }): boolean {
  if (!(ev.toolUseId && ev.toolUseId === w.toolUseId) && !(w.taskId && ev.taskId === w.taskId)) return false;
  if (w.ended) {
    if (w.status !== "gone" || !ev.status) return false;
    w.status = ev.status;
    return true;
  }
  return end(w, ev.status || "completed");
}

/** a background_tasks_changed set; true when it ended this watch */
export function monitorTasksLive(w: MonitorWatch, taskIds: readonly string[]): boolean {
  if (w.ended || !w.taskId) return false;
  if (taskIds.includes(w.taskId)) { w.seenLive = true; return false; }
  return w.seenLive ? end(w, "gone") : false;
}

/** the clock; true when the deadline ended this watch */
export function monitorClock(w: MonitorWatch, now: number): boolean {
  return now >= w.deadline ? end(w, "timeout") : false;
}

/** the session ended (exit or a new session id); true when it ended this watch */
export function monitorSessionEnd(w: MonitorWatch): boolean {
  return end(w, "session ended");
}

const SHELL_ENDED: Record<string, string> = {
  completed: "Completed", failed: "Failed", killed: "Killed", stopped: "Killed",
  gone: "Ended", "session ended": "Session Ended",
};

/** hover title of the icon */
export function monitorTitle(w: MonitorWatch | null): string {
  if (!w) return "Monitor";
  if (w.kind === "shell") {
    if (!w.ended) return `${w.tool} · Running`;
    return `${w.tool} · ${SHELL_ENDED[w.status ?? ""] ?? "Ended"}`;
  }
  return w.ended ? `Monitor · ended (${w.status ?? "?"})` : "Monitor · watching";
}
