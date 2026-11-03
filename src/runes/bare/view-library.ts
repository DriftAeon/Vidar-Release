// src\runes\bare\view-library.ts — the Rune Library in Modify: every rune the tab's agent can load from its libraries
// (`rune_vault_library_runes`), grouped by runeset. One card per library runeset (`.runesets`), shaped as the vault
// pane's runeset cards (view-vault.ts libCard: set head, kind groups inside), its head checkbox adding or removing
// the runeset in the vault; then the Rune Satchel, every rune no shown runeset holds. The runes and runesets come back
// filtered to the tab's agent (frontmatter `agent:`, store.rs library_runes and library_sets.rs), so a runeset whose
// members are all another agent's is left out. Each row's checkbox reads "this rune loads in this vault after Done":
// it stages through vault-pending.ts (`libraryTargets`: a one-off the vault holds, a member of each placed or joining
// runeset holding it, a pick that joins the card's runeset with only this rune on, or a new one-off), never writes. Rows sort by name inside their kind, so a flip never moves one. Delete
// Rune sits on the row's card and Delete Runeset at the end of an open runeset card, each with its inline confirm
// (library-delete.ts). Deletes are immediate (Cancel cannot undo them): they leave the store, not the vault.
import { runeName, type CardCtx } from "../cards";
import type { RuneItem, RunesLoaded } from "../types";
import type { LibraryRuneset, SetSource } from "../../ipc";
import { checkBox, checkSlot } from "../check-box";
import { el } from "../../dom";
import { iconImg } from "../../icon-img";
import type { VaultView, VaultViewRune } from "./cake";
import { idLabel } from "./row-name";
import { stateLabel, stateTooltip } from "./rune-state";
import { runeGroups, SATCHEL_TITLE } from "./rune-groups";
import { libraryTargets, rowState, setTarget, type Pending, type PendingCtl, type Target } from "./vault-pending";
import { isVidarSet, LABEL_REQUIRED, libCard, lockedBox, MODULE_SET_KEYS, runeLock, TIP_REQUIRED, TIP_RUNESET, type RuneCtl } from "./view-vault";
import {
  DELETE_RUNE_LABEL, DELETE_RUNESET_LABEL, deletable, deleteButton, deleteInline, runesetConfirmText, sameTarget, type DeleteTarget,
} from "./library-delete";

export const LIBRARY_TITLE = "Rune Library";
const MODULES_TITLE = "Modules";
const TIP_ROW = "Loads this rune in the tab's vault after Done.";
const TIP_DELETE_RUNE = "Moves this rune out of its library into the library backup.";
const TIP_DELETE_RUNESET = "Moves this runeset into the library backup; its runes stay in the library.";

export interface LibraryPaneCtx {
  /** The library's runes; null while the first read runs. */
  runes: readonly VaultViewRune[] | null;
  /** The library runesets the pane groups by; absent or empty, every rune sits in the Rune Satchel. */
  runesets?: readonly LibraryRuneset[];
  /** The vault as it is now, which each row's targets read. */
  view: VaultView;
  changes: Pending;
  pend: PendingCtl;
  /** Busy, or a choice card asking: the boxes hold still. */
  still: boolean;
  busy: boolean;
  card: CardCtx;
  loads?: RunesLoaded | null;
  trackOpen(det: HTMLDetailsElement, key: string, dflt: boolean): void;
  deleting: DeleteTarget | null;
  askDelete(t: DeleteTarget): void;
  confirmDelete(): void;
  cancelDelete(): void;
}

/** Delete Rune on a library rune's card, for a library the store lets go of. Once asked, the button is gone and the
 *  card opens with the confirm row under its head. */
function deleteCtl(c: LibraryPaneCtx, library: string, id: string): { tail: HTMLElement[]; confirm?: HTMLElement } {
  if (!deletable(library, c.runesets ?? [])) return { tail: [] };
  if (sameTarget(c.deleting, { library, id })) return { tail: [], confirm: deleteInline(id, c.confirmDelete, c.cancelDelete) };
  return { tail: [deleteButton(DELETE_RUNE_LABEL, TIP_DELETE_RUNE, () => c.askDelete({ library, id }), c.busy)] };
}

/** One card of library runes (a runeset or the satchel): each row's checkbox and Delete Rune; `keep` prefixes the
 *  boxes' focus keys, so a rune in two runesets keeps two. */
