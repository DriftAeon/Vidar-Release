// src\runes\bare\library-toggle.ts — the head checkbox of a library's one-off card in Modify (Stock Claude, Stock
// Codex, any library whose runes the vault holds on their own). One-offs have no runeset op, so the head switches
// the card's runes as one batch of the per-rune ops: all on → a removeRune each; some or none on → an addRune for
// each rune that is off, in one vault edit. Output styles are exclusive (style-pick.ts): the batch adds at most one,
// and none when the card already holds one on.
import type { VaultOp } from "../../ipc";
import type { CheckState } from "../check-box";
import type { VaultView, VaultViewRune } from "./cake";
import { OUTPUT_STYLE, withStyleReplace } from "./style-pick";

/** Pure: the head's state (`mixed` when some are on) and the ops its click sends. */
export function libraryToggle(library: string, rs: readonly { rune: VaultViewRune; on: boolean }[],
  view: { vault: VaultView["vault"]; runes: readonly VaultViewRune[] }): { state: CheckState; ops: VaultOp[] } {
  const n = rs.filter((o) => o.on).length;
  let styled = rs.some((o) => o.on && o.rune.kind === OUTPUT_STYLE);
  // an off style beside an on one is as on as it can get: the card reads on, not stuck partial
  const settled = rs.filter((o) => o.on || (styled && o.rune.kind === OUTPUT_STYLE)).length;
  const state: CheckState = n === 0 ? "off" : settled === rs.length ? "on" : "mixed";
  if (state === "on") return { state, ops: rs.filter((o) => o.on).map((o) => ({ op: "removeRune", ref: { library, id: o.rune.id } })) };
  const ops: VaultOp[] = [];
  for (const o of rs) {
    if (o.on) continue;
    if (o.rune.kind === OUTPUT_STYLE) { if (styled) continue; styled = true; }
    const ref = { library, id: o.rune.id };
    for (const op of withStyleReplace({ ...ref, kind: o.rune.kind }, { op: "addRune", ref }, view))
      if (!ops.some((x) => JSON.stringify(x) === JSON.stringify(op))) ops.push(op);
  }
  return { state, ops };
}
