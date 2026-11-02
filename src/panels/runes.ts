// Runes tab: the rune libraries (Global, then Vidar) traced against what the focused tab loaded.
// The catalog is cached until Refresh; `runes_loaded` runs only while the tab is on screen (on show,
// on `vidar-focus` while shown, on `vidar-reply-done` for the focused tab while shown, on Refresh).
// A Rendered tab's session id is read at query time. Bare content comes from its session vault.
import { invoke } from "../ipc";
import type { ReplyDoneDetail } from "./reply-events";
import { iconImg } from "../icon-img";
import { lucide } from "../icons";
import { paneShell } from "./pane-shell";
import type { VaultPickHandle } from "../runes/bare/vault-pick-view";
import { openDraft, tabDraft, type CoverEntry } from "./runes-draft";
import { headName, type HeadName, type HeadNameEdit } from "../runes/bare/head-name";
import type { VaultDraft } from "../runes/bare/vault-draft";
import { getFocusedSession, pendingVaultTab, renderedBody, renderedSessionId, sessionLaunchInfo, type FocusedSession } from "./sessions/lookup";
import { respawnVaultTabs, tabVaultSession } from "./sessions/vault-tabs";
import { tabVaultIo, type VaultIo } from "../runes/bare/vault-io";
import { getLeftCover, onLeftCoverChange, setLeftCover } from "./sessions/left-cover";
import { mountBareView, type BareViewHandle } from "../runes/bare/view";
import { createBareIo } from "../runes/bare/io";
import { bareViewKey } from "../runes/bare/cake";
import { runeIconKey, type CardCtx } from "../runes/cards";
import type { GenCtx } from "../runes/bare/agent-view";
import { notCarriedLine } from "../runes/not-carried";
import { wiredModels } from "../flow/roster";
import { getPref } from "../prefs";
import { isAgentId, type AgentId } from "../agents/id";
import { AGENTS } from "../agents/descriptor";
import { AGENT_PROFILE } from "../agents/agent-profile";
import { ensureCodexModels } from "../agents/codex-models";
import { el } from "../dom";
import type { RunesCatalog, RunesLoaded } from "../runes/types";
import { restartCard, trustCard, trustedOfferText, type TrustOffer } from "./rendered/notice-actions";

let visible = false;
let catalog: RunesCatalog | null = null;
let catalogErr: string | null = null;
let seq = 0;
let listEl: HTMLElement;
let frameEl: HTMLElement | undefined;
// the last ordinary draw: the catalog object and the answers it drew from; equal again means no DOM writes
let drawnCatalog: RunesCatalog | null = null;
let drawnKey: string | null = null;
let pendingReload = false;
let queued = false;
let stateEl: HTMLElement;
let noteEl: HTMLElement | undefined;
/** The shown Bare view's head buttons (Lock, Modify; in Modify Done, Cancel), at the head's right end; empty otherwise. */
let actsEl: HTMLElement | undefined;
let stripEl: HTMLElement;
let nameHead: HeadName; // the vault's name in the head: a draft's (renamable) or a started session's (read-only)
let markEl: HTMLElement;
let stripTitleEl: HTMLElement;
let refreshBtn: HTMLButtonElement;
let ctx: CardCtx;
let viewEl: HTMLElement | undefined;
let focusListener: (() => void) | undefined;
let replyListener: ((e: Event) => void) | undefined;
let keyEl: HTMLElement | undefined;
// One kept Bare view per agent, row and folder; a run, an open set or a scroll position outlives a
// refresh, a workbench-tab switch and a hide. Disposed with the Runes view.
interface BareEntry {
  handle: BareViewHandle; scrollTop: number; drawKey: string; note: string | null; name: string | null; ready: boolean;
  /** In Modify (the view's onModifyChange); the Rune Library covers the left pane while this entry is shown. */
  modifying: boolean;
  /** Something else took the left slot (openRelay, openDual): no re-set until the next Modify entry. */
  coverGone: boolean;
  /** The libraryRoot wrapped for the left pane (its "Rune Library" title rides inside the root). */
  cover?: HTMLElement;
}
const bareViews = new Map<string, BareEntry>();
const pickViews = new Map<string, VaultPickHandle>();
let shownBare: BareEntry | undefined;
let shownDraft: CoverEntry | undefined; // the focused waiting tab's New Rune Vault draft (runes-draft.ts)
let freshNext = false; // shown again or Refresh pressed: the next Bare draw re-reads the row
let lastTabId: string | null = null;
let catalogVer = 0;

