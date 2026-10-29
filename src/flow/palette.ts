// The "+" palette: a two-level popover (node kind, then — for Agent — a preset) that mints and
// mounts a new node via nodes.ts's single creation path (`createNode`).
// Mounting the anchor `+` button into the toolbar, and picking `at` from a
// real click/viewport position, is panels/flow.ts's job — this module only
// builds the popover DOM and creates nodes once a choice is made.

import type { AgentPreset, ModelId, V1NodeKind } from "./model";
import { V1_NODE_KINDS } from "./model";
import { createNode } from "./nodes";
import { text } from "./state";
import { presetLabel } from "./labels";
import { modelLabel, wiredModels } from "./roster";
import { EDIT_RULE } from "./templates";
import { scheduleGraphSave } from "./store";
import { setSelection } from "./selection";

interface AgentPresetSpec {
  preset: AgentPreset;
  title: string;
  model: ModelId;
  task: string;
}

/** Default model per preset ("No preset defaults to Fable... Every default is a
 *  placeholder shown in the select, never silently kept"). Default task has no `{{…}}`
 *  placeholders: a preset stamped from the palette onto a free canvas knows no upstream node
 *  ids, so it relies on `renderPrompt`'s default-append of the predecessor's output (§3, §4.2).
 *  The display order is fixed. */
const AGENT_PRESETS: readonly AgentPresetSpec[] = [
  { preset: "plan", title: "Plan", model: "claude-opus-5-5", task: "Write an implementation plan for this request." },
  {
    preset: "review",
    title: "Review",
    model: "claude-opus-5-5",
    task: "Review the upstream output against the original request. List findings by severity with the fix for each.",
  },
  {
    preset: "revise",
    title: "Revise",
    model: "claude-sonnet-5",
    task: "Revise the upstream output per the review notes. Keep scope unchanged.",
  },
  {
    preset: "execute",
    title: "Execute",
    model: "claude-sonnet-5",
    // The Execute task uses the same runner-neutral file-edit rule as the starter templates.
    task: `Implement the plan. ${EDIT_RULE}`,
  },
  {
    preset: "brainstorm-format",
    title: "Brainstorm-Format",
    model: "claude-sonnet-5",
    task: "Structure the upstream ideas into a clear, organized draft.",
  },
  {
    preset: "academy",
    title: "Academy",
    model: "claude-sonnet-5",
    task: "Suggest one improvement to this run's flow or prompts, based on what just happened.",
  },
  {
    preset: "improve",
    title: "Improve",
    model: "claude-sonnet-5",
    task: "Rewrite the upstream output for clarity and correctness. Keep scope unchanged.",
  },
];

/** Not in `AGENT_PRESETS`: it sits after the separator in the mock, and starts with an empty
 *  task rather than a stamped one — nothing is silently kept unedited (§3). */
const CUSTOM_PRESET: AgentPresetSpec = { preset: "custom", title: "Custom", model: "claude-sonnet-5", task: "" };

const KIND_TITLE: Record<V1NodeKind, string> = { input: "Input", agent: "Agent", output: "Output" };
/** Dot colors. Off-token by design:
 *  they reuse styles.css's existing edge/node-kind hues (`.flow-kind-trigger`'s blue for `input`,
 *  `.flow-kind-agent`'s gold, `.flow-kind-output`'s orange) so the palette reads as the same
 *  color axis as the canvas, but V1's `input`/`agent`/`output` kinds don't share a css variable
 *  with those legacy `trigger`/`tool`/`review` node-kind classes. */
const KIND_DOT: Record<V1NodeKind, string> = { input: "#6aa6d6", agent: "#d7b254", output: "#c97a4a" };

/** Popover -> its close function (set by `bindOutsideClose`), so `closePalettes` tears down the
 *  document-level listeners too instead of just detaching the element. */
const paletteClosers = new WeakMap<Element, () => void>();

function closePalettes(): void {
  document.querySelectorAll(".flow-palette").forEach((el) => (paletteClosers.get(el) ?? (() => el.remove()))());
}

/** Closes `pop` on the next outside pointerdown or an Escape keypress. Deferred one frame so the
 *  same click that opened the popover doesn't also close it. A click on the popover itself
 *  (label, separator, an item after it handles its own click) is stopped so it never bubbles to
 *  whatever anchor Integration mounts the `+` button as — the naming invites passing the button
 *  itself, and a bubbled click would close-then-reopen the popover it belongs to. The listeners
 *  share one `AbortController` so any close path (outside click, Escape, an item pick) tears both
 *  down together instead of leaving the document-level pointerdown listener registered. */
