// Live state of the Monitor and background-shell pills of one Rendered body: arms a watch from the
// tool_result, ends it from the task events the dispatcher already receives (events.ts), a deadline
// tick or the session ending, and paints `data-monitor` on the pill (CSS swaps the tool icon for a
// spinner while armed). The decision itself is monitor-watch.ts. A subagent's shell pill sits in its
// Agent pill's children, so its spinner stays under that subagent and off the main chain.

import {
  armMonitor, armShell, monitorClock, monitorSessionEnd, monitorTasksLive, monitorTaskDone, monitorTitle, type MonitorWatch,
} from "./monitor-watch";
import type { Group, RenderedState, ToolRecord } from "./state";

const MONITOR_TOOL = "Monitor";
/** shell tools whose call can leave a background task (run_in_background, or moved there at its timeout) */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const TICK_MS = 5000;

export interface MonitorRunDeps {
  tools: Map<string, ToolRecord>;
  groupRefresh: (g: Group) => void;
}

export function createMonitorRun(S: RenderedState, deps: MonitorRunDeps) {
  const { tools, groupRefresh } = deps;
  const starts = new Map<string, { name: string; input: unknown }>();
  const watches = new Map<string, MonitorWatch>();
  /** the last background_tasks_changed set: a task listed before its tool_result counts as seen */
  let lastLive: readonly string[] = [];
  let timer: number | undefined;

  function paint(w: MonitorWatch) {
    const t = tools.get(w.toolUseId);
    if (!t) return;
    t.details.dataset.monitor = w.ended ? "ended" : "armed";
    const title = monitorTitle(w);
    const badge = t.details.querySelector<HTMLElement>(":scope > summary > .tool-badge");
    if (badge) {
      badge.title = title;
      const img = badge.querySelector<HTMLElement>(".icn");
      if (img) img.title = title;
    }
    if (t.group) groupRefresh(t.group); // the chain segment is rebuilt from the pills' state
  }
  function settle(changed: boolean, w: MonitorWatch) {
    if (!changed) return;
    paint(w);
    if (![...watches.values()].some((x) => !x.ended)) stopTimer();
  }
  function tick() {
    if (S.disposed) { stopTimer(); return; }
    const now = Date.now();
    for (const w of watches.values()) settle(monitorClock(w, now), w);
  }
  function stopTimer() {
    if (timer !== undefined) { window.clearInterval(timer); timer = undefined; }
  }

  return {
    onToolStart(toolUseId: string, name: string, input: unknown) {
      if (name === MONITOR_TOOL || SHELL_TOOLS.has(name)) starts.set(toolUseId, { name, input });
    },
    onToolDone(toolUseId: string, content: string, isError: boolean) {
      const start = starts.get(toolUseId);
      starts.delete(toolUseId);
      const name = start?.name ?? tools.get(toolUseId)?.name;
      if (!name || (name !== MONITOR_TOOL && !SHELL_TOOLS.has(name))) return;
      if (S.replaying) return; // history: nothing is being watched any more
      const w = name === MONITOR_TOOL
        ? armMonitor(toolUseId, start?.input, content, isError, Date.now())
        : armShell(toolUseId, name, content, isError);
      if (!w) return;
      if (w.taskId && lastLive.includes(w.taskId)) w.seenLive = true;
      watches.set(toolUseId, w);
      paint(w);
      // only a Monitor has a deadline to tick toward
      if (w.kind === "monitor" && timer === undefined) timer = window.setInterval(tick, TICK_MS);
    },
    onTaskDone(ev: { taskId: string; toolUseId?: string; status?: string }) {
      for (const w of watches.values()) settle(monitorTaskDone(w, ev), w);
    },
    onTasksLive(taskIds: readonly string[]) {
      lastLive = taskIds;
      for (const w of watches.values()) settle(monitorTasksLive(w, taskIds), w);
    },
    endAll() {
      for (const w of watches.values()) settle(monitorSessionEnd(w), w);
    },
  };
}
