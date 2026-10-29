// src\runes\bare\view-vault.ts — Modify on a tab's Rune Vault.
// One card per runeset (its head switch adds or removes the runeset) and one card per library of one-off runes
// (each rune's switch adds or removes it). Every switch hands its ops to `edit`, which goes through vault-edit.ts:
// nothing here reads or writes a launcher row. A runeset's runes switch through the `member` op, which edits
// only the vault's copy: a slotted rune's line, or a recall member's id in the copy's `recall-off` header (the
// reply's `off` list, drawn off). Add Rune lists the agent's library runes the vault does not hold (rune_vault_library_runes) and adds one
// as a one-off through the same path. Switching an output style on also switches the vault's other style off in the
// same edit (style-pick.ts: picking replaces). Reuses the library card and rune card; in Modify each switch is the
// checkbox left of its bar or head (check-box.ts, mock runes-modify-toggles B); a one-off library's head batches its
// runes' ops (library-toggle.ts). Read mode keeps the switch chip on an off runeset's runes.
import type { RuneRef, SetSource, VaultOp } from "../../ipc";
import { runeName, type CardCtx } from "../cards";
import type { RuneItem } from "../types";
import { setCard, setHead } from "../set-card";
import { byKind, kindGroup } from "../kind-groups";
import { nameLabel } from "./row-name";
import { btn, el } from "./agent-view";
import { vaultLibraries, type VaultView, type VaultViewRune } from "./cake";
import { hueOf } from "./view-data";
import { runeCard, runeSwitch } from "./view-sets";
import { stateLabel, stateTooltip } from "./rune-state";
import { checkBox, checkRow, checkSlot, type CheckState } from "../check-box";
import { libraryToggle } from "./library-toggle";
import { choiceCard, EDIT_ORIGINAL_NOTE, EDIT_ORIGINAL_RESTART, type VaultPick } from "./vault-edit";
import { withStyleReplace } from "./style-pick";
import { loadReason, notCarriedIds, runeWasRead } from "./load-reason";
import type { RunesLoaded } from "../types";
import {
  DELETE_LIBRARY_LABEL, DELETE_RUNE_LABEL, deletable, deleteButton, deleteConfirm, type DeleteTarget,
} from "./library-delete";

export const LOCKED_EDIT_TEXT = `This vault is locked. ${EDIT_ORIGINAL_NOTE}`;
export const DRIFT_TEXT = `A rune changed in its library after this vault locked. ${EDIT_ORIGINAL_NOTE}`;
const TIP_SET_MEMBER = "Part of a runeset that is off; switch the runeset on to change it.";
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
  /** The tab's loads result; each card's tooltip says why its rune loaded or not (load-reason.ts). Absent, no line. */
  loads?: RunesLoaded | null;
  /** Delete Rune / Delete Library (library-delete.ts): asking sets `deleting`, which draws the confirm card. */
  deleting?: DeleteTarget | null;
  askDelete?: (t: DeleteTarget) => void;
  confirmDelete?: () => void;
  cancelDelete?: () => void;
}

const TIP_DELETE_RUNE = "Moves this rune out of its library into the library backup.";
const TIP_DELETE_LIBRARY = "Moves this whole library into the library backup.";
const TIP_LIBRARY = "Switches every rune of this library on or off in the tab's vault.";
const SOME_ON = "Some On";

/** A rune row's controls in Modify: the checkbox left of the bar, and the chips at the bar's end. */
interface RuneCtl { check?: HTMLElement; tail: HTMLElement[] }

/** Modify's checkbox with the switch's label and tooltip (check-box.ts). */
const runeCheck = (state: CheckState, disabled: boolean, title: string, flip: () => void): HTMLElement =>
  checkBox({ state, disabled, title, label: state === "mixed" ? `State: ${SOME_ON}` : stateLabel(state), flip });

const canDelete = (c: VaultModifyCtx, library: string): boolean => !!c.askDelete && !c.readOnly && deletable(library);

/** Delete Rune on a library rune's card, for a library the store lets go of. */
function deleteTail(c: VaultModifyCtx, library: string, id: string): HTMLElement[] {
  return canDelete(c, library) ? [deleteButton(DELETE_RUNE_LABEL, TIP_DELETE_RUNE, () => c.askDelete!({ library, id }), c.busy)] : [];
}

/** Delete Library under a library's card. */
function withDeleteLibrary(c: VaultModifyCtx, det: HTMLElement, library: string): HTMLElement {
  if (canDelete(c, library)) {
    const b = deleteButton(DELETE_LIBRARY_LABEL, TIP_DELETE_LIBRARY, () => c.askDelete!({ library }), c.busy);
    b.classList.add("runes-lib-delete");
    det.appendChild(b);
  }
  return det;
}

const sameRef = (a: { library: string; id: string }, b: RuneRef): boolean => a.library === b.library && a.id === b.id;
const sameSet = (a: SetSource | null, b: SetSource): boolean => !!a && a.library === b.library && a.set === b.set;