/** Swap the icon key between the ordinary one and the Bare one (the class marks which view it keys). */
function showKey(bare: boolean) {
  if (!keyEl || keyEl.classList.contains("runes-key-bare") === bare) return;
  const next = runeIconKey();
  if (bare) next.classList.add("runes-key-bare");
  keyEl.replaceWith(next);
  keyEl = next;
}

/** Show the ordinary icon key again and clear the head buttons; the kept Bare view stays mounted (on hide) or is left
 *  by the caller. Every non-Bare draw path (drawPick, the ordinary draw, hide) runs it. `keep` is the draft drawPick
 *  shows again: its cover stays put, since a cover change re-lays the slot, fires `vidar-focus` and so the next
 *  drawPick (a drop and re-set per refresh looped without end, 2026-10-31). */
function dropBare(keep?: CoverEntry) {
  showKey(false);
  actsEl?.replaceChildren();
  nameHead?.show(null);
  shownDraft = keep;
  syncCover();
}

let coverEl: HTMLElement | null = null; // the cover this panel set in the left pane
let coverOwner: CoverEntry | undefined;
let unsubCover: (() => void) | undefined;

/** The Rune Library covers the left pane only while the Runes tab is shown and the focused tab's Bare view (or its
 *  New Rune Vault draft) is in Modify. */
function syncCover() {
  const e = shownBare ?? shownDraft;
  if (!visible || !e || !e.modifying || e.coverGone) {
    const c = coverEl;
    coverEl = null;
    coverOwner = undefined;
    if (c && getLeftCover() === c) setLeftCover(null);
    return;
  }
  if (!e.cover) { e.cover = el("div", "runes-left-library"); e.cover.appendChild(e.handle.libraryRoot); }
  if (coverEl === e.cover) return;
  coverEl = e.cover;
  coverOwner = e;
  setLeftCover(e.cover);
}

/** The ordinary view takes the list: remember the Bare view's scroll position and let it go. */
/** The Make Variant notice in the pane head: one truncated line at the right, the full text in its tooltip. */
function showNote(text: string | null) {
  if (!noteEl) return;
  noteEl.textContent = text ?? "";
  noteEl.title = text ?? "";
  noteEl.hidden = !text;
}

function leaveBare() {
  if (shownBare && frameEl) shownBare.scrollTop = frameEl.scrollTop;
  shownBare = undefined;
  showNote(null);
}


/** The focused tab's state line: [text, isError, isStrip]. A strip is the tab's mark and title
 *  (the loads came from its transcript); an empty text shows nothing. */
function stateLine(f: FocusedSession | null, res: RunesLoaded | null, err: string | null): [string, boolean, boolean] {
  if (!f) return ["", false, false];
  if (err) return [err, true, false];
  if (!res) return ["No Loads Recorded", false, false];
  if (res.source === "none") return [res.reason, false, false];
  if (!res.files.length) return ["No Loads Recorded", false, false];
  return [f.title, false, true];
}

const STRIP_TIP = "Loaded from the transcript"; // copy-ok: sentence-case tooltip (2026-10-11)

/** The loaded vault's name rides the tab-name strip as a tooltip, never a visible subtitle. */
function showVault(name: string | null): void {
  stripEl.title = name ? `Vault: ${name}` : STRIP_TIP; // copy-ok: sentence-case tooltip
  nameHead.show(name); // read-only in the head slot a draft's name uses
}

const DRAFT_NAME = "New Rune Vault";

/** The head name of a New Rune Vault draft: "New Rune Vault" until named, with the rename pencil. */
function draftName(d: VaultDraft): HeadNameEdit {
  let made = draftEdits.get(d);
  if (!made) {
    made = { value: () => d.name ?? "", fallback: DRAFT_NAME, set: (name) => { d.name = name; } };
    draftEdits.set(d, made);
  }
  return made;
}
const draftEdits = new WeakMap<VaultDraft, HeadNameEdit>(); // one edit object per draft, so a redraw does not close an open field

