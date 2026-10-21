// Toolbench: the bottom half of the right panel. A Photoshop-style tool grid
// over an options strip that belongs to whichever tool is armed.
//
// The distinction from the macro strip is target: a macro fires the instant you
// click it, a tool is armed and then acts on something. The distinction from
// inspect mode is scope — inspect suppresses clicks globally at the capture
// phase (it has to; it inspects Vidar itself), whereas a tool only ever listens
// on its own canvas. That is why inspect stays in the bottom bar and these
// don't, and why the two are mutually exclusive below.

import { exitInspect, onInspectEnter } from "./inspect";
import { getPref, setPref } from "../prefs";
import { applyOrder, enableReorder } from "./reorder";
import { openModuleContextMenu, type ModuleMenuAction } from "../modules/context-menu";
import type { ToolModule } from "../tools/registry";
import { moduleName, onModuleNamesChange } from "../modules/names";

export type Canvas = "terminal" | "display" | "none";

export interface Tool {
  id: string;
  /** text fallback, used when `icon` is absent */
  glyph: string;
  /** imported asset URL; takes precedence over `glyph` */
  icon?: string;
  label: string;
  /** which surface the tool acts on; "none" = always available */
  canvas: Canvas;
  /** false = arming leaves the options host hidden; the tool reveals it itself through `reveal` */
  revealOnArm?: boolean;
  /** called once at init to build the tool's options UI into `host`; `reveal` shows or hides that host */
  mount(host: HTMLElement, reveal?: (visible: boolean) => void): void;
  /** A fresh instance for remount after disposal. */
  create?(): Tool;
  arm(): void;
  disarm(): void;
  dispose(): void;
}

interface Mounted {
  tool: Tool;
  button: HTMLButtonElement;
  host: HTMLElement;
}

const mounted: Mounted[] = [];
const descriptors = new Map<string, ToolModule>();
const factories = new Map<string, () => Tool>();
const pending = new Map<string, Promise<boolean>>();
const requests = new Map<string, number>();
const desired = new Map<string, boolean>();
let mountEpoch = 0;
const toolLabels = new Map<string, string>();
let gridEl: HTMLElement | null = null;
let optionsEl: HTMLElement | null = null;
let armedId: string | null = null;
let activeCanvas: Canvas = "terminal";
let handlersInstalled = false;
const reorderWired = new WeakSet<HTMLElement>();
let menuGrid: HTMLElement | null = null;
let modulesChangeListener: (() => void) | undefined;
let unsubscribeNames: (() => void) | undefined;

/** The button's aria-label: the Tool's long label, with its leading name ("Marquee — read text…")
 *  swapped for the user's name; a label without " — " is replaced whole. Unrenamed keeps the long label. */
function toolAria(id: string, long: string): string {
  const short = toolLabels.get(id) ?? long;
  const name = moduleName(id, short);
  if (name === short) return long;
  const cut = long.indexOf(" — ");
  return cut < 0 ? name : name + long.slice(cut);
}

function setSavedVisibility(id: string, visible: boolean) {
  const key = `tool:${id}`;
  const hidden = getPref("modules.hidden") ?? [];
  const next = visible ? hidden.filter((entry) => entry !== key) : [...hidden, key];
  if (setPref("modules.hidden", next)) document.dispatchEvent(new document.defaultView!.CustomEvent("vidar-modules-change"));
}

function toolMenuActions(clicked?: string): ModuleMenuAction[] {
  const actions: ModuleMenuAction[] = [];
  const hidden = new Set(getPref("modules.hidden") ?? []);
  if (clicked && toolLabels.has(clicked)) {
    const savedHidden = hidden.has(`tool:${clicked}`);
    actions.push({ label: `${savedHidden ? "Show" : "Hide"} ${moduleName(clicked, toolLabels.get(clicked)!)}`,
      kind: savedHidden ? "show" : "hide",
      onSelect: () => setSavedVisibility(clicked, savedHidden) });
  }
  for (const [id, label] of toolLabels) {
    if (id === clicked || !hidden.has(`tool:${id}`)) continue;
    actions.push({ label: `Show ${moduleName(id, label)}`, kind: "show",
      onSelect: () => setSavedVisibility(id, true) });
  }
  actions.push({ label: "Modules…", kind: "manage",
    onSelect: () => { void import("../settings/modal").then(({ openShortcutsModal }) => openShortcutsModal("modules")); } });
  return actions;
}

