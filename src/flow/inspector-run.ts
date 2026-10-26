// Run-facing parts of the node-details card: run state lookups, the stats tiles, the Result / Live
// box on agent nodes and the Final Result card on output nodes (Copy, Open in Document).
// Split out of inspector.ts; it imports none of inspector, modifiers, nodes or popover.

import type { FlowNode } from "./model";
import type { FlowRunNodeState, FlowRunNodeStatus } from "./run";
import type { OutputTarget } from "./output-read";
import { S } from "./state";
import { capLabel } from "./inspector-label";
import { fetchFullOutput, fillFullOutput, fullOutputFor } from "./output-fill";
import { getRun } from "./runs-store";
import { elapsedLabel, markLive, markTotal, totalLabel } from "./run-clock";
import { invoke } from "../ipc";
import { moduleName } from "../modules/names";
import { showFlowToast } from "./viewport";

/** Set once by popover.ts (initPopover) — avoids a circular import with popover.ts, which needs
 *  inspector.ts's renderInspector. */
let openInDocumentCb: ((path: string) => void) | null = null;
export function setOpenInDocumentCb(fn: ((path: string) => void) | null): void {
  openInDocumentCb = fn;
}

export function nodeRun(node: FlowNode): { runId: string; state: FlowRunNodeState } | null {
  const runId = S.activeRunId;
  if (!runId) return null;
  const run = getRun(runId);
  const state = run?.nodes[node.id];
  return state ? { runId, state } : null;
}

export function nodeRunStatus(node: FlowNode): FlowRunNodeStatus | null {
  return nodeRun(node)?.state.status ?? null;
}

function statTile(value: string, label: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "flow-pop-stat";
  const b = document.createElement("b");
  b.textContent = value;
  const span = document.createElement("span");
  span.textContent = label;
  el.append(b, span);
  return el;
}

/** Time/cost pair off a run node's timing — cost stands in for a token count FlowRunNodeState
 *  doesn't carry (same substitution run-view.ts's footer already makes). */
function timeAndCost(st: FlowRunNodeState): { time?: string; cost?: string } {
  const time = elapsedLabel(st.startedAt, st.endedAt, Date.now());
  const cost = st.costUsd !== undefined ? `$${st.costUsd.toFixed(3)}` : undefined;
  return { time, cost };
}

/** Stats tiles: time, cost, attempt (brief's "Data limits" — tokens has no field, cost stands in,
 *  same substitution run-view.ts's canvas footer already makes). Agent nodes only, once the node
 *  has actually started (never for a node that hasn't run yet). */
export function buildStats(node: FlowNode): HTMLElement | null {
  const run = nodeRun(node);
  if (!run || !run.state.startedAt) return null;
  const { time, cost } = timeAndCost(run.state);
  const wrap = document.createElement("div");
  wrap.className = "flow-pop-stats";
  const timeTile = statTile(time ?? "—", "Time");
  markLive(timeTile.firstElementChild as HTMLElement, run.state.startedAt, run.state.endedAt);
  wrap.append(timeTile, statTile(cost ?? "—", "Cost"), statTile(String(run.state.attempts), "Attempt"));
  return wrap;
}

/** Shared with the Output card: the node's full output file once read (output-fill.ts), else its
 *  latest attempt's live text if the run is still writing it, falling back to the persisted run
 *  record's `summary` — same sourcing renderOutputSection used in the docked panel. `target` is
 *  the file still to read when `text` is not yet the full output. */
function nodeOutputText(node: FlowNode, runId: string, st: FlowRunNodeState): { text?: string; error?: string; target?: OutputTarget } {
  const { target, full } = fullOutputFor(runId, node.id);
  if (full !== undefined) return { text: full, error: st.error };
  let outputText: string | undefined;
  if (node.kind === "output") {
    // engine.ts's writeOutputNodeResult writes the output node's content once, at port "in",
    // attempt 1 — it never runs, so `st.attempts` stays 0 and the agent-loop lookup below would
    // never match it.
    outputText = S.runOutputs.get(`${runId}:${node.id}:in:1`)?.text;
  } else {
    for (let attempt = st.attempts; attempt >= 1; attempt--) {
      const live = S.runOutputs.get(`${runId}:${node.id}:out:${attempt}`);
      if (live) {
        outputText = live.text;
        break;
      }
    }
  }
  outputText ??= st.summary;
  return { text: outputText, error: st.error, target };
}

/** Latest attempt's live text for a running node, or `undefined` before any attempt has written
 *  one — shared by buildResult (first render of the Live line) and updateLiveOutput (every repaint
 *  after). */
function liveOutputText(runId: string, node: FlowNode, attempts: number): string {
  for (let attempt = attempts; attempt >= 1; attempt--) {
    const entry = S.runOutputs.get(`${runId}:${node.id}:out:${attempt}`);
    if (entry) return entry.text;
  }
  return "";
}

/** popover.ts calls this on every run-node event for the
 *  selected node instead of a full renderInspector() — patches just the `.flow-pop-live` text node
 *  (plus the Time/Cost stat tiles) in place and pins the live box's scroll to the bottom, so an
 *  in-progress Live line no longer resets scroll position, wipes an open addon menu or drops focus
 *  on every ~4Hz event. Returns `false` (caller falls back to a full rebuild) unless
 *  `nodeRunStatus(node) === "running"` — covering both the first render after selection settles
 *  and the running -> terminal transition, which must take the full rebuild to unlock the
 *  controls and swap the Live line for Result/Error (this must not key off whether
 *  `.flow-pop-live` was still in the DOM, which it still was on the very event that ended the run,
 *  so that transition never rebuilt). */