function draw(f: FocusedSession | null, res: RunesLoaded | null, err: string | null) {
  stripEl.title = STRIP_TIP;
  const [text, bad, strip] = stateLine(f, res, err);
  stateEl.textContent = strip ? "" : text;
  stateEl.classList.toggle("runes-err", bad);
  stripEl.hidden = !strip;
  if (strip && f) {
    markEl.dataset.art = f.art;
    stripTitleEl.textContent = text;
  }
  refreshBtn.hidden = !(bad || catalogErr); // retry only: focus change and show already re-query
  const scroll = frameEl?.scrollTop ?? 0;
  listEl.replaceChildren(...(catalogErr ? [el("div", "runes-err", catalogErr)] : []));
  if (frameEl) frameEl.scrollTop = scroll;
}

const hasLoads = (res: RunesLoaded | null): boolean => !!res && res.source !== "none" && res.files.length > 0;

/** A Bare tab's state line: with a launch recorded, the trace body speaks for it, so no "nothing
 *  loaded" reason shows; the strip still names the tab when the transcript has loads. */
function bareStateLine(f: FocusedSession, res: RunesLoaded | null, err: string | null): [string, boolean, boolean] {
  if (err) return stateLine(f, res, err);
  return hasLoads(res) ? [f.title, false, true] : ["", false, false];
}

/** Launch warnings the user dismissed, as `${tabId}\n${text}`, for the page's life (no persistence). */
const dismissedWarns = new Set<string>();

/** One launch warning, compact: icon and one truncated line (the full text in its tooltip), then a Dismiss button. */
export function vaultWarningLine(text: string, tabId: string): HTMLElement | null {
  if (dismissedWarns.has(`${tabId}\n${text}`)) return null;
  const row = el("div", "runes-err runes-warn-line");
  row.title = text;
  const msg = el("span", "runes-warn-text");
  msg.append(...notCarriedLine(text));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "cx-ico runes-warn-close";
  close.title = "Dismiss";
  close.setAttribute("aria-label", "Dismiss");
  close.append(lucide("x"));
  close.addEventListener("click", () => {
    dismissedWarns.add(`${tabId}\n${text}`);
    const trace = row.parentElement;
    row.remove();
    if (trace && !trace.childElementCount) trace.hidden = true;
  });
  row.append(iconImg("warning"), msg, close);
  return row;
}

/** The Bare view's notice slot: the trust card when the tab offers one, else the restart line while the tab's untrusted
 *  launch still runs after a trust (`restart`); vault warnings are drawn from the vault read. */
function bareTrustParts(tabId: string, trust: TrustOffer | null, restart: boolean): HTMLElement[] {
  return trust ? [trustCard(tabId, trust, undefined, restartCard)] : restart ? [restartCard()] : [];
}

/** The agent Generate's model list for a Bare tab's agent: the SDK roster of an agent that runs through it
 *  (its model-id prefix picks the rows), else the agent's saved catalog; none for a name that is no agent. */
export function genModels(agent: string): GenCtx {
  if (!isAgentId(agent)) return { models: [] };
  const d = AGENTS[agent];
  if (!d.flowSdk) return { models: [...(getPref(d.modelPref) ?? [])] as GenCtx["models"] };
  return { models: wiredModels().filter((m) => m.runner === "sdk" && String(m.id).startsWith(d.modelPrefix ?? "")).map((m) => ({ value: m.id, label: m.label })) };
}

/** The model fetch an agent's Bare view starts, only while its catalog is unsaved (the view repaints when it lands). */
const CATALOG_FETCH: Record<AgentId, () => Promise<void> | undefined> = {
  claude: () => undefined,
  codex: () => (!getPref("codexModels")?.length ? ensureCodexModels() : undefined),
};

export function codexModelsReady(agent: string): Promise<void> | undefined {
  return isAgentId(agent) ? CATALOG_FETCH[agent]() : undefined;
}

