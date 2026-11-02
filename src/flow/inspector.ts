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
import { fieldLabel, fieldValue, presetLabel } from "./labels";
import { S, text } from "./state";
import { capLabel } from "./inspector-label";
import { buildOutputCard, buildResult, buildStats, nodeRunStatus } from "./inspector-run";
import { scheduleGraphSave } from "./store";
import { modelLabel, wiredModels } from "./roster";
import { releaseFullOutput } from "./output-fill";
import { setSelection } from "./selection";
import { isBlank } from "./validate";
import { refreshVaultNames, vaultRows, vaultsLoaded } from "./vault-names";
import { refreshNodeFace } from "./nodes";
import { buildModifiers, closeAddonMenu } from "./modifiers";
import "./inspector.css";

export { setOpenInDocumentCb, updateLiveOutput } from "./inspector-run";

/** Shape-control accent colour — the mock's own hex (flow-popover-mockup.html's
 *  `--m-shape`), the same categorical-colour convention styles.css already uses for
 *  `--kind` and the addon-chip hues, not a "decorative colour" pick. */
const SHAPE_SEG_COLOR = "#6fa3c9";

function fieldSpecFor(node: FlowNode, k: string): FlowFieldSpec | undefined {
  return node.fieldSpecs?.find((s) => s.k === k);
}

/** The card control focus sat on before a rebuild: its accessible name when it has one, else
 *  its tag/class and position among its kind, plus a text field's caret. */
interface FocusMark {
  label: string | null;
  kind: string; // tag plus class list, for controls with no accessible name
  index: number;
  selStart: number | null;
  selEnd: number | null;
  selDir: "forward" | "backward" | "none" | null;
}

const kindOf = (el: Element) => `${el.tagName} ${el.className}`;
/** Same-kind elements in card order (no CSS selector: class names are not escaped). */
const sameKind = (kind: string) => [...S.inspectorEl.querySelectorAll<HTMLElement>("*")].filter((el) => kindOf(el) === kind);

/** `null` when focus is outside the card: a rebuild then takes nothing back. */
function markFocus(): FocusMark | null {
  const ae = document.activeElement as HTMLElement | null;
  if (!ae || !S.inspectorEl.contains(ae)) return null;
  if (ae === S.inspectorEl) return { label: null, kind: "", index: -1, selStart: null, selEnd: null, selDir: null };
  const kind = kindOf(ae);
  const field = ae instanceof HTMLTextAreaElement || ae instanceof HTMLInputElement ? ae : null;
  let selStart: number | null = null, selEnd: number | null = null, selDir: FocusMark["selDir"] = null;
  try {
    selStart = field?.selectionStart ?? null;
    selEnd = field?.selectionEnd ?? null;
    selDir = field?.selectionDirection ?? null;
  } catch { /* input types without a selection API */ }
  return { label: ae.getAttribute("aria-label"), kind, index: sameKind(kind).indexOf(ae), selStart, selEnd, selDir };
}

/** Puts focus back on the control `mark` names after a rebuild, without scrolling; a control that
 *  no longer exists leaves focus on the card root so Escape and Tab still work from there. */
function restoreFocus(mark: FocusMark): void {
  let el: HTMLElement | null = null;
  if (mark.label) el = [...S.inspectorEl.querySelectorAll<HTMLElement>("[aria-label]")].find((c) => c.getAttribute("aria-label") === mark.label) ?? null;
  if (!el && mark.kind) el = sameKind(mark.kind)[mark.index] ?? null;
  if (!el || (el as HTMLButtonElement).disabled) el = S.inspectorEl;
  el.focus({ preventScroll: true });
  if (mark.selStart !== null && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
    try {
      el.setSelectionRange(mark.selStart, mark.selEnd ?? mark.selStart, mark.selDir ?? undefined);
    } catch { /* input types without a selection API */ }
  }
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
    refreshNodeFace(node); // the subtitle follows the model
  });
  if (isBlank(node.model) || unwired) select.classList.add("warn");
  wrap.append(select);
  return wrap;
}

const NO_VAULT_PROMPT = "Pick a Vault";

