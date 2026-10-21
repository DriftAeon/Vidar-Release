// Settings > Build, DOM: Idle (set picker, grouped toggles, Cancel/Build), Building (picker and toggles
// disabled, phase and elapsed time, log tail, Cancel), Result and Failure. Reuses the Modules page rows
// and switch (settings/modules.css) and the decision pair (styles/decision-pair.css); its own layout is
// styles/release-build.css. Rendering only: page.ts owns the state and the IPC.
import { iconImg, type ColorIcon } from "../../icon-img";
import { SURFACE_ICONS } from "../../panels/workbench-modules";
import openaiIcon from "../../assets/openai.png";
import claudeIcon from "../../assets/claude.png";
import pickerIcon from "../../assets/picker.png";
import type { ReleaseBuildSet } from "../../ipc-settings";
import { failureLine, GROUPS, phaseLabel, summarize, type RunModel, type Toggle } from "./state";

export type Mode = "idle" | "building" | "result" | "failure";

export interface BuildView {
  sets: ReleaseBuildSet[];
  baseId: string;
  list: Toggle[];
  on: ReadonlySet<string>;
  dims: ReadonlyMap<string, string>;
  mode: Mode;
  run: RunModel;
  elapsed: string;
  changed: boolean;
  /** an invoke in flight: the button that started it shows loading */
  busy: "start" | "cancel" | null;
  /** the last refusal or failure of a button's invoke, shown as given */
  error: string;
  errorFrom: "start" | "cancel" | "result" | null;
}

export interface BuildHandlers {
  pick(id: string): void;
  flip(id: string): void;
  build(): void;
  cancel(): void;
  reset(): void;
  done(): void;
  openFolder(): void;
  copyPath(): void;
}

const ICONS: Record<string, ColorIcon> = {
  tray: "tray", doc: "doc", flow: "flow", runelib: "runelib",
  lab: "lab", changes: "changes", unreal: "unreal", ...SURFACE_ICONS, marquee: "marquee",
  "voice-stock": "mic",
};
/** Rows whose mark is a bundled asset, not a manifest icon: the launcher's vendor marks and the toolbar's picker. */
const ASSET_ICONS: Record<string, string> = {
  "codex-profiles": openaiIcon, "agent-profiles": claudeIcon, eyedropper: pickerIcon,
};

function assetImg(src: string): HTMLImageElement {
  const img = iconImg("mic"); // same class and a11y attributes as every other row mark
  img.src = src;
  return img;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Label first, so lint-copy's `button(` sink judges the label. */
function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function picker(v: BuildView, h: BuildHandlers): HTMLSelectElement {
  const sel = el("select", "sc-select release-build__set");
  sel.setAttribute("aria-label", "Build Set");
  for (const s of v.sets) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    sel.appendChild(opt);
  }
  sel.value = v.baseId;
  sel.disabled = v.mode !== "idle";
  sel.addEventListener("change", () => h.pick(sel.value));
  return sel;
}

function groups(v: BuildView, h: BuildHandlers): HTMLElement {
  const host = el("div", "module-settings__groups");
  for (const title of GROUPS) {
    const entries = v.list.filter((t) => t.group === title);
    if (!entries.length) continue;
    const section = el("section", "module-settings__group");
    section.setAttribute("aria-label", title);
    section.appendChild(el("h2", "module-settings__heading", title));
    for (const t of entries) {
      const row = el("div", "module-settings__row release-build__row");
      row.dataset.buildId = t.id;
      const need = v.dims.get(t.id);
      if (need) {
        row.classList.add("release-build__row--dim");
        row.title = `Needs ${need}`;
      }
      const name = el("span", "module-settings__name");
      const icon = ICONS[t.id];
      const asset = ASSET_ICONS[t.id];
      if (icon) name.appendChild(iconImg(icon));
      else if (asset) name.appendChild(assetImg(asset));
      name.appendChild(el("span", "", t.label));
      const toggle = button("", "module-settings__switch",() => h.flip(t.id));
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", t.label);
      toggle.setAttribute("aria-checked", String(v.on.has(t.id)));
      toggle.disabled = v.mode !== "idle";
      row.append(name, toggle);
      section.appendChild(row);
    }
    host.appendChild(section);
  }
  return host;
}

function tail(lines: string[]): HTMLElement {
  const box = el("div", "release-build__tail");
  box.dataset.buildTail = "";
  box.setAttribute("role", "log");
  box.setAttribute("aria-label", "Build Log");
  for (const line of lines) box.appendChild(el("div", "release-build__line", line));
  return box;
}

