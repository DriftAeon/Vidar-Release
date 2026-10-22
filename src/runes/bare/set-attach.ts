// src\runes\bare\set-attach.ts — what each rune set attaches, in the Bare Runes tab's Actives view (run
// 2026-10-20-rune-sets, W4). Per set the row names in a library, one group per kind its layer sidecar
// (`<library>\sets\<set>.layer.json`, bare/set_layer.rs) attaches, drawn with the Inherited Runes groups' heads
// and tick rows: View lists what is ticked, Modify offers every candidate and a tick writes the set's sidecar
// through `bare_set_layer_write`, then the view re-reads.
import type { ColorIcon } from "../../icon-img";
import {
  agentFiles,
  type ActionResult, type BareActiveLibrary, type BareFileKind, type BareFlowIo, type BareGuard, type BareLocalFile,
  type BareLocalSources, type BareSetLayer, type BareSetLayerWrite,
} from "./flow";
import { el } from "./agent-view";
import { isFileRow, nameAndPath } from "./row-name";
const lastSeg = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const samePath = (a: string, b: string): boolean => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
/** A guard's identity as set_layer.rs `guard_name` dedupes it: event, matcher and run file names. */
const guardName = (g: BareGuard): string =>
  [g.event, g.matcher ?? "", g.run.map((r) => lastSeg(r).toLowerCase()).join(",")].join("|");

/** Pure: one set's attachment files: the offered skill, agent and hook files (Codex: skills only; Vidar's own
 *  block guards are offered like any hook) plus any sidecar entry no longer offered (kept so
 *  a toggle round-trips it), ticked from what the set's sidecar holds. */
export function setFiles(src: BareLocalSources | null, s: BareSetLayer, codex = false): { files: BareLocalFile[]; ticked: Set<string> } {
  const files = agentFiles(src?.files ?? [], codex)
    .filter((f) => f.kind === "skill" || (!codex && (f.kind === "agent" || f.kind === "hook")));
  const lists: ["skill" | "agent", string[]][] = codex ? [["skill", s.codexSkills]] : [["skill", s.skills], ["agent", s.agents]];
  for (const [kind, list] of lists) {
    for (const p of list) {
      if (!files.some((f) => f.kind === kind && samePath(f.path, p))) files.push({ path: p, shown: p, kind, scope: "global", ticked: true, pickable: true });
    }
  }
  if (!codex) {
    for (const g of s.guards) {
      if (files.some((f) => f.guard && guardName(f.guard) === guardName(g))) continue;
      const p = g.run[g.run.length - 1] ?? g.event;
      files.push({ path: p, shown: p, kind: "hook", scope: "global", ticked: true, pickable: true, guard: g });
    }
  }
  const ticked = new Set<string>();
  for (const f of files) {
    const on = f.kind === "skill" ? (codex ? s.codexSkills : s.skills).some((p) => samePath(p, f.path))
      : f.kind === "agent" ? s.agents.some((p) => samePath(p, f.path))
      : !!f.guard && s.guards.some((g) => guardName(g) === guardName(f.guard!));
    if (on) ticked.add(f.path);
  }
  return { files, ticked };
}

/** Pure: how many skills, agents and hooks the sets `lib` names attach (the sum of the group heads' counts). */
export function attachedCount(src: BareLocalSources | null, lib: Pick<BareActiveLibrary, "sets">, codex = false): number {
  return (lib.sets ?? []).reduce((n, s) => n + setFiles(src, s, codex).ticked.size, 0);
}

/** Pure: the sidecar write that flips `f` in set `s`: only the key of its kind (a Codex skill writes `codexSkills`). */
export function setFlip(s: BareSetLayer, f: BareLocalFile, on: boolean, codex = false): BareSetLayerWrite {
  const flipPath = (list: string[]): string[] => (on ? [...list.filter((p) => !samePath(p, f.path)), f.path] : list.filter((p) => !samePath(p, f.path)));
  if (f.kind === "skill") return codex ? { codexSkills: flipPath(s.codexSkills) } : { skills: flipPath(s.skills) };
  if (f.kind === "agent") return { agents: flipPath(s.agents) };
  const g = f.guard;
  const rest = s.guards.filter((x) => !g || guardName(x) !== guardName(g));
  return { guards: on && g ? [...rest, g] : rest };
}

/** What the view lends the set groups: its state at draw time and the head, open-state and tick-row helpers it already uses. */
export interface SetAttachCtx {
  codex: boolean; modify: boolean; editable: boolean; io: BareFlowIo; sources: BareLocalSources | null;
  kinds: [BareFileKind, string, ColorIcon][];
  setHead(name: string, count: number, icon: ColorIcon | null): HTMLElement;
  trackOpen(det: HTMLDetailsElement, key: string, dflt: boolean): void;
  tickRow(f: BareLocalFile, on: boolean, flip: () => void, off: boolean): HTMLButtonElement;
  /** Runs the write with every control disabled; `done` gets the error (null on success), then the view re-reads. */
  act(fn: () => Promise<void>): void;
  done(err: ActionResult | null): Promise<void>;
}

/** The set groups of `lib`: per set, one group per kind with anything to show. */
export function setAttachments(lib: BareActiveLibrary, c: SetAttachCtx): HTMLElement[] {
  const out: HTMLElement[] = [];
  const kinds = c.kinds.filter(([k]) => k === "skill" || (!c.codex && (k === "agent" || k === "hook")));
  for (const s of lib.sets ?? []) {
    const { files, ticked: on } = setFiles(c.sources, s, c.codex);
    const writable = c.editable && s.editable && !!c.io.setLayerWrite;
    for (const [kind, name, icon] of kinds) {
      const kindFiles = files.filter((f) => f.kind === kind && ((c.modify && writable) || on.has(f.path)));
      if (!kindFiles.length) continue;
      const det = el("details", `runes-set hue-${kind}`) as HTMLDetailsElement;
      det.dataset.set = s.set;
      det.dataset.kind = kind;
      c.trackOpen(det, `set:${lib.library}:${s.set}:${kind}`, false);
      const head = c.setHead(name, kindFiles.filter((f) => on.has(f.path)).length, icon);
      head.title = `Attached by the ${s.set} set.`;
      det.appendChild(head);
      const list = el("div", "rp-sources runes-tray");
      for (const f of kindFiles) {
        if (!c.modify || !writable) {
          const ro = el("div", "rp-source is-ro", isFileRow(f) ? "" : f.shown);
          if (isFileRow(f)) ro.append(...nameAndPath(f));
          ro.dataset.path = f.path;
          ro.dataset.kind = kind;
          ro.title = f.path;
          list.appendChild(ro);
          continue;
        }
        const row = c.tickRow(f, on.has(f.path), () => {
          const layer = setFlip(s, f, !on.has(f.path), c.codex);
          c.act(async () => {
            let err: ActionResult | null = null;
            try { await c.io.setLayerWrite!({ library: lib.library, set: s.set, layer }); } catch (e) { err = { ok: false, reason: "failed", error: String(e) }; }
            await c.done(err);
          });
        }, false);
        row.dataset.kind = kind;
        list.appendChild(row);
      }
      det.appendChild(list);
      out.push(det);
    }
  }
  return out;
}