/** A card OPENED: vault-names.ts reads `rune_vault_list` (one fetch in flight; a render never
 *  fetches), then the card it was opened for is re-drawn. */
export function refreshVaults(node: FlowNode): void {
  void refreshVaultNames().then((ok) => {
    if (ok && S.selected.size === 1 && S.selected.has(node.id)) renderInspector(node);
  });
}

function buildVaultRow(node: FlowNode, locked: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.append(capLabel("Vault"));
  // an agent node names its vault: unset reads as the Pick a Vault prompt and the node cannot Run (validate.ts)
  const current = node.vault ?? "";
  const rows = vaultRows();
  const options = rows.map((v) => ({ value: v.id, label: v.name, bad: "" }));
  if (current && !options.some((o) => o.value === current)) {
    const bad = vaultsLoaded() ? "Unknown Vault" : "";
    options.unshift({ value: current, label: bad ? `${current} (${bad})` : current, bad });
  }
  if (!current) options.unshift({ value: "", label: NO_VAULT_PROMPT, bad: NO_VAULT_PROMPT });
  const select = document.createElement("select");
  select.className = "flow-model-select";
  select.setAttribute("aria-label", "Vault");
  select.disabled = locked;
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.disabled = !!item.bad;
    option.textContent = item.label;
    select.append(option);
  }
  select.value = current;
  if (options.some((o) => o.bad)) select.classList.add("warn");
  select.addEventListener("change", () => {
    node.vault = select.value;
    scheduleGraphSave();
    renderInspector(node);
    refreshNodeFace(node);
  });
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
  textarea.setAttribute("aria-label", "Task");
  textarea.disabled = locked;
  textarea.value = value;
  if (isBlank(value)) textarea.classList.add("warn");
  textarea.addEventListener("input", () => {
    if (idx < 0) return;
    node.fields[idx].v = textarea.value;
    scheduleGraphSave();
    refreshNodeFace(node);
  });
  textarea.addEventListener("blur", () => {
    if (idx < 0) return;
    node.fields[idx].v = textarea.value;
    scheduleGraphSave();
    refreshNodeFace(node);
    textarea.classList.toggle("warn", isBlank(textarea.value));
  });
  wrap.append(textarea);
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
    refreshNodeFace(node);
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
  textarea.setAttribute("aria-label", "Content");
  textarea.value = value;
  if (isBlank(value)) textarea.classList.add("warn");
  textarea.addEventListener("input", () => {
    if (idx < 0) return;
    node.fields[idx].v = textarea.value;
    scheduleGraphSave();
    refreshNodeFace(node);
    const extraEl = wrap.querySelector<HTMLElement>(".flow-pop-cap span:last-child");
    if (extraEl) extraEl.textContent = `${textarea.value.length} Chars`;
  });
  textarea.addEventListener("blur", () => {
    if (idx < 0) return;
    node.fields[idx].v = textarea.value;
    scheduleGraphSave();
    refreshNodeFace(node);
    textarea.classList.toggle("warn", isBlank(textarea.value));
  });
  wrap.append(textarea);
  return wrap;
}

/** Builds this node's card content into S.inspectorEl (popover.ts owns show/hide/position). Called
 *  whenever the selection settles on exactly one node, and again after any edit made inside the
 *  card (mirrors the old docked panel's full-rebuild-on-edit pattern). */
export function renderInspector(node: FlowNode): void {
  const focus = markFocus();
  const scrollTop = S.inspectorEl.scrollTop;
  buildCard(node);
  if (focus) {
    S.inspectorEl.scrollTop = scrollTop;
    restoreFocus(focus);
  }
}

function buildCard(node: FlowNode): void {
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
    controls.append(buildModelRow(node, running), buildVaultRow(node, running), buildTaskCard(node, running), buildModifiers(node, running));
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
  label: string,
) {
  const input = document.createElement("input");
  input.className = "flow-inspector-input";
  input.setAttribute("aria-label", label);
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
    refreshNodeFace(node);
    scheduleGraphSave();
  };
  const rebuild = (value: string) => {
    const next = text("flow-pop-title", value);
    next.addEventListener("click", () => startEditTitle(node, next));
    return next;
  };
  editInPlace(node, span, node.title, commit, rebuild, "Title");
}
