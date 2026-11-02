// src\runes\bare\vault-pending.ts — Modify's staged vault changes. Every checkbox in Modify (the vault pane, the Rune
// Library) flips an entry here instead of writing; Done turns the entries into one `rune_vault_edit`, Cancel drops
// them. Pure: no DOM, no IPC.
// An entry is the wanted on/off state of one target against the baseline it was flipped from; flipping back to the
// baseline deletes it, so add-then-unadd nets to nothing. Output styles stay exclusive over the pending state
// (style-pick.ts): switching one on switches the other effectively-on styles off, and the two entries are coupled, so
// switching the new one back restores the replaced one.
import type { RuneRef, SetSource, VaultOp } from "../../ipc";
import { OUTPUT_STYLE } from "./style-pick";

export type Target =
  | { t: "rune"; library: string; id: string; kind?: string }
  /** `styles`: the runeset's output-style members in set order (setTarget), so joining keeps one style on. */
  /** `only`: a Rune Library row picked in a runeset card the vault does not hold (libraryTargets) joins the runeset with
   *  that one of its `members` on; joining switches the others off in the vault's copy. */
  | { t: "set"; source: SetSource; styles?: RuneRef[]; members?: RuneRef[]; only?: RuneRef }
  | { t: "member"; set: SetSource; rune: RuneRef; kind?: string };

interface Entry { target: Target; on: boolean; base: boolean; coupled?: string[] }
export type Pending = Map<string, Entry>;
/** A target with the state the vault holds it in now. */
export interface Based { target: Target; base: boolean }

/** What the views get: read a target's state, flip it. */
export interface PendingCtl {
  on(t: Target, base: boolean): boolean;
  pending(t: Target): boolean;
  flip(t: Target, base: boolean): void;
  /** Sets every target to `on` (a library head, a library row held in more than one runeset). */
  set(ts: readonly Based[], on: boolean): void;
  /** Entries waiting for Done. */
  count: number;
  /** The staged entries (a runeset or one-off staged to join is drawn from these). */
  staged(): readonly Entry[];
}

const setKey = (s: SetSource): string => `${s.library}/${s.set}`;
/** A rune's `library/id`, the key a runeset's `off` list holds. */
export const refKey = (r: RuneRef): string => `${r.library}/${r.id}`;

export function targetKey(t: Target): string {
  switch (t.t) {
    case "rune": return `rune:${refKey(t)}`;
    case "set": return `set:${setKey(t.source)}`;
    case "member": return `member:${setKey(t.set)}:${refKey(t.rune)}`;
  }
}

export const effectiveOn = (p: Pending, t: Target, base: boolean): boolean => p.get(targetKey(t))?.on ?? base;
export const isPending = (p: Pending, t: Target): boolean => p.has(targetKey(t));
const isStyle = (t: Target): boolean => (t.t === "rune" || t.t === "member") && t.kind === OUTPUT_STYLE;

/** Sets `t` to `on`. `styles` are every output-style target the vault or the library offers, with their baselines;
 *  switching a style on switches the others off in the same step. */
export function setWanted(p: Pending, t: Target, base: boolean, on: boolean, styles: readonly Based[] = []): void {
  if (effectiveOn(p, t, base) === on) return;
  const key = targetKey(t);
  // switching back undoes what the switch coupled to it (a replaced style comes back)
  for (const k of p.get(key)?.coupled ?? []) if (p.get(k)?.coupled?.includes(key)) p.delete(k);
  // a runeset staged to join and unstaged again takes its member entries with it (a later pick may have left one)
  if (t.t === "set" && !on && !base)
    for (const [k, e] of [...p]) if (e.target.t === "member" && setKey(e.target.set) === setKey(t.source)) p.delete(k);
  const coupled: string[] = [];
  // a runeset joining with output styles picks its first (as launch keeps it); the rest go off in the vault's copy
  const own = t.t === "set" && on && !base ? t.styles ?? [] : [];
  if (on && (isStyle(t) || own.length)) {
    for (const o of styles) {
      const k = targetKey(o.target);
      if (k === key || !effectiveOn(p, o.target, o.base)) continue;
      // styles the replaced pick had replaced now hang on this one (A over C, then B: unticking B brings C back)
      for (const j of p.get(k)?.coupled ?? []) {
        const e = p.get(j);
        if (e?.coupled?.includes(k)) { e.coupled = [key]; coupled.push(j); }
      }
      if (o.base) { p.set(k, { target: o.target, on: false, base: true, coupled: [key] }); coupled.push(k); }
      else p.delete(k);
    }
    if (t.t === "set") for (const rune of own.slice(1)) {
      const m: Target = { t: "member", set: t.source, rune, kind: OUTPUT_STYLE };
      p.set(targetKey(m), { target: m, on: false, base: true, coupled: [key] });
      coupled.push(targetKey(m));
    }
  }
  // a runeset joining for one picked member: its other members go off in the vault's copy. Not coupled, so switching
  // one back on keeps the join; unstaging the runeset drops them (above).
  if (t.t === "set" && on && !base && t.only) for (const rune of t.members ?? []) {
    if (sameRef(rune, t.only)) continue;
    const m: Target = { t: "member", set: t.source, rune: { library: rune.library, id: rune.id } };
    if (!p.has(targetKey(m))) p.set(targetKey(m), { target: m, on: false, base: true });
  }
  if (on === base) p.delete(key);
  else p.set(key, { target: t, on, base, ...(coupled.length ? { coupled } : {}) });
}

