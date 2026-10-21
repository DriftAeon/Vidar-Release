// Settings › Agents › Launcher Order: the launcher's root rows as a drag list, Loadout's row look and drag (panels/reorder.ts).
// The order lives in the "order.launcher" pref as rowIds; roster-shown.ts applies it wherever the
// roster is shaped. Variants stay in their root's flyout and are named here only as a hint. Rows
// whose dependency is missing are listed too (the launcher hides them, the order keeps their slot).
import "./launcher-order.css";
import { loadConfig, type AgentType } from "../config";
import { overlayAgents } from "../config-agents";
import { buildTypeMenu } from "../launcher/menu";
import { builtinAgents } from "../launcher/roster";
import { orderRoots, rowId, setRootOrderSource } from "../launcher/roster-shown";
import { enableReorder, type OrderKey } from "../panels/reorder";
import { el } from "../panels/rendered/dom";
import { getPref, setPref } from "../prefs";

const ORDER_KEY: OrderKey = "order.launcher";

/** Binds the saved order to the roster shaping; once, at boot, before the launcher's first build. */
export function initLauncherOrder(): void {
  setRootOrderSource(() => getPref(ORDER_KEY));
}

// The launcher menu draws its rows once per build; a changed order rebuilds it from the same
// config the app built it from (main.ts does the same on an "agents" settings change).
function rebuildLauncher(): void {
  void loadConfig().then(({ config: c }) => {
    buildTypeMenu(overlayAgents(builtinAgents(), c.agents), c.locations ?? []);
  });
}

function renumber(list: HTMLElement): void {
  list.querySelectorAll<HTMLElement>(":scope > .rack-row .lo-pos").forEach((p, i) => { p.textContent = String(i + 1); });
}

/** Draws the list into `root` from the resolved rows (agents.ts liveList redraws it on each read). */
export function drawLauncherOrder(root: HTMLElement, rows: AgentType[]): void {
  const roots = rows.filter((r) => !r.under);
  const list = el("div", "rack-list lo-list");
  for (const r of orderRoots(roots, getPref(ORDER_KEY))) {
    const row = el("div", "rack-row lo-row");
    row.dataset.key = rowId(r); // reorder.ts
    const name = el("div", "rack-name lo-name");
    name.title = "Drag To Reorder";
    // variants attach to the first root with their `under` id (roster.ts resolveAgents)
    const host = roots.find((x) => x.id === r.id) === r;
    const subs = host ? rows.filter((v) => v.under === r.id).map((v) => v.label ?? v.id) : [];
    name.append(el("span", "lo-grip", "⋮⋮"), el("span", "lo-label", r.label ?? r.id));
    if (subs.length) name.append(el("span", "lo-sub", `+ ${subs.join(", ")}`));
    name.append(el("span", "lo-pos"));
    row.append(name);
    list.append(row);
  }
  renumber(list);
  enableReorder(list, ORDER_KEY);
  // reorder.ts saves on release; the list then renumbers and the launcher follows
  let last = JSON.stringify(getPref(ORDER_KEY) ?? null);
  const sync = () => {
    const now = JSON.stringify(getPref(ORDER_KEY) ?? null);
    if (now === last) return;
    last = now;
    renumber(list);
    rebuildLauncher();
  };
  list.addEventListener("pointerup", () => queueMicrotask(sync));
  list.addEventListener("lostpointercapture", () => queueMicrotask(sync));

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ws-btn lo-reset";
  reset.textContent = "Reset Order";
  reset.addEventListener("click", () => {
    setPref(ORDER_KEY, undefined);
    root.replaceChildren();
    drawLauncherOrder(root, rows);
    rebuildLauncher();
  });
  root.append(list, reset);
}
