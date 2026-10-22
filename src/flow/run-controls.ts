// Flow toolbar run controls: RUN (validate.ts-gated), the run selector and Cancel. Owns the
// three elements and the selector's painting of the chosen run; drives engine.ts and paints
// through run-view.ts. The panel (panels/flow.ts) mounts the elements and calls `refresh` /
// `updateRunGate` from its lifecycle hooks.

import type { FlowGraph } from "./model";
import type { FlowRun, FlowRunStatus } from "./run";
import { iconImg, type ColorIcon } from "../icon-img";
import { runLabel } from "./run-names";
import { attachMenu } from "./flow-picker";
import { S } from "./state";
import { flushGraphSave, activeDraft } from "./store";
import { validateGraph } from "./validate";
import { startRun, cancelRun, heldRunIds } from "./engine";
import { getRun, runsForGraph } from "./runs-store";
import { paintRun, clearRunPaint, CANCEL_RUN_TOOLTIP } from "./run-view";
import { showFlowToast } from "./viewport";

/** The active graph, its `nodes`/`edges` pointed at the live working copy (`S.nodes`/`S.edges`)
 *  rather than the last-saved snapshot in `S.graphs` — RUN and the validity gate both need this
 *  moment's edits, not the debounced-save lag. `null` only before any graph exists yet (mount
 *  always creates one, so this is defensive). */
function currentGraph(): FlowGraph | null {
  // An unsaved template instance runs too; its runs keep its id, which Save keeps.
  const stored = S.graphs.find((g) => g.id === S.activeGraphId) ?? activeDraft();
  if (!stored) return null;
  return { ...stored, nodes: S.nodes, edges: S.edges };
}

function runStatusLabel(status: FlowRunStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "success":
      return "Success";
    case "error":
      return "Error";
    case "canceled":
      return "Canceled";
    case "denied":
      return "Denied";
  }
}

/** A reconciled run (`runs-core.ts`'s `reconcileInterrupted`,
 *  every node still live when Flow last closed/reloaded ends error:"Interrupted") landed on
 *  screen labeled just "Error", indistinguishable from a real in-run failure. */
function isInterrupted(run: FlowRun): boolean {
  return Object.values(run.nodes).some((n) => n.error === "Interrupted");
}

/** The status as a colour icon (the selector's prefix) and a word (its tooltip). */
const RUN_STATUS_ICON = {
  success: "check-circle", error: "dismiss-circle", interrupted: "warning",
  canceled: "cancel", denied: "shield", running: "timer",
} as const satisfies Record<FlowRunStatus | "interrupted", ColorIcon>;

function runStatus(run: FlowRun): { icon: ColorIcon; word: string } {
  if (isInterrupted(run)) return { icon: RUN_STATUS_ICON.interrupted, word: "Interrupted" };
  return { icon: RUN_STATUS_ICON[run.status], word: runStatusLabel(run.status) };
}

/** `<icon> Juniper 18 Oct 12:51 pm` into `host`; the status word is the tooltip of `titleEl`. */
function paintRunName(host: HTMLElement, titleEl: HTMLElement, run: FlowRun): void {
  const { icon, word } = runStatus(run);
  host.replaceChildren(iconImg(icon), document.createTextNode(runLabel(run.id, run.startedAt)));
  titleEl.title = word;
}

const NO_RUN = "Run";

/** Builds the toolbar's RUN gating + run-selector + Cancel controls (§5). Exposes `refresh`
 *  (repopulate the run list after a run starts, a graph switches, or a run's status changes)
 *  and `updateRunGate` (recompute RUN's disabled state from the live graph) so the panel's mount
 *  code and the flow/New picker hooks can drive them. */
