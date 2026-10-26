// src\runes\bare\view-vault.ts — Modify on a tab's Rune Vault (run 2026-10-25-rune-vault, L3b2).
// One card per runeset (its head switch adds or removes the runeset) and one card per library of one-off runes
// (each rune's switch adds or removes it). Every switch hands its ops to `edit`, which goes through vault-edit.ts:
// nothing here reads or writes a launcher row. A runeset's slotted runes switch through the `member` op (L3d),
// which edits only the vault's copy; a recall member has no slot line, so its switch stays disabled with a
// tooltip. Add Rune lists the agent's library runes the vault does not hold (rune_vault_library_runes) and adds one
// as a one-off through the same path. Reuses the library card, rune card and switch chip; no new look.
import type { RuneRef, SetSource, VaultOp } from "../../ipc";
import type { CardCtx } from "../cards";
import { setCard, setHead } from "../set-card";
import { nameLabel } from "./row-name";
import { btn, el } from "./agent-view";
import { vaultLibraries, type VaultView, type VaultViewRune } from "./cake";
import { hueOf } from "./view-data";
import { runeCard, runeSwitch } from "./view-sets";
import { costBar } from "./cost-bar";
import { stateTooltip } from "./rune-state";
import { choiceCard, EDIT_ORIGINAL_NOTE, EDIT_ORIGINAL_RESTART, type VaultPick } from "./vault-edit";

export const LOCKED_EDIT_TEXT = `This vault is locked. ${EDIT_ORIGINAL_NOTE}`;
export const DRIFT_TEXT = `A rune changed in its library after this vault locked. ${EDIT_ORIGINAL_NOTE}`;
const TIP_SET_MEMBER = "Part of a runeset that is off; switch the runeset on to change it.";
const TIP_RECALL_MEMBER = "Joins this runeset through recall; switch the runeset off to drop it.";
const TIP_MEMBER = "Changes this vault's copy of the runeset; the library runeset stays as it is.";
const TIP_RUNESET = "Adds or removes this runeset in the tab's vault.";
const TIP_ADD_RUNE = "Adds a rune from your libraries to this tab's vault on its own.";
const TIP_ADD_NONE = "Every rune your libraries offer this agent is already in this vault.";
const TIP_ADD_KIT ="Makes a Kit set from your skills, agents, hooks and MCP servers and adds it to this tab's vault.";

/** An edit waiting on the user's Make Variant / Edit Original pick; `ops` may be empty (a drift answer). */
export interface PendingEdit { ops: VaultOp[]; text: string }

export interface VaultModifyCtx {
  /** The vault as it is now (read without a hash). */
  view: VaultView;
  /** Runes and runesets this view removed, kept so their switches can put them back (the reply no longer has them). */
  removed: VaultViewRune[];
  pending: PendingEdit | null;
  busy: boolean;
  readOnly?: boolean;
  card: CardCtx;
  trackOpen(det: HTMLDetailsElement, key: string, dflt: boolean): void;
  /** Runs `ops` through the vault edit path (asks before a locked edit). */
  edit(ops: VaultOp[]): void;
  /** The user's pick on the choice card for the pending edit. */
  pick(p: VaultPick): Promise<void>;
  /** Add Kit (kit-add.ts, then the vault edit path); absent, no button. */
  addKit?: () => void;
  /** The last Add Kit's outcome: Kit or Kit Attached, the skipped count in the tooltip. */
  kitNotice?: { attached: boolean; skipped: number } | null;
  /** Add Rune's list (the agent's library runes), null while closed; drawn deduped against the vault. */
  library?: VaultViewRune[] | null;
  /** Opens or closes Add Rune's list; absent, no button. */
  addRune?: () => void;
  attachments?: (set: SetSource, runes: VaultViewRune[]) => HTMLElement[];
}

const sameRef = (a: { library: string; id: string }, b: RuneRef): boolean => a.library === b.library && a.id === b.id;
const sameSet = (a: SetSource | null, b: SetSource): boolean => !!a && a.library === b.library && a.set === b.set;

/** A rune's `library/id`, the key `off` lists. */
export const memberKey = (r: { library: string; id: string }): string => `${r.library}/${r.id}`;

/** The `member` op that switches rune `r` of placed runeset `set` to `on` (L3d: edits the vault's copy only). */
export const memberOp = (set: SetSource, r: { library: string; id: string }, on: boolean): VaultOp =>
  ({ op: "member", ref: { library: set.library, runeset: set.set, rune: { library: r.library, id: r.id }, on } });

