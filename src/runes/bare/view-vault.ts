// src\runes\bare\view-vault.ts — Modify on a tab's Rune Vault.
// One card per runeset (its head switch adds or removes the runeset) and one Rune Satchel card for every loose rune
// (each rune's switch adds or removes it; rune-groups.ts groups both panes). Every switch flips a staged change (vault-pending.ts) through `pend`;
// nothing is written until Done, which sends them as one edit through vault-edit.ts. Nothing here reads or writes a
// launcher row. A runeset's runes switch through the `member` op, which edits only the vault's copy: a slotted
// rune's line, or a recall member's id in the copy's `recall-off` header (the reply's `off` list, drawn off).
// Switching an output style on also switches the vault's other style off (style-pick.ts: picking replaces; the
// pending model keeps that over staged changes). Rows sort on the saved vault, so a flip never moves one; a staged
// change reads as an accent box (check-box.ts `pending`), a settled tick as grey. Switched-off loose runes hide (the Rune
// Library holds them); a staged add shows on the Satchel. Reuses the library card and rune card; in Modify
// each switch is the checkbox left of its bar or head (check-box.ts, mock runes-modify-toggles B); the Satchel's head
// has no switch. Read mode keeps the switch chip on an off runeset's runes.
import type { LibraryRuneset, SetSource, VaultOp } from "../../ipc";
import { fillCard, runeName, type CardCtx } from "../cards";
import type { RuneItem } from "../types";
import { setCard, setHead } from "../set-card";
import { byKind, kindGroup } from "../kind-groups";
import { idLabel } from "./row-name";
import { VIDAR_LIBRARY, VIDAR_SET } from "./library-delete";
import { BENCH_ICONS } from "../../panels/workbench-modules";
import bundles from "../../../contracts/module-bundles.json" with { type: "json" };

/** Card keys of the module runesets (one per module in the vidar library, `sets/<id>.md`): they draw their module's bench icon (BENCH_ICONS), not the globe. */
export const MODULE_SET_KEYS:ReadonlySet<string> = new Set(Object.keys(bundles.bundles).map((id) => `set:${VIDAR_LIBRARY}/${id}`));
/** Card keys of the two built-in runesets -> the agent whose session-tab icon their head draws. */
const AGENT_SET_KEY = new RegExp(`^set:${VIDAR_LIBRARY}/built-in-(.+)$`);
const agentOfSetKey = (key: string): string | undefined => AGENT_SET_KEY.exec(key)?.[1];
import { markFor } from "../../launcher/menu-rows";
import vidarIcon from "../../../src-tauri/icons/titlebar-32.png"; // the window's own icon (caption.ts draws the same file)
import satchelIcon from "../../assets/rune-satchel.png"; // the Rune Satchel's backpack
import { assetImg } from "../../settings/build/view";
import { button, el } from "../../dom";
import { vaultLibraries, type VaultView, type VaultViewRune } from "./cake";
import { hueOf } from "./view-data";
import { runeCard, runeSwitch } from "./view-sets";
import { stateLabel, stateTooltip } from "./rune-state";
import { checkBox, checkRow, checkSlot, type CheckState } from "../check-box";
import { CODEX_FILES_TITLE, REPO_SKILLS_TITLE, runeGroups, SATCHEL_TITLE, TIP_CODEX_FILE, TIP_REPO_SKILL_OFF } from "./rune-groups";
import { choiceCard, EDIT_ORIGINAL_NOTE, EDIT_ORIGINAL_RESTART, type VaultPick } from "./vault-edit";
import { saveAsControls, type SaveAsState } from "./vault-save-as";
import { loadReason, notCarriedIds, runeWasRead } from "./load-reason";
import type { RunesLoaded } from "../types";
import { refKey, sameRef, targetKey, type PendingCtl, type Target } from "./vault-pending";