export function buildRunControls(): {
  runPick: HTMLButtonElement;
  runBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  refresh: () => void;
  updateRunGate: () => void;
} {
  // The run selector is the Flow picker's dropdown (flow-picker.ts attachMenu): same face and row
  // classes. `selectedId` is the chosen run ("" = none), what `<select>.value` used to be.
  const runPick = document.createElement("button");
  runPick.type = "button";
  runPick.className = "flow-pick pick-face flow-run-pick";
  const face = document.createElement("span");
  face.className = "nm";
  const caret = document.createElement("span");
  caret.className = "car";
  caret.textContent = "▾";
  runPick.append(face, caret);
  let selectedId = "";
  let runs: FlowRun[] = [];
  // The run the user picked (or started) per graph this session: opening or switching to a graph with
  // no pick shows "Run" (none), not its newest run.
  const picked = new Map<string, string>();

  function paintFace(): void {
    const run = selectedId ? runs.find((r) => r.id === selectedId) : undefined;
    if (run) paintRunName(face, runPick, run);
    else {
      face.textContent = NO_RUN;
      runPick.title = "";
    }
  }

  function addRunRow(m: HTMLElement, run: FlowRun | null): void {
    const row = document.createElement("button");
    row.type = "button";
    const id = run?.id ?? "";
    row.className = "display-pick-row" + (id === selectedId ? " active" : "");
    const nm = document.createElement("span");
    nm.className = "nm";
    if (run) paintRunName(nm, row, run);
    else nm.textContent = NO_RUN;
    row.append(nm);
    row.addEventListener("click", () => {
      menu.close();
      runPick.focus();
      choose(id);
    });
    m.append(row);
  }

  const menu = attachMenu(runPick, (m) => {
    m.replaceChildren();
    addRunRow(m, null);
    for (const run of runs) addRunRow(m, run);
  });

  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "flow-run-btn icon-btn";
  runBtn.setAttribute("aria-label", "Run");
  runBtn.title = "Run";
  runBtn.appendChild(iconImg("send"));

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "flow-run-cancel ws-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.title = CANCEL_RUN_TOOLTIP;
  cancelBtn.disabled = true;

  function paintSelected(): void {
    const runId = selectedId;
    if (!runId) {
      clearRunPaint();
      cancelBtn.disabled = true;
      return;
    }
    const run = getRun(runId);
    if (!run) {
      clearRunPaint();
      cancelBtn.disabled = true;
      return;
    }
    // Liveness read off `S.activeRunId` went stale the moment a
    // graph switch nulled it out, so a held run's approval queue and Cancel silently died until
    // Vidar restarted. `heldRunIds()` is engine.ts's own live set and never goes stale.
    const isLive = heldRunIds().has(run.id);
    paintRun(run, { readOnly: !isLive });
    cancelBtn.disabled = !isLive;
  }

  function refresh(): void {
    if (!S.activeGraphId) {
      runs = [];
      selectedId = "";
      paintFace();
      menu.refill();
      clearRunPaint();
      cancelBtn.disabled = true;
      return;
    }
    runs = runsForGraph(S.activeGraphId);
    const has = (id: string | null | undefined): id is string => !!id && runs.some((r) => r.id === id);
    const pick = picked.get(S.activeGraphId);
    const live = [...heldRunIds()].find((id) => has(id));
    const keep = has(S.activeRunId) ? S.activeRunId : has(pick) ? pick : (live ?? "");
    // `S.activeRunId` follows the run this graph is about to show, held or finished: engine.ts's
    // `persistRun` only repaints the run whose id matches it, and inspector.ts reads the node card
    // from it. Setting it only for a held run left a finished run on the canvas while the card
    // read a null or leftover id (the Output card showed another run's text, or none, until the
    // selector was toggled). Only ever set from `runsForGraph` of the *active* graph, so it never
    // points at a run of an unrelated graph with id-colliding nodes.
    S.activeRunId = keep || null;
    selectedId = keep;
    paintFace();
    menu.refill();
    paintSelected();
  }

  /** Match the engine's single-live-run gate, including runs of another graph. */
  function updateRunGate(): void {
    const graph = currentGraph();
    if (!graph) {
      runBtn.disabled = true;
      runBtn.title = "Run\n\nNo active flow.";
      return;
    }
    const result = validateGraph(graph);
    const liveRun = heldRunIds().size > 0;
    runBtn.disabled = !result.valid || liveRun;
    // The "runs live only while Vidar is open" notice used to live
    // only on the valid-graph tooltip, so it vanished the moment the graph had an issue instead of
    // just moving aside.
    const liveNotice = "Runs live only while Vidar is open — closing or restarting Vidar ends any run in progress.";
    runBtn.title = `Run\n\n${liveRun
      ? "A Flow run is already in progress."
      : result.valid
        ? liveNotice
        : `${result.issues.map((i) => i.message).join("\n")}\n\n${liveNotice}`}`;
    for (const node of graph.nodes) {
      const el = S.nodeEls.get(node.id);
      el?.classList.toggle("invalid", result.invalidNodeIds.has(node.id));
    }
  }

  function choose(id: string): void {
    // The selector's own choice is now the single "currently shown run" — engine.ts's persistRun
    // and run-view.ts's subscriber both gate their live repaint on `S.activeRunId` (browsing to a past run
    // while another run of the same graph is live must not get
    // silently overwritten on the live run's next status change).
    selectedId = id;
    S.activeRunId = id || null;
    if (S.activeGraphId) picked.set(S.activeGraphId, id);
    paintFace();
    paintSelected();
  }

  runBtn.addEventListener("click", () => {
    const graph = currentGraph();
    if (!graph) return;
    if (heldRunIds().size > 0) {
      updateRunGate();
      showFlowToast("A Flow run is already in progress.", 3000);
      return;
    }
    flushGraphSave();
    if (!validateGraph(graph).valid) {
      updateRunGate();
      return;
    }
    let run: FlowRun;
    try { run = startRun(graph); }
    catch (error) {
      console.error("flow: run start failed:", error);
      showFlowToast(error instanceof Error && error.message === "flow busy"
        ? "A Flow run is already in progress." : "Flow Run Failed", 3000);
      updateRunGate();
      return;
    }
    S.activeRunId = run.id;
    if (S.activeGraphId) picked.set(S.activeGraphId, run.id);
    refresh();
    selectedId = run.id;
    paintFace();
    paintSelected();
    updateRunGate();
  });

  cancelBtn.addEventListener("click", () => {
    // Cancels whatever run this control is currently showing, not necessarily `S.activeRunId`
    // (the two can diverge across a graph switch).
    const runId = selectedId;
    if (runId && heldRunIds().has(runId)) cancelRun(runId);
  });

  return { runPick, runBtn, cancelBtn, refresh, updateRunGate };
}