export const flip = (p: Pending, t: Target, base: boolean, styles: readonly Based[] = []): void =>
  setWanted(p, t, base, !effectiveOn(p, t, base), styles);

/** Runesets pending removal: their member entries are left out of the ops. */
const removedSets = (p: Pending): Set<string> =>
  new Set([...p.values()].filter((e) => e.target.t === "set" && !e.on).map((e) => setKey((e.target as { source: SetSource }).source)));

/** The `member` op that switches rune `rune` of placed runeset `set` to `on` (L3d: edits the vault's copy only). */
export const memberOp = (set: SetSource, rune: RuneRef, on: boolean): VaultOp =>
  ({ op: "member", ref: { library: set.library, runeset: set.set, rune: { library: rune.library, id: rune.id }, on } });

/** One op list for Done: runesets added, runesets removed, one-offs added, one-offs removed, members last (so a member
 *  op can act on a runeset added in the same batch). */
export function pendingOps(p: Pending): VaultOp[] {
  const gone = removedSets(p);
  const sets: VaultOp[] = [], unsets: VaultOp[] = [], adds: VaultOp[] = [], removes: VaultOp[] = [];
  const members = new Map<string, VaultOp>();
  for (const e of p.values()) {
    const t = e.target;
    if (t.t === "set") (e.on ? sets : unsets).push({ op: e.on ? "addRuneset" : "removeRuneset", ref: t.source });
    else if (t.t === "rune") (e.on ? adds : removes).push({ op: e.on ? "addRune" : "removeRune", ref: { library: t.library, id: t.id } });
    else if (gone.has(setKey(t.set))) continue;
    else members.set(`${setKey(t.set)}:${refKey(t.rune)}`, memberOp(t.set, t.rune, e.on));
  }
  return [...sets, ...unsets, ...adds, ...removes, ...members.values()];
}

/** The shape of a vault read this module needs (cake.ts VaultView). */
export interface VaultShape {
  vault: { runesets: { source: SetSource }[]; runes: RuneRef[] };
  runes: readonly { library: string; id: string; set: SetSource | null; kind?: string }[];
  off?: readonly { library: string; id: string; set: SetSource | null; kind?: string }[];
}

/** A Rune Library runeset head's target: the runeset with its output-style members in set order (`library` gives the
 *  kinds), so switching it on keeps one style (setWanted). */
export function setTarget(source: SetSource, sets: readonly { library: string; set: string; members: readonly RuneRef[] }[],
  library: readonly (RuneRef & { kind?: string })[]): Target {
  const members = sets.find((s) => sameSet(source, s))?.members ?? [];
  const styles = members.filter((m) => library.some((r) => sameRef(r, m) && r.kind === OUTPUT_STYLE)).map((m) => ({ library: m.library, id: m.id }));
  return { t: "set", source: { library: source.library, set: source.set }, ...(styles.length ? { styles } : {}) };
}

/** Every output-style target the vault, a runeset staged to join (its copy starts whole, so on) or the library offers,
 *  with its saved state: the `styles` setWanted switches off when a style is picked. */
export function styleTargets(v: VaultShape, p: Pending, library: readonly (RuneRef & { kind?: string })[] = []): Based[] {
  const out = new Map<string, Based>();
  for (const [r, held] of [...v.runes.map((r) => [r, true] as const), ...(v.off ?? []).map((r) => [r, false] as const)]) {
    if (r.kind !== OUTPUT_STYLE) continue;
    const t: Target | null = !r.set ? { t: "rune", library: r.library, id: r.id, kind: r.kind }
      : placed(v, r.set) ? { t: "member", set: r.set, rune: { library: r.library, id: r.id }, kind: r.kind } : null;
    if (t) out.set(targetKey(t), { target: t, base: t.t === "rune" ? v.vault.runes.some((x) => sameRef(x, r)) : held });
  }
  for (const e of p.values()) {
    const s = e.target;
    if (s.t !== "set" || !e.on || e.base) continue;
    for (const rune of s.styles ?? []) {
      const t: Target = { t: "member", set: s.source, rune, kind: OUTPUT_STYLE };
      out.set(targetKey(t), { target: t, base: true });
    }
  }
  for (const r of library) if (r.kind === OUTPUT_STYLE)
    for (const b of libraryTargets(v, p, r)) if (!out.has(targetKey(b.target))) out.set(targetKey(b.target), b);
  return [...out.values()];
}

const sameSet =(a: SetSource | null, b: SetSource): boolean => !!a && a.library === b.library && a.set === b.set;
export const sameRef = (a: RuneRef, b: RuneRef): boolean => a.library === b.library && a.id === b.id;
const placed = (v: VaultShape, s: SetSource): boolean => v.vault.runesets.some((r) => sameSet(r.source, s));