function runesCard(c: LibraryPaneCtx, runes: VaultViewRune[], name: string, key: string, open: string, keep: string, head?: HTMLElement,
  set?: SetSource): HTMLDetailsElement {
  // libCard hands each row its own rune, so a same id from two libraries stays two rows with their own state; a row on
  // a runeset card the vault does not hold joins that runeset with this rune on (libraryTargets `card`)
  const stateOf = (r: VaultViewRune) => { const ts = libraryTargets(c.view, c.changes, r, c.runesets ?? [], set); return { ts, st: rowState(c.changes, ts) }; };
  const ctl = (_id: string, r?: VaultViewRune): RuneCtl => {
    if (!r) return { tail: [] };
    const { ts, st } = stateOf(r);
    const state = st.on ? "on" : "off";
    const label = runeName({ id: r.id, path: r.path ?? "" } as RuneItem);
    const lock = runeLock(r, c.view);
    const check = lock ? lockedBox(lock, `${keep}${r.library}/${r.id}`)
      : checkBox({ state, disabled: c.still, title: `${stateTooltip(state)}\n${TIP_ROW}`, label: `${label}: ${stateLabel(state)}`,
        flip: () => c.pend.set(ts, !st.on), pending: st.pending, keep: `${keep}${r.library}/${r.id}` });
    const del = deleteCtl(c, r.library, r.id);
    return { check, tail: del.tail, ...(del.confirm ? { confirm: del.confirm } : {}), title: idLabel(r.library), library: r.library };
  };
  const dim = (_id: string, r?: VaultViewRune): boolean => !r || !stateOf(r).st.on;
  // rows order by name inside their kind and never on state, so a flip never moves one; library cards start open, their
  // kind groups start collapsed
  return libCard(c, runes, name, key, false, ctl, dim, head, () => false, open, true) as HTMLDetailsElement;
}

/** The library pane's children: the head row with the title, then the runeset cards and the Rune Satchel. */
export function libraryPane(c: LibraryPaneCtx): HTMLElement[] {
  // the vault pane's head row classes (#runes-view .runes-head.wb-pane-head), so the title row takes its height
  const head = el("div", "wb-pane-head runes-head runes-lib-head");
  head.appendChild(el("span", "runes-lib-title", LIBRARY_TITLE));
  const out: HTMLElement[] = [head];
  if (!c.runes) return out;
  // the one grouping function (rune-groups.ts), shared with the vault pane
  const g = runeGroups({ sets: (c.runesets ?? []).map((s) => ({ source: { library: s.library, set: s.set }, members: s.members, on: false })), runes: c.runes });
  const group = el("section", "runes-group runes-lib-groups");
  // module runesets sit below every other card (Satchel included), under the Modules heading; the grouping function
  // stays shared with the vault pane, so the split lives here
  const isModule = (s: SetSource): boolean => MODULE_SET_KEYS.has(`set:${s.library}/${s.set}`);
  const modules: HTMLElement[] = [];
  for (const { source, runes } of g.sets) {
    const set = (c.runesets ?? []).find((s) => s.library === source.library && s.set === source.set)!;
    const t: Target = setTarget(set, c.runesets ?? [], c.runes);
    const base = c.view.vault.runesets.some((r) => r.source.library === set.library && r.source.set === set.set);
    const state = c.pend.on(t, base) ? "on" as const : "off" as const;
    const check = isVidarSet(source) ? lockedBox({ label: LABEL_REQUIRED, tip: TIP_REQUIRED }, `libset:${set.library}/${set.set}`)
      : checkBox({ state, disabled: c.still, title: `${stateTooltip(state)}\n${TIP_RUNESET}`, label: stateLabel(state),
        flip: () => c.pend.flip(t, base), pending: c.pend.pending(t), keep: `libset:${set.library}/${set.set}` });
    // the vault pane's hue key (`set:`), its own open-state key
    const card = runesCard(c, runes, idLabel(set.set), `set:${set.library}/${set.set}`, `libset:${set.library}/${set.set}`,
      `libset:${set.library}/${set.set}:`, check, source);
    card.dataset.library = set.library;
    card.dataset.runeset = set.set;
    // Delete Runeset sits inside the open card after its kind groups, where the vault pane's runeset cards put their
    // attachments; the Vidar Runeset and template runesets (`fixed`) have none
    if (!set.fixed) card.appendChild(runesetDelete(c, set, card));
    if (isModule(source)) modules.push(card); else group.appendChild(card);
  }
  if (g.satchel.length) {
    // no runeset to add: the head holds the checkbox's empty slot, so its title lines up with the runeset heads
    const card = runesCard(c, g.satchel.map((o) => o.rune), SATCHEL_TITLE, "satchel", "libsatchel", "lib:", checkSlot());
    delete card.dataset.library; // the satchel spans libraries: each rune card names its own
    card.classList.add("runes-satchel");
    group.appendChild(card);
  }
  if (modules.length) {
    const mark = el("div", "runes-lib-modules");
    mark.append(iconImg("toolbox-ocean"), el("span", "runes-lib-modules-word", MODULES_TITLE), iconImg("toolbox-ocean"));
    group.append(mark, ...modules);
  }
  if (group.childElementCount) out.push(group);
  return out;
}

/** A runeset card's last row: Delete Runeset, or once asked its inline confirm (the card opens to show it). Immediate,
 *  as Delete Rune is: it removes the runeset only, so its runes stay and fall into the Rune Satchel. */
function runesetDelete(c: LibraryPaneCtx, set: LibraryRuneset, card: HTMLDetailsElement): HTMLElement {
  const t: DeleteTarget = { library: set.library, id: set.set, runeset: true };
  const name = idLabel(set.set);
  if (sameTarget(c.deleting, t)) {
    card.open = true;
    return deleteInline(name, c.confirmDelete, c.cancelDelete, runesetConfirmText(name));
  }
  const row = el("div", "rp-actions runes-set-acts");
  row.appendChild(deleteButton(DELETE_RUNESET_LABEL, TIP_DELETE_RUNESET, () => c.askDelete(t), c.busy));
  return row;
}
