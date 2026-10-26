// Tab strip: each tab's button (wheel, close, click/rename/menu handlers), strip order and drag,
// the tab context menu, and rename. sessions.ts binds its tab map, view state and actions in.
import { trapMenu } from "../../modules/context-menu";
import { onPress } from "../press";
import dualViewIcon from "../../assets/dual-view.png";
import singleViewIcon from "../../assets/single-view.png";
import terminalIcon from "../../assets/terminal.png";
import { armAstra, armBlocker, disarmAstra, isArmed } from "./astra-bridge";
import { saveCodexTabs } from "./codex-save";
import { hostedNames } from "../../launcher/hosted-names-pref";
import { hostedFalconSession } from "./lookup";
import { forgetPair } from "./pair";
import { buildRightColumn, tabRowSlot } from "./tab-row-paint";
import { tabTitleCase } from "./tab-state-format";
import { initTabAgents, moveTabFamily } from "./tab-agents";
export { resolveBodyKind } from "./body-kind";
import type { LaunchOpts, TerminalSession } from "./types";

export interface TabStripDeps {
  sessions: ReadonlyMap<string, TerminalSession>;
  /** sessions.ts's live view state, read at call time */
  view: () => { visible: string[]; activeId: string | null; workbenchOpen: boolean };
  activate: (id: string) => void;
  closeSession: (id: string) => void;
  openDual: (id: string) => void;
  openWorkbench: () => void;
  collapseWorkbench: () => void;
  jettisonSession: (id: string) => Promise<unknown>;
  closeHostedTab: (id: string) => Promise<void>;
  dispatchFocus: () => void;
  focusBody: (s: TerminalSession | undefined) => void;
}

let sessions: TabStripDeps["sessions"] = new Map();
let view: TabStripDeps["view"];
let activate: TabStripDeps["activate"];
let closeSession: TabStripDeps["closeSession"];
let openDual: TabStripDeps["openDual"];
let openWorkbench: TabStripDeps["openWorkbench"];
let collapseWorkbench: TabStripDeps["collapseWorkbench"];
let jettisonSession: TabStripDeps["jettisonSession"];
let closeHostedTab: TabStripDeps["closeHostedTab"];
let dispatchFocus: TabStripDeps["dispatchFocus"];
let focusBody: TabStripDeps["focusBody"];
let stripEl: HTMLElement;
let disposeTabAgents: (() => void) | undefined;

/** sessions.ts, at load: the tab map, view state and actions the strip calls back into. */
export function bindTabStrip(deps: TabStripDeps) {
  ({ sessions, view, activate, closeSession, openDual, openWorkbench, collapseWorkbench, jettisonSession, closeHostedTab, dispatchFocus, focusBody } = deps);
}

/** initSessions: the strip element tab buttons live in. */
export function initTabStrip(strip: HTMLElement) {
  disposeTabAgents?.();
  disposeKeepInView?.();
  stripEl = strip;
  disposeTabAgents = initTabAgents(strip, sessions, (id) => activate(id));
  disposeKeepInView = keepActiveInView();
}

/** Set while a press on a strip tab runs activate(): that tab is under the pointer already. */
let pressedTab: string | null = null;
let disposeKeepInView: (() => void) | undefined;

/** The active tab scrolls into the strip when it changes by other means than a press (cycling, a
 *  new tab); a dispatch with the same id never fights a manual scroll. Moves only the strip's scrollTop. */
function keepActiveInView(): () => void {
  let lastId: string | null = view?.().activeId ?? null;
  const onFocus = () => {
    const id = view().activeId;
    if (id === lastId) return;
    lastId = id;
    if (id === pressedTab) return;
    const button = id ? sessions.get(id)?.button : undefined;
    if (!button) return;
    requestAnimationFrame(() => {
      if (!button.isConnected || !stripEl.contains(button)) return;
      const s = stripEl.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      if (b.top < s.top) stripEl.scrollTop += b.top - s.top;
      else if (b.bottom > s.bottom) stripEl.scrollTop += b.bottom - s.bottom;
    });
  };
  document.addEventListener("vidar-focus", onFocus);
  return () => document.removeEventListener("vidar-focus", onFocus);
}