/** A rune's `library/id`, the key `off` lists. */
export const memberKey = (r: { library: string; id: string }): string => `${r.library}/${r.id}`;

/** The `member` op that switches rune `r` of placed runeset `set` to `on` (L3d: edits the vault's copy only). */
export const memberOp = (set: SetSource, r: { library: string; id: string }, on: boolean): VaultOp =>
  ({ op: "member", ref: { library: set.library, runeset: set.set, rune: { library: r.library, id: r.id }, on } });

/** Pure: Add Rune's list less every rune the vault already draws (in a runeset or as a one-off, switched off
 *  included: this view's `removed` and the reply's `off`), keyed by library and id. */
export function addable(library: readonly VaultViewRune[], view: { vault: VaultView["vault"]; runes: VaultViewRune[]; off?: VaultViewRune[] },
  removed: readonly VaultViewRune[] = []): VaultViewRune[] {
  const held = [...view.runes, ...(view.off ?? []), ...removed, ...view.vault.runes];
  return library.filter((r) => !held.some((h) => sameRef(h, r)));
}

/** Pure: the vault's runesets and one-off runes, with what this view removed marked off. A rune switched out of a
 *  placed runeset stays in that runeset's list with its key in `off`, as does a member the vault's copy holds off
 *  and a one-off the vault holds off (`view.off`, `rune_vault_read`'s list; absent when none), so the switch
 *  survives Done and a variant. */