export const LOCKED_EDIT_TEXT = `This vault is locked. ${EDIT_ORIGINAL_NOTE}`;
export const DRIFT_TEXT = `A rune changed in its library after this vault locked. ${EDIT_ORIGINAL_NOTE}`;
const TIP_SET_MEMBER = "Part of a runeset that is off; switch the runeset on to change it.";
const TIP_MEMBER = "Changes this vault's copy of the runeset; the library runeset stays as it is.";
export const TIP_RUNESET = "Adds or removes this runeset in the tab's vault.";

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
  /** Modify's staged changes (vault-pending.ts): every checkbox reads and flips them; nothing writes before Done. */
  pend?: PendingCtl;
  /** The user's pick on the choice card for the pending edit. */
  pick(p: VaultPick): Promise<void>;
  /** The Rune Library's runes, so a staged one-off add can be drawn under its library's card. */
  libraryRunes?: readonly VaultViewRune[] | null;
  /** The Rune Library's runesets, so a runeset staged to join lists its members (drawn from `libraryRunes`). */
  librarySets?: readonly LibraryRuneset[];
  /** Generate Runes from Local: opens the files view; absent, no button. */
  files?: () => void;
  /** Save Vault As (vault-save-as.ts): the state and what its controls run; absent, no button. `held` overrides the
   *  wait while changes are staged (New Rune Vault's name prompt saves the staged changes with the vault). */
  saveAs?: { state: SaveAsState; toggle(): void; save(): void; held?: boolean };
  /** The tab's loads result; each card's tooltip says why its rune loaded or not (load-reason.ts). Absent, no line. */
  loads?: RunesLoaded | null;
}

const SOME_ON = "Some On";

/** Read mode and a Modify without staging: every target reads as saved and nothing flips. */
export const SAVED: PendingCtl = { on: (_t, base) => base, pending: () => false, flip() {}, set() {}, count: 0, staged: () => [] };

/** A rune row's controls in Modify: the checkbox left of the bar, and the chips at the bar's end. `confirm` (the Rune
 *  Library's Delete Rune question) opens the card and sits under its head; `title` is a line added to its tooltip;
 *  `library` names the rune's own library on the card (`data-library`), for a card spanning libraries. */
export interface RuneCtl { check?: HTMLElement; tail: HTMLElement[]; confirm?: HTMLElement; title?: string; library?: string;
  /** The row's own load reason, replacing the vault's `loadReason`; null shows none (rows that are not vault runes). */
  reason?: string | null;
  /** The row's shown name, when the id's Title Case form would mangle it (a file path). */
  name?: string }

/** What a card of runes reads from its host: the vault pane's ctx, or the Rune Library's. */
export type CardHost = Pick<VaultModifyCtx, "view" | "card" | "trackOpen" | "loads">;

/** Modify's checkbox with the switch's label and tooltip (check-box.ts). */
const runeCheck = (state: CheckState, disabled: boolean, title: string, flip: () => void, pending = false, keep?: string): HTMLElement =>
  checkBox({ state, disabled, title, label: state === "mixed" ? `State: ${SOME_ON}` : stateLabel(state), flip, pending, ...(keep ? { keep } : {}) });


const runeTarget = (r: VaultViewRune): Target => ({ t: "rune", library: r.library, id: r.id, kind: r.kind });

export const LABEL_REQUIRED = "Required";
export const TIP_REQUIRED = "Vidar needs this rune to run.";
const tipNeeded = (by: string): string => `Needed by ${idLabel(by)}.`;

/** Why a Vidar Runeset row's box cannot flip: the aria label and the tooltip. */
export interface RuneLock { label: string; tip: string }

/** The lock on a Vidar Runeset rune: required (`required`, or `item.requiredByVidar`), or needed by an on slot (`neededBy`, from the row or
 *  from the vault's own row when `r` is a library rune). Null for every other rune. A required text rune carries no item
 *  yet, so only item runes read as required here. */
export function runeLock(r: VaultViewRune, view?: VaultView): RuneLock | null {
  if (r.library !== VIDAR_LIBRARY) return null;
  if (r.item?.requiredByVidar || r.required) return { label: LABEL_REQUIRED, tip: TIP_REQUIRED };
  const by = r.neededBy ?? view?.runes.find((x) => x.library === r.library && x.id === r.id)?.neededBy;
  return by ? { label: tipNeeded(by), tip: tipNeeded(by) } : null;
}

/** The Vidar Runeset itself: always in the vault, never removed. */
export const isVidarSet = (s: SetSource): boolean => s.library === VIDAR_LIBRARY && s.set === VIDAR_SET;

/** A box that holds still, ticked: it ignores clicks. */
export const lockedBox = (lock: RuneLock, keep?: string): HTMLElement =>
  checkBox({ state: "on", disabled: true, title: lock.tip, label: lock.label, flip: () => undefined, ...(keep ? { keep } : {}) });

const SET_LOCK: RuneLock = { label: LABEL_REQUIRED, tip: TIP_REQUIRED };