/** createSession: the tab's strip button, appended to the strip with its handlers and drag. */
export function buildTabButton(id: string, opts: LaunchOpts | undefined, counter: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "bar-btn session-btn";
  const title = opts?.title ?? `Session ${counter}`;
  button.title = title;
  // Tab art instead of a digit (CAS wheel; OpenAI mark for Codex, via CSS on
  // data-agent). Active = scale + ring; armed = kind-tinted art. Identity
  // lives in the tooltip and the .tab-title slot (row line one); .tab-sub is line two.
  const face = document.createElement("span");
  face.className = "tab-face";
  const wheel = document.createElement("span");
  wheel.className = "session-wheel";
  face.appendChild(wheel);
  button.appendChild(face);
  const titleEl = document.createElement("span");
  titleEl.className = "tab-title";
  titleEl.textContent = tabTitleCase(title); // display only; button.title keeps the stored name
  button.appendChild(titleEl);
  const sub = document.createElement("span");
  sub.className = "tab-sub";
  sub.appendChild(tabRowSlot("tab-model")); // line two: the model, or empty
  button.appendChild(sub);
  button.appendChild(buildRightColumn());
  const close = document.createElement("span");
  close.className = "session-close";
  close.setAttribute("role", "button");
  close.setAttribute("aria-label", "Close Tab");
  close.title = "Close Tab"; // the X is a CSS mask (leftbar.css .session-close)
  close.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeSession(id);
  });
  // a press on the X is a close, never a select: keep it from reaching the button's press handler
  close.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  button.appendChild(close);
  // A press (or keyboard click) shows this tab, beside its sticky-pair mate when it has one; the
  // menu's Single-View is how you leave dual-view for good. A fresh press clears the post-drag flag
  // first (capture runs before the press handler), so a stale flag never eats a select.
  button.addEventListener("pointerdown", () => { delete button.dataset.dragged; }, true);
  onPress(button, () => {
    // the click that lands after a drag is the drop, not a select
    if (button.dataset.dragged) {
      delete button.dataset.dragged;
      return;
    }
    pressedTab = id;
    try { activate(id); } finally { pressedTab = null; }
  });
  // acting on pointerdown would let the default mousedown move focus back to this button,
  // away from the pane activate() just focused
  button.addEventListener("mousedown", (ev) => ev.preventDefault());
  button.addEventListener("dblclick", () => beginRename(id));
  button.addEventListener("contextmenu", (ev) => {
    ev.preventDefault(); // suppress the WebView2 context menu
    openTabMenu(id, button);
  });
  button.dataset.id = id;
  stripEl.appendChild(button);
  attachTabDrag(button);
  return button;
}

/* ---- tab order ----
   The strip's DOM order is the one source of truth (drag reorders it); the
   `sessions` Map keeps creation order and must not be used for anything the
   user reads as "next to". */
export function orderedIds(): string[] {
  return [...stripEl.querySelectorAll<HTMLElement>(".session-btn")].map((b) => b.dataset.id!);
}

