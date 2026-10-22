// Builds the anchored node-details popover's content into S.inspectorEl, which popover.ts owns
// the mount/position/focus lifecycle of ("a positioning module apart from
// the card's content"). Field editing and persistence (click-to-edit, addon add/remove, the
// model/shape pickers) are the same data path the old docked panel used — node.fields,
// node.addons, node.model, scheduleGraphSave — only the layout changed.
//
// Card shape per node kind:
//   agent  — header, run stats (time/cost/attempt), Model (dropdown) + Task (text card) +
//            Modifiers (colour-coded chips) locked while the node runs, then Result (or a live
//            amber line while running).
//   input  — header, Shape (segmented) + Content (text card, with a char count).
//   output — header, the final result large with Copy / Open in Document.
//
// No input/output token bar on the Result box: FlowRunNodeState carries no per-node token count
// today (grepped — only costUsd and timestamps), so the bar the round-3 mock shows is omitted
// rather than fabricated (see report). No "Effort" control either: model.ts's `ReservedAddonKind`
// keeps effort out of v1 ("needs a sidecar flag") and it isn't in V1_ADDON_KINDS, so there is no
// field for it to write back to.
//
// Required-field marker: asterisk + red box, no "Required" text.

import type { AgentPreset, FlowFieldSpec, FlowNode } from "./model";
import type { FlowRunNodeState, FlowRunNodeStatus } from "./run";
import { fieldLabel, fieldValue, presetLabel } from "./labels";
import { S, text } from "./state";
import { scheduleGraphSave } from "./store";
import { modelLabel, wiredModels } from "./roster";
import type { OutputTarget } from "./output-read";
import { fetchFullOutput, fillFullOutput, fullOutputFor, releaseFullOutput } from "./output-fill";
import { setSelection } from "./selection";
import { getRun } from "./runs-store";
import { elapsedLabel, markLive, markTotal, totalLabel } from "./run-clock";
import { invoke } from "../ipc";
import { moduleName } from "../modules/names";
import { isBlank } from "./validate";
import { showFlowToast } from "./viewport";
import { buildModifiers, closeAddonMenu } from "./modifiers";
import "./inspector.css";

/** Shape-control accent colour — the mock's own hex (flow-popover-mockup.html's
 *  `--m-shape`), the same categorical-colour convention styles.css already uses for
 *  `--kind` and the addon-chip hues, not a "decorative colour" pick. */
const SHAPE_SEG_COLOR = "#6fa3c9";

/** Set once by popover.ts (initPopover) — avoids a circular import with popover.ts, which needs
 *  inspector.ts's renderInspector. */
let openInDocumentCb: ((path: string) => void) | null = null;
export function setOpenInDocumentCb(fn: ((path: string) => void) | null): void {
  openInDocumentCb = fn;
}

function fieldSpecFor(node: FlowNode, k: string): FlowFieldSpec | undefined {
  return node.fieldSpecs?.find((s) => s.k === k);
}

/** Refreshes the canvas card's field-0 text after an edit that doesn't go through a full
 *  `renderInspector()` — `fields[0]` is what `buildNode` (nodes.ts) shows on the card. No-op for
 *  any field but the first. */
function refreshCanvasField0(node: FlowNode, idx: number, value: string): void {
  if (idx !== 0) return;
  const fv = S.nodeEls.get(node.id)?.querySelector<HTMLElement>(".flow-node-field-v");
  if (fv) fv.textContent = fieldValue(node.fields[idx].k, value);
}

function nodeRun(node: FlowNode): { runId: string; state: FlowRunNodeState } | null {
  const runId = S.activeRunId;
  if (!runId) return null;
  const run = getRun(runId);
  const state = run?.nodes[node.id];
  return state ? { runId, state } : null;
}

function nodeRunStatus(node: FlowNode): FlowRunNodeStatus | null {
  return nodeRun(node)?.state.status ?? null;
}