function wireToolMenu(grid: HTMLElement) {
  if (menuGrid === grid) return;
  menuGrid = grid;
  grid.tabIndex = 0;
  grid.setAttribute("aria-label", "Toolbar");
  grid.setAttribute("aria-haspopup", "menu");
  const openMenu = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    if (armedId) { disarmTool(); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".tool-btn");
    const anchor = button?.parentElement === grid ? button : grid;
    openModuleContextMenu(anchor, toolMenuActions(button?.dataset.key),
      event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : { bar: grid });
  };
  grid.addEventListener("contextmenu", openMenu);
  grid.addEventListener("keydown", (event) => {
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) openMenu(event);
  });
}

function available(t: Tool): boolean {
  return t.canvas === "none" || t.canvas === activeCanvas;
}

export function disarmTool() {
  if (!armedId) return;
  const m = mounted.find((x) => x.tool.id === armedId);
  armedId = null;
  if (m) {
    m.tool.disarm();
    m.button.classList.remove("active");
    m.button.setAttribute("aria-pressed", "false");
    m.host.classList.add("hidden");
  }
}

function armTool(id: string) {
  const m = mounted.find((x) => x.tool.id === id);
  if (!m || !available(m.tool)) return;
  if (armedId === id) {
    disarmTool();
    return;
  }
  disarmTool();
  // inspect's capture-phase suppression would eat this tool's own clicks
  exitInspect();
  armedId = id;
  m.tool.arm();
  m.button.classList.add("active");
  m.button.setAttribute("aria-pressed", "true");
  if (m.tool.revealOnArm !== false) m.host.classList.remove("hidden");
}

/** Called by main.ts whenever the main view changes; dims off-canvas tools. */
export function setActiveCanvas(canvas: Canvas) {
  activeCanvas = canvas;
  for (const m of mounted) {
    const ok = available(m.tool);
    m.button.disabled = !ok;
    m.button.classList.toggle("offcanvas", !ok);
  }
  // an armed tool whose canvas just went away has nothing to act on
  if (armedId) {
    const m = mounted.find((x) => x.tool.id === armedId);
    if (m && !available(m.tool)) disarmTool();
  }
}

function mountTool(tool: Tool) {
  if (!gridEl || !optionsEl || mounted.some((entry) => entry.tool.id === tool.id)) return;
  const button = document.createElement("button");
  button.className = "tool-btn";
  button.dataset.key = tool.id;
  if (tool.icon) {
    button.classList.add("iconed");
    // inline, not a stylesheet rule: the URL is a bundler-hashed import
    button.style.setProperty("--tool-icon", `url("${tool.icon}")`);
  } else {
    button.textContent = tool.glyph;
  }
  button.setAttribute("aria-label", toolAria(tool.id, tool.label));
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => armTool(tool.id));
  const ids = [...descriptors.keys()];
  const next = mounted.find((entry) => ids.indexOf(entry.tool.id) > ids.indexOf(tool.id));
  gridEl.insertBefore(button, next?.button ?? null);

  const host = document.createElement("div");
  host.className = "tool-options hidden";
  optionsEl.insertBefore(host, next?.host ?? null);
  tool.mount(host, (visible) => host.classList.toggle("hidden", !visible));
  mounted.push({ tool, button, host });
  setActiveCanvas(activeCanvas);
}

