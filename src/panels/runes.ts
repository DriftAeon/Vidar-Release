// Runes tab: the rune libraries (Global, then Vidar) traced against what the focused tab loaded.
// The catalog is cached until Refresh; `runes_loaded` runs only while the tab is on screen (on show,
// on `vidar-focus` while shown, on `vidar-reply-done` for the focused tab while shown, on Refresh).
// A Rendered tab's session id is read at query time. A Bare tab reads no instruction files, so its
// trace lists what the launch carried (`bare_launch`, the tab's newest manifest) before any loads.
import { invoke, type BareLaunch } from "../ipc";
import type { ReplyDoneDetail } from "./reply-events";
import { iconImg } from "../icon-img";
import { lucide } from "../icons";
import { paneShell } from "./pane-shell";
import { getFocusedSession, renderedSessionId, sessionLaunchInfo, type FocusedSession } from "./sessions/lookup";
import { mountBareView, type BareViewHandle } from "../runes/bare/view";
import { createBareIo } from "../runes/bare/io";
import { BARE_SCOPE, openKeys, reopen, runeIconKey, setSection, type CardCtx } from "../runes/cards";
import type { GenCtx } from "../runes/bare/agent-view";
import { wiredModels } from "../flow/roster";
import { getPref } from "../prefs";
import { ensureCodexModels } from "../agents/codex-models";
import { canLoad, traceRunes } from "../runes/trace";
import type { RunesCatalog, RunesLoaded } from "../runes/types";
import { trustCard, type TrustOffer } from "./rendered/notice-actions";

const GROUP_NAME: Record<string, string> = { global: "Global", vidar: "Vidar" };
// tier dividers as the sets view: tier 1 (every session) is the top group and gets none
const TIER_DIVIDER: Record<number, string> = { 2: "Path-Scoped", 3: "Recall", 4: "Not Loaded" };

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
let stripEl: HTMLElement;
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
interface BareEntry { handle: BareViewHandle; scrollTop: number; drawKey: string }
const bareViews = new Map<string, BareEntry>();
let shownBare: BareEntry | undefined;
let freshNext = false; // shown again or Refresh pressed: the next Bare draw re-reads the row
let lastTabId: string | null = null;
let catalogVer = 0;

/** Swap the icon key between the ordinary one (Scope: Global, Vidar) and the Bare one (Global, Project). */
function showKey(bare: boolean) {
  if (!keyEl || keyEl.classList.contains("runes-key-bare") === bare) return;
  const next = runeIconKey(bare ? BARE_SCOPE : undefined);
  if (bare) next.classList.add("runes-key-bare");
  keyEl.replaceWith(next);
  keyEl = next;
}

/** Show the ordinary icon key again; the kept Bare view stays mounted (on hide) or is left by the caller. */
function dropBare() {
  showKey(false);
}