function capLabel(labelText: string, opts: { required?: boolean; extra?: string } = {}): HTMLElement {
  const cap = document.createElement("div");
  cap.className = "flow-pop-cap";
  const left = document.createElement("span");
  if (opts.required) {
    const star = document.createElement("span");
    star.className = "flow-inspector-req";
    star.textContent = "*";
    left.append(star);
  }
  left.append(document.createTextNode(labelText));
  cap.append(left);
  if (opts.extra) cap.append(text("", opts.extra));
  return cap;
}

function buildSegmented(
  options: { value: string; label: string }[],
  current: string,
  colorVar: string,
  onChange: (v: string) => void,
  disabled = false,
): HTMLElement {
  const seg = document.createElement("div");
  seg.className = "flow-pop-seg";
  seg.style.setProperty("--m", colorVar);
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opt.label;
    btn.className = opt.value === current ? "on" : "";
    btn.disabled = disabled;
    btn.addEventListener("click", () => onChange(opt.value));
    seg.appendChild(btn);
  }
  return seg;
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
function buildStats(node: FlowNode): HTMLElement | null {
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

function headerSubtitle(node: FlowNode): string {
  const kind = fieldLabel(node.kind);
  if (node.kind === "agent") return `${kind} · ${node.model ? modelLabel(node.model) : "—"}`;
  if (node.kind === "input") {
    const shape = node.fields.find((f) => f.k === "shape")?.v;
    return shape ? `${kind} · ${fieldValue("shape", shape)}` : kind;
  }
  if (node.kind === "output") {
    const upstream = S.edges.find((e) => e.to.node === node.id);
    const from = upstream ? S.nodes.find((n) => n.id === upstream.from.node) : undefined;
    return from ? `${kind} · From ${from.title}` : kind;
  }
  return kind;
}

/** Header C: kind-coloured band, title (click-to-edit), a run-status square mark on agent/output
 *  (they're the only kinds with a real run status — an input never runs, so it never gets a mark),
 *  and ×. `--k` (the connector/header colour) is set by popover.ts, which already reads it off the
 *  node's own `--kind` custom property. */
function buildHeader(node: FlowNode): HTMLElement {
  const header = document.createElement("div");
  header.className = "flow-pop-header";
  const row1 = document.createElement("div");
  row1.className = "flow-pop-header-row1";
  const titleSpan = text("flow-pop-title", node.title);
  titleSpan.addEventListener("click", () => startEditTitle(node, titleSpan));
  row1.append(titleSpan);
  const status = nodeRunStatus(node);
  if (status && (node.kind === "agent" || node.kind === "output")) {
    const mark = document.createElement("span");
    mark.className = `flow-pop-mark flow-run-badge flow-run-mark flow-run-${status}`;
    row1.append(mark);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "flow-pop-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", () => setSelection(new Set()));
  row1.append(close);
  header.append(row1, text("flow-pop-sub", headerSubtitle(node)));
  return header;
}

function buildModelRow(node: FlowNode, locked: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.append(capLabel("Model", { required: true }));
  const wired = wiredModels();
  const unwired = !!node.model && !wired.some((m) => m.id === node.model);
  const options = wired.map((m) => ({ value: m.id as string, label: m.label }));
  if (unwired) options.unshift({ value: node.model as string, label: modelLabel(node.model!) });
  const select = document.createElement("select");
  select.className = "flow-model-select";
  select.setAttribute("aria-label", "Model");
  select.disabled = locked;
  if (isBlank(node.model)) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select Model";
    placeholder.disabled = true;
    select.append(placeholder);
  }
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.disabled = unwired && item.value === node.model;
    option.textContent = option.disabled ? `${item.label} (Unavailable)` : item.label;
    select.append(option);
  }
  select.value = node.model ?? "";
  select.addEventListener("change", () => {
    node.model = select.value as FlowNode["model"];
    // Write node.subtitle too, not only the canvas card's DOM, so the next full canvas rebuild
    // (loadGraph, a Reset Layout, a reload) does not revert the card to the model it was created with.
    node.subtitle = node.model ? modelLabel(node.model) : node.subtitle;
    scheduleGraphSave();
    renderInspector(node);
    const subtitleEl = S.nodeEls.get(node.id)?.querySelector<HTMLElement>(".flow-node-subtitle");
    if (subtitleEl && node.model) subtitleEl.textContent = modelLabel(node.model);
  });
  if (isBlank(node.model) || unwired) select.classList.add("warn");
  wrap.append(select);
  return wrap;
}