function status(v: BuildView): HTMLElement {
  const box = el("div", "release-build__status");
  const head = el("div", "release-build__phase");
  head.append(el("span", "release-build__phase-name", phaseLabel(v.run.phase)), el("span", "release-build__elapsed", v.elapsed));
  head.setAttribute("role", "status");
  box.append(head, tail(v.run.log));
  return box;
}

function errorLine(text: string): HTMLElement {
  const line = el("div", "release-build__error", text);
  line.setAttribute("role", "alert");
  return line;
}

function loading(b: HTMLButtonElement, on: boolean) {
  if (!on) return;
  b.disabled = true;
  b.setAttribute("aria-busy", "true");
}

function failed(b: HTMLButtonElement, on: boolean) {
  if (on) b.dataset.state = "error";
}

function actions(...children: HTMLElement[]): HTMLElement {
  const row = el("div", "release-build__actions");
  row.append(...children);
  return row;
}

function idleOrBuilding(v: BuildView, h: BuildHandlers): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (v.mode === "building") out.push(status(v));
  out.push(groups(v, h));
  if (v.error) out.push(errorLine(v.error));
  const cancel = button("Cancel", "release-build__cancel",v.mode === "building" ? h.cancel : h.reset);
  if (v.mode === "building") {
    loading(cancel, v.busy === "cancel");
    failed(cancel, v.errorFrom === "cancel");
    out.push(actions(cancel));
    return out;
  }
  cancel.disabled = !v.changed || v.busy !== null;
  const go = button("Build", "release-build__go",h.build);
  go.disabled = v.on.size === 0 || v.busy !== null;
  loading(go, v.busy === "start");
  failed(go, v.errorFrom === "start");
  out.push(actions(cancel, go));
  return out;
}

function result(v: BuildView, h: BuildHandlers): HTMLElement[] {
  const r = v.run.result!;
  if (v.mode === "failure") {
    return [errorLine(failureLine(r)), tail(v.run.log), actions(button("Done", "ws-btn release-build__done", h.done))];
  }
  const s = summarize(r, v.list);
  const out: HTMLElement[] = [];
  if (s.zipName || s.size) {
    const zip = el("div", "release-build__result");
    zip.append(el("span", "release-build__zip", s.zipName), el("span", "release-build__size", s.size));
    if (r.zip) zip.title = r.zip;
    out.push(zip);
  }
  const trace = el("div", "release-build__result");
  if (s.trace) {
    const t = el("span", "release-build__trace", s.trace);
    t.dataset.trace = r.trace ?? "";
    trace.appendChild(t);
  }
  if (s.gaps) trace.appendChild(el("span", "release-build__gaps", s.gaps));
  if (trace.childElementCount) out.push(trace);
  if (s.dropped) out.push(el("div", "release-build__dropped", s.dropped));
  if (s.personal) out.push(el("div", "release-build__dropped", s.personal));
  if (v.error) out.push(errorLine(v.error));
  const open = button("Open Folder", "ws-btn", h.openFolder);
  const copy = button("Copy Path", "ws-btn", h.copyPath);
  open.disabled = copy.disabled = !r.zip;
  failed(open, v.errorFrom === "result");
  out.push(actions(open, copy, button("Done", "ws-btn release-build__done", h.done)));
  return out;
}

/** Rebuilds the page into `root`, keeping keyboard focus on the same control when it survives. */
export function renderBuild(root: HTMLElement, v: BuildView, h: BuildHandlers) {
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active && root.contains(active) ? keyOf(active) : null;
  root.replaceChildren();
  if (v.mode === "idle" || v.mode === "building") root.append(picker(v, h), ...idleOrBuilding(v, h));
  else root.append(...result(v, h));
  if (!focusKey) return;
  const next = [...root.querySelectorAll<HTMLElement>("button, select")].find((n) => keyOf(n) === focusKey);
  if (next && !(next as HTMLButtonElement).disabled) next.focus();
}

function keyOf(n: HTMLElement): string {
  const row = n.closest<HTMLElement>("[data-build-id]");
  return row ? `row:${row.dataset.buildId}` : `${n.tagName}:${n.className}:${n.textContent}`;
}

/** Building only: the phase, elapsed time and log tail change in place, so a stream of log lines
 *  does not rebuild the toggles under the pointer. */
export function paintRun(root: HTMLElement, v: BuildView) {
  const name = root.querySelector<HTMLElement>(".release-build__phase-name");
  const time = root.querySelector<HTMLElement>(".release-build__elapsed");
  const box = root.querySelector<HTMLElement>("[data-build-tail]");
  if (name) name.textContent = phaseLabel(v.run.phase);
  if (time) time.textContent = v.elapsed;
  if (box) box.replaceWith(tail(v.run.log));
}