export function updateLiveOutput(node: FlowNode): boolean {
  if (nodeRunStatus(node) !== "running") return false;
  const run = nodeRun(node);
  if (!run) return false;
  const live = S.inspectorEl.querySelector<HTMLElement>(".flow-pop-live");
  if (!live) return false;
  live.textContent = liveOutputText(run.runId, node, run.state.attempts) || "…";
  live.scrollTop = live.scrollHeight;
  const { time, cost } = timeAndCost(run.state);
  const tiles = S.inspectorEl.querySelectorAll<HTMLElement>(".flow-pop-stats .flow-pop-stat b");
  if (tiles[0]) tiles[0].textContent = time ?? "—";
  if (tiles[1]) tiles[1].textContent = cost ?? "—";
  return true;
}

/** Result box (or, mid-run, a live amber line) — no token bar, see the file header. */
export function buildResult(node: FlowNode, locked: boolean): HTMLElement | null {
  const run = nodeRun(node);
  if (!run) return null;
  if (locked) {
    const wrap = document.createElement("div");
    wrap.append(capLabel("Live"));
    const live = document.createElement("div");
    live.className = "flow-pop-live";
    live.textContent = liveOutputText(run.runId, node, run.state.attempts) || "…";
    wrap.append(live);
    return wrap;
  }
  const { text: outputText, error, target } = nodeOutputText(node, run.runId, run.state);
  if (!outputText && !error) return null;
  const wrap = document.createElement("div");
  if (outputText) {
    wrap.append(capLabel("Result"));
    const res = document.createElement("div");
    res.className = "flow-pop-result";
    res.textContent = outputText;
    wrap.append(res);
    if (target) fillFullOutput(target, res);
  }
  if (error) {
    if (!outputText) wrap.append(capLabel("Error"));
    const err = document.createElement("div");
    err.className = "flow-pop-result flow-pop-result-error";
    err.textContent = error;
    wrap.append(err);
  }
  return wrap;
}

/** Best-effort: writes the output text to a new document and hands it to popover.ts's
 *  open-in-document callback (wired from workbench.ts's existing tray "Open" path, panels/flow.ts
 *  -> popover.ts). A failure (disk, size cap) shows the one Flow toast surface and leaves the
 *  button retryable; nothing is retried automatically. `create_document` is create-new only
 *  (documents.rs), so a time-of-day suffix keeps every name unique across repeated Opens. */
async function openOutputInDocument(node: FlowNode, outputText: string): Promise<void> {
  try {
    const safeName = (node.title || "Output").replace(/[\\/:*?"<>|]/g, "_") || "Output";
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "-"); // "14-32-05"
    const path = await invoke("create_document", { name: `${safeName} ${stamp}.md` });
    const mtime = (await invoke("stat_document", { path })) ?? 0;
    await invoke("write_document", { path, text: outputText, expectedMtime: mtime });
    openInDocumentCb?.(path);
  } catch (e) {
    showFlowToast("Couldn't Save Document — Try Again", 3000);
    console.error("flow output -> document:", e);
  }
}

export function buildOutputCard(node: FlowNode): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "flow-pop-body";
  const run = nodeRun(node);
  const shown = run ? nodeOutputText(node, run.runId, run.state) : {};
  const { error, target } = shown;
  // Full text once fillFullOutput lands; Copy and Open in Document read it at click time.
  let outputText = shown.text;
  let full = !target;
  // Total is the whole run's span, live while it runs, not this node's own instant span.
  const shownRun = S.activeRunId ? getRun(S.activeRunId) : undefined;
  wrap.append(markTotal(capLabel("Final Result", { extra: totalLabel(shownRun) }), shownRun));
  const box = document.createElement("div");
  box.className = "flow-pop-result flow-pop-output-text";
  box.textContent = outputText || (error ? "" : "—");
  wrap.append(box);
  if (error) {
    const err = document.createElement("div");
    err.className = "flow-pop-result flow-pop-result-error";
    err.textContent = error;
    wrap.append(err);
  }
  const actions = document.createElement("div");
  actions.className = "flow-pop-actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "flow-add-btn ws-btn";
  copyBtn.textContent = "Copy";
  copyBtn.disabled = !outputText;
  // Both actions export the full result, never the summary: read it now if the card's read has not
  // landed; a failed read toasts and exports nothing.
  const exportText = async (): Promise<string | undefined> => {
    const text = !target || full ? outputText : await fetchFullOutput(target);
    if (text === undefined) showFlowToast("Couldn't Read Full Output — Try Again", 3000);
    return text;
  };
  copyBtn.addEventListener("click", () => {
    void exportText().then((text) => {
      if (!text) return;
      // N4: a clipboard write can reject, and `navigator.clipboard` can be undefined (the `?.` would
      // skip the `.catch`), so fall back to a rejected promise and always toast the failure.
      (navigator.clipboard?.writeText(text) ?? Promise.reject()).catch(() =>
        showFlowToast("Couldn't Copy — Select And Copy Manually", 3000),
      );
    });
  });
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "flow-add-btn ws-btn";
  openBtn.textContent = `Open in ${moduleName("doc", "Document")}`;
  openBtn.disabled = !outputText;
  openBtn.addEventListener("click", () => {
    void exportText().then((text) => (text ? openOutputInDocument(node, text) : undefined));
  });
  actions.append(copyBtn, openBtn);
  wrap.append(actions);
  if (target) {
    fillFullOutput(target, box, (text) => {
      outputText = text;
      full = true;
      copyBtn.disabled = openBtn.disabled = false;
    });
  }
  return wrap;
}