/** Bare tab: the import and actives view replaces the tab's body; the load trace sits collapsed below it. */
function drawBare(f: FocusedSession, res: RunesLoaded | null, err: string | null, trust: TrustOffer | null, restart: boolean) {
  const [text, bad, strip] = bareStateLine(f, res, err);
  stateEl.textContent = strip ? "" : text;
  stateEl.classList.toggle("runes-err", bad);
  stripEl.hidden = !strip;
  if (strip) {
    markEl.dataset.art = f.art;
    stripTitleEl.textContent = text;
  }
  refreshBtn.hidden = !(bad || catalogErr);
  showKey(true);
  drawnKey = null;
  shownDraft = undefined;
  const key = bareViewKey(f.id);
  const drawKey = JSON.stringify([res, err, catalogErr, catalogVer, trust, restart]);
  const fresh = freshNext || f.id !== lastTabId;
  freshNext = false;
  let e = bareViews.get(key);
  if (!e) {
    const bv = bareView(f);
    if (!bv) return;
    leaveBare();
    // a vault just started on this tab: its Pick card stays on screen (Start busy) until the bare view's first
    // resolved paint, so the panel never shows an empty gap; the view mounts detached and swaps in on onReady
    const pick = pickViews.get(f.id);
    const host = pick ? document.createElement("div") : listEl;
    if (!pick) listEl.replaceChildren();
    const io = vaultIo(f.id);
    const handle = mountBareView(
      host,
      {
        onReady: () => {
          if (!e) return;
          e.ready = true;
          const p = pickViews.get(f.id);
          if (!p) return;
          if (p.root.parentNode === listEl && shownBare === e) listEl.replaceChildren(e.handle.root);
          p.dispose();
          pickViews.delete(f.id);
        },
        ...bv,
        trustParts: bareTrustParts(f.id, trust, restart),
        headNote: (text) => { if (e) e.note = text; if (e && shownBare === e) showNote(text); },
        headName: (text) => { if (e) e.name = text; if (e && shownBare === e) showVault(text); },
        warningLine: (warning) => trust && warning === trust.text ? null : vaultWarningLine(warning, f.id),
        vault: io,
        vaultEdit: io,
        placesLibrary: true,
        onModifyChange: (on) => {
          if (!e) return;
          e.modifying = on;
          if (on) e.coverGone = false;
          syncCover();
        },
        // a tab launched without a vault has no record to wait for: paint No Vault Session at once
        retry: !!sessionLaunchInfo(f.id)?.vault,
      },
      createBareIo(),
      res,
    );
    e = { handle, scrollTop: 0, drawKey, note: null, name: null, ready: !pick, modifying: false, coverGone: false };
    bareViews.set(key, e);
  } else {
    if (e.drawKey !== drawKey) {
      e.handle.setLoads(res);
      e.handle.setTrust(bareTrustParts(f.id, trust, restart));
      e.drawKey = drawKey;
    }
    if (fresh) e.handle.reload();
    if (e.ready && (shownBare !== e || e.handle.root.parentNode !== listEl)) {
      leaveBare();
      listEl.replaceChildren(e.handle.root);
      if (frameEl) frameEl.scrollTop = e.scrollTop;
    }
  }
  shownBare = e;
  showVault(e.name);
  showNote(e.note);
  // the head's right end: Lock, then Modify far right; in Modify the view hides Lock and shows Done, then Cancel
  if (actsEl && e.handle.modeButton.parentNode !== actsEl) actsEl.replaceChildren(e.handle.lockButton, e.handle.modeButton, e.handle.cancelButton);
  syncCover(); // a focus switch lands on a tab in or out of Modify
}

/** A tab still waiting for its Rune Vault: the Pick state (vault-pick-view.ts) replaces the list; each pending tab keeps its own. */
async function drawPick(f: FocusedSession, my: number) {
  leaveBare();
  dropBare(tabDraft(f.id));
  drawnKey = null;
  lastTabId = f.id;
  stateEl.textContent = "";
  stripEl.hidden = true;
  refreshBtn.hidden = true;
  for (const [id, h] of pickViews) if (id !== f.id && !pendingVaultTab(id)) { h.dispose(); pickViews.delete(id); }
  let h = pickViews.get(f.id);
  if (!h) {
    const bv = bareView(f);
    if (!bv) return;
    const { mountVaultPick } = await import("../runes/bare/vault-pick-view"); // loaded on the first pending tab only
    if (my !== seq || !viewEl) return;
    const made = mountVaultPick(document.createElement("div"), { tab: f.id, agent: f.agent, card: ctx,
      draft: (hooks) => openDraft(f.id, hooks, { view: bv, changed: syncCover, shown: (e) => lastTabId === f.id && showDraft(e) }),
      onStarted: () => { freshNext = true; requestRefresh(); } }); // the card stays (Start busy); drawBare's onReady swaps it out
    pickViews.set(f.id, made);
    h = made;
  }
  listEl.replaceChildren(h.root);
  showDraft(tabDraft(f.id) ?? null); // back on a tab mid-draft: Done and Cancel return to the head, the library to the left
}