function buildTaskCard(node: FlowNode, locked: boolean): HTMLElement {
  const idx = node.fields.findIndex((f) => f.k === "task");
  const value = idx >= 0 ? node.fields[idx].v : "";
  const wrap = document.createElement("div");
  wrap.append(capLabel("Task", { required: true }));
  const textarea = document.createElement("textarea");
  textarea.className = "flow-pop-task";
  textarea.rows = 3;
  textarea.disabled = locked;
  textarea.value = value;
  if (isBlank(value)) textarea.classList.add("warn");
  textarea.addEventListener("input", () => {
    if (idx < 0) return;
    node.fields[idx].v = textarea.value;
    scheduleGraphSave();
  });
  textarea.addEventListener("blur", () => {
    if (idx < 0) return;
    node.fields[idx].v = textarea.value;
    scheduleGraphSave();
    refreshCanvasField0(node, idx, textarea.value);
    textarea.classList.toggle("warn", isBlank(textarea.value));
  });
  wrap.append(textarea);
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
function buildResult(node: FlowNode, locked: boolean): HTMLElement | null {
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

/** `preset` is shown read-only: engine.ts's Academy lookup keys off `{k:"preset",v:"academy"}`,
 *  as a caption rather
 *  than an editable field. `null` for a Custom-preset or legacy agent node with no `preset` field. */
function buildPresetCaption(node: FlowNode): HTMLElement | null {
  const preset = node.fields.find((f) => f.k === "preset")?.v as AgentPreset | undefined;
  if (!preset) return null;
  const wrap = document.createElement("div");
  wrap.append(capLabel("Preset"));
  const val = document.createElement("div");
  val.className = "flow-pop-caption";
  val.textContent = presetLabel(preset);
  wrap.append(val);
  return wrap;
}

function buildShapeRow(node: FlowNode): HTMLElement {
  const idx = node.fields.findIndex((f) => f.k === "shape");
  const spec = fieldSpecFor(node, "shape");
  const wrap = document.createElement("div");
  wrap.append(capLabel("Shape", { required: !!spec?.required }));
  const options = (spec?.options ?? ["free-text", "structured"]).map((o) => ({ value: o, label: fieldValue("shape", o) }));
  const current = idx >= 0 ? node.fields[idx].v : "";
  const seg = buildSegmented(options, current, SHAPE_SEG_COLOR, (v) => {
    if (idx < 0) return;
    node.fields[idx].v = v;
    scheduleGraphSave();
    refreshCanvasField0(node, idx, v);
    renderInspector(node);
  });
  if (isBlank(current)) seg.classList.add("warn");
  wrap.append(seg);
  return wrap;
}

function buildContentCard(node: FlowNode): HTMLElement {
  const idx = node.fields.findIndex((f) => f.k === "content");
  const spec = fieldSpecFor(node, "content");
  const value = idx >= 0 ? node.fields[idx].v : "";
  const wrap = document.createElement("div");
  wrap.append(capLabel("Content", { required: !!spec?.required, extra: `${value.length} Chars` }));
  const textarea = document.createElement("textarea");
  textarea.className = "flow-pop-task";
  textarea.rows = 4;
  textarea.value = value;
  if (isBlank(value)) textarea.classList.add("warn");
  textarea.addEventListener("input", () => {
    if (idx < 0) return;
    node.fields[idx].v = textarea.value;
    scheduleGraphSave();
    const extraEl = wrap.querySelector<HTMLElement>(".flow-pop-cap span:last-child");
    if (extraEl) extraEl.textContent = `${textarea.value.length} Chars`;
  });
  textarea.addEventListener("blur", () => {
    if (idx < 0) return;
    node.fields[idx].v = textarea.value;
    scheduleGraphSave();
    refreshCanvasField0(node, idx, textarea.value);
    textarea.classList.toggle("warn", isBlank(textarea.value));
  });
  wrap.append(textarea);
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

function buildOutputCard(node: FlowNode): HTMLElement {
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

/** Builds this node's card content into S.inspectorEl (popover.ts owns show/hide/position). Called
 *  whenever the selection settles on exactly one node, and again after any edit made inside the
 *  card (mirrors the old docked panel's full-rebuild-on-edit pattern). */
export function renderInspector(node: FlowNode): void {
  // A full rebuild replaces every element in the card, including the ADD button an open addon
  // menu is anchored off — leaving the menu open referencing a detached anchor (and its own
  // document listeners still armed) if the rebuild didn't close it first.
  closeAddonMenu();
  releaseFullOutput(); // a full-output read for the card being replaced must not fill the new one
  S.inspectorEl.textContent = "";
  S.inspectorEl.append(buildHeader(node));
  if (node.kind === "output") {
    S.inspectorEl.append(buildOutputCard(node));
    return;
  }
  const body = document.createElement("div");
  body.className = "flow-pop-body";
  if (node.kind === "agent") {
    const running = nodeRunStatus(node) === "running";
    const stats = buildStats(node);
    if (stats) body.append(stats);
    const preset = buildPresetCaption(node);
    if (preset) body.append(preset);
    const controls = document.createElement("div");
    controls.className = running ? "flow-pop-controls locked" : "flow-pop-controls";
    controls.append(buildModelRow(node, running), buildTaskCard(node, running), buildModifiers(node, running));
    body.append(controls);
    const result = buildResult(node, running);
    if (result) body.append(result);
  } else if (node.kind === "input") {
    body.append(buildShapeRow(node), buildContentCard(node));
  }
  S.inspectorEl.append(body);
}

/** Swaps `span` for a prefilled `<input>`. Enter/Escape re-render the whole card (`node` is a
 *  stable reference into S.nodes, so this stays correct even though the popover no longer reads
 *  S.selected on every render). Blur commits too, but must not re-render synchronously — a
 *  mousedown on another field's span would detach that span before its own click fires, swallowing
 *  the click. Blur instead swaps the input back for a fresh span in place, via `rebuild`, which
 *  re-wires that span's own click-to-edit. Every keydown is stopped from bubbling so document-level
 *  Escape/nudge/delete never fire while typing. */
export function editInPlace(
  node: FlowNode,
  span: HTMLElement,
  initial: string,
  commit: (value: string) => void,
  rebuild: (value: string) => HTMLElement,
) {
  const input = document.createElement("input");
  input.className = "flow-inspector-input";
  input.value = initial;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      if (done) return;
      done = true;
      commit(input.value);
      renderInspector(node);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (done) return;
      done = true;
      renderInspector(node);
    }
  });
  input.addEventListener("blur", () => {
    if (done) return;
    done = true;
    commit(input.value);
    input.replaceWith(rebuild(input.value));
  });
}

function startEditTitle(node: FlowNode, span: HTMLElement) {
  const commit = (value: string) => {
    node.title = value;
    const sub = S.inspectorEl.querySelector<HTMLElement>(".flow-pop-sub");
    if (sub) sub.textContent = headerSubtitle(node);
    const titleEl = S.nodeEls.get(node.id)?.querySelector<HTMLElement>(".flow-node-title");
    if (titleEl) titleEl.textContent = node.title;
    scheduleGraphSave();
  };
  const rebuild = (value: string) => {
    const next = text("flow-pop-title", value);
    next.addEventListener("click", () => startEditTitle(node, next));
    return next;
  };
  editInPlace(node, span, node.title, commit, rebuild);
}
