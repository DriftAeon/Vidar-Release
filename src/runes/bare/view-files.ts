// Local Files card and actions for the Bare view.
import { setCard, setHead } from "../set-card";
import { kindHeadName, kindHue } from "../kind-groups";
import { button, el } from "../../dom";
import { type BareFileKind, type BareLocalFile, type BareLocalSources } from "./flow";
import { generatable } from "./view-data";
import type { ColorIcon } from "../../icon-img";
import type { AgentId } from "../../agents/id";
// @ts-ignore TS5097: node --test loads this module directly
import { AGENTS } from "../../agents/descriptor.ts";

// Head order; names and hues come from kind-groups.ts (the file kind `rules` is the rune kind `rule`)
const FILE_KINDS: BareFileKind[] = ["rules", "memory", "skill", "agent", "hook", "mcp"];
const FILE_HEAD_ICON: Partial<Record<BareFileKind, ColorIcon>> = { rules: "rules", memory: "memory-card" };

export interface FilesViewArgs {
  agent: AgentId; sources: BareLocalSources | null; sourcesErr: string | null; ticked: Set<string>;
  busy: boolean;
  layerKinds: [BareFileKind, string, ColorIcon][];
  trackOpen(det: HTMLDetailsElement, key: string, dflt: boolean): void;
  tickRow(f: BareLocalFile, on: boolean, flip: () => void, off: boolean, icon?: ColorIcon | null): HTMLElement;
  error(text: string): HTMLElement | null;
  generateButton(): HTMLElement | null;
  selects(): HTMLElement[];
  back(): void; paint(): void;
}

export function filesView(a: FilesViewArgs): HTMLElement[] {
  const out: HTMLElement[] = [];
  const topHead = setHead("Local Files", null, "folder");
  if (!AGENTS[a.agent].flowSdk) topHead.title = `${AGENTS[a.agent].name} Bare loads rules, memories, skills, agents and hosted MCP servers.`;
  const top = setCard("hue-none", topHead);
  a.trackOpen(top, "files", true);
  out.push(top);
  const files = a.sourcesErr ? [] : (a.sources?.files ?? []).filter((f) => AGENTS[a.agent].flowSdk || f.kind !== "hook");
  if (a.sourcesErr) {
    const error = a.error(a.sourcesErr);
    if (error) { const tray = el("div", "runes-tray"); tray.appendChild(error); top.appendChild(tray); }
  } else if (!files.length) {
    const tray = el("div", "runes-tray");
    tray.appendChild(el("div", "rp-empty", "No Local Files Found")); // note-ok: docs/projects/bare/runes-tab-plan.md
    top.appendChild(tray);
  }
  for (const kind of FILE_KINDS) {
    const runeKind = kind === "rules" ? "rule" : kind;
    const kindFiles = files.filter((f) => f.kind === kind);
    if (!kindFiles.length) continue;
    const group = el("details", `runes-set ${kindHue(runeKind)}`);
    group.dataset.kind = kind;
    a.trackOpen(group, "file:" + kind, false);
    const icon = a.layerKinds.find(([k]) => k === kind)?.[2] ?? FILE_HEAD_ICON[kind] ?? null;
    group.appendChild(setHead(kindHeadName(runeKind), `${kindFiles.filter((f) => a.ticked.has(f.path)).length}/${kindFiles.length}`, icon));
    const list = el("div", "rp-sources runes-tray");
    for (const f of kindFiles) list.appendChild(a.tickRow(f, a.ticked.has(f.path), () => {
      if (a.busy) return;
      if (!a.ticked.delete(f.path)) a.ticked.add(f.path);
      a.paint();
    }, false, icon));
    group.appendChild(list);
    top.appendChild(group);
  }
  const actions = el("div", "rp-actions");
  const gen = a.sources && !a.sourcesErr ? a.generateButton() : null;
  actions.append(...(gen ? [...a.selects(), gen] : []), button("Back", "ws-btn", a.back, a.busy));
  out.push(actions);
  return out;
}

export { generatable };
