// src\runes\bare\rune-groups.ts — the one grouping function behind both Runes panes. The Rune Library (view-library.ts)
// and the vault view (view-vault.ts) hand it their runesets and runes; it returns the runeset groups and the Rune
// Satchel, so a rune sits in the same group on either side. Pure, no DOM.
//
// A rune with `set` joins that group (an unlisted set is appended, off). A rune without `set` joins every set whose
// `members` name it. A set with members and none present drops; a set with no members stays. The satchel is every
// other rune, once. The left pane passes library runesets (members) and library runes (`set: null`); the right pane
// passes the placed copies (on) with `members: []`, the runesets staged to join (`joining`) with their library
// runeset's members drawn from `pool` (the library runes), and the vault's runes with their `set` already set.
import type { RuneRef, SetSource } from "../../ipc";
import type { VaultViewRune } from "./cake";
import { refKey, sameRef } from "./vault-pending";

export const SATCHEL_TITLE = "Rune Satchel";
export const REPO_SKILLS_TITLE = "Repo Skills";
export const CODEX_FILES_TITLE = "Codex Folder";
export const TIP_CODEX_FILE = "Loaded: Codex reads this trusted folder's .codex settings";
export const TIP_REPO_SKILL_OFF = "Off: Vidar turns repo skills off unless the vault places a skill of the same name";

interface GroupSetIn{ source: SetSource; members: readonly RuneRef[]; on: boolean; joining?: boolean }
export interface RuneGroupsIn {
  sets: readonly GroupSetIn[];
  /** The runes the vault (or the library) holds on. */
  runes: readonly VaultViewRune[];
  /** Runes the vault holds off (`view.off`) and runes this view removed; listed off, in their runeset when they have one. */
  off?: readonly VaultViewRune[];
  removed?: readonly VaultViewRune[];
  /** Loose runes the vault holds on, by ref; every other loose rune reads off. Absent, all read off. */
  held?: readonly RuneRef[];
  /** Runes a set's `members` may name that the pane's own list lacks (the vault pane: library runes, for a runeset
   *  staged to join). */
  pool?: readonly VaultViewRune[];
  /** Library runes staged to add: shown in the satchel, off, past `keep`. */
  staged?: readonly VaultViewRune[];
  /** The hide-off filter for a satchel rune and its state; absent, every one stays. */
  keep?: (rune: VaultViewRune, on: boolean) => boolean;
}
interface RuneGroup{ source: SetSource; on: boolean; joining: boolean; runes: VaultViewRune[]; off: string[] }
export interface RuneGroupsOut { sets: RuneGroup[]; satchel: { rune: VaultViewRune; on: boolean }[] }

export function runeGroups(a: RuneGroupsIn): RuneGroupsOut {
  const groups = new Map<string, RuneGroup>();
  const members = new Map<string, readonly RuneRef[]>();
  const keyOf = (s: SetSource): string => `${s.library}/${s.set}`;
  const add = (s: GroupSetIn): void => {
    const k = keyOf(s.source);
    if (groups.has(k)) return;
    groups.set(k, { source: s.source, on: s.on, joining: !!s.joining, runes: [], off: [] });
    members.set(k, s.members);
  };
  for (const s of a.sets) if (!s.joining) add(s);
  const loose: VaultViewRune[] = [];
  const looseOff: VaultViewRune[] = [];
  for (const r of a.runes) {
    if (!r.set) { loose.push(r); continue; }
    // a rune two placed runesets hold loads once (under `set`) and sits in each one's list (`also`)
    for (const s of [r.set, ...(r.also ?? [])]) {
      const k = keyOf(s);
      if (!groups.has(k)) add({ source: s, members: [], on: false });
      const g = groups.get(k)!;
      if (!g.runes.some((x) => sameRef(x, r))) g.runes.push(r);
    }
  }
  for (const r of [...(a.off ?? []), ...(a.removed ?? [])]) {
    if (!r.set) { if (!looseOff.some((x) => sameRef(x, r))) looseOff.push(r); continue; }
    const k = keyOf(r.set);
    const known = groups.has(k);
    if (!known) add({ source: r.set, members: [], on: false });
    const g = groups.get(k)!;
    if (g.runes.some((x) => sameRef(x, r))) continue;
    g.runes.push(r);
    // a rune switched out of a placed runeset stays in its list with its key in `off`; an off runeset reads off whole
    if (known && g.on) g.off.push(refKey(r));
  }
  for (const s of a.sets) if (s.joining) add(s);
  // loose runes join every set whose members name them, in the member order
  const onLoose = (r: VaultViewRune): boolean => a.held ? a.held.some((x) => sameRef(x, r)) : false;
  for (const [k, ms] of members) {
    const g = groups.get(k)!;
    for (const m of ms) {
      const r = loose.find((x) => sameRef(x, m)) ?? a.pool?.find((x) => sameRef(x, m));
      if (r && !g.runes.some((x) => sameRef(x, r))) g.runes.push(r);
    }
  }
  // a joining set stays, its runes still loading or not
  const sets = [...groups.entries()].filter(([k, g]) => g.joining || !members.get(k)!.length || g.runes.length).map(([, g]) => g);
  const inSet = (r: VaultViewRune): boolean => sets.some((g) => g.runes.some((x) => sameRef(x, r)));
  const satchel: RuneGroupsOut["satchel"] = [];
  const put = (r: VaultViewRune, on: boolean): void => { if (!satchel.some((o) => sameRef(o.rune, r))) satchel.push({ rune: r, on }); };
  for (const r of loose) if (!inSet(r)) { const on = onLoose(r); if (!a.keep || a.keep(r, on)) put(r, on); }
  for (const r of looseOff) if (!inSet(r) && (!a.keep || a.keep(r, false))) put(r, false);
  for (const r of a.staged ?? []) if (!inSet(r)) put(r, false);
  return { sets, satchel };
}