/** Modify's body for a tab with a vault record: the choice card (a pending locked edit, or a locked vault whose
 *  library runes drifted, hidden while changes are staged), then the runeset cards and the one-off cards. */
export function vaultModify(c: VaultModifyCtx): HTMLElement[] {
  const out: HTMLElement[] = [];
  const v = c.view.vault;
  const p = c.readOnly ? SAVED : c.pend ?? SAVED;
  // while the choice card asks, the boxes hold still: its pick sends the staged batch as it stood at Done
  const still = c.busy || !!c.pending;
  if (!c.readOnly && c.pending) out.push(choiceCard(c.pick, `${c.pending.text} ${EDIT_ORIGINAL_RESTART}`));
  else if (!c.readOnly && !p.count && v.lockedUtc && c.view.drift.length) out.push(choiceCard(c.pick, `${DRIFT_TEXT} ${EDIT_ORIGINAL_RESTART}`));
  const box = (t: Target, base: boolean, disabled: boolean, tip: (s: "on" | "off") => string): HTMLElement => {
    const s = p.on(t, base) ? "on" as const : "off" as const;
    return runeCheck(s, disabled, tip(s), () => p.flip(t, base), p.pending(t), `vault:${targetKey(t)}`);
  };
  const staged = c.readOnly ? [] : p.staged();
  // a runeset staged to join has no copy yet: its card lists its library runeset's members (the copy starts whole), so
  // each reads as on the Rune Library's card
  const membersOf = (s: SetSource) => c.librarySets?.find((x) => x.library === s.library && x.set === s.set)?.members ?? [];
  const joining = staged.flatMap((e) => e.on && !e.base && e.target.t === "set"
    ? [{ source: e.target.source, members: membersOf(e.target.source), on: false, joining: true }] : []);
  // a staged add from the library is drawn on the satchel; Modify hides a switched-off loose rune (the Rune Library
  // offers it) unless a change to it is staged
  const added = staged.flatMap((e) => {
    const t = e.target;
    const r = e.on && t.t === "rune" ? c.libraryRunes?.find((x) => sameRef(x, t)) : undefined;
    return r ? [r] : [];
  });
  const g = runeGroups({
    sets: [...v.runesets.map((r) => ({ source: r.source, members: [], on: true })), ...joining],
    runes: c.view.runes, off: c.view.off ?? [], removed: c.removed, held: v.runes, staged: added, pool: c.libraryRunes ?? [],
    keep: c.readOnly ? undefined : (r, on) => on || p.pending(runeTarget(r)),
  });
  const group = el("section", "runes-group");
  for (const s of g.sets) {
    const st: Target = { t: "set", source: s.source };
    const setOn = p.on(st, s.on);
    // Modify: the runeset's checkbox opens the head; read mode draws none
    const head = c.readOnly ? undefined
      : isVidarSet(s.source) ? lockedBox(SET_LOCK, `vault:${targetKey(st)}`) : box(st, s.on, still, (x) => `${stateTooltip(x)}\n${TIP_RUNESET}`);
    // one card per runeset: its bricks are keyed by id, so a member is found by id (first match)
    const byId = (id: string): VaultViewRune | undefined => s.runes.find((r) => r.id === id);
    const offHere = (id: string): boolean => { const r = byId(id); return !!r && s.off.includes(refKey(r)); };
    const memberT = (r: VaultViewRune): Target => ({ t: "member", set: s.source, rune: { library: r.library, id: r.id }, kind: r.kind });
    const memberOn = (id: string): boolean => { const r = byId(id); return !!r && p.on(memberT(r), !offHere(id)); };
    const card = libCard(c, s.runes, idLabel(s.source.set), `set:${s.source.library}/${s.source.set}`, !setOn, (id) => {
      const r = byId(id);
      // a switched-off runeset (or one staged to leave) has no copy to edit; a recall member switches in the copy's header;
      // a joining runeset's member switches in the copy Done makes
      const live = s.on || s.joining;
      if (!r || !live || !setOn) {
        const st = live && setOn ? "on" : "off";
        return c.readOnly ? { tail: [runeSwitch(st, true, TIP_SET_MEMBER, () => undefined)] }
          : { check: runeCheck(st, true, TIP_SET_MEMBER, () => undefined), tail: [] };
      }
      const lock = c.readOnly ? null : runeLock(r, c.view);
      if (lock) return { check: lockedBox(lock, `vault:${targetKey(memberT(r))}`), tail: [] };
      return c.readOnly ? { tail: [] } : { check: box(memberT(r),!offHere(id), still, (x) => `${stateTooltip(x)}\n${TIP_MEMBER}`), tail: [] };
    }, (id) => !setOn || !memberOn(id), head, (id) => !s.on || offHere(id));
    // the same keys the Rune Library's card carries, so a rune's group reads alike on both sides
    card.dataset.library = s.source.library;
    card.dataset.runeset = s.source.set;
    group.appendChild(card);
  }
  // every loose rune (a one-off, a runeset's slot-off member, a staged add) sits on the one Rune Satchel card, as the
  // Rune Library's; each row names its own library and is matched by ref, a same id from two libraries staying two rows
  if (g.satchel.length) {
    const items = g.satchel.map((o) => ({ rune: o.rune, t: runeTarget(o.rune), base: o.on }));
    const find = (r?: VaultViewRune) => r ? items.find((i) => sameRef(i.rune, r)) : undefined;
    const card = libCard(c, items.map((i) => i.rune), SATCHEL_TITLE, "satchel", false, (_id, r) => {
      const i = find(r);
      const own = r ? { title: idLabel(r.library), library: r.library } : {};
      return c.readOnly || !i ? { tail: [], ...own } : { check: box(i.t, i.base, still, stateTooltip), tail: [], ...own };
    }, (_id, r) => { const i = find(r); return !i || !p.on(i.t, i.base); }, c.readOnly ? undefined : checkSlot(), (_id, r) => !find(r)?.base);
    delete card.dataset.library; // the satchel spans libraries: each rune card names its own
    card.classList.add("runes-satchel");
    group.appendChild(card);
  }
  // Codex only (Rust fills the field for Codex alone): the repo skills Vidar turned off, one read-only dimmed row each
  if (c.loads?.repoSkillsOff?.length) {
    const runes: VaultViewRune[] = c.loads.repoSkillsOff.map((name) => ({ set: null, library: "repo-skills", id: name, kind: "skill",
      activate: "always", description: "", section: [], recall: false, body: "", path: "", drift: false }));
    const card = libCard(c, runes, REPO_SKILLS_TITLE, "repo-skills", true, () => ({ tail: [], title: TIP_REPO_SKILL_OFF, reason: null }));
    card.classList.add("runes-repo-skills");
    group.appendChild(card);
  }
  // Codex only: the trusted launch folder's `.codex` files, one read-only row each (the path is the name)
  const loads = c.loads;
  const listed = loads?.codexFiles;
  if (listed && listed.length) {
    const runes: VaultViewRune[] = listed.map((path) => ({ set: null, library: "trusted-folder",
      id: path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), kind: "setting",
      activate: "always", description: "", section: [], recall: false, body: "", path, drift: false }));
    const card = libCard(c, runes, CODEX_FILES_TITLE, "trusted-folder", false, (_id, r) => ({ tail: [], title: TIP_CODEX_FILE, reason: null, ...(r ? { name: r.path } : {}) }));
    card.classList.add("runes-trusted-folder");
    group.appendChild(card);
  }
  if (group.childElementCount) out.push(group);
  const actions = el("div", "rp-actions");
  if (c.files) actions.appendChild(button("Generate Runes from Local", "ws-btn", c.files, c.busy));
  // Save Vault As is the completion action: it sits at the right edge, its form and chip with it, wrapping as one unit;
  // it saves the vault as it is, so it waits while changes are staged
  if (c.saveAs) {
    const end = el("span", "rp-actions-end");
    end.append(...saveAsControls(c.saveAs.state, c.busy, c.saveAs, c.saveAs.held ?? p.count > 0));
    actions.appendChild(end);
  }
  if (actions.childElementCount) out.push(actions);
  return out;
}