export function vaultGroups(view: { vault: VaultView["vault"]; runes: VaultViewRune[]; off?: VaultViewRune[] }, removed: readonly VaultViewRune[]): {
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
  for (const r of [...(view.off ?? []), ...removed]) {
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
  if (!c.readOnly && c.deleting && c.confirmDelete && c.cancelDelete) {
    const t = c.deleting;
    out.push(deleteConfirm(t.id ?? (nameLabel(t.library) || t.library), c.confirmDelete, c.cancelDelete));
  }
  const g = vaultGroups(c.view, c.removed);
  const group = el("section", "runes-group");
  const offered = new Set<string>();
  for (const s of g.sets) {
    // Modify: the runeset's checkbox opens the head; read mode draws none
    const head = c.readOnly ? undefined : runeCheck(s.on ? "on" : "off", c.busy, `${stateTooltip(s.on ? "on" : "off")}\n${TIP_RUNESET}`,
      () => c.edit([{ op: s.on ? "removeRuneset" : "addRuneset", ref: s.source }]));
    // one card per runeset: its bricks are keyed by id, so a member is found by id (first match)
    const byId = (id: string): VaultViewRune | undefined => s.runes.find((r) => r.id === id);
    const offHere = (id: string): boolean => { const r = byId(id); return !!r && s.off.includes(memberKey(r)); };
    const setCard = libCard(c, s.runes, nameLabel(s.source.set) || s.source.set, `set:${s.source.library}/${s.source.set}`, null, !s.on, (id) => {
      const r = byId(id);
      // a switched-off runeset has no copy to edit; a recall member switches in the copy's header
      if (!r || !s.on) {
        const st = s.on ? "on" : "off";
        return c.readOnly ? { tail: [runeSwitch(st, true, TIP_SET_MEMBER, () => undefined)] }
          : { check: runeCheck(st, true, TIP_SET_MEMBER, () => undefined), tail: [] };
      }
      const state = offHere(id) ? "off" : "on";
      const op = memberOp(s.source, r, state === "off");
      return c.readOnly ? { tail: [] } : { check: runeCheck(state, c.busy, `${stateTooltip(state)}\n${TIP_MEMBER}`,
        () => c.edit(state === "off" ? withStyleReplace(r, op, c.view) : [op])), tail: [] };
    }, (id) => !s.on || offHere(id), true, head);
    if (!c.readOnly && s.on) setCard.append(...(c.attachments?.(s.source, s.runes) ?? []));
    // a library placed only as runesets (Add Kit) has no one-off card: its first runeset card offers Delete Library
    if (!offered.has(s.source.library) && !g.oneOffs.some((o) => o.rune.library === s.source.library)) {
      offered.add(s.source.library);
      withDeleteLibrary(c, setCard, s.source.library);
    }
    group.appendChild(setCard);
  }
  const libs = new Map<string, { rune: VaultViewRune; on: boolean }[]>();
  for (const o of g.oneOffs) libs.set(o.rune.library, [...(libs.get(o.rune.library) ?? []), o]);
  for (const [library, rs] of libs) {
    const on = new Map(rs.map((o) => [o.rune.id, o.on]));
    // one-offs have no runeset op: the head batches the per-rune ops into one edit (library-toggle.ts)
    const lt = libraryToggle(library, rs, c.view);
    const head = c.readOnly ? undefined : runeCheck(lt.state, c.busy || !lt.ops.length,
      lt.state === "mixed" ? `${SOME_ON}\n${TIP_LIBRARY}` : `${stateTooltip(lt.state)}\n${TIP_LIBRARY}`, () => c.edit(lt.ops));
    group.appendChild(withDeleteLibrary(c, libCard(c, rs.map((o) => o.rune), nameLabel(library) || library, `one:${library}`, null, false, (id) => {
      const state = on.get(id) ? "on" : "off";
      const r = rs.find((o) => o.rune.id === id)?.rune;
      const add = (): VaultOp[] => withStyleReplace({ library, id, kind: r?.kind ?? "" }, { op: "addRune", ref: { library, id } }, c.view);
      return c.readOnly ? { tail: [] } : { check: runeCheck(state, c.busy, stateTooltip(state),
        () => c.edit(state === "on" ? [{ op: "removeRune", ref: { library, id } }] : add())), tail: deleteTail(c, library, id) };
    }, (id) => !on.get(id), true, head), library));
  }
  if (group.childElementCount) out.push(group);
  const actions = el("div", "rp-actions");
  if (c.addKit) { const add = btn("Add Kit", "ws-btn", c.addKit, c.busy); add.title = TIP_ADD_KIT; actions.appendChild(add); }
  const adds = c.library ? addable(c.library, c.view, c.removed) : null;
  if (c.addRune) {
    const add = btn("Add Rune", "ws-btn", c.addRune, c.busy);
    add.title = adds && !adds.length ? TIP_ADD_NONE : TIP_ADD_RUNE;
    add.setAttribute("aria-pressed", String(!!c.library));
    actions.appendChild(add);
  }
  // the outcome chip trails the buttons, not between them
  if (c.kitNotice) {
    const chip = el("span", "runes-chip also", c.kitNotice.attached ? "Kit Attached" : "Kit");
    if (c.kitNotice.skipped) chip.title = `Add Kit · ${c.kitNotice.skipped} Skipped`;
    actions.appendChild(chip);
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
    // no head op here: an empty slot keeps the title in line with the checked heads above
    group.appendChild(withDeleteLibrary(c, libCard(c, rs, nameLabel(library) || library, `add:${library}`, null, true,
      (id) => ({ check: runeCheck("off", c.busy, `${stateTooltip("off")}\n${TIP_ADD_RUNE}`, () => c.edit(withStyleReplace(
        { library, id, kind: rs.find((r) => r.id === id)?.kind ?? "" }, { op: "addRune", ref: { library, id } }, c.view))),
        tail: deleteTail(c, library, id) }), undefined, false, checkSlot()), library));
  }
  return group;
}

function libCard(c: VaultModifyCtx, runes: VaultViewRune[], name: string, key: string, cond: HTMLElement | null, dimAll: boolean,
  ctl: (id: string) => RuneCtl, dim: (id: string) => boolean = () => dimAll, reasons = true, headCheck?: HTMLElement): HTMLElement {
  // one card here is one runeset (cross-library slots included) or one library's one-offs: group them under one name
  const lib = vaultLibraries({ runes: runes.map((r) => ({ ...r, set: null, library: key })) })[0]
    ?? { library: name, source: null, scope: "global" as const, sourceGone: false, bricks: [], sets: [], onDemand: [] };
  const bricks = [...lib.bricks, ...(lib.onDemand ?? [])];
  const on = bricks.filter((b) => !dim(b.id)).length;
  const det = setCard(hueOf(lib), setHead(name, `${on}/${bricks.length}`, "globe", cond ?? undefined, headCheck));
  det.dataset.library = runes[0]?.set?.library ?? runes[0]?.library ?? key;
  c.trackOpen(det, key, false);
  const carried = notCarriedIds(c.view.warnings);
  const cardOf = (b: (typeof bricks)[number]): HTMLElement => {
    const read = reasons && runeWasRead(c.loads, b.id);
    const reason = reasons ? loadReason({ id: b.id, kind: b.kind, activate: b.activate, recall: (lib.onDemand ?? []).includes(b), paths: b.paths },
      { state: dim(b.id) ? "off" : "on", notCarried: carried, loads: c.loads, read }) : null;
    const rc = ctl(b.id);
    const card = runeCard(lib, b, { dim: dim(b.id), tail: rc.tail, card: c.card, read, ...(reasons ? { reason } : {}) });
    c.trackOpen(card, `rune:${key}:${b.id}`, false);
    // Modify: the checkbox sits left of the bar, outside it
    return rc.check ? checkRow(rc.check, card) : card;
  };
  if (c.readOnly) {
    // read view: nested kind heads, like Modify's tick lists (a single kind keeps its head, for one shape)
    for (const g of byKind(bricks, (b) => b.kind, { off: (b) => dim(b.id), name: (b) => runeName({ id: b.id, path: b.path } as RuneItem) })) {
      const tray = el("div", "runes-tray");
      for (const b of g.items) tray.appendChild(cardOf(b));
      det.appendChild(kindGroup(g.kind, `${g.items.filter((b) => !dim(b.id)).length}/${g.items.length}`, tray,
        (d) => c.trackOpen(d, `kind:${key}:${g.kind}`, true)));
    }
    return det;
  }
  const tray = el("div", "runes-tray");
  for (const b of bricks) tray.appendChild(cardOf(b));
  if (tray.childElementCount) det.appendChild(tray);
  return det;
}
