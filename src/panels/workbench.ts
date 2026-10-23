// Workbench: the one non-terminal pane, always on the right of #view-sessions.
// sessions.ts owns WHETHER it is shown (its `workbenchOpen` flag, reconciled in
// layout() like everything else); this module owns WHAT it shows. It never
// touches activeId — clicking into it moves keyboard focus, not the terminal
// destination, which the header keeps labelled so Insert stays predictable.
//
// This file is the pane shell and the header tab switcher. The Tray's blocks
// and producers live in workbench-tray.ts, mounted into the body element with
// the callbacks it needs from here.

import { getCurrentWebview } from "../ipc";
import { openWorkbench, isWorkbenchOpen } from "./sessions";
import { showSessionsToast } from "./sessions/zoom";
import { mountDocumentView, openDocumentPath, onDocumentShown, onDocumentHidden } from "./document";
import { mountFlowView, onFlowShown, onFlowHidden } from "./flow";
import { tabIcon } from "./workbench-tab-icons";
import { mountRelayTab, onRelayShown, onRelayHidden } from "./relay";
import { applyOrder, enableReorder } from "./reorder";
import { onPress } from "./press";
import { mountTray, onPaste, dropPaths } from "./workbench-tray";
import { OPTIONAL_SURFACE_IDS, WORKBENCH_MODULES } from "./workbench-modules";
import * as prefs from "../prefs";
import { openModuleContextMenu, type ModuleMenuAction } from "../modules/context-menu";
import { moduleListed, onModulesChange } from "../modules/registry";
import { moduleName, onModuleNamesChange } from "../modules/names";

const { getPref } = prefs;

let root: HTMLElement;
let toggleEl: HTMLButtonElement | undefined;
let bodyEl: HTMLElement;

/** header tabs: one instance of each view's state; switching hides, never destroys */
export type Tab = (typeof WORKBENCH_MODULES)[number]["id"];
let tab: Tab = "tray";
type TabView = { element: HTMLElement; display: "" | "flex"; onShown?: () => void; onHidden?: () => void };
const tabViews = new Map<Tab, TabView>();
const hiddenTabs = new Set<Tab>();
/** Non-core tabs a release build's registry does not list (`moduleListed`): no button, no view, no menu entry. */
const unlistedTabs = new Set<Tab>();
const tabOff = (id: Tab): boolean => hiddenTabs.has(id) || unlistedTabs.has(id);
type OptionalTab = "runelib" | "lab" | "changes" | "unreal" | "jira" | "notion" | "slack";
/** One entry per lazy-loaded optional tab: its loader, its mount, and the hooks the workbench calls. */
type OptionalSpec = {
  load: () => Promise<unknown>;
  mount: (view: never, parent: HTMLElement, note: (msg: string) => void) => HTMLElement;
  shown: (view: never) => () => void;
  hidden: (view: never) => () => void;
  dispose: (view: never) => () => void;
};
type OptionalModule = unknown;
/** Types each entry against its own module, then erases the module type for the shared table. */
const spec = <M>(s: {
  load: () => Promise<M>;
  mount: (view: M, parent: HTMLElement, note: (msg: string) => void) => HTMLElement;
  shown: (view: M) => () => void;
  hidden: (view: M) => () => void;
  dispose: (view: M) => () => void;
}): OptionalSpec => s as unknown as OptionalSpec;
const OPTIONAL_TABS: Record<OptionalTab, OptionalSpec> = {
  runelib: spec({
    load: () => import("./runes"),
    mount: (v, parent, note) => v.mountRunesView(parent, openInDocument, note),
    shown: (v) => v.onRunesShown,
    hidden: (v) => v.onRunesHidden,
    dispose: (v) => v.disposeRunesView,
  }),
  lab: spec({
    load: () => import("./lab"),
    mount: (v, parent, note) => v.mountLabView(parent, note),
    shown: (v) => v.onLabShown,
    hidden: (v) => v.onLabHidden,
    dispose: (v) => v.disposeLabView,
  }),
  changes: spec({
    load: () => import("./changes"),
    mount: (v, parent) => v.mountChangesView(parent),
    shown: (v) => v.onChangesShown,
    hidden: (v) => v.onChangesHidden,
    dispose: (v) => v.disposeChangesView,
  }),
  unreal: spec({
    load: () => import("./unreal"),
    mount: (v, parent) => v.mountUnrealView(parent),
    shown: (v) => v.onUnrealShown,
    hidden: (v) => v.onUnrealHidden,
    dispose: (v) => v.disposeUnrealView,
  }),
  jira: spec({
    load: () => import("./jira"),
    mount: (v, parent) => v.mountJiraView(parent),
    shown: (v) => v.onJiraShown,
    hidden: (v) => v.onJiraHidden,
    dispose: (v) => v.disposeJiraView,
  }),
  notion: spec({
    load: () => import("./notion"),
    mount: (v, parent) => v.mountNotionView(parent),
    shown: (v) => v.onNotionShown,
    hidden: (v) => v.onNotionHidden,
    dispose: (v) => v.disposeNotionView,
  }),
  slack: spec({
    load: () => import("./slack"),
    mount: (v, parent) => v.mountSlackView(parent),
    shown: (v) => v.onSlackShown,
    hidden: (v) => v.onSlackHidden,
    dispose: (v) => v.disposeSlackView,
  }),
};
const optionalGenerations = new Map<OptionalTab, number>();
const optionalModules = new Map<OptionalTab, OptionalModule>();
const optionalDisposers = new Map<OptionalTab, () => void>();
let pendingTab: OptionalTab | undefined;
let shown = false;