/** Pure: Add Rune's list less every rune the vault already draws (in a runeset or as a one-off, switched off
 *  included), keyed by library and id. */
export function addable(library: readonly VaultViewRune[], view: { vault: VaultView["vault"]; runes: VaultViewRune[] },
  removed: readonly VaultViewRune[] = []): VaultViewRune[] {
  const held = [...view.runes, ...removed, ...view.vault.runes];
  return library.filter((r) => !held.some((h) => sameRef(h, r)));
}

/** Pure: the vault's runesets and one-off runes, with what this view removed marked off. A rune switched out of a
 *  placed runeset stays in that runeset's list with its key in `off`. */
export function vaultGroups(view: { vault: VaultView["vault"]; runes: VaultViewRune[] }, removed: readonly VaultViewRune[]): {
  sets: { source: SetSource; on: boolean; runes: VaultViewRune[]; off: string[] }[];
  oneOffs: { rune: VaultViewRune; on: boolean }[];
} {
  const sets = new Map<string, { source: SetSource; on: boolean; runes: VaultViewRune[]; off: string[] }>();
  const placed = view.vault.runesets.map((r) => r.source);
  for (const s of placed) sets.set(`${s.library}/${s.set}`, { source: s, on: true, runes: [], off: [] });
  const oneOffs: { rune: VaultViewRune; on: boolean }[] = [];
  for (const r of view.runes) {
    if (r.set) sets.get(`${r.set.library}/${r.set.set}`)?.runes.push(r);
    else oneOffs.push({ rune: r, on: view.vault.runes.some((x) => sameRef(r, x)) });
  }
  for (const r of removed) {
    if (r.set) {
      const key = `${r.set.library}/${r.set.set}`;
      if (placed.some((s) => sameSet(r.set, s))) {
        const g = sets.get(key)!;
        if (!g.runes.some((x) => sameRef(x, r))) { g.runes.push(r); g.off.push(memberKey(r)); }
        continue;
      }
      const g = sets.get(key) ?? { source: r.set, on: false, runes: [], off: [] };
      g.runes.push(r);
      sets.set(key, g);
    } else if (!oneOffs.some((o) => sameRef(o.rune, r))) oneOffs.push({ rune: r, on: false });
  }
  return { sets: [...sets.values()], oneOffs };
}

/** Modify's body for a tab with a vault record: the choice card (a pending locked edit, or a locked vault whose
 *  library runes drifted), then the runeset cards and the one-off cards. */
