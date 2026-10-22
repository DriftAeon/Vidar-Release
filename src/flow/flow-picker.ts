// Flow picker: the toolbar's "which flow" control (mock state 1's left dropdown + New button)
// — lists `S.graphs` by `updatedAt` desc, switches the active graph, and seeds a new flow that is
// never truly blank (an input -> output pair) under a name the user supplies. Mounting this into
// panels/flow.ts's toolbar is panels/flow.ts's job; this module only builds the control and
// performs the switch/create, on top of store.ts's bookkeeping.

import { iconImg } from "../icon-img";
import type { FlowGraph } from "./model";
import { S } from "./state";
import { setActiveGraph, scheduleGraphSave, applyTemplateDraft, activeDraft, deleteGraph } from "./store";
import { closeDeleteConfirm, deleteConfirmEl, openDeleteConfirm } from "./delete-confirm";
import { stampGraph, starterDescription } from "./store-core";
import { loadGraph } from "./nodes";
// top-to-bottom, same stack as the starter templates
import { stackY, STARTER_TEMPLATES } from "./templates";
import { modelLabel, wiredModels } from "./roster";
import { dropdown } from "../panels/dropdown";

/** Title Case: it becomes a row label in the Flow picker (ui-copy rule). */
export const DEFAULT_NAME = "Untitled Flow";

/** The picker face while no flow is open (the open one was deleted). */
const NO_FLOW = "No Flow";

function sortedGraphs(): FlowGraph[] {
  return [...S.graphs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Switches to `graph` (store.ts's active-graph bookkeeping, including flushing the outgoing
 *  graph's pending save) and rebuilds the canvas DOM from it — the one path both the picker's
 *  menu rows and `createBlankFlow` use, so the DOM never drifts from `S.nodes`/`S.edges` after a
 *  switch. */
function switchToGraph(graph: FlowGraph): void {
  setActiveGraph(graph);
  loadGraph(graph);
}

/** New (§5: "New seeds an input -> output pair, never blank, opens a name prompt"). Node ids
 *  `"input"`/`"output"` match model.ts's charset and the input node's frozen id (§2, so
 *  `{{input}}` and the input node coincide, §4.2). The name comes from the caller — the toolbar's
 *  inline name field (buildNewFlowButton) or a fixed default at mount; an empty/blank name
 *  creates nothing. `window.prompt` is not used: in the Tauri webview it blocks
 *  the JS thread, which hung DevTools-driven automation, and it looked foreign. */
export function createBlankFlow(name: string): FlowGraph | null {
  if (!name.trim()) return null;
  const graph = blankGraph(name);
  S.graphs.push(graph);
  switchToGraph(graph);
  scheduleGraphSave();
  return graph;
}

/** The input -> output pair New seeds, stamped but stored nowhere until `createBlankFlow` adds it. */
function blankGraph(name: string): FlowGraph {
  return stampGraph(
    {
      name: name.trim(),
      nodes: [
        {
          id: "input",
          kind: "input",
          title: "Input",
          x: 0,
          y: stackY(0),
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
        { id: "output", kind: "output", title: "Output", x: 0, y: stackY(1), fields: [], inputs: ["in"], outputs: [] },
      ],
      edges: [{ id: "e1", from: { node: "input", port: "out" }, to: { node: "output", port: "in" } }],
    },
    new Date().toISOString(),
  );
}

/** A template (any of `S.templates`, starters included) applied as an unsaved instance and drawn;
 *  it joins the User list only through Save (save-button.ts). */
function openTemplateDraft(templateId: string): FlowGraph | null {
  const graph = applyTemplateDraft(templateId);
  if (!graph) return null;
  loadGraph(graph);
  return graph;
}

/** The canvas's graph for the picker face: the stored active graph, else the unsaved draft. */
function activeGraph(): FlowGraph | null {
  return S.graphs.find((g) => g.id === S.activeGraphId) ?? activeDraft();
}

/** User section collapsed state: in-memory for the session (src/flow reads no prefs key). */
let userCollapsed = false;

/** The mounted picker: `el` goes in the toolbar, `refresh` re-syncs after `S.graphs` changes
 *  (New, template instantiation), `destroy` closes an open menu and drops its document listeners. */
export interface FlowPicker {
  el: HTMLButtonElement;
  refresh: () => void;
  destroy: () => void;
}

/** Fills `el` with `name`, drawing each "→" as a spaced " / " (2026-10-06: the colour arrow
 *  icons read poorly; the spaces keep a stage like "/ Review" from reading as a slash command).
 *  Text goes in by textContent only. `title` is the drawn name, for the ellipsised case. */
function renderName(el: HTMLElement, name: string): void {
  const span = document.createElement("span");
  span.textContent = name.split("→").map((p) => p.trim()).join(" / ");
  el.replaceChildren(span);
  el.title = span.textContent;
}

/** One menu row (`.display-pick-row` look); `name` arrows render as " / ". */
function addRow(parent: HTMLElement, name: string, active: boolean, onPick: () => void, stageChain?: string): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "display-pick-row" + (active ? " active" : "");
  if (stageChain) row.title = stageChain;
  const nm = document.createElement("span");
  nm.className = "nm";
  renderName(nm, name);
  if (stageChain) nm.title = stageChain;
  row.append(nm);
  row.addEventListener("click", onPick);
  parent.append(row);
  return row;
}

/** A User row: the menu row plus a Delete icon beside it, shown on hover and focus (flow.css).
 *  The icon is a sibling, not a child, so its click never reaches the row's open; ArrowRight
 *  from the row focuses it, ArrowLeft goes back, and Delete on the row opens the confirm too. */
function addUserRow(parent: HTMLElement, graph: FlowGraph, onPick: () => void, onDelete: (row: HTMLElement) => void): void {
  const item = document.createElement("div");
  item.className = "flow-pick-item";
  const row = addRow(item, graph.name, graph.id === S.activeGraphId, onPick);
  const del = document.createElement("button");
  del.type = "button";
  del.className = "flow-pick-del";
  del.title = "Delete";
  del.setAttribute("aria-label", "Delete");
  del.append(iconImg("trash"));
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    onDelete(row);
  });
  row.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      del.focus();
    } else if (e.key === "Delete") {
      e.preventDefault();
      onDelete(row);
    }
  });
  del.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      row.focus();
    }
  });
  item.append(del);
  parent.append(item);
}

