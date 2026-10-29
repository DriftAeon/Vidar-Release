// The popover's Modifiers chip row (Controls A) — split out of inspector.ts per
// module-boundaries.md's line budget. Same data path as the rest of the card: node.addons,
// scheduleGraphSave, refreshed on the canvas card via refreshCanvasAddons (mirrors
// nodes.ts's buildAddonChip). Circular import with inspector.ts (renderInspector, to re-render
// the whole card after an add/edit/remove) is safe here the same way engine.ts/run-view.ts's
// mutual import is: only used from inside event handlers, never at module-init time.

import type { FlowAddon, FlowNode, V1AddonKind } from "./model";
import { V1_ADDON_KINDS } from "./model";
import { fieldLabel } from "./labels";
import { S, text } from "./state";
import { scheduleGraphSave } from "./store";
import { buildAddonChip } from "./nodes";
import { renderInspector, editInPlace } from "./inspector";
import { placeBelow } from "../panels/dropdown";

/** Default value a freshly-added addon starts with — never empty for `retries` (an empty value
 *  would fail validate.ts's "v1 addon has a value" check the moment it's added, §4.2/§7). */
const ADDON_DEFAULT_VALUE: Record<V1AddonKind, string> = {
  "system-prompt": "",
  cwd: "",
  retries: "0",
};

/** Menu-item tooltip where the limit is worth stating (a sub-line there would
 *  crowd the menu); the rest have none. */
const ADDON_MENU_TITLE: Partial<Record<V1AddonKind, string>> = { retries: "Max 3 Attempts" };

/** Modifier-chip colours: the mock's own hexes, which are the *old* `.flow-addon-*` colours the
 *  brief names ("old .flow-addon-* colours") re-mapped from the legacy kind names (rule/skill/hook/
 *  permission) onto the current v1 kind names (system-prompt/cwd/retries/permission-allowlist). */
const CHIP_COLOR: Record<V1AddonKind, string> = {
  "system-prompt": "#6f8fae",
  cwd: "#a97fc9",
  retries: "#c65f74",
};

/** Stops a `<select>`'s keydown from bubbling to the document — belt-and-braces alongside
 *  selection.ts's keyboardAllowed() (which excludes SELECT too), so Delete/Backspace/arrows
 *  never delete or move the node being edited while its retries select has focus. Escape is let
 *  through un-stopped so the card's own keydown handler (popover.ts, bubble phase) still clears the
 *  selection and closes the card from here. */
function stopSelectKeys(el: HTMLSelectElement): void {
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") e.stopPropagation();
  });
}

/** Rebuilds the canvas card's addon-chip row from `node.addons` after an add/edit/remove that
 *  doesn't go through `loadGraph` — mirrors `buildNode`'s own addon-chip build (nodes.ts). */
function refreshCanvasAddons(node: FlowNode): void {
  const body = S.nodeEls.get(node.id)?.querySelector<HTMLElement>(".flow-node-body");
  if (!body) return;
  const addons = node.addons ?? [];
  let row = body.querySelector<HTMLElement>(".flow-node-addons");
  if (addons.length === 0) {
    row?.remove();
    return;
  }
  if (!row) {
    row = document.createElement("div");
    row.className = "flow-node-addons";
    body.appendChild(row);
  }
  row.textContent = "";
  for (const a of addons) row.appendChild(buildAddonChip(a.kind, a.label));
}

function chipLabel(kind: V1AddonKind, value: string): string {
  if (kind === "retries") return `${fieldLabel(kind)} ${value || "0"}`;
  const v = value || "—";
  return v.length > 28 ? `${v.slice(0, 28)}…` : v;
}

function startEditChip(node: FlowNode, idx: number, span: HTMLElement): void {
  const addon = node.addons![idx];
  const commit = (value: string) => {
    addon.value = value;
    addon.label = value;
    scheduleGraphSave();
    refreshCanvasAddons(node);
  };
  const rebuild = (value: string) => {
    const next = text("", chipLabel(addon.kind as V1AddonKind, value));
    next.addEventListener("click", () => startEditChip(node, idx, next));
    return next;
  };
  editInPlace(node, span, addon.value, commit, rebuild);
}