function bindOutsideClose(pop: HTMLElement): void {
  const ac = new AbortController();
  const close = () => {
    pop.remove();
    ac.abort();
  };
  paletteClosers.set(pop, close);
  pop.addEventListener("click", (e) => e.stopPropagation(), { signal: ac.signal });
  const onDown = (e: PointerEvent) => {
    if (pop.isConnected && pop.contains(e.target as Node)) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  requestAnimationFrame(() => {
    if (!pop.isConnected) return;
    document.addEventListener("pointerdown", onDown, { capture: true, signal: ac.signal });
    document.addEventListener("keydown", onKey, { signal: ac.signal });
  });
}

function paletteItem(label: string, dot?: string): HTMLElement {
  const item = document.createElement("div");
  item.className = "flow-palette-item";
  if (dot) {
    const d = document.createElement("span");
    d.className = "flow-palette-dot";
    d.style.background = dot;
    item.append(d);
  }
  item.append(document.createTextNode(label));
  return item;
}

function placeInputNode(at: { x: number; y: number }): void {
  const node = createNode(
    {
      kind: "input",
      title: "Input",
      x: at.x,
      y: at.y,
      fields: [
        { k: "shape", v: "free-text" },
        { k: "content", v: "" },
      ],
      fieldSpecs: [
        { k: "shape", required: true, kind: "select", options: ["free-text", "structured"] },
        { k: "content", required: true, kind: "text" },
      ],
      inputs: [],
      outputs: ["out"],
    },
    "input",
  );
  setSelection(new Set([node.id]));
  scheduleGraphSave();
}

function placeOutputNode(at: { x: number; y: number }): void {
  const node = createNode(
    { kind: "output", title: "Output", x: at.x, y: at.y, fields: [], inputs: ["in"], outputs: [] },
    "output",
  );
  setSelection(new Set([node.id]));
  scheduleGraphSave();
}

/** Stamps an agent node from a preset: title, default model, default task plus the read-only
 *  `{k:"preset",...}` marker (§2/§3) — engine.ts finds the Academy node by this field, never by
 *  title. Mints the id from the preset name (`"plan-1"`, …), matching `mintNodeId`'s "for a
 *  stamped agent preset, the preset name" rule; Custom mints from the kind instead. */
function placeAgentNode(spec: AgentPresetSpec, at: { x: number; y: number }): void {
  // A preset whose default model is not offered (its module is off) takes the first wired model.
  const wired = wiredModels();
  const model = wired.some((m) => m.id === spec.model) ? spec.model : (wired[0]?.id ?? spec.model);
  const node = createNode(
    {
      kind: "agent",
      title: spec.title,
      subtitle: modelLabel(model),
      x: at.x,
      y: at.y,
      model,
      fields: [
        { k: "task", v: spec.task },
        { k: "preset", v: spec.preset },
      ],
      fieldSpecs: [{ k: "task", required: true, kind: "text" }],
      inputs: ["in"],
      outputs: ["out"],
    },
    spec.preset === "custom" ? "agent" : spec.preset,
  );
  setSelection(new Set([node.id]));
  scheduleGraphSave();
}

/** Second-level popover: the seven presets, a separator, then Custom. Picking one
 *  places the agent node immediately — no separate confirm step. */
function openPresetPalette(anchor: HTMLElement, at: { x: number; y: number }): void {
  closePalettes();
  const pop = document.createElement("div");
  pop.className = "flow-palette flow-palette-presets";
  pop.append(text("flow-palette-label", "Agent Preset"));
  for (const spec of AGENT_PRESETS) {
    const item = paletteItem(presetLabel(spec.preset));
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      closePalettes();
      placeAgentNode(spec, at);
    });
    pop.append(item);
  }
  const sep = document.createElement("div");
  sep.className = "flow-palette-sep";
  pop.append(sep);
  const custom = paletteItem(presetLabel(CUSTOM_PRESET.preset));
  custom.addEventListener("click", (e) => {
    e.stopPropagation();
    closePalettes();
    placeAgentNode(CUSTOM_PRESET, at);
  });
  pop.append(custom);
  anchor.appendChild(pop);
  bindOutsideClose(pop);
}

/** Top-level "+" palette: exactly Input / Agent / Output, from `V1_NODE_KINDS`
 *  (`ReservedNodeKind` is never offered here). Agent opens the preset sub-palette; Input/Output
 *  place immediately. `anchor` is the positioned element the popover is appended to (the `+`
 *  button's container); `at` is the world position for the new node — the caller
 *  supplies it (e.g. viewport center or last canvas click). */
export function openNodeKindPalette(anchor: HTMLElement, at: { x: number; y: number }): void {
  closePalettes();
  const pop = document.createElement("div");
  pop.className = "flow-palette";
  pop.append(text("flow-palette-label", "Add Node"));
  for (const kind of V1_NODE_KINDS) {
    const item = paletteItem(KIND_TITLE[kind], KIND_DOT[kind]);
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      closePalettes();
      if (kind === "agent") openPresetPalette(anchor, at);
      else if (kind === "input") placeInputNode(at);
      else placeOutputNode(at);
    });
    pop.append(item);
  }
  anchor.appendChild(pop);
  bindOutsideClose(pop);
}