/** The ordinary view takes the list: remember the Bare view's scroll position and let it go. */
function leaveBare() {
  if (shownBare && frameEl) shownBare.scrollTop = frameEl.scrollTop;
  shownBare = undefined;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
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

/** Repo root for outside-file labels: the Vidar library's parent folder. */
function repoRootOf(c: RunesCatalog): string | null {
  const v = c.libraries.find((l) => l.key === "vidar" && l.present);
  return v ? v.root.replace(/[\\/][^\\/]*[\\/]?$/, "") : null;
}

function draw(f: FocusedSession | null, res: RunesLoaded | null, err: string | null) {
  const [text, bad, strip] = stateLine(f, res, err);
  stateEl.textContent = strip ? "" : text;
  stateEl.classList.toggle("runes-err", bad);
  stripEl.hidden = !strip;
  if (strip && f) {
    markEl.dataset.art = f.art;
    stripTitleEl.textContent = text;
  }
  refreshBtn.hidden = !(bad || catalogErr); // retry only: focus change and show already re-query
  const open = openKeys(listEl);
  const scroll = frameEl?.scrollTop ?? 0;
  // no focused tab: nothing to trace, so the list stays empty (a catalog error still shows)
  listEl.replaceChildren(...(f ? traceParts(res) : catalogErr ? [el("div", "runes-err", catalogErr)] : []));
  reopen(listEl, open);
  if (frameEl) frameEl.scrollTop = scroll;
}

/** The load trace as today's tab draws it: library groups, then the outside files. */
function traceParts(res: RunesLoaded | null): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (catalogErr) parts.push(el("div", "runes-err", catalogErr));
  if (catalog) {
    const trace = traceRunes(catalog, res, repoRootOf(catalog));
    for (const t of trace.libraries) {
      const group = el("section", "runes-group");
      group.appendChild(el("h3", "runes-group-head", GROUP_NAME[t.lib.key] ?? t.lib.key));
      if (!t.lib.present) {
        const missing = el("div", "runes-missing", "No Library");
        missing.title = `No rune library at ${t.lib.root}`; // copy-ok: sentence-case tooltip (full sentence)
        group.appendChild(missing);
      }
      if (t.lib.error) group.appendChild(el("div", "runes-err", t.lib.error));
      let lastTier = 0;
      for (const s of t.sets) {
        if (!canLoad(s)) continue;
        const tier = s.set.tier;
        if (tier !== lastTier && TIER_DIVIDER[tier]) group.appendChild(el("div", "runes-div", TIER_DIVIDER[tier]));
        lastTier = tier;
        group.appendChild(setSection(t, s, ctx));
      }
      parts.push(group);
    }
    if (trace.outside.length) {
      const group = el("section", "runes-group");
      const head = el("h3", "runes-group-head");
      head.title = "Not from a rune library"; // copy-ok: sentence-case tooltip (2026-10-11)
      head.setAttribute("aria-label", "Not from a rune library"); // copy-ok: same tooltip text
      head.appendChild(iconImg("grp-findings"));
      group.appendChild(head);
      const list = el("ul", "runes-outside");
      for (const o of trace.outside) {
        const li = document.createElement("li");
        const row = el("button", "runes-blk card runes-outside-row") as HTMLButtonElement;
        row.type = "button";
        row.title = o.path;
        row.append(iconImg("doc"), el("span", "runes-rname", o.path.split(/[\\/]/).pop() ?? o.path));
        row.addEventListener("click", () => ctx.openInDocument(o.path));
        li.appendChild(row);
        list.appendChild(li);
      }
      group.appendChild(list);
      parts.push(group);
    }
  }
  return parts;
}

const hasLoads = (res: RunesLoaded | null): boolean => !!res && res.source === "transcript" && res.files.length > 0;

/** A Bare tab's state line: with a launch recorded, the trace body speaks for it, so no "nothing
 *  loaded" reason shows; the strip still names the tab when the transcript has loads. */
function bareStateLine(f: FocusedSession, res: RunesLoaded | null, err: string | null, launch: BareLaunch | null): [string, boolean, boolean] {
  if (err || !launch) return stateLine(f, res, err);
  return hasLoads(res) ? [f.title, false, true] : ["", false, false];
}

/** Launch warnings the user dismissed, as `${tabId}\n${text}`, for the page's life (no persistence). */
const dismissedWarns = new Set<string>();

/** One launch warning, compact: icon and one truncated line (the full text in its tooltip), then a Dismiss button. */
function warnLine(text: string, tabId: string): HTMLElement {
  const row = el("div", "runes-err runes-warn-line");
  row.title = text;
  const msg = el("span", "runes-warn-text", text);
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

/** The Bare trace, drawn once in View: the launch's warnings, then today's file-load rows when the
 *  transcript has any. The set, skill and hook name lists repeat the config and are not drawn. */
export function bareTraceParts(launch: BareLaunch | null, launchErr: string | null, res: RunesLoaded | null, tabId = "", trust: TrustOffer | null = null): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (launchErr) parts.push(el("div", "runes-err", launchErr));
  else if (launch) {
    // the untrusted-folder warning becomes the chat's trust card (Trust Folder, Dismiss) while the tab has an offer
    for (const w of launch.warnings) {
      if (trust && w === trust.text) parts.push(trustCard(tabId, trust));
      else if (!dismissedWarns.has(`${tabId}\n${w}`)) parts.push(warnLine(w, tabId));
    }
  }
  if (hasLoads(res)) parts.push(...traceParts(res));
  return parts;
}

/** The agent Generate's model list for a Bare tab's agent: the Claude roster, or the saved Codex catalog. */
export function genModels(agent: string): GenCtx {
  if (agent === "codex") return { models: [...(getPref("codexModels") ?? [])] };
  return { models: wiredModels().filter((m) => m.runner === "sdk" && String(m.id).startsWith("claude-")).map((m) => ({ value: m.id, label: m.label })) };
}