/** A draft's head buttons (Done, Cancel; Lock never shows in Modify) and its left cover, as drawBare places a Bare view's. */
function showDraft(e: CoverEntry | null) {
  if (!e && !shownDraft) return;
  shownDraft = e ?? undefined;
  actsEl?.replaceChildren(...(e ? [e.handle.modeButton, e.handle.cancelButton] : []));
  const d = e?.draft;
  nameHead.show(d ? (d.name?.trim() || DRAFT_NAME) : null, d ? draftName(d) : undefined);
  syncCover();
}

/** The fields every Bare view of waiting or Bare tab `f` gets, its own view and a New Rune Vault draft alike; null for a
 *  tab whose agent is no Bare agent (a PTY-only agent or a shell), which draws nothing. */
const bareView = (f: FocusedSession) => isAgentId(f.agent) ? { agent: f.agent, cwd: f.cwd, profile: "bare", card: ctx,
  gen: () => genModels(f.agent), modelsReady: codexModelsReady(f.agent) } : null;

/** The Rune Vault calls for tab `tab` (src/runes/bare/vault-io.ts): its session record, the vault reads, the Lock
 *  button, Modify's edit, and a fresh respawn of its Rendered body (the /clear route; a Raw tab has none). */
function vaultIo(tab: string): VaultIo {
  return tabVaultIo(() => tabVaultSession(tab), async () => { await renderedBody(tab)?.respawnFresh(); }, (vault) => respawnVaultTabs(vault, tab));
}

async function refresh(reloadCatalog: boolean) {
  const my = ++seq;
  refreshBtn.disabled = true;
  refreshBtn.setAttribute("aria-busy", "true");
  if (!catalog || reloadCatalog) {
    try {
      const loaded: RunesCatalog = await invoke("runes_catalog");
      if (my !== seq || !viewEl) return;
      catalog = loaded;
      catalogVer++;
      catalogErr = null;
    } catch (e) {
      if (my !== seq || !viewEl) return;
      catalogErr = String(e);
    }
  }
  if (my !== seq || !viewEl) return;
  const f = getFocusedSession();
  if (f && pendingVaultTab(f.id)) { refreshBtn.disabled = false; refreshBtn.removeAttribute("aria-busy"); void drawPick(f, my); return; }
  let res: RunesLoaded | null = null;
  let err: string | null = null;
  if (f) {
    try {
      res = await invoke("runes_loaded", { tab: f.id, agent: f.agent, sessionId: renderedSessionId(f.id), profile: f.profile ?? null });
    } catch (e) {
      err = String(e);
    }
  }
  // a Codex tab whose folder the user's config does not trust has an offer; the chat reads it the same way (transport.ts)
  let trust: TrustOffer | null = null;
  if (f?.profile === "bare" && isAgentId(f.agent) && AGENT_PROFILE[f.agent].trustOffer && my === seq && viewEl) {
    try { trust = (await invoke("codex_trust_offer", { id: f.id })) ?? null; } catch { trust = null; }
  }
  // trusted from a card this page drew: the restart line holds while the tab's newest launch is the untrusted one (its
  // manifest still carries the offer's warning); a restarted tab's launch carries none
  let restart = false;
  const trustedText = f && !trust && f.profile === "bare" ? trustedOfferText(f.id) : undefined;
  if (f && trustedText && my === seq && viewEl) {
    try { restart = !!(await invoke("bare_launch", { tab: f.id }))?.warnings.includes(trustedText); } catch { restart = false; }
  }
  if (my !== seq || !viewEl) return; // a newer query or disposal owns the view
  refreshBtn.disabled = false;
  refreshBtn.removeAttribute("aria-busy");
  if (f?.profile === "bare") {
    drawBare(f, res, err, trust, restart);
    lastTabId = f.id;
    return;
  }
  lastTabId = f?.id ?? null;
  freshNext = false;
  const key = JSON.stringify([f?.id, f?.title, f?.art, f?.profile, res, err, catalogErr]);
  if (catalog === drawnCatalog && key === drawnKey) return; // the same answers: leave the DOM as drawn
  leaveBare();
  dropBare();
  draw(f, res, err);
  drawnCatalog = catalog;
  drawnKey = key;
}