export function vaultModify(c: VaultModifyCtx): HTMLElement[] {
  const out: HTMLElement[] = [];
  const v = c.view.vault;
  if (!c.readOnly && c.pending) out.push(choiceCard(c.pick, `${c.pending.text} ${EDIT_ORIGINAL_RESTART}`));
  else if (!c.readOnly && v.lockedUtc && c.view.drift.length) out.push(choiceCard(c.pick, `${DRIFT_TEXT} ${EDIT_ORIGINAL_RESTART}`));
  const g = vaultGroups(c.view, c.removed);
  const group = el("section", "runes-group");
  for (const s of g.sets) {
    const sw = runeSwitch(s.on ? "on" : "off", c.busy, `${stateTooltip(s.on ? "on" : "off")}\n${TIP_RUNESET}`,
      () => c.edit([{ op: s.on ? "removeRuneset" : "addRuneset", ref: s.source }]));
    const cond = el("span", "runes-cond");
    if (!c.readOnly) cond.appendChild(sw);
    // one card per runeset: its bricks are keyed by id, so a member is found by id (first match)
    const byId = (id: string): VaultViewRune | undefined => s.runes.find((r) => r.id === id);
    const offHere = (id: string): boolean => { const r = byId(id); return !!r && s.off.includes(memberKey(r)); };
    const setCard = libCard(c, s.runes, nameLabel(s.source.set) || s.source.set, `set:${s.source.library}/${s.source.set}`, cond, !s.on, (id) => {
      const r = byId(id);
      // a recall member joins by its own header, not a slot line, and a switched-off runeset has no copy to edit
      if (!r || r.recall || !s.on) return [runeSwitch(s.on ? "on" : "off", true, r?.recall && s.on ? TIP_RECALL_MEMBER : TIP_SET_MEMBER, () => undefined)];
      const state = offHere(id) ? "off" : "on";
      return c.readOnly ? [] : [runeSwitch(state, c.busy, `${stateTooltip(state)}\n${TIP_MEMBER}`, () => c.edit([memberOp(s.source, r, state === "off")]))];
    }, (id) => !s.on || offHere(id));
    if (!c.readOnly && s.on) setCard.append(...(c.attachments?.(s.source, s.runes) ?? []));
    group.appendChild(setCard);
  }
  const libs = new Map<string, { rune: VaultViewRune; on: boolean }[]>();
  for (const o of g.oneOffs) libs.set(o.rune.library, [...(libs.get(o.rune.library) ?? []), o]);
  for (const [library, rs] of libs) {
    const on = new Map(rs.map((o) => [o.rune.id, o.on]));
    group.appendChild(libCard(c, rs.map((o) => o.rune), nameLabel(library) || library, `one:${library}`, null, false, (id) => {
      const state = on.get(id) ? "on" : "off";
      return c.readOnly ? [] : [runeSwitch(state, c.busy, stateTooltip(state), () => c.edit([{ op: state === "on" ? "removeRune" : "addRune", ref: { library, id } }]))];
    }, (id) => !on.get(id)));
  }
  if (group.childElementCount) out.push(group);
  const actions = el("div", "rp-actions");
  if (c.addKit) { const add = btn("Add Kit", "ws-btn", c.addKit, c.busy); add.title = TIP_ADD_KIT; actions.appendChild(add); }
  if (c.kitNotice) {
    const chip = el("span", "runes-chip also", c.kitNotice.attached ? "Kit Attached" : "Kit");
    if (c.kitNotice.skipped) chip.title = `Add Kit · ${c.kitNotice.skipped} Skipped`;
    actions.appendChild(chip);
  }
  const adds = c.library ? addable(c.library, c.view, c.removed) : null;
  if (c.addRune) {
    const add = btn("Add Rune", "ws-btn", c.addRune, c.busy);
    add.title = adds && !adds.length ? TIP_ADD_NONE : TIP_ADD_RUNE;
    add.setAttribute("aria-pressed", String(!!c.library));
    actions.appendChild(add);
  }
  if (actions.childElementCount) out.push(actions);
  if (adds?.length) out.push(addRuneList(c, adds));
  return out;
}

/** Add Rune's list: one library card per library, each rune switched off; its switch adds it as a one-off. */
function addRuneList(c: VaultModifyCtx, runes: VaultViewRune[]): HTMLElement {
  const group = el("section", "runes-group");
  const libs = new Map<string, VaultViewRune[]>();
  for (const r of runes) libs.set(r.library, [...(libs.get(r.library) ?? []), r]);
  for (const [library, rs] of libs) {
    group.appendChild(libCard(c, rs, nameLabel(library) || library, `add:${library}`, null, true,
      (id) => [runeSwitch("off", c.busy, `${stateTooltip("off")}\n${TIP_ADD_RUNE}`, () => c.edit([{ op: "addRune", ref: { library, id } }]))]));
  }
  return group;
}

function libCard(c: VaultModifyCtx, runes: VaultViewRune[], name: string, key: string, cond: HTMLElement | null, dimAll: boolean,
  tail: (id: string) => HTMLElement[], dim: (id: string) => boolean = () => dimAll): HTMLElement {
  // one card here is one runeset (cross-library slots included) or one library's one-offs: group them under one name
  const lib = vaultLibraries({ runes: runes.map((r) => ({ ...r, set: null, library: key })) })[0]
    ?? { library: name, source: null, scope: "global" as const, sourceGone: false, bricks: [], sets: [], onDemand: [] };
  const bricks = [...lib.bricks, ...(lib.onDemand ?? [])];
  const on = bricks.filter((b) => !dim(b.id)).length;
  if (c.readOnly) {
    const cost = costBar(lib);
    if (cost) { cond ??= el("span", "runes-cond"); cond.appendChild(cost); }
  }
  const det = setCard(hueOf(lib), setHead(name, `${on}/${bricks.length}`, "globe", cond ?? undefined));
  det.dataset.library = runes[0]?.set?.library ?? runes[0]?.library ?? key;
  c.trackOpen(det, key, false);
  const tray = el("div", "runes-tray");
  for (const b of bricks) {
    const card = runeCard(lib, b, { dim: dim(b.id), tail: tail(b.id), card: c.card });
    c.trackOpen(card, `rune:${key}:${b.id}`, false);
    tray.appendChild(card);
  }
  if (tray.childElementCount) det.appendChild(tray);
  return det;
}