/** A Codex Bare view's model fetch, started only while no catalog is saved (the view repaints when it lands). */
export function codexModelsReady(agent: string): Promise<void> | undefined {
  return agent === "codex" && !getPref("codexModels")?.length ? ensureCodexModels() : undefined;
}

/** Bare tab: the import and actives view replaces the tab's body; the load trace sits collapsed below it. */
function drawBare(f: FocusedSession, res: RunesLoaded | null, err: string | null, launch: BareLaunch | null, launchErr: string | null, trust: TrustOffer | null) {
  const [text, bad, strip] = bareStateLine(f, res, err, launch);
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
  const rowKey = sessionLaunchInfo(f.id)?.rowKey ?? null;
  const key = rowKey ? `${f.agent}|${rowKey}|${f.cwd}` : `tab|${f.id}`;
  const drawKey = JSON.stringify([res, err, catalogErr, catalogVer, launch, launchErr, trust]);
  const fresh = freshNext || f.id !== lastTabId;
  freshNext = false;
  let e = bareViews.get(key);
  if (!e) {
    leaveBare();
    listEl.replaceChildren();
    const handle = mountBareView(
      listEl,
      {
        agent: f.agent,
        rowKey,
        cwd: f.cwd,
        profile: "bare",
        traceParts: bareTraceParts(launch, launchErr, res, f.id, trust),
        card: ctx,
        gen: () => genModels(f.agent),
        modelsReady: codexModelsReady(f.agent),
      },
      createBareIo(),
    );
    e = { handle, scrollTop: 0, drawKey };
    bareViews.set(key, e);
  } else {
    if (e.drawKey !== drawKey) {
      e.handle.setTrace(bareTraceParts(launch, launchErr, res, f.id, trust));
      e.drawKey = drawKey;
    }
    if (fresh) e.handle.reload();
    if (shownBare !== e || e.handle.root.parentNode !== listEl) {
      leaveBare();
      listEl.replaceChildren(e.handle.root);
      if (frameEl) frameEl.scrollTop = e.scrollTop;
    }
  }
  shownBare = e;
  // the View / Modify switch sits on the Key's last line, at the right
  if (keyEl && e.handle.modeButton.parentNode !== keyEl) {
    keyEl.querySelector(".runes-mode")?.remove();
    keyEl.appendChild(e.handle.modeButton);
  }
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
  let res: RunesLoaded | null = null;
  let err: string | null = null;
  if (f) {
    try {
      res = await invoke("runes_loaded", { tab: f.id, agent: f.agent, sessionId: renderedSessionId(f.id), profile: f.profile ?? null });
    } catch (e) {
      err = String(e);
    }
  }
  let launch: BareLaunch | null = null;
  let launchErr: string | null = null;
  if (f?.profile === "bare" && my === seq && viewEl) {
    try {
      launch = (await invoke("bare_launch", { tab: f.id })) ?? null;
    } catch (e) {
      launchErr = String(e);
    }
  }
  // a Codex tab whose folder the user's config does not trust has an offer; the chat reads it the same way (transport.ts)
  let trust: TrustOffer | null = null;
  if (f?.profile === "bare" && f.agent === "codex" && launch && my === seq && viewEl) {
    try { trust = (await invoke("codex_trust_offer", { id: f.id })) ?? null; } catch { trust = null; }
  }
  if (my !== seq || !viewEl) return; // a newer query or disposal owns the view
  refreshBtn.disabled = false;
  refreshBtn.removeAttribute("aria-busy");
  if (f?.profile === "bare") {
    drawBare(f, res, err, launch, launchErr, trust);
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
  stripEl.title = "Loaded from the transcript"; // copy-ok: sentence-case tooltip (2026-10-11)
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
  shell.head.append(stateEl, stripEl, refreshBtn);
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
  // a finished turn of the focused tab: its session and loads may be new (Rendered tabs fire it)
  replyListener = (e) => {
    if (visible && (e as CustomEvent<ReplyDoneDetail>).detail?.id === getFocusedSession()?.id) requestRefresh();
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
  if (replyListener) document.removeEventListener("vidar-reply-done", replyListener);
  replyListener = undefined;
  viewEl?.remove();
  viewEl = undefined;
  keyEl = undefined;
  frameEl = undefined;
  catalog = null;
  catalogErr = null;
  drawnCatalog = null;
  drawnKey = null;
  for (const e of bareViews.values()) e.handle.dispose();
  bareViews.clear();
  shownBare = undefined;
  lastTabId = null;
  freshNext = false;
}