let fillEl: HTMLElement | undefined;
let modulesChangeListener: (() => void) | undefined;
let unsubscribeRegistry: (() => void) | undefined;
let unsubscribeNames: (() => void) | undefined;

/** The name a bench tab shows: the user's, else the contract label. */
function benchLabel(id: Tab): string {
  return moduleName(id, WORKBENCH_MODULES.find((entry) => entry.id === id)!.label);
}

/** Re-applies the current names to the tab buttons: span text, title, aria-label only (the icon stays). */
function relabelTabs() {
  root.querySelectorAll<HTMLButtonElement>(".wb-tab").forEach((button) => {
    const name = benchLabel(button.dataset.tab as Tab);
    const text = button.querySelector("span");
    if (text) text.textContent = name;
    button.title = name;
    button.setAttribute("aria-label", name);
  });
  placeFill(false);
}

function setSavedVisibility(id: Tab, visible: boolean) {
  const key = `bench:${id}`;
  const hidden = getPref("modules.hidden") ?? [];
  const next = visible ? hidden.filter((entry) => entry !== key) : [...hidden, key];
  if (prefs.setPref("modules.hidden", next)) document.dispatchEvent(new CustomEvent("vidar-modules-change"));
}

function tabMenuActions(clicked?: Tab): ModuleMenuAction[] {
  const actions: ModuleMenuAction[] = [];
  const selected = WORKBENCH_MODULES.find((entry) => entry.id === clicked);
  if (selected && selected.level !== "core" && !unlistedTabs.has(selected.id)) {
    const savedHidden = hiddenTabs.has(selected.id);
    actions.push({ label: `${savedHidden ? "Show" : "Hide"} ${benchLabel(selected.id)}`,
      kind: savedHidden ? "show" : "hide", level: selected.level,
      onSelect: () => setSavedVisibility(selected.id, savedHidden) });
  }
  for (const module of WORKBENCH_MODULES) {
    if (module.id === clicked || !hiddenTabs.has(module.id) || unlistedTabs.has(module.id)) continue;
    actions.push({ label: `Show ${benchLabel(module.id)}`, kind: "show",
      onSelect: () => setSavedVisibility(module.id, true) });
  }
  actions.push({ label: "Modules…", kind: "manage",
    onSelect: () => { void import("../settings/modal").then(({ openShortcutsModal }) => openShortcutsModal("modules")); } });
  return actions;
}

/** Puts the sliding fill behind the current tab. `animate` false jumps (mount, reorder, resize):
 *  the inline `transition: none` is cleared after a forced reflow so the next switch glides. */
function placeFill(animate: boolean) {
  const cur = root?.querySelector<HTMLElement>('.wb-tab[aria-current="true"]');
  if (!fillEl || !cur) return;
  const track = cur.parentElement!;
  if (!animate) fillEl.style.transition = "none";
  fillEl.style.transform = `translateX(${cur.offsetLeft}px)`;
  fillEl.style.width = `${cur.offsetWidth}px`;
  const left = cur.offsetLeft;
  const right = left + cur.offsetWidth;
  if (left < track.scrollLeft) track.scrollTo({ left, behavior: animate ? "smooth" : "auto" });
  else if (right > track.scrollLeft + track.clientWidth) {
    track.scrollTo({ left: right - track.clientWidth, behavior: animate ? "smooth" : "auto" });
  }
  if (!animate) {
    void fillEl.offsetWidth;
    fillEl.style.transition = "";
  }
}