/** One refresh per task, whoever asks (show, focus and reply events land together on a tab switch). */
function requestRefresh(reloadCatalog = false) {
  pendingReload ||= reloadCatalog;
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    const reload = pendingReload;
    pendingReload = false;
    if (visible && viewEl) void refresh(reload);
  });
}

export function mountRunesView(parent: HTMLElement, openInDocument: (path: string) => void, note: (msg: string) => void): HTMLElement {
  const shell = paneShell({ id: "runes-view", head: { cls: "runes-head" }, frame: { cls: "runes-body" } });
  viewEl = shell.root;
  catalog = null;
  catalogErr = null;
  visible = false;
  frameEl = shell.frame;
  drawnCatalog = null;
  drawnKey = null;
  shell.root.style.display = "none";
  ctx = { openInDocument, note };
  stateEl = el("span", "runes-state pane-head-card");
  stripEl = el("span", "runes-strip pane-head-card");
  stripEl.hidden = true;
  stripEl.title = STRIP_TIP;
  markEl = el("span", "runes-mark");
  stripTitleEl = el("span", "runes-strip-title");
  stripEl.append(markEl, stripTitleEl);
  refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "runes-act runes-refresh";
  refreshBtn.setAttribute("aria-label", "Refresh");
  refreshBtn.title = "Refresh";
  refreshBtn.hidden = true;
  refreshBtn.append(iconImg("refresh"));
  refreshBtn.addEventListener("click", () => {
    freshNext = true;
    void refresh(true);
  });
  noteEl = el("span", "runes-head-note");
  noteEl.hidden = true;
  actsEl = el("span", "runes-head-acts");
  nameHead = headName("runes-state runes-vault-name pane-head-card");
  shell.head.append(stateEl, nameHead.root, stripEl, noteEl, refreshBtn, actsEl);
  listEl = el("div", "runes-list");
  // the frame holds the scrolling list and, under it, the pinned key strip
  const scrollEl = el("div", "runes-scroll");
  scrollEl.appendChild(listEl);
  frameEl = scrollEl;
  keyEl = runeIconKey();
  shell.frame.append(scrollEl, keyEl);
  parent.appendChild(shell.root);
  focusListener = () => {
    if (visible) requestRefresh();
  };
  document.addEventListener("vidar-focus", focusListener);
  // another route took the left slot (openRelay, openDual): the cover is gone until the next Modify entry
  unsubCover = onLeftCoverChange(() => {
    if (!coverEl || getLeftCover() === coverEl) return;
    if (coverOwner) coverOwner.coverGone = true;
    coverEl = null;
    coverOwner = undefined;
  });
  // a finished turn of the focused tab: its session and loads may be new (Rendered tabs fire it)
  replyListener = (e) => {
    // fresh: the first message locked the vault (agent.rs lock_first_send), so the Bare view re-reads it for Locked
    if (visible && (e as CustomEvent<ReplyDoneDetail>).detail?.id === getFocusedSession()?.id) { freshNext = true; requestRefresh(); }
  };
  document.addEventListener("vidar-reply-done", replyListener);
  return shell.root;
}

export function onRunesShown() {
  visible = true;
  freshNext = true;
  requestRefresh();
}

export function onRunesHidden() {
  visible = false;
  seq++;
  dropBare();
}

export function disposeRunesView() {
  onRunesHidden();
  if (focusListener) document.removeEventListener("vidar-focus", focusListener);
  focusListener = undefined;
  unsubCover?.();
  unsubCover = undefined;
  if (replyListener) document.removeEventListener("vidar-reply-done", replyListener);
  replyListener = undefined;
  viewEl?.remove();
  viewEl = undefined;
  keyEl = undefined;
  actsEl = undefined;
  frameEl = undefined;
  catalog = null;
  catalogErr = null;
  drawnCatalog = null;
  drawnKey = null;
  for (const e of bareViews.values()) e.handle.dispose();
  bareViews.clear();
  for (const h of pickViews.values()) h.dispose();
  pickViews.clear();
  shownBare = undefined;
  lastTabId = null;
  freshNext = false;
}