/** Apply a visibility choice; persistence is owned by the caller. */
export function setToolVisibility(id: string, visible: boolean): Promise<boolean> {
  const descriptor = descriptors.get(id);
  if (!descriptor) return Promise.resolve(false);
  desired.set(id, visible);
  const index = mounted.findIndex((entry) => entry.tool.id === id);
  if (!visible) {
    requests.set(id, (requests.get(id) ?? 0) + 1);
    pending.delete(id);
    if (index >= 0) {
      if (armedId === id) disarmTool();
      const [entry] = mounted.splice(index, 1);
      entry.tool.dispose();
      entry.button.remove();
      entry.host.remove();
    }
    return Promise.resolve(true);
  }
  if (index >= 0) return Promise.resolve(true);
  const existing = pending.get(id);
  if (existing) return existing;
  const token = (requests.get(id) ?? 0) + 1;
  const epoch = mountEpoch;
  requests.set(id, token);
  const loading = (async () => {
    try {
      const factory = factories.get(id) ?? await descriptor.load();
      if (mountEpoch !== epoch || requests.get(id) !== token || !desired.get(id)) return false;
      factories.set(id, factory);
      mountTool(factory());
      syncToolOrder();
      return true;
    } catch (error) {
      console.error(`Tool ${id} failed to load`, error);
      return false;
    }
  })();
  pending.set(id, loading);
  void loading.finally(() => { if (pending.get(id) === loading) pending.delete(id); });
  return loading;
}

/** Reconcile after a preference change without writing visibility state. */
export async function syncToolVisibility(): Promise<void> {
  const hidden = new Set(getPref("modules.hidden") ?? []);
  await Promise.all([...descriptors.keys()].map((id) => setToolVisibility(id, !hidden.has(`tool:${id}`))));
}

export function syncToolOrder() {
  if (gridEl) applyOrder(gridEl, "order.tools");
}

export function initToolbench(grid: HTMLElement, options: HTMLElement, tools: readonly ToolModule[]): Promise<void> {
  mountEpoch++;
  disarmTool();
  for (const entry of mounted.splice(0)) {
    entry.tool.dispose();
    entry.button.remove();
    entry.host.remove();
  }
  gridEl = grid;
  optionsEl = options;
  descriptors.clear();
  factories.clear();
  pending.clear();
  requests.clear();
  desired.clear();
  toolLabels.clear();
  for (const tool of tools) {
    descriptors.set(tool.id, tool);
    // Tool.label is a longer tooltip; the menu uses the short module name.
    toolLabels.set(tool.id, tool.label);
  }
  syncToolOrder();
  if (!reorderWired.has(grid)) {
    enableReorder(grid, "order.tools", { handle: ".tool-btn", axis: "x" });
    reorderWired.add(grid);
  }
  wireToolMenu(grid);
  if (modulesChangeListener) document.removeEventListener("vidar-modules-change", modulesChangeListener);
  modulesChangeListener = () => { void syncToolVisibility(); syncToolOrder(); };
  document.addEventListener("vidar-modules-change", modulesChangeListener);
  unsubscribeNames?.();
  unsubscribeNames = onModuleNamesChange(() => {
    for (const m of mounted) m.button.setAttribute("aria-label", toolAria(m.tool.id, m.tool.label));
  });

  if (handlersInstalled) return syncToolVisibility();
  handlersInstalled = true;
  // Bubble phase, not capture: inspect owns the capture phase for Escape and
  // the two are never active together anyway.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && armedId) {
      const t = e.target as HTMLElement;
      // don't steal Escape from a text field in the options strip, and never
      // from a terminal — Esc there belongs to whatever TUI is running, and
      // disarming out from under a vim keystroke would be pure surprise
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (t.closest?.(".term-container")) return;
      disarmTool();
    }
  });

  // entering inspect mode disarms whatever was armed (the reverse of armTool)
  onInspectEnter(disarmTool);
  // shutting Vidar puts every tool down — the marquee's overlay window in
  // particular must not outlive the main window (main.rs also enforces this)
  window.addEventListener("beforeunload", disarmTool);

  setActiveCanvas(activeCanvas);
  return syncToolVisibility();
}