function syncTabControls() {
  root.querySelectorAll<HTMLButtonElement>(".wb-tab").forEach((button) => {
    const id = button.dataset.tab as Tab;
    button.style.display = unlistedTabs.has(id) || (hiddenTabs.has(id) && id !== tab) ? "none" : "";
  });
}

/** Every selection path passes here. Only an external open may reveal a saved-hidden required tab. */
function setTab(next: Tab, external = false): boolean {
  const module = WORKBENCH_MODULES.find((entry) => entry.id === next);
  if (!module || unlistedTabs.has(next)) return false;
  if (hiddenTabs.has(next) && (module.level === "optional" || !external)) return false;
  if (!tabViews.has(next)) {
    if (module.level !== "optional") return false;
    pendingTab = next as OptionalTab;
    return true;
  }
  pendingTab = undefined;
  if (next === tab) { syncTabControls(); return true; }
  // Document flushes its scroll save even when the pane is closed.
  // The popover card is a document.body child now, so it needs an
  // explicit hide when Flow stops being the shown tab (display:none on #flow-view no longer covers it).
  if (shown || tab === "doc") tabViews.get(tab)?.onHidden?.();
  tab = next;
  syncTabControls();
  root.querySelectorAll<HTMLButtonElement>(".wb-tab").forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  });
  placeFill(true);
  for (const module of WORKBENCH_MODULES) {
    const view = tabViews.get(module.id);
    if (view) view.element.style.display = module.id === tab ? view.display : "none";
  }
  if (shown) tabViews.get(tab)?.onShown?.();
  return true;
}

/** File blocks with a document extension open in the Document tab; the path is
 *  always re-read — the tray preview is never treated as the document. */
async function openInDocument(path: string) {
  setTab("doc", true);
  const ok = await openDocumentPath(path);
  if (!ok) note(`Open Failed — See the ${benchLabel("doc")} Tab`);
}