/** The state `t` holds in vault read `v`; null when the target is gone (an unplaced runeset's member, a rune the
 *  runeset no longer lists). */
export function baseOf(v: VaultShape, t: Target): boolean | null {
  switch (t.t) {
    case "rune": return v.vault.runes.some((r) => sameRef(r, t));
    case "set": return placed(v, t.source);
    case "member": {
      if (!placed(v, t.set)) return null;
      if (v.runes.some((r) => sameSet(r.set, t.set) && sameRef(r, t.rune))) return true;
      if ((v.off ?? []).some((r) => sameSet(r.set, t.set) && sameRef(r, t.rune))) return false;
      return null;
    }
  }
}

/** Re-baselines every entry on a fresh read: drops what the vault already holds as wanted, and what is gone (a member
 *  of a runeset neither placed nor pending add). */
export function prune(p: Pending, v: VaultShape): void {
  const adding = new Set([...p.values()].filter((e) => e.target.t === "set" && e.on).map((e) => setKey((e.target as { source: SetSource }).source)));
  for (const [k, e] of [...p]) {
    const b = baseOf(v, e.target);
    if (b === null) {
      const t = e.target as { set: SetSource };
      if (!adding.has(setKey(t.set))) p.delete(k);
      continue;
    }
    if (b === e.on) p.delete(k);
    else e.base = b;
  }
}

/** Drops the entries naming a deleted library rune (or every rune of a deleted library). */
export function forget(p: Pending, library: string, id?: string): void {
  for (const [k, e] of [...p]) {
    const t = e.target;
    const r = t.t === "rune" ? t : t.t === "member" ? t.rune : null;
    if (r && r.library === library && (id === undefined || r.id === id)) p.delete(k);
  }
}

/** Drops the entries naming a deleted runeset: the runeset itself and its members. */
export function forgetSet(p: Pending, s: SetSource): void {
  for (const [k, e] of [...p]) {
    const t = e.target;
    const set = t.t === "set" ? t.source : t.t === "member" ? t.set : null;
    if (set && setKey(set) === setKey(s)) p.delete(k);
  }
}

/** What a Rune Library row's tick switches (Q4): a one-off the vault holds (on or off) switches as a one-off; a rune
 *  placed runesets hold switches as a member of each (runesets pending removal left out), and a member of each
 *  runeset staged to join whose library runeset (`sets`) names it (its copy starts whole, so on); a row on the card of
 *  library runeset `card`, which the vault does not hold, joins that runeset with only this member on; anything else
 *  is a new one-off. */
export function libraryTargets(v: VaultShape, p: Pending, r: RuneRef & { kind?: string },
  sets: readonly { library: string; set: string; members: readonly RuneRef[] }[] = [], card?: SetSource): Based[] {
  const kind = r.kind;
  const one = { t: "rune" as const, library: r.library, id: r.id, ...(kind ? { kind } : {}) };
  if (v.vault.runes.some((x) => sameRef(x, r))) return [{ target: one, base: true }];
  if ((v.off ?? []).some((x) => !x.set && sameRef(x, r))) return [{ target: one, base: false }];
  const gone = removedSets(p);
  const out: Based[] = [];
  for (const { source } of v.vault.runesets) {
    if (gone.has(setKey(source))) continue;
    const held = v.runes.some((x) => sameSet(x.set, source) && sameRef(x, r));
    const off = !held && (v.off ?? []).some((x) => sameSet(x.set, source) && sameRef(x, r));
    if (held || off) out.push({ target: { t: "member", set: source, rune: { library: r.library, id: r.id }, ...(kind ? { kind } : {}) }, base: held });
  }
  const membersOf = (s: SetSource): readonly RuneRef[] => sets.find((x) => sameSet(s, x))?.members ?? [];
  const ref = { library: r.library, id: r.id };
  for (const e of p.values()) {
    const t = e.target;
    if (t.t !== "set" || !e.on || e.base || !membersOf(t.source).some((m) => sameRef(m, r))) continue;
    out.push({ target: { t: "member", set: t.source, rune: ref, ...(kind ? { kind } : {}) }, base: true });
  }
  if (out.length) return out;
  const members = card && !placed(v, card) ? membersOf(card) : [];
  if (card && members.some((m) => sameRef(m, r))) {
    const t: Target = { t: "set", source: { library: card.library, set: card.set }, members: members.map((m) => ({ library: m.library, id: m.id })),
      only: ref, ...(kind === OUTPUT_STYLE ? { styles: [ref] } : {}) };
    return [{ target: t, base: false }];
  }
  return [{ target: one, base: false }];
}

/** A Rune Library row: ticked when any of its targets is effectively on; pending when any of them is staged. */
export function rowState(p: Pending, ts: readonly Based[]): { on: boolean; pending: boolean } {
  return { on: ts.some((b) => effectiveOn(p, b.target, b.base)), pending: ts.some((b) => isPending(p, b.target)) };
}