// Pointer drag along the strip. Pointer events, not HTML5 DnD: WebView2's
// native drag image and drop-zone handshake fight the click/dblclick/context
// handlers on the same button, and a translate follows the pointer exactly.
// The button is moved in the DOM as the pointer crosses sibling midpoints;
// the translate is re-based on its new layout slot so it never jumps.
const DRAG_SLOP = 4;
function attachTabDrag(button: HTMLButtonElement) {
  let startY = 0;
  let baseTop = 0;
  let moved = false;
  let active = false;
  button.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || (ev.target as HTMLElement).classList.contains("session-close")) return;
    active = true;
    moved = false;
    startY = ev.clientY;
    baseTop = button.offsetTop;
    button.setPointerCapture(ev.pointerId);
  });
  button.addEventListener("pointermove", (ev) => {
    if (!active) return;
    const dy = ev.clientY - startY;
    if (!moved) {
      if (Math.abs(dy) < DRAG_SLOP) return;
      moved = true;
      button.classList.add("dragging");
    }
    const parents = [...stripEl.children].filter((c) => c.classList.contains("session-btn")) as HTMLElement[];
    const siblings = parents.filter((c) => c !== button);
    // siblings aren't transformed, so their client rects are their layout slots
    let target = siblings.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return ev.clientY < r.top + r.height / 2;
    });
    if (target < 0) target = siblings.length;
    const current = parents.indexOf(button);
    if (target !== current) moveTabFamily(button, siblings[target] ?? null);
    // offsetTop is layout-only (ignores transform): pointer travel minus how far
    // the slot itself moved keeps the button under the finger across reorders
    button.style.transform = `translateY(${dy - (button.offsetTop - baseTop)}px)`;
  });
  const end = (ev: PointerEvent) => {
    if (!active) return;
    active = false;
    if (button.hasPointerCapture(ev.pointerId)) button.releasePointerCapture(ev.pointerId);
    if (!moved) return;
    button.classList.remove("dragging");
    button.style.transform = "";
    button.dataset.dragged = "1"; // the trailing click is swallowed
    saveCodexTabs(); // strip order
  };
  button.addEventListener("pointerup", end);
  button.addEventListener("pointercancel", end);
}

let tabMenu: HTMLElement | null = null;
/** the tab id `tabMenu` is currently showing rows for, if open — lets
 *  `removeSessionView` hide an orphaned menu (a losing duplicate close can
 *  reopen it on a button the winning close then removes). */
let tabMenuFor: string | null = null;
let releaseTabTrap: (() => void) | undefined;
let tabMenuAnchor: HTMLElement | null = null;
/** what had focus before the menu opened; Escape returns there */
let tabMenuReturn: HTMLElement | null = null;

/** The one hide path: drops the key/focus trap and, when `restore`, returns focus to the opener. */
function hideTabMenu(restore = false) {
  releaseTabTrap?.();
  releaseTabTrap = undefined;
  tabMenu?.classList.add("hidden");
  tabMenuFor = null;
  const back = tabMenuReturn;
  tabMenuReturn = null;
  if (restore) (back?.isConnected ? back : tabMenuAnchor?.isConnected ? tabMenuAnchor : null)?.focus();
}

/** removeSessionView: hide the menu when it is showing rows for id. */
export function dismissTabMenuFor(id: string) {
  if (tabMenuFor === id) hideTabMenu();
}

