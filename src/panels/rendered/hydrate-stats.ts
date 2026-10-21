// Hydrate cost meter of a Rendered body: what the last hydration of each tab cost. Read it over
// the DevTools port: `node tools\drive\vidar-drive.mjs eval "__vidarHydrateStats()"` (keyed by
// tab id). Plain numbers only: the registry never holds a transcript, so a closed tab leaks nothing.

interface HydrateRun {
  ms: number | null;
  records: number;
  groupsCreated: number;
  groupsOpened: number;
  nodes: number;
  longTasks: number;
  /** longtask window, read lazily: entries are delivered after the task ends */
  t0: number;
  t1: number | null;
}

const runs = new Map<string, HydrateRun>();
const longTasks: number[] = [];
let observing = false;

function observe() {
  if (observing) return;
  observing = true;
  try {
    if (typeof PerformanceObserver === "undefined") return;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(e.startTime);
      if (longTasks.length > 4096) longTasks.splice(0, longTasks.length - 4096);
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* longtask unsupported: the count stays 0 */ }
}

const debugHost = window as unknown as Record<string, unknown>;
if (!debugHost.__vidarHydrateStats) {
  debugHost.__vidarHydrateStats = () => Object.fromEntries([...runs].map(([id, r]) => [id, {
    ms: r.ms === null ? null : +r.ms.toFixed(1),
    records: r.records,
    groupsCreated: r.groupsCreated,
    groupsOpened: r.groupsOpened,
    nodes: r.nodes,
    longTasks: longTasks.filter((t) => t >= r.t0 && (r.t1 === null || t <= r.t1)).length,
  }]));
}

export interface HydrateStats {
  start: () => void;
  /** one host payload or agent event handled */
  record: () => void;
  groupCreated: () => void;
  groupOpened: () => void;
  end: () => void;
}

export function createHydrateStats(tabId: string, transcript: HTMLElement, isHydrating: () => boolean): HydrateStats {
  observe();
  let run: HydrateRun | null = null;
  return {
    start() {
      run = { ms: null, records: 0, groupsCreated: 0, groupsOpened: 0, nodes: 0, longTasks: 0, t0: performance.now(), t1: null };
      runs.set(tabId, run);
    },
    record() { if (run && isHydrating()) run.records++; },
    groupCreated() { if (run && isHydrating()) run.groupsCreated++; },
    groupOpened() { if (run && isHydrating()) run.groupsOpened++; },
    end() {
      if (!run) return;
      run.t1 = performance.now();
      run.ms = run.t1 - run.t0;
      run.nodes = transcript.getElementsByTagName("*").length;
    },
  };
}