function buildChip(node: FlowNode, a: FlowAddon, idx: number): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `flow-pop-chip flow-pop-chip-${a.kind}`;
  chip.style.setProperty("--m", CHIP_COLOR[a.kind as V1AddonKind] ?? "#8f96a3");
  chip.title = `${fieldLabel(a.kind)}: ${a.value || "—"}`;
  if (a.kind === "retries") {
    const select = document.createElement("select");
    select.className = "flow-pop-chip-select";
    for (const v of ["0", "1", "2"]) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      if (v === a.value) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      node.addons![idx].value = select.value;
      node.addons![idx].label = select.value;
      scheduleGraphSave();
      renderInspector(node);
      refreshCanvasAddons(node);
    });
    stopSelectKeys(select);
    chip.append(document.createTextNode(`${fieldLabel(a.kind)} `), select);
  } else {
    const labelSpan = text("", chipLabel(a.kind as V1AddonKind, a.value));
    labelSpan.addEventListener("click", () => startEditChip(node, idx, labelSpan));
    chip.append(labelSpan);
  }
  // A real button (not a `<span role="button">`, unreachable by keyboard) gets Enter/Space and tab order for free.
  const x = document.createElement("button");
  x.type = "button";
  x.className = "flow-pop-chip-x";
  x.textContent = "×";
  x.setAttribute("aria-label", `Remove ${fieldLabel(a.kind)}`);
  x.addEventListener("click", (e) => {
    e.stopPropagation();
    node.addons!.splice(idx, 1);
    scheduleGraphSave();
    renderInspector(node);
    refreshCanvasAddons(node);
  });
  chip.append(x);
  return chip;
}

/** Not a child of `.flow-pop-chip-add-wrap`
 *  (`position: relative`), so once the card gained `max-height`/`overflow: auto` the menu
 *  clipped against the card's own scroll box the moment it needed room below the fold. Mounted on
 *  `document.body` instead, `position: fixed`, placed off the button's own rect — same escape-the-
 *  scroll-ancestor pattern panels/document.ts's Open dropdown already uses. Only one can be open at
 *  a time, tracked here rather than per-anchor. */
let openMenuEl: HTMLElement | null = null;
/** Tears down the open menu's document-level listeners alongside the element (palette.ts's
 *  bindOutsideClose pattern) — the toggle, an outside click, Esc and an item pick all close through
 *  this one function, so none of them can remove the menu while leaving its listeners armed. */
let openMenuAbort: AbortController | null = null;

export function closeAddonMenu(): void {
  openMenuEl?.remove();
  openMenuEl = null;
  openMenuAbort?.abort();
  openMenuAbort = null;
}

function openAddonMenu(node: FlowNode, anchor: HTMLElement): void {
  closeAddonMenu();
  const present = new Set((node.addons ?? []).map((a) => a.kind));
  const available = V1_ADDON_KINDS.filter((k) => !present.has(k));
  if (available.length === 0) return;
  const menu = document.createElement("div");
  menu.className = "flow-addon-menu";
  const ac = new AbortController();
  for (const kind of available) {
    const item = document.createElement("div");
    item.className = "flow-addon-menu-item";
    item.append(document.createTextNode(fieldLabel(kind)));
    const tip = ADDON_MENU_TITLE[kind];
    if (tip) item.title = tip;
    item.addEventListener("click", () => {
      closeAddonMenu();
      node.addons = node.addons ?? [];
      node.addons.push({ kind, label: ADDON_DEFAULT_VALUE[kind], value: ADDON_DEFAULT_VALUE[kind] });
      scheduleGraphSave();
      renderInspector(node);
      refreshCanvasAddons(node);
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  openMenuEl = menu;
  openMenuAbort = ac;
  placeBelow(menu, anchor);
  const onDown = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) closeAddonMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Nit 6: this is a capture-phase document listener, so stopping it here keeps Esc from also
    // reaching popover.ts's own Escape handler (card root, bubble phase) and clearing the whole
    // selection — Esc closes only the ADD menu.
    e.stopPropagation();
    closeAddonMenu();
  };
  requestAnimationFrame(() => {
    document.addEventListener("pointerdown", onDown, { capture: true, signal: ac.signal });
    document.addEventListener("keydown", onKey, { capture: true, signal: ac.signal });
  });
}

function capLabel(labelText: string): HTMLElement {
  const cap = document.createElement("div");
  cap.className = "flow-pop-cap";
  cap.append(document.createTextNode(labelText));
  return cap;
}

export function buildModifiers(node: FlowNode, locked: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.append(capLabel("Modifiers"));
  const chips = document.createElement("div");
  chips.className = "flow-pop-chips";
  const addons = node.addons ?? [];
  addons.forEach((a, idx) => chips.append(buildChip(node, a, idx)));
  const present = new Set(addons.map((a) => a.kind));
  const remaining = V1_ADDON_KINDS.filter((k) => !present.has(k));
  if (remaining.length) {
    const addWrap = document.createElement("span");
    addWrap.className = "flow-pop-chip-add-wrap";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "flow-pop-chip-add";
    addBtn.textContent = "ADD";
    addBtn.disabled = locked;
    addBtn.addEventListener("click", () => {
      if (openMenuEl) closeAddonMenu();
      else openAddonMenu(node, addBtn);
    });
    addWrap.append(addBtn);
    chips.append(addWrap);
  }
  wrap.append(chips);
  return wrap;
}