/** One card of runes: a runeset (cross-library slots included) or the Rune Satchel. `dim` is what the rows read
 *  (staged state); `savedOff` orders them, so a flip never moves a row. `key` sets the hue (view-data.ts hueOf);
 *  `open` keys the open state, so the Rune Library's copy of a runeset opens apart from the vault pane's. */
export function libCard(c: CardHost, runes: VaultViewRune[], name: string, key: string, dimAll: boolean,
  ctl: (id: string, r?: VaultViewRune) => RuneCtl, dim: (id: string, r?: VaultViewRune) => boolean = () => dimAll, headCheck?: HTMLElement,
  savedOff: (id: string, r?: VaultViewRune) => boolean = dim, open: string = key, library = false): HTMLElement {
  // one card here is one runeset (cross-library slots included) or the satchel: group them under one name
  const lib = vaultLibraries({ runes: runes.map((r) => ({ ...r, set: null, library: key })) })[0]
    ?? { library: name, source: null, scope: "global" as const, sourceGone: false, bricks: [], sets: [], onDemand: [] };
  const bricks = [...lib.bricks, ...(lib.onDemand ?? [])];
  // each brick's own rune (vaultLibraries keeps the input order, recall runes in onDemand), so a card spanning libraries
  // tells a same id apart in `ctl` and `dim`
  const src = new Map<object, VaultViewRune>();
  let bi = 0, oi = 0;
  for (const r of runes) { const b = r.recall ? lib.onDemand?.[oi++] : lib.bricks[bi++]; if (b) src.set(b, r); }
  const dimB = (b: (typeof bricks)[number]): boolean => dim(b.id, src.get(b));
  const on = bricks.filter((b) => !dimB(b)).length;
  const agent = agentOfSetKey(key);
  // the agent's own session-tab art (the launcher's vendor mark), or Vidar's window icon for the Vidar Runeset, not the globe
  const art = agent ? markFor(agent)?.icon : key === `set:${VIDAR_LIBRARY}/${VIDAR_SET}` ? vidarIcon : key === "satchel" ? satchelIcon : undefined;
  const head = setHead(name, `${on}/${bricks.length}`, art ? null : MODULE_SET_KEYS.has(key) ? BENCH_ICONS[key.slice(`set:${VIDAR_LIBRARY}/`.length)] ?? "globe" : key === `set:${VIDAR_LIBRARY}/auto-mode` ? "robot" : "globe", undefined, headCheck);
  if (art) head.querySelector(".runes-scp")?.appendChild(assetImg(art));
  const det = setCard(library ? "hue-set" : hueOf(lib), head);
  det.dataset.library = runes[0]?.set?.library ?? runes[0]?.library ?? key;
  // the Rune Library opens its cards and folds their kind groups (rules and facts run long); the vault pane the reverse
  c.trackOpen(det, open, library);
  const carried = notCarriedIds(c.view.warnings);
  const cardOf = (b: (typeof bricks)[number]): HTMLElement => {
    const read = runeWasRead(c.loads, b.id);
    const rc = ctl(b.id, src.get(b));
    // a row whose ctl names its own reason (null: none) skips the vault's load reason
    const reason = rc.reason !== undefined ? rc.reason : loadReason({ id: b.id, kind: b.kind, activate: b.activate, recall: (lib.onDemand ?? []).includes(b), paths: b.paths },
      { state: dimB(b) ? "off" : "on", notCarried: carried, loads: c.loads, read });
    const card = runeCard(lib, b, { dim: dimB(b), tail: rc.tail, card: c.card, read, reason, ...(rc.name ? { name: rc.name } : {}) });
    c.trackOpen(card, `rune:${open}:${b.id}`, false);
    if (rc.title) card.title = card.title ? `${card.title}\n${rc.title}` : rc.title;
    if (rc.library) card.dataset.library = rc.library;
    // a confirm asked on the rune: the card opens and shows it under the head, so the question sits on the rune
    if (rc.confirm) { card.open = true; fillCard(card); card.querySelector(":scope > summary")?.after(rc.confirm); }
    // Modify: the checkbox sits left of the bar, outside it
    return rc.check ? checkRow(rc.check, card) : card;
  };
  // both views: nested kind heads, like Modify's tick lists (a single kind keeps its head, for one shape). The heads
  // are plain (no per-kind checkbox) and share the read view's open-state keys.
  for (const g of byKind(bricks, (b) => b.kind, { off: (b) => savedOff(b.id, src.get(b)), name: (b) => runeName({ id: b.id, path: b.path } as RuneItem) })) {
    const tray = el("div", "runes-tray");
    for (const b of g.items) tray.appendChild(cardOf(b));
    det.appendChild(kindGroup(g.kind, `${g.items.filter((b) => !dimB(b)).length}/${g.items.length}`, tray,
      (d) => c.trackOpen(d, `kind:${open}:${g.kind}`, !library)));
  }
  return det;
}