/** Builds the pane into `parent` (hidden) plus the bench toggle at the top of the right rail. */
export function mountWorkbench(parent: HTMLElement, on: { open: () => void; collapse: () => void }) {
  tab = "tray";
  shown = false;
  fillEl = undefined;
  tabViews.clear();
  hiddenTabs.clear();
  unlistedTabs.clear();
  optionalDisposers.clear();
  pendingTab = undefined;
  for (const id of getPref("modules.hidden") ?? []) {
    const module = WORKBENCH_MODULES.find((entry) => `bench:${entry.id}` === id);
    if (module && module.level !== "core") hiddenTabs.add(module.id);
  }
  // main.ts mounts the bench after loadModules settles, so a release set's unlisted tabs never paint.
  for (const module of WORKBENCH_MODULES) {
    if (module.level !== "core" && !moduleListed(module.id)) unlistedTabs.add(module.id);
  }
  root = document.createElement("section");
  root.id = "workbench";
  root.tabIndex = -1; // focusable: paste lands here once the pane is clicked
  // Relay and Tray are icon-only to give the bar width back; the name stays in title and aria-label
  // (2026-10-16 Relay, 2026-10-17 Tray)
  const iconOnly = new Set(["relay", "tray"]);
  const buttons = WORKBENCH_MODULES.map(({ id }) => {
    const button = document.createElement("button");
    button.className = "wb-tab";
    if (id === "tray") button.setAttribute("aria-current", "true");
    button.dataset.tab = id;
    if (!iconOnly.has(id)) button.append(document.createElement("span"));
    return button;
  });
  root.innerHTML = `
    <div id="workbench-head">
      <div id="wb-tabs">
        <span id="wb-fill"></span>
      </div>
    </div>
    <div id="workbench-body"></div>`;
  root.querySelector<HTMLElement>("#wb-tabs")!.append(...buttons);
  bodyEl = root.querySelector<HTMLElement>("#workbench-body")!;
  tabViews.set("tray", { element: bodyEl, display: "" });
  // the fixture runner (dev) needs the tab on screen: open the pane on Document
  const docViewEl = mountDocumentView(root, viewNote("doc"), () => { if (setTab("doc", true)) revealWorkbench(); });
  tabViews.set("doc", { element: docViewEl, display: "flex", onShown: onDocumentShown, onHidden: onDocumentHidden });
  // A throw here (e.g. a stored graph the code no longer understands) used to abort this mount
  // before expandEl was set, which broke every later tab open: contain it to Flow.
  try {
    const flowViewEl = mountFlowView(root, openInDocument);
    tabViews.set("flow", { element: flowViewEl, display: "flex", onShown: onFlowShown, onHidden: onFlowHidden });
  } catch (err) {
    console.error("flow view failed to mount", err);
    const flowViewEl = document.createElement("div");
    flowViewEl.className = "flow-mount-error";
    flowViewEl.textContent = `${benchLabel("flow")} couldn't load. Details are in the DevTools console.`;
    (bodyEl.parentElement ?? root).appendChild(flowViewEl);
    tabViews.set("flow", { element: flowViewEl, display: "flex", onShown: onFlowShown, onHidden: onFlowHidden });
  }
  for (const id of OPTIONAL_SURFACE_IDS) {
    if (id in OPTIONAL_TABS && !tabOff(id as OptionalTab)) mountOptionalTab(id as OptionalTab);
  }
  // an unread relay item while Relay is not on screen swaps its icon to the bell, as the left bar's
  // relay button does; no dot, which widened the tab (2026-10-04)
  // icons first: the relay notify below may fire during its mount
  root.querySelectorAll<HTMLButtonElement>(".wb-tab").forEach((b) => {
    const kind = (b.dataset.tab as Tab) ?? "tray";
    b.dataset.key = kind;
    b.prepend(tabIcon(kind)); // icon before the label
    onPress(b, () => setTab(kind));
  });
  syncTabControls();
  const relayIcon = root.querySelector<HTMLImageElement>('.wb-tab[data-tab="relay"] img.icn')!;
  const relayViewEl = mountRelayTab(root, (unseen) => {
    relayIcon.src = `/icons/color/${unseen ? "relay-alert" : "relay"}.svg`;
  });
  tabViews.set("relay", { element: relayViewEl, display: "flex", onShown: onRelayShown, onHidden: onRelayHidden });
  if (tabOff("tray")) setTab("relay");
  const track = root.querySelector<HTMLElement>("#wb-tabs")!;
  const head = root.querySelector<HTMLElement>("#workbench-head")!;
  head.tabIndex = 0;
  head.setAttribute("aria-label", "Bench Tabs");
  head.setAttribute("aria-haspopup", "menu");
  root.querySelectorAll<HTMLButtonElement>(".wb-tab").forEach((button) => button.setAttribute("aria-haspopup", "menu"));
  const openTabMenu = (event: MouseEvent | KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>(".wb-tab");
    const actions = tabMenuActions(button?.dataset.tab as Tab | undefined);
    event.preventDefault();
    if (!actions.length) return;
    if (event instanceof MouseEvent) {
      openModuleContextMenu(button ?? head, actions, { x: event.clientX, y: event.clientY });
      return;
    }
    openModuleContextMenu(button ?? head, actions);
    const menu = document.querySelector<HTMLElement>(".module-context-menu")!;
    const edge = head.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(edge.left + 8, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, edge.top - menu.offsetHeight - 8)}px`;
  };
  head.addEventListener("contextmenu", openTabMenu);
  head.addEventListener("keydown", (event) => {
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) openTabMenu(event);
  });
  fillEl = root.querySelector<HTMLElement>("#wb-fill")!;
  applyOrder(track, "order.workbenchTabs");
  enableReorder(track, "order.workbenchTabs", { handle: ".wb-tab", axis: "x",
    visible: (row) => !tabOff(row.dataset.key as Tab) });
  if (modulesChangeListener) document.removeEventListener("vidar-modules-change", modulesChangeListener);
  unsubscribeRegistry?.();
  unsubscribeNames?.();
  modulesChangeListener = () => {
    syncWorkbenchTabVisibility();
    applyOrder(track, "order.workbenchTabs");
    placeFill(false);
  };
  document.addEventListener("vidar-modules-change", modulesChangeListener);
  relabelTabs();
  unsubscribeNames = onModuleNamesChange(relabelTabs);
  // A registry reload (or a release build's dead-dep re-resolve) can change which tabs are listed.
  unsubscribeRegistry = onModulesChange(modulesChangeListener);
  // Re-place without animating after any reorder (applyOrder, a drag's insertBefore) and on resize;
  // the pane mounts hidden, so the first real size also arrives through the observer.
  new MutationObserver(() => placeFill(false)).observe(track, { childList: true });
  new ResizeObserver(() => placeFill(false)).observe(track);
  placeFill(false);
  // "Click the pane, Ctrl+V" must not depend on nearest-focusable-ancestor
  // behaviour: focus the root on a background mousedown, leaving buttons and
  // text selection alone.
  root.addEventListener("mousedown", (e) => {
    const t = e.target as Element;
    if (t.closest("button, input, textarea, a, #bottombar")) return; // the docked bottom bar is not the pane (sessions/bottombar-dock.ts)
    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
  });
  root.addEventListener("paste", onPaste);
  parent.appendChild(root);

  // The toggle is the first child of #toolbench, before #tool-grid: toolbench.ts only fills and reorders
  // the grid, so it never clears or moves this button. Rebuilt on a remount.
  toggleEl?.remove();
  toggleEl = document.createElement("button");
  toggleEl.id = "wb-toggle";
  toggleEl.type = "button";
  toggleEl.className = "tool-btn rail-btn";
  const toggleIcon = document.createElement("img");
  toggleIcon.className = "icn";
  toggleIcon.alt = "";
  toggleIcon.draggable = false;
  toggleIcon.setAttribute("aria-hidden", "true");
  toggleEl.append(toggleIcon);
  toggleEl.addEventListener("click", () => (shown ? on.collapse() : on.open()));
  const toolbench = document.getElementById("toolbench");
  toolbench?.insertBefore(toggleEl, toolbench.firstChild);
  syncToggle();
  root.style.display = "none"; // initial state; setWorkbenchShown skips an unchanged state

  // OS file drops: Tauri's native handler owns them on Windows (HTML5 drop
  // never sees paths). Position is client-relative physical pixels; the
  // hit-test runs on the drop itself, not the last `over`.
  getCurrentWebview()
    .onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type === "over") root.classList.toggle("wb-dropping", hit(p.position));
      else if (p.type === "leave") root.classList.remove("wb-dropping");
      else if (p.type === "drop") {
        root.classList.remove("wb-dropping");
        if (hit(p.position)) dropPaths(p.paths);
      }
    })
    .catch((e) => note(`Drop Unavailable: ${e}`));

  // Binds the tray and rebuilds whatever survived from the last run.
  mountTray(bodyEl, { note: (msg, landed) => note(msg, "tray", landed), openInDocument, revealWorkbench, trayActive: () => tab === "tray" });
}

function hit(pos: { x: number; y: number }): boolean {
  if (root.style.display === "none") return false;
  const r = root.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const s = window.devicePixelRatio || 1;
  const x = pos.x / s, y = pos.y / s;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** The rail toggle's icon, title and aria-label follow `shown`. */
function syncToggle() {
  if (!toggleEl) return;
  const label = shown ? "Collapse Bench" : "Open Bench";
  toggleEl.title = `${label} (Ctrl+\\)`;
  toggleEl.setAttribute("aria-label", label);
  toggleEl.querySelector("img")!.src = `/icons/color/bench-${shown ? "collapse" : "expand"}.svg`; // Fluent arrow square, turned (2026-10-18)
}

/** Called from sessions.ts layout(): the pane and the rail toggle follow the same flag. */
export function setWorkbenchShown(next: boolean) {
  if (next === shown) return;
  if (!next && shown) tabViews.get(tab)?.onHidden?.();
  shown = next;
  root.style.display = next ? "flex" : "none";
  syncToggle();
  if (!next) root.classList.remove("wb-dropping");
  if (next) tabViews.get(tab)?.onShown?.();
}

/** Tools call this after a successful add: show the pane without moving focus
 *  or the terminal destination (openWorkbench renders with refocus=false). */
export function revealWorkbench() {
  if (!isWorkbenchOpen()) openWorkbench();
}

/** Control verbs (`ctl.show --focus`): reveal the pane on a named sub-tab, not
 *  whichever one was last active. */
export function revealWorkbenchTab(next: Tab) {
  if (!setTab(next, true)) return false;
  revealWorkbench();
  return true;
}

function mountOptionalTab(id: OptionalTab) {
  const generation = (optionalGenerations.get(id) ?? 0) + 1;
  optionalGenerations.set(id, generation);
  const mountRoot = root;
  const mountLoaded = (view: OptionalModule) => {
    if (optionalGenerations.get(id) !== generation || tabOff(id) || root !== mountRoot) return;
    try {
      const entry = OPTIONAL_TABS[id];
      const element = entry.mount(view as never, root, viewNote(id));
      keepAboveBar(element);
      const onShown = entry.shown(view as never);
      const onHidden = entry.hidden(view as never);
      optionalDisposers.set(id, entry.dispose(view as never));
      tabViews.set(id, { element, display: "flex", onShown, onHidden });
      if (pendingTab === id) setTab(id);
      else element.style.display = "none";
    } catch (err) {
      mountOptionalError(id, err);
    }
  };
  const loaded = optionalModules.get(id);
  if (loaded) mountLoaded(loaded);
  else void OPTIONAL_TABS[id].load()
    .then((view) => { optionalModules.set(id, view); mountLoaded(view); })
    .catch((err) => {
      if (optionalGenerations.get(id) !== generation || tabOff(id) || root !== mountRoot) return;
      mountOptionalError(id, err);
    });
}

/** sessions.ts docks the mini bar (#bottombar) as the last child of #workbench (sessions/bottombar-dock.ts).
 *  A view mounted after that (a module turned on, a chunk that loaded late) appended below the bar, so the
 *  bar rose to the tabs and the view filled the space under it: move the view back above the bar. */
function keepAboveBar(element: HTMLElement) {
  const bar = root.querySelector<HTMLElement>(":scope > #bottombar");
  if (bar && element.parentElement === root && bar.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
    root.insertBefore(element, bar);
  }
}

function mountOptionalError(id: OptionalTab, err: unknown) {
  console.error(`${id} view failed to mount`, err);
  const element = document.createElement("div");
  element.className = "flow-mount-error";
  element.textContent = `${benchLabel(id)} couldn't load. Details are in the DevTools console.`;
  (bodyEl.parentElement ?? root).appendChild(element);
  keepAboveBar(element);
  tabViews.set(id, { element, display: "flex" });
  if (pendingTab === id) setTab(id);
  else element.style.display = "none";
}

