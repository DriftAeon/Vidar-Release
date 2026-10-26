// Local item ticks for a vault's copied runeset. Import writes library runes; member edits change only the vault.
import type { SetSource, VaultOp } from "../../ipc";
import { setHead } from "../set-card";
import { btn, el } from "./agent-view";
import { itemRuneInputs } from "./kit-add";
import { memberOp } from "./view-vault";
import type { VaultViewRune } from "./cake";
import type { BareFlowIo, BareLocalFile, BareLocalSources, BareModuleBundles, ItemRuneInputs } from "./flow";

const same = (a: string, b: string): boolean => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
const hasFile = (r: VaultViewRune, f: BareLocalFile): boolean =>
  r.kind === f.kind && (r.item?.source ? same(r.item.source, f.path)
    : f.kind === "hook" && !!f.guard && r.item?.event === f.guard.event &&
      (r.item.run ?? []).some((p) => same(p, f.path)));
const hasRef = (runes: readonly VaultViewRune[], ref: { library: string; id: string }): boolean =>
  runes.some((r) => r.library === ref.library && r.id === ref.id);

/** Import a selected item, then put its refs in the runeset copy through the common vault edit guard. */
export async function importMembers(io: BareFlowIo, set: SetSource, layer: ItemRuneInputs,
  on: boolean, present: readonly VaultViewRune[], edit: (ops: VaultOp[]) => Promise<void>,
  remove?: readonly VaultViewRune[]): Promise<void> {
  const imported = await io.itemsImport({ library: set.library, layer });
  const refs = on ? imported.runes : remove ?? imported.runes.filter((r) => hasRef(present, r));
  if (refs.length) await edit(refs.map((r) => memberOp(set, r, on)));
  if (on && imported.dropped.length) throw new Error(imported.dropped.map((d) => `${d.id}: ${d.reason}`).join("\n"));
}

export interface SetAttachCtx {
  io: BareFlowIo; set: SetSource; runes: VaultViewRune[]; sources: BareLocalSources | null;
  bundles: BareModuleBundles | null; codex: boolean; busy: boolean;
  edit(ops: VaultOp[]): Promise<void>;
  act(fn: () => Promise<void>): void;
  trackOpen(det: HTMLDetailsElement, key: string, dflt: boolean): void;
}

export function setAttachments(c: SetAttachCtx): HTMLElement[] {
  const files = (c.sources?.files ?? []).filter((f) =>
    f.pickable && (f.kind === "skill" || f.kind === "agent" || f.kind === "hook"));
  const out: HTMLElement[] = [];
  for (const [kind, name, icon] of [
    ["skill", "Skills", "skill"], ["agent", "Agents", "agent"], ["hook", "Hooks", "hook"],
  ] as const) {
    const offered = files.filter((f) => f.kind === kind);
    if (!offered.length) continue;
    const group = el("details", `runes-set hue-${kind}`);
    group.dataset.set = c.set.set;
    group.dataset.kind = kind;
    c.trackOpen(group, `attach:${c.set.library}/${c.set.set}:${kind}`, false);
    group.appendChild(setHead(name, offered.filter((f) => c.runes.some((r) => hasFile(r, f))).length, icon));
    const list = el("div", "rp-sources runes-tray");
    for (const f of offered) {
      const on = c.runes.some((r) => hasFile(r, f));
      const row = btn(f.shown, "rp-source", () => {
        const layer = itemRuneInputs([f], new Set([f.path]), c.bundles, c.codex);
        c.act(() => importMembers(c.io, c.set, layer, !on, c.runes, c.edit,
          c.runes.filter((r) => hasFile(r, f))));
      }, c.busy);
      row.dataset.path = f.path;
      row.dataset.kind = kind;
      row.setAttribute("aria-pressed", String(on));
      row.title = f.path;
      list.appendChild(row);
    }
    group.appendChild(list);
    out.push(group);
  }
  return out;
}
