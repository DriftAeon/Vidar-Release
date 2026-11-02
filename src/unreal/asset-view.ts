// Asset and Find sections of the Unreal tab. One long-lived node: the status poll never redraws it.
import { button, el } from "../dom";
import { invoke, type UnrealFindMode } from "../ipc";
import { lucide } from "../icons";
import { cardRows, FIND_MODES, findView, parseOverrideQuery } from "./asset";

export interface AssetSection {
  root: HTMLElement;
  /** The project root shown in the tab head; null hides the section. A new root clears fields and results. */
  setRoot(root: string | null): void;
}

function sectionHead(label: string): HTMLElement {
  const top = el("div", "cx-sec");
  top.append(el("span", "cx-sec-label", label));
  return top;
}

function textRow(label: string, value: string, tooltip?: string, dim = false): HTMLElement {
  const row = el("div", "cx-row");
  if (tooltip) row.title = tooltip;
  if (label) row.append(el("span", "ux-file", label));
  const text = el("span", "ux-message", value);
  if (!dim) text.style.color = "var(--fg)";
  row.append(text);
  return row;
}

function errorLine(message: string): HTMLElement {
  const line = el("div", "cx-note");
  line.setAttribute("role", "alert");
  line.append(lucide("circle-alert"), el("span", "cx-note-msg", message));
  return line;
}

export function buildAssetSection(): AssetSection {
  const root = el("div", "cx-list");
  root.hidden = true;
  let project: string | null = null;
  let cardSeq = 0;
  let findSeq = 0;

  const assetField = el("input", "cx-message");
  assetField.type = "text";
  assetField.setAttribute("aria-label", "Asset Path");
  assetField.style.flex = "1";
  const openBtn = button("Open", "ws-btn");
  const assetBar = el("div", "cx-row");
  assetBar.append(assetField, openBtn);
  const cardOut = el("div", "cx-rows");
  const graphBtn = button("Show Graph Text", "ws-btn");
  graphBtn.title = "Reads the saved Blueprint graphs through the editor. Opening a graph can mark its asset as changed.";
  const graphBar = el("div", "cx-row");
  graphBar.hidden = true;
  graphBar.append(graphBtn);
  const graphOut = el("div", "cx-rows");
  let cardAsset: string | null = null;

  const modeSel = el("select", "cx-message");
  modeSel.setAttribute("aria-label", "Find Mode");
  for (const m of FIND_MODES) modeSel.append(new Option(m.label, m.mode));
  const queryField = el("input", "cx-message");
  queryField.type = "text";
  queryField.setAttribute("aria-label", "Find Query");
  queryField.style.flex = "1";
  const findBtn = button("Find", "ws-btn");
  const findBar = el("div", "cx-row");
  findBar.append(modeSel, queryField, findBtn);
  const findOut = el("div", "cx-rows");

  const assetGroup = el("div", "cx-group");
  assetGroup.append(sectionHead("Asset"), assetBar, cardOut, graphBar, graphOut);
  const findGroup = el("div", "cx-group");
  findGroup.append(sectionHead("Find"), findBar, findOut);
  root.replaceChildren(assetGroup, findGroup);

  function busy(btn: HTMLButtonElement, on: boolean) {
    btn.disabled = on;
    btn.setAttribute("aria-busy", on ? "true" : "false");
  }

  async function openCard(asset: string) {
    const path = asset.trim();
    if (!project || !path) return;
    const mine = ++cardSeq;
    const forRoot = project;
    assetField.value = path;
    cardOut.replaceChildren();
    graphOut.replaceChildren();
    graphBar.hidden = true;
    cardAsset = null;
    busy(graphBtn, false);
    busy(openBtn, true);
    try {
      const card = await invoke("unreal_asset_card", { root: forRoot, asset: path });
      if (mine !== cardSeq || forRoot !== project) return;
      for (const r of cardRows(card)) cardOut.append(textRow(r.label, r.value, r.tooltip, r.dim));
      cardAsset = path;
      graphBar.hidden = false;
    } catch (e) {
      if (mine !== cardSeq || forRoot !== project) return;
      cardOut.append(errorLine(String(e)));
    } finally {
      if (mine === cardSeq) busy(openBtn, false);
    }
  }

  async function showGraphText() {
    if (!project || !cardAsset) return;
    const mine = ++cardSeq;
    const forRoot = project;
    graphOut.replaceChildren();
    busy(graphBtn, true);
    try {
      const result = await invoke("unreal_graph_text", { root: forRoot, asset: cardAsset });
      if (mine !== cardSeq || forRoot !== project) return;
      for (const g of result.graphs) {
        graphOut.append(textRow("", g.name));
        const pre = el("pre", "ux-message", g.text);
        pre.style.cssText = "margin: 0; overflow: auto; font-family: var(--font-mono); max-height: calc(var(--row-32) * 10);";
        graphOut.append(pre);
      }
      for (const n of result.notes) graphOut.append(textRow("", n, undefined, true));
    } catch (e) {
      if (mine !== cardSeq || forRoot !== project) return;
      graphOut.append(errorLine(String(e)));
    } finally {
      if (mine === cardSeq) busy(graphBtn, false);
    }
  }

  async function runFind() {
    const query = queryField.value.trim();
    if (!project || !query) return;
    const mode = modeSel.value as UnrealFindMode;
    const mine = ++findSeq;
    const forRoot = project;
    findOut.replaceChildren();
    if (mode === "overridesOf" && !parseOverrideQuery(query)) {
      findOut.append(errorLine("Enter Overrides Of as Class.Field"));
      return;
    }
    busy(findBtn, true);
    try {
      const result = await invoke("unreal_find", { root: forRoot, mode, query });
      if (mine !== findSeq || forRoot !== project) return;
      const view = findView(result);
      if (view.message) findOut.append(textRow("", view.message, undefined, true));
      for (const r of view.rows) {
        const row = textRow(r.name, r.detail, r.assetPath);
        row.style.cursor = "pointer";
        row.addEventListener("click", () => { void openCard(r.assetPath); });
        findOut.append(row);
      }
    } catch (e) {
      if (mine !== findSeq || forRoot !== project) return;
      findOut.append(errorLine(String(e)));
    } finally {
      if (mine === findSeq) busy(findBtn, false);
    }
  }

  openBtn.addEventListener("click", () => { void openCard(assetField.value); });
  findBtn.addEventListener("click", () => { void runFind(); });
  graphBtn.addEventListener("click", () => { void showGraphText(); });
  assetField.addEventListener("keydown", (e) => { if (e.key === "Enter") void openCard(assetField.value); });
  queryField.addEventListener("keydown", (e) => { if (e.key === "Enter") void runFind(); });

  function setRoot(next: string | null) {
    root.hidden = !next;
    if (next === project) return;
    project = next;
    cardSeq++;
    findSeq++;
    assetField.value = "";
    queryField.value = "";
    cardOut.replaceChildren();
    graphOut.replaceChildren();
    graphBar.hidden = true;
    cardAsset = null;
    findOut.replaceChildren();
    busy(openBtn, false);
    busy(graphBtn, false);
    busy(findBtn, false);
  }

  return { root, setRoot };
}