/** Apply a visibility choice to this pane; persistence is owned by the caller. */
export function setWorkbenchTabVisibility(id: Tab, visible: boolean): boolean {
  const module = WORKBENCH_MODULES.find((entry) => entry.id === id);
  if (!module || (module.level === "core" && !visible)) return false;
  if (visible) hiddenTabs.delete(id);
  else hiddenTabs.add(id);
  applyTabState(module);
  return true;
}

/** Mounts or tears down one tab's view to match its saved-hidden and unlisted state. */
function applyTabState(module: (typeof WORKBENCH_MODULES)[number]) {
  const id = module.id;
  const visible = !tabOff(id);
  if (module.level === "optional") {
    const optionalId = id as OptionalTab;
    if (visible && !tabViews.has(id)) void mountOptionalTab(optionalId);
    if (!visible) {
      optionalGenerations.set(optionalId, (optionalGenerations.get(optionalId) ?? 0) + 1);
      if (pendingTab === optionalId) pendingTab = undefined;
    }
    if (!visible && tabViews.has(id)) {
      if (tab === id) setTab("relay");
      optionalDisposers.get(optionalId)?.();
      optionalDisposers.delete(optionalId);
      tabViews.get(id)?.element.remove();
      tabViews.delete(id);
    }
  } else if (!visible && tab === id) setTab("relay");
  syncTabControls();
  placeFill(false);
}

/** Reconcile after a confirmed or pending preference change or a registry change, without writing state. */
export function syncWorkbenchTabVisibility() {
  const hidden = new Set(getPref("modules.hidden") ?? []);
  for (const module of WORKBENCH_MODULES) {
    const shouldHide = module.level !== "core" && hidden.has(`bench:${module.id}`);
    if (hiddenTabs.has(module.id) !== shouldHide) setWorkbenchTabVisibility(module.id, !shouldHide);
    const unlisted = module.level !== "core" && !moduleListed(module.id);
    if (unlistedTabs.has(module.id) === unlisted) continue;
    if (unlisted) unlistedTabs.add(module.id);
    else unlistedTabs.delete(module.id);
    applyTabState(module);
  }
}

function viewNote(from: Tab): (msg: string) => void {
  return (msg) => note(msg, from);
}

/** Head notes are toasts now (the head has no note slot); `from` and `landed` stay so callers don't change. */
function note(msg: string, _from?: Tab, _landed = false) {
  if (msg) showSessionsToast(msg, 4000);
}