export function openTabMenu(id: string, anchor: HTMLElement) {
  const { visible, activeId, workbenchOpen } = view();
  const reopening = tabMenuFor !== null; // keep the first opener's focus target across a re-open
  tabMenuFor = id;
  tabMenuAnchor = anchor;
  if (!reopening) {
    const focused = document.activeElement;
    tabMenuReturn = focused instanceof HTMLElement && !tabMenu?.contains(focused) ? focused : null;
  }
  releaseTabTrap?.();
  releaseTabTrap = undefined;
  if (!tabMenu) {
    tabMenu = document.createElement("div");
    tabMenu.id = "tab-menu";
    tabMenu.className = "hidden";
    document.body.appendChild(tabMenu);
  }
  tabMenu.innerHTML = "";

  const row = (icon: string, text: string, onPick: () => void, keepOpen = false) => {
    const b = document.createElement("button");
    b.className = "menu-icon-row";
    const ico = document.createElement("span");
    ico.className = "menu-icon";
    ico.style.setProperty("--menu-icon", `url("${icon}")`);
    const label = document.createElement("span");
    label.textContent = text;
    b.append(ico, label);
    b.addEventListener("click", () => {
      if (!keepOpen) hideTabMenu();
      onPick();
    });
    tabMenu!.appendChild(b);
    return b;
  };

  const split = visible.length > 1;
  const besideWorkbench = workbenchOpen && visible.includes(id);
  if (split && visible.includes(id)) {
    // Offered on the pane you want to KEEP — it collapses to this one.
    row(singleViewIcon, "Single-View", () => { forgetPair(); activate(id); });
  } else if (besideWorkbench) {
    // A plain tab click keeps the workbench (it swaps the terminal side);
    // Single-View is the explicit "just the terminal".
    row(singleViewIcon, "Single-View", () => { forgetPair(); activate(id); collapseWorkbench(); });
  } else {
    // Needs another session to sit beside, and pairing a tab with itself is a
    // no-op — so the focused tab can't offer it either.
    const dual = row(dualViewIcon, "Dual-View", () => openDual(id));
    dual.disabled = sessions.size < 2 || id === activeId;
  }
  if (!besideWorkbench) {
    row(dualViewIcon, "Workbench", () => { activate(id); openWorkbench(); });
  }

  // Astra: Codex tabs only. Disabled with the reason when the tab doesn't
  // qualify (approvals must be off — see the bridge comment above).
  if (sessions.get(id)?.agent === "codex") {
    const blocker = armBlocker(id);
    const arm = isArmed(id)
      ? row(terminalIcon, "Disarm Astra", () => disarmAstra())
      : row(terminalIcon, blocker ? `Arm as Astra — ${blocker}` : "Arm as Astra", () => { armAstra(id); });
    if (!isArmed(id) && blocker) arm.disabled = true;
  }

  // Rendered tabs: Jettison and Close only (2026-10-04). Raw and page tabs get no
  // row here; Jettison is the only detach.
  const s = sessions.get(id);
  if (s && s.body === "rendered") {
    const hosted = !!s.falconSession || !!s.rendered?.hosted();
    if (hosted) {
      row(terminalIcon, "Jettison to Falcon", () => { void jettisonSession(id); });
      row(terminalIcon, "Close Session", () => { void closeHostedTab(id); });
      if (s.closeError) {
        const message = s.closeError.length > 96 ? `${s.closeError.slice(0, 95)}…` : s.closeError;
        const failure = row(terminalIcon, `Failed — ${message}`, () => {});
        failure.disabled = true;
        failure.title = s.closeError;
      }
    }
  }

  tabMenu.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  // off the left bar's edge, not the tab's: the bar is wider than the tab (see openLauncher)
  const bar = document.getElementById("leftbar")?.getBoundingClientRect();
  tabMenu.style.left = `${Math.max(r.right, bar?.right ?? 0) + 6}px`;
  tabMenu.style.top = `${Math.min(r.top, window.innerHeight - tabMenu.offsetHeight - 8)}px`;
  const menuEl = tabMenu;
  const enabledRows = () => [...menuEl.querySelectorAll<HTMLElement>("button:not(:disabled)")];
  enabledRows()[0]?.focus();
  releaseTabTrap = trapMenu(menuEl, enabledRows, hideTabMenu);
}

/* ---- session rename (window.prompt is dead in WebView2 — tauri#4783) ----
   Renaming retargets the tooltip and the inspect-mode label only; tabs show
   the CAS wheel alone, with no caption under it. */

function beginRename(id: string) {
  const s = sessions.get(id);
  if (!s || document.getElementById("rename-input")) return;
  const input = document.createElement("input");
  input.id = "rename-input";
  input.spellcheck = false;
  const r = s.button.getBoundingClientRect();
  const bar = document.getElementById("leftbar")?.getBoundingClientRect();
  input.style.left = `${Math.max(r.right, bar?.right ?? 0) + 6}px`;
  input.style.top = `${r.top + 6}px`;
  input.value = s.button.title;
  document.body.appendChild(input);
  input.focus();
  input.select();
  let finished = false;
  const done = (commit: boolean) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (commit && name) {
      s.button.title = name;
      const titleSlot = s.button.querySelector(".tab-title");
      if (titleSlot) titleSlot.textContent = tabTitleCase(name);
      s.container.dataset.title = name;
      if (id === view().activeId) dispatchFocus(); // the workbench header shows the name
      saveCodexTabs();
      // a hosted Claude tab: the host keeps only the spawn-time name, so a swap re-adopt reads this one
      if (s.agent === "claude" && s.body === "rendered") {
        void (s.falconSession ? Promise.resolve(s.falconSession) : hostedFalconSession(id))
          .then((session) => hostedNames.remember(session, name));
      }
    }
    input.remove();
    focusBody(s);
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") done(true);
    else if (ev.key === "Escape") done(false);
  });
  input.addEventListener("blur", () => done(false));
}
