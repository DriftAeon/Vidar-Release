// src\runes\bare\style-pick.ts — output styles are exclusive in a vault: switching
// one on also switches off every other output-style rune the vault carries, in the same edit, so picking replaces.
// The launch warning for a second style (bare/rune_items.rs) stays as the backstop for vaults built elsewhere.
import type { RuneRef, VaultOp } from "../../ipc";
import type { VaultView, VaultViewRune } from "./cake";

export const OUTPUT_STYLE = "output-style";

/** Pure: `on` for rune `pick`, preceded by the ops that switch off the vault's other output styles when `pick` is
 *  one. A one-off style leaves through `removeRune`, a runeset's slotted style through the `member` op (the vault's
 *  copy only); a recall member has no slot and is left alone. */
export function withStyleReplace(pick: RuneRef & { kind: string }, on: VaultOp,
  view: { vault: VaultView["vault"]; runes: readonly VaultViewRune[] }): VaultOp[] {
  if (pick.kind !== OUTPUT_STYLE) return [on];
  const out: VaultOp[] = [];
  for (const r of view.runes) {
    if (r.kind !== OUTPUT_STYLE || (r.library === pick.library && r.id === pick.id)) continue;
    const ref = { library: r.library, id: r.id };
    if (!r.set) {
      if (view.vault.runes.some((x) => x.library === r.library && x.id === r.id)) out.push({ op: "removeRune", ref });
    } else if (!r.recall && view.vault.runesets.some((s) => s.source.library === r.set!.library && s.source.set === r.set!.set)) {
      out.push({ op: "member", ref: { library: r.set.library, runeset: r.set.set, rune: ref, on: false } });
    }
  }
  return [...out, on];
}
