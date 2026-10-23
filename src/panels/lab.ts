// Lab tab: runes that sit in a CLAUDE.md or AGENTS.md target (Global, then Vidar) on the left, the selected
// rune's eval suite and run history on the right. The catalog reloads each time the tab is shown;
// `lab_item` runs on select and on show, and only while the tab is on screen. Refresh appears
// only as a retry after a failed load.
import { invoke } from "../ipc";
import { iconImg } from "../icon-img";
import { paneShell } from "./pane-shell";
import { runeName } from "../runes/cards";
import { LAB_KIND_ICONS, itemDetail, type LabLib } from "../lab/view";
import { labItems, type LabGroup, type LabRuneItem, type LabTarget } from "../lab/items";
import { moduleOn } from "../modules/registry";
import claudeIcon from "../assets/claude.png";
import openaiIcon from "../assets/openai.png";
import type { RuneItem, RunesCatalog } from "../runes/types";

const GROUP_NAME: Record<string, string> = { global: "Global", vidar: "Vidar" };

interface Pick {
  lib: LabLib;
  rune: RuneItem;
  target: LabTarget;
}

let catalog: RunesCatalog | null = null;
let catalogErr: string | null = null;
let itemErr = false;
let picked: { lib: LabLib; id: string; target: LabTarget } | null = null;
let seq = 0;
let visible = false;
let listEl: HTMLElement;
let detailEl: HTMLElement;
let stateEl: HTMLElement;
let refreshBtn: HTMLButtonElement;
let note: (msg: string) => void;
let viewEl: HTMLElement | undefined;
let refreshGeneration = 0;

/** Retry only: show and select already re-query, so the button appears when a load failed. */
function syncRetry() {
  refreshBtn.hidden = !(catalogErr || itemErr);
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The Lab's items for the agents that are on, per library, catalog order. */
const groups = (c: RunesCatalog): LabGroup[] => labItems(c.libraries, moduleOn);

/** With both agents on, an item's icon names its agent (Claude or Codex); with one, the rune icon. */
function itemIcon(it: LabRuneItem): HTMLImageElement {
  const img = iconImg(LAB_KIND_ICONS.rune);
  if (moduleOn("claude") && moduleOn("codex")) {
    img.src = it.target === "AGENTS.md" ? openaiIcon : claudeIcon;
    img.title = it.target === "AGENTS.md" ? "Codex" : "Claude";
  }
  return img;
}

function findPick(): Pick | null {
  if (!catalog || !picked) return null;
  for (const g of groups(catalog)) {
    if (g.lib !== picked.lib) continue;
    const it = g.items.find((i) => i.rune.id === picked?.id && i.target === picked.target);
    if (it) return { lib: g.lib, rune: it.rune, target: it.target };
  }
  return null;
}

function drawList() {
  const parts: HTMLElement[] = [];
  if (catalogErr) parts.push(el("div", "lab-err", catalogErr));
  if (catalog) {
    for (const g of groups(catalog)) {
      if (!g.items.length) continue;
      const group = el("section", "lab-group");
      group.appendChild(el("h3", "lab-group-head", GROUP_NAME[g.lib] ?? g.lib));
      for (const it of g.items) {
        const r = it.rune;
        const b = el("button", "lab-item") as HTMLButtonElement;
        b.type = "button";
        const title = el("span", "lab-item-title", runeName(r));
        b.append(itemIcon(it), title);
        b.title = r.id;
        const on = picked?.lib === g.lib && picked.id === r.id && picked.target === it.target;
        b.classList.toggle("is-sel", on);
        if (on) b.setAttribute("aria-current", "true");
        b.addEventListener("click", () => {
          picked = { lib: g.lib, id: r.id, target: it.target };
          drawList();
          void loadItem();
        });
        group.appendChild(b);
      }
      parts.push(group);
    }
  }
  listEl.replaceChildren(...parts);
}

async function loadItem() {
  const my = ++seq;
  itemErr = false;
  const p = findPick();
  stateEl.textContent = p ? runeName(p.rune) : "";
  if (!p) {
    const none = catalog && !groups(catalog).some((g) => g.items.length);
    detailEl.replaceChildren(...(catalog ? [el("div", "lab-empty", none ? "No Lab Runes" : "No Suite Yet")] : []));
    return;
  }
  if (!visible) return; // never query while hidden
  try {
    const item = await invoke("lab_item", { library: p.lib, id: p.rune.id });
    if (my !== seq || !visible) return; // a newer pick or Refresh owns the view
    detailEl.replaceChildren(...itemDetail(p.rune.id, p.lib, p.target, item, { note }));
  } catch (e) {
    if (my !== seq) return;
    itemErr = true;
    syncRetry();
    detailEl.replaceChildren(el("div", "lab-err", String(e)));
  }
}

async function refresh(reloadCatalog: boolean) {
  const generation = ++refreshGeneration;
  refreshBtn.disabled = true;
  refreshBtn.setAttribute("aria-busy", "true");
  if (!catalog || reloadCatalog) {
    try {
      const loaded: RunesCatalog = await invoke("runes_catalog");
      if (generation !== refreshGeneration || !viewEl) return;
      catalog = loaded;
      catalogErr = null;
    } catch (e) {
      if (generation !== refreshGeneration || !viewEl) return;
      catalogErr = String(e);
    }
  }
  if (!visible || !viewEl || generation !== refreshGeneration) { // hidden or disposed while loading
    refreshBtn.disabled = false;
    refreshBtn.removeAttribute("aria-busy");
    return;
  }
  if (!findPick()) {
    const first = catalog ? groups(catalog).find((g) => g.items.length) : undefined;
    picked = first ? { lib: first.lib, id: first.items[0].rune.id, target: first.items[0].target } : null;
  }
  drawList();
  await loadItem();
  syncRetry();
  refreshBtn.disabled = false;
  refreshBtn.removeAttribute("aria-busy");
}

export function mountLabView(parent: HTMLElement, noteFn: (msg: string) => void): HTMLElement {
  const shell = paneShell({ id: "lab-view", head: { cls: "lab-head" }, frame: { cls: "lab-body" }, scroll: true });
  viewEl = shell.root;
  catalog = null;
  catalogErr = null;
  itemErr = false;
  picked = null;
  visible = false;
  shell.root.style.display = "none";
  note = noteFn;
  stateEl = el("span", "lab-state pane-head-card");
  refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "lab-act lab-refresh";
  refreshBtn.setAttribute("aria-label", "Refresh");
  refreshBtn.title = "Refresh";
  refreshBtn.hidden = true;
  refreshBtn.append(iconImg("refresh"));
  refreshBtn.addEventListener("click", () => void refresh(true));
  shell.head.append(stateEl, refreshBtn);
  listEl = el("nav", "lab-list");
  detailEl = el("div", "lab-detail");
  shell.frame.append(listEl, detailEl);
  parent.appendChild(shell.root);
  return shell.root;
}

export function onLabShown() {
  visible = true;
  void refresh(true);
}

export function onLabHidden() {
  visible = false;
  seq++; // drop a pending lab_item answer; the next show reloads
  refreshGeneration++;
}

export function disposeLabView() {
  onLabHidden();
  viewEl?.remove();
  viewEl = undefined;
  catalog = null;
  picked = null;
}
