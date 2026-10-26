// Local Files card and actions for the Bare view.
import { setCard, setHead } from "../set-card";
import { btn, el } from "./agent-view";
import { type BareFileKind, type BareLocalFile, type BareLocalSources } from "./flow";
import { generatable } from "./view-data";
import type { ColorIcon } from "../../icon-img";

const KIND_HEAD: [BareFileKind, string][] = [
  ["rules", "Rules"], ["memory", "Memories"], ["skill", "Skills"], ["agent", "Agents"], ["hook", "Hooks"], ["mcp", "MCP Servers"],
];
const TIP_FILES_CODEX = "Codex Bare loads rules, memories, skills, agents and hosted MCP servers.";
const FILE_HEAD_ICON: Partial<Record<BareFileKind, ColorIcon>> = { rules: "rules", memory: "memory-card" };

export interface FilesViewArgs {
  codex: boolean; sources: BareLocalSources | null; sourcesErr: string | null; ticked: Set<string>;
  kitError: string | null;
  busy: boolean; canAddKit: boolean;
  layerKinds: [BareFileKind, string, ColorIcon][];
  trackOpen(det: HTMLDetailsElement, key: string, dflt: boolean): void;
  tickRow(f: BareLocalFile, on: boolean, flip: () => void, off: boolean): HTMLButtonElement;
  error(text: string): HTMLElement | null;
  generateButton(): HTMLElement | null;
  selects(): HTMLElement[];
  addKit(): void; back(): void; paint(): void;
}

export function filesView(a: FilesViewArgs): HTMLElement[] {
  const out: HTMLElement[] = [];
  const topHead = setHead("Local Files", null, "folder");
  if (a.codex) topHead.title = TIP_FILES_CODEX;
  const top = setCard("hue-none", topHead);
  a.trackOpen(top, "files", true);
  out.push(top);
  const files = a.sourcesErr ? [] : (a.sources?.files ?? []).filter((f) => !a.codex || f.kind !== "hook");
  if (a.sourcesErr) {
    const error = a.error(a.sourcesErr);
    if (error) { const tray = el("div", "runes-tray"); tray.appendChild(error); top.appendChild(tray); }
  } else if (!files.length) {
    const tray = el("div", "runes-tray");
    tray.appendChild(el("div", "rp-empty", "No Local Files Found")); // note-ok: docs/projects/bare/runes-tab-plan.md
    top.appendChild(tray);
  }
  for (const [kind, name] of KIND_HEAD) {
    const kindFiles = files.filter((f) => f.kind === kind);
    if (!kindFiles.length) continue;
    const group = el("details", `runes-set hue-${kind === "skill" || kind === "agent" || kind === "hook" ? kind : "none"}`);
    group.dataset.kind = kind;
    a.trackOpen(group, "file:" + kind, true);
    group.appendChild(setHead(name, kindFiles.filter((f) => a.ticked.has(f.path)).length,
      a.layerKinds.find(([k]) => k === kind)?.[2] ?? FILE_HEAD_ICON[kind] ?? null));
    const list = el("div", "rp-sources runes-tray");
    for (const f of kindFiles) list.appendChild(a.tickRow(f, a.ticked.has(f.path), () => {
      if (a.busy) return;
      if (!a.ticked.delete(f.path)) a.ticked.add(f.path);
      a.paint();
    }, false));
    group.appendChild(list);
    top.appendChild(group);
  }
  const actions = el("div", "rp-actions");
  if (a.kitError) {
    const error = el("div", "rp-error");
    error.appendChild(el("b", "", "Add Kit Failed"));
    error.title = a.kitError;
    out.push(error);
  }
  if (!files.length && !a.sourcesErr && a.canAddKit) actions.appendChild(btn("Add Kit", "ws-btn ws-add", a.addKit, a.busy));
  const gen = a.sources && !a.sourcesErr ? a.generateButton() : null;
  actions.append(...(gen ? [...a.selects(), gen] : []), btn("Back", "ws-btn", a.back, a.busy));
  out.push(actions);
  return out;
}

export { generatable };
