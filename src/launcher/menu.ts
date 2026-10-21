// src\launcher\menu.ts — the ＋ launcher menu: the type menu and the open/close. Split from
// main.ts; openLocations is passed in by initLauncherMenu, so this module never imports the
// flyouts that build on it. Flyout columns live in columns.ts, row builders in menu-rows.ts,
// the Falcon hosted row in hosted.ts.
import { focusActive } from "../panels/sessions";
import { onboardingOpen } from "../onboarding/shell";
import { resetHostedProbe, setHostedClose } from "./hosted";
import { resetRecentCache } from "./recent-cache";
import type { AgentType, Location } from "../config";
import { setWorkspaces, workspaces } from "./workspaces";
import { setRoster, shownKey, shownRoots, typeLabel, setCloseLauncher } from "./roster";
import { onDepsChange } from "../deps/state";
import { col, hideColsFrom, hoverOpen, launcherCols, setColumnRoot } from "./columns";
import { markFor, menuRow, onGatewayMarksChange } from "./menu-rows";

export interface LauncherMenuDeps {
  openLocations: (t: AgentType, anchor: HTMLElement, locations: Location[]) => void;
}
let openLocations: LauncherMenuDeps["openLocations"] = () => {};

export let newBtn: HTMLElement;
export let launcherMenu: HTMLDivElement;

// column 0 under its old name: Active and Add-new are modes of it and fill it in place
export let launcherSub: HTMLElement;

export function closeLauncher() {
  launcherMenu.classList.add("hidden");
  hideColsFrom(0);
  for (const c of launcherMenu.children) c.classList.remove("open");
  resetHostedProbe();
  resetRecentCache();
}

// Type rows. Hover (or click) slides the workspace flyout out beside the row.
export function buildTypeMenu(agents: AgentType[], locations: Location[]) {
  setRoster(agents);
  setWorkspaces(locations);
  renderTypeRows();
}

// The rows only: launcherTypes/variantsOf stay resolved from the unfiltered roster, and the
// dependency filter (shownRoots) is applied here on every render.
// shownKey() at the last render: onDepsChange compares against it.
let renderedKey: string | null = null;
function renderTypeRows() {
  renderedKey = shownKey();
  launcherMenu.innerHTML = "";
  for (const t of shownRoots()) {
    const b = menuRow(launcherMenu, typeLabel(t), markFor(`${t.id} ${t.label ?? ""}`));
    b.classList.add("has-sub");
    const open = () => openLocations(t, b, workspaces);
    // Chromium synthesises a mousemove (and so mouseenter) when layout puts
    // the menu under a resting pointer — that must not steal the row the
    // keyboard just selected. Cleared by a real pointer move (see kbNav).
    hoverOpen(b, 0, open);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      open();
    });
  }
}

// A new dependency report (or a failed detect) can hide or reveal rows. Only when the shown set of
// root/variant ids actually changed: close an open launcher first so no flyout points at a row that
// is gone, then redraw from the same resolved roster. A Re-check that changes nothing leaves an open
// launcher alone. Module-level, subscribed once. Before initLauncherMenu there is nothing to redraw;
// before the first buildTypeMenu launcherTypes is empty, which renders an empty menu as it did already.
onDepsChange(() => {
  if (!launcherMenu) return;
  if (shownKey() === renderedKey) return;
  if (!launcherMenu.classList.contains("hidden")) closeLauncher();
  renderTypeRows();
});

// Gateway art lands after the first render (module_art is async): redraw so those rows get their
// mark. Same close-first rule as above; the flyouts build on open and read the marks then.
onGatewayMarksChange(() => {
  if (!launcherMenu || renderedKey === null) return;
  if (!launcherMenu.classList.contains("hidden")) closeLauncher();
  renderTypeRows();
});

// Left click opens the launcher list — picking the shell is the common case,
// and a bare click that silently spawned powershell was the odd one out.
export function openLauncher() {
  if (onboardingOpen()) return; // onboarding gate: new sessions wait for the overlay
  const r = newBtn.getBoundingClientRect();
  // off the left bar's edge, not the button's: the bar (and a theme's border on it) is wider
  // than the button, and a button-anchored menu overlapped it by 3px
  const bar = document.getElementById("leftbar")?.getBoundingClientRect();
  launcherMenu.style.left = `${Math.max(r.right, bar?.right ?? 0) + 6}px`;
  launcherMenu.classList.remove("hidden");
  // New Session sits under the tab list, low in the bar: keep the menu on screen
  launcherMenu.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - launcherMenu.offsetHeight - 8))}px`;
}

export function initLauncherMenu(deps: LauncherMenuDeps): void {
  openLocations = deps.openLocations;
  newBtn = document.getElementById("new-session")!;
  launcherMenu = document.createElement("div");
  setColumnRoot(launcherMenu);
  launcherMenu.id = "launcher-menu";
  launcherMenu.className = "hidden";
  launcherSub = col(0);
  document.body.append(launcherMenu);
  setCloseLauncher(closeLauncher);
  setHostedClose(closeLauncher);
  newBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // else the document handler below closes it immediately
    if (!launcherMenu.classList.contains("hidden")) {
      closeLauncher();
      return;
    }
    openLauncher();
  });
  // Right click is claimed but inert: it's reserved for close options (close
  // others / close to the right / close all). Preventing default stops the
  // WebView2 context menu appearing in the meantime.
  newBtn.addEventListener("contextmenu", (e) => e.preventDefault());

  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (!launcherMenu.contains(t) && !launcherCols.some((c) => c.contains(t))) closeLauncher();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !launcherMenu.classList.contains("hidden")) {
      closeLauncher();
      focusActive(); // a keyboard-opened menu must hand focus back, not drop it on body
    }
  });
}