export interface MenuHandle {
  open: () => void;
  close: () => void;
  /** Re-runs `fill` on an open menu and refocuses; a no-op while closed. */
  refill: () => void;
}

/** The body-appended `#flow-pick-menu` both toolbar controls share, on dropdown.ts (open, close,
 *  Escape, Tab, outside mousedown, placement with the gap measured from the toolbar's edge);
 *  here only the rows: arrow keys walk them, open and refill focus the active row or the first. */
export function attachMenu(button: HTMLButtonElement, fill: (m: HTMLElement) => void, inside?: () => Node[]): MenuHandle {
  const rows = (m: HTMLElement): HTMLElement[] => Array.from(m.querySelectorAll<HTMLElement>(".display-pick-row"));
  const focusFirst = (m: HTMLElement) => (m.querySelector<HTMLElement>(".display-pick-row.active") ?? rows(m)[0])?.focus();
  let current: HTMLDivElement | null = null;

  const dd = dropdown({
    button,
    // gap measured from the toolbar's edge, not the button's (ui-look: menus opened from a bar)
    anchor: () => button.closest(".flow-toolbar") ?? button,
    floor: true,
    inside,
    build: (m) => {
      current = m;
      m.id = "flow-pick-menu";
      fill(m);
    },
    onKey: (e, m) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = rows(m);
      if (!items.length) return;
      // on a User row's Delete icon, walk from its row
      const focused = document.activeElement as HTMLElement | null;
      const from = focused?.classList.contains("flow-pick-del") ? focused.previousElementSibling : focused;
      const idx = items.indexOf(from as HTMLElement);
      const next = e.key === "ArrowDown" ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      items[next].focus();
    },
    enter: (m) => focusFirst(m),
  });

  function refill(): void {
    if (!dd.isOpen() || !current) return;
    dd.rerender();
    focusFirst(current);
  }

  return { open: () => dd.open(), close: dd.close, refill };
}

/** The menu's Templates section label (not a row: arrow keys skip it). */
function addSectionLabel(parent: HTMLElement, label: string): void {
  const head = document.createElement("div");
  head.className = "flow-pick-head";
  head.textContent = label;
  parent.append(head);
}

/** The User section header: a row that toggles the section, chevron at the right (the face's
 *  caret glyph when open). */
function addCollapsibleHead(parent: HTMLElement, label: string, collapsed: boolean, onToggle: () => void): void {
  const head = document.createElement("button");
  head.type = "button";
  head.className = "display-pick-row flow-pick-head flow-pick-user";
  head.setAttribute("aria-expanded", String(!collapsed));
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = label;
  const car = document.createElement("span");
  car.className = "car";
  car.append(iconImg("folder"));
  head.title = collapsed ? "Expand" : "Collapse";
  head.append(nm, car);
  head.addEventListener("click", onToggle);
  parent.append(head);
}

/** Builds the Flow picker (mock state 1's first control): a button face (active flow's name, caret
 *  at the right) and a menu with two sections: Templates on top (every `S.templates` entry; a
 *  click applies an unsaved instance), then User (the saved graphs, newest `updatedAt` first, the
 *  active one marked), collapsible from its header (2026-10-05; this reverses the
 *  2026-10-04 "templates only from New"). `onSwitched` mirrors `buildNewFlowButton`'s
 *  `onCreated` — §5's run selector is filtered to the active graph, so Integration needs a hook to
 *  refresh it after a switch, not just after a create. The menu is a custom one (not a
 *  `<select>`) so the name arrows can be icons. */
export function buildFlowPicker(onSwitched?: (graph: FlowGraph | null) => void): FlowPicker {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "flow-pick pick-face";
  const face = document.createElement("span");
  face.className = "nm";
  const caret = document.createElement("span");
  caret.className = "car";
  caret.textContent = "▾";
  button.append(face, caret);

  const paintFace = () => {
    renderName(face, activeGraph()?.name ?? NO_FLOW);
  };

  const picked = (graph: FlowGraph | null) => {
    if (!graph) return;
    refresh();
    onSwitched?.(graph);
  };

  const menu = attachMenu(button, (m) => {
    m.replaceChildren();
    if (S.templates.length) {
      addSectionLabel(m, "Templates");
      for (const template of S.templates) {
        addRow(m, template.name, false, () => {
          menu.close();
          button.focus();
          picked(openTemplateDraft(template.id));
        }, STARTER_TEMPLATES.some((starter) => starter.id === template.id)
          ? starterDescription(template, wiredModels().map((model) => model.id), modelLabel)
          : template.description);
      }
    }
    addCollapsibleHead(m, "User", userCollapsed, () => {
      userCollapsed = !userCollapsed;
      menu.refill();
      m.querySelector<HTMLElement>(".flow-pick-user")?.focus();
    });
    if (userCollapsed) return;
    for (const graph of sortedGraphs()) {
      addUserRow(m, graph, () => {
        menu.close();
        button.focus();
        switchToGraph(graph);
        picked(graph);
      }, (row) => openDeleteConfirm(row, graph.name, () => removeGraph(graph.id), row));
    }
  }, () => {
    const c = deleteConfirmEl();
    return c ? [c] : [];
  });

  /** Confirmed Delete: the store refuses templates and starters. Deleting the open flow clears
   *  the canvas and tells the toolbar with `null` (nothing open). The menu refills and focuses
   *  the active row, or the first. */
  const removeGraph = (id: string) => {
    const before = S.activeGraphId;
    if (!deleteGraph(id)) return;
    if (S.activeGraphId !== before) {
      loadGraph({ id: "", name: "", nodes: [], edges: [], updatedAt: "" });
      onSwitched?.(null);
    }
    refresh();
  };

  function refresh(): void {
    paintFace();
    menu.refill();
  }

  paintFace();
  return {
    el: button,
    refresh,
    destroy: () => {
      closeDeleteConfirm();
      menu.close();
    },
  };
}

/** Builds the New button (mock state 1) plus its inline name field: New swaps itself for a text
 *  field and a Create button, focused on open; Enter or Create makes the flow, Esc (or blurring
 *  out of the pair with the field empty) cancels. `onCreated` lets the caller
 *  update any other toolbar state (run selector, `+` availability) once a flow
 *  exists. Returns the wrapper holding both states, for the toolbar to mount as one item. */
export function buildNewFlowButton(picker: FlowPicker, onCreated?: (graph: FlowGraph) => void): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "flow-picker-new-wrap";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "flow-picker-new icon-btn";
  btn.setAttribute("aria-label", "New");
  btn.title = "New";
  btn.appendChild(iconImg("document-add"));

  const form = document.createElement("span");
  form.className = "flow-picker-name-form";
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "flow-picker-name";
  input.placeholder = "Flow Name";
  input.setAttribute("aria-label", "Flow name");
  const create = document.createElement("button");
  create.type = "button";
  create.className = "flow-picker-create";
  create.textContent = "Create";
  form.append(input, create);
  wrap.append(btn, form);

  const close = () => {
    form.hidden = true;
    btn.hidden = false;
    input.value = "";
  };
  const submit = () => {
    const graph = createBlankFlow(input.value);
    if (!graph) {
      input.focus();
      return;
    }
    close();
    picker.refresh();
    onCreated?.(graph);
  };

  const openNameForm = () => {
    btn.hidden = true;
    form.hidden = false;
    input.value = DEFAULT_NAME;
    input.focus();
    input.select();
  };

  // New opens Custom / Template; Template swaps the same menu for the template list (2026-10-04).
  // Registered before attachMenu's toggle listener, so every open starts at the first level.
  let level: "kind" | "template" = "kind";
  btn.addEventListener("click", () => {
    level = "kind";
  });
  const menu = attachMenu(btn, (m) => {
    m.replaceChildren();
    if (level === "kind") {
      addRow(m, "Custom", false, () => {
        menu.close();
        openNameForm();
      });
      if (S.templates.length) {
        addRow(m, "Template", false, () => {
          level = "template";
          menu.refill();
        });
      }
      return;
    }
    for (const template of S.templates) {
      addRow(m, template.name, false, () => {
        menu.close();
        btn.focus();
        const graph = openTemplateDraft(template.id);
        picker.refresh();
        if (graph) onCreated?.(graph);
      });
    }
  });
  create.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  // Focus leaving the field+Create pair with nothing typed (blank or the untouched default) is a
  // cancel; with a name typed the pair stays open so a stray click doesn't throw the name away.
  form.addEventListener("focusout", (e) => {
    if (form.contains(e.relatedTarget as Node | null)) return;
    const v = input.value.trim();
    if (!v || v === DEFAULT_NAME) close();
  });
  return wrap;
}
