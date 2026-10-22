// Notion bench tab: the saved Notion connection, its shared databases and pages, and one data source at a
// time. Read-only. Loads on show when the shown level is stale (10 min), on Refresh, after Connect and on
// drill-in; there is no interval poll. The token goes from the form to notion_connect once and is never held
// here. Plan: docs/projects/notion/plan.md § Views, § Adapter rules. Model: notion/model.ts, facets.ts;
// paging: notion/fetch.ts; adapter: notion/adapter.ts; DOM: notion/view.ts. Registration is W4's.
import { invoke } from "../ipc";
import type { Item } from "../browser/types";
import { clearAdapterState, makeAdapter, openLink, rememberLinks } from "../notion/adapter";
import { topFacets } from "../notion/facets";
import {
  TOP, bumpGen, call, clearRefused, clearStamps, dueOnShow, isStale, loadSource, loadTop, markAttempt,
} from "../notion/fetch";
import {
  ROW_CAP_NOTE, SHOWN_KINDS, TOP_CAP_NOTE, connectCopy, errorCopy, hitItem, partialNote, rowItem, type NotionErr,
} from "../notion/model";
import {
  CONNECTIONS_URL, TOKENS_URL, buildNotionView, type ErrView, type NotionView, type SourceState, type TopState, type ViewState,
} from "../notion/view";
import { getPref, setPref } from "../prefs";
import { getFocusedSession } from "./sessions/lookup";
import { writeToSession } from "./sessions";

let view: NotionView | undefined;
/** Bumped by mount, hide and dispose: a list read in flight from before is dropped. */
let seq = 0;
/** Bumped by mount and dispose: a Connect from an older view drops its result. */
let mountGen = 0;
let state: ViewState = blank();

function blankTop(): TopState {
  return { workspace: "", kind: null, items: [], facets: topFacets(), busy: false, note: null, error: null };
}

function blank(): ViewState {
  return { mode: "loading", formBusy: false, formError: null, top: blankTop(), source: null, hint: null };
}

function draw(): void {
  view?.render(state);
}

function errView(e: NotionErr): ErrView {
  return { ...errorCopy(e), shown: SHOWN_KINDS.has(e.kind) };
}

function showNotice(): void {
  state = { ...state, mode: "notice", top: blankTop(), source: null, formBusy: false, formError: null, hint: null };
}

/** Forget everything tied to the old connection: generation, stamps, details, links, refused props, and the
 *  top browser's Fullscreen and cards. */
function forget(): void {
  bumpGen();
  clearStamps();
  clearRefused();
  clearAdapterState();
  view?.reset();
}

/** The seq of the load that set each level's busy. Only that load clears it when it ends, however it ends
 *  (landed, error, superseded), so busy never outlives its load and a newer load's busy is never cleared. */
let topOwner = -1;
let sourceOwner = -1;

function beginTop(mine: number): void {
  topOwner = mine;
  state = { ...state, top: { ...state.top, busy: true } };
  draw();
}

function endTop(mine: number): void {
  if (topOwner !== mine) return;
  topOwner = -1;
  if (!state.top.busy) return;
  state = { ...state, top: { ...state.top, busy: false } };
  draw();
}

function endSource(mine: number): void {
  if (sourceOwner !== mine) return;
  sourceOwner = -1;
  if (!state.source?.busy) return;
  state = { ...state, source: { ...state.source, busy: false } };
  draw();
}

async function loadTopLevel(): Promise<void> {
  if (state.top.busy) return;
  const mine = seq;
  beginTop(mine);
  try {
    await readTop(mine);
  } finally {
    endTop(mine);
  }
}

/** The two searches; the caller set busy and clears it. */
async function readTop(mine: number): Promise<void> {
  const r = await loadTop(() => mine === seq);
  if (mine !== seq || !r) return;
  if (r.error?.kind === "unset") { showNotice(); draw(); return; }
  rememberLinks(r.hits.map((h) => ({ id: h.id, url: h.url, source: h.kind === "source" })));
  const items = r.hits.map(hitItem);
  state = {
    ...state,
    top: { ...state.top, busy: false, items, error: r.error ? errView(r.error) : null, note: r.capped ? TOP_CAP_NOTE : null },
  };
  draw();
}

async function loadSourceLevel(): Promise<void> {
  const cur = state.source;
  if (!cur || cur.busy) return;
  const mine = seq;
  sourceOwner = mine;
  state = { ...state, source: { ...cur, busy: true } };
  draw();
  try {
    await readSource(mine, cur.id, cur.adapter);
  } finally {
    endSource(mine);
  }
}

async function readSource(mine: number, id: string, adapter: SourceState["adapter"]): Promise<void> {
  const r = await loadSource(id, () => mine === seq && state.source?.adapter === adapter);
  if (mine !== seq || state.source?.adapter !== adapter || !r) return;
  const now = state.source;
  if (r.error?.kind === "unset") { showNotice(); draw(); return; }
  rememberLinks(r.rows.map((row) => ({ id: row.id, url: row.url })));
  const plan = r.plan;
  const anyIcon = r.rows.some((row) => !!(row.icon || row.iconName));
  const items = plan ? r.rows.map((row) => rowItem(row, plan, anyIcon)) : [];
  const partial = !!r.error && items.length > 0;
  state = {
    ...state,
    source: {
      ...now,
      busy: false,
      title: r.source?.title.trim() || now.title,
      items,
      facets: plan ? plan.facets : now.facets,
      error: r.error && !partial ? errView(r.error) : null,
      note: partial ? partialNote(items.length) : r.capped ? ROW_CAP_NOTE : null,
    },
  };
  draw();
}

/** The shown level reloads; the top level also re-reads the saved connection first. */
async function refresh(): Promise<void> {
  if (!view || state.top.busy || state.source?.busy) return; // a load in flight owns the level (jira.ts)
  if (state.mode === "list" && state.source) { void loadSourceLevel(); return; }
  const mine = ++seq;
  beginTop(mine); // busy covers the status read too, so a repeat show cannot start a second one
  try {
    const st = await call(() => invoke("notion_status"));
    if (mine !== seq) return;
    if ("error" in st) {
      markAttempt(TOP);
      state = { ...state, mode: "list", top: { ...state.top, busy: false, items: [], error: errView(st.error) } };
      draw();
      return;
    }
    if (!st.ok.tokenSaved) {
      if (state.mode !== "form") showNotice();
      draw();
      return;
    }
    state = { ...state, mode: "list", top: { ...state.top, workspace: st.ok.workspace ?? "", kind: st.ok.kind } };
    await readTop(mine);
  } finally {
    endTop(mine);
  }
}

function drill(item: Item): void {
  bumpGen(); // level change
  seq++;
  state = { ...state, top: { ...state.top, busy: false } };
  const adapter = makeAdapter(`notion:${item.id}`, { drill, back, type });
  state = {
    ...state,
    source: { id: item.id, title: item.title, adapter, items: [], facets: [], busy: false, note: null, error: null },
  };
  void loadSourceLevel();
}

function back(): void {
  if (!state.source) return;
  bumpGen(); // level change
  seq++;
  state = { ...state, source: null };
  draw();
  if (isStale(TOP) && dueOnShow(TOP)) void loadTopLevel();
}

async function type(text: string): Promise<void> {
  const id = getFocusedSession()?.id ?? null; // captured before any await
  const gen = mountGen;
  const mine = seq;
  const ok = id ? await writeToSession(id, text) : false;
  if (gen !== mountGen || mine !== seq || !view) return;
  state = { ...state, hint: ok ? null : "No tab to type into." };
  draw();
}

function hideTab(): void {
  const key = "bench:notion";
  const hidden = getPref("modules.hidden") ?? [];
  if (hidden.includes(key)) return;
  if (setPref("modules.hidden", [...hidden, key])) document.dispatchEvent(new document.defaultView!.CustomEvent("vidar-modules-change"));
}

async function onSubmit(token: string): Promise<void> {
  if (state.formBusy) return;
  const mine = mountGen;
  seq++; // a status read in flight must not overwrite the form
  state = { ...state, mode: "form", formBusy: true, formError: null };
  draw();
  const r = await call(() => invoke("notion_connect", { token }));
  if (mine !== mountGen || !view) return;
  if ("error" in r) {
    state = { ...state, mode: "form", formBusy: false, formError: connectCopy(r.error) };
    draw();
    return;
  }
  forget();
  state = {
    ...state, mode: "list", formBusy: false, formError: null, source: null, hint: null,
    top: { ...blankTop(), workspace: r.ok.workspace ?? "", kind: r.ok.kind },
  };
  await loadTopLevel();
}

/** The old connection's reads and walks stop at once; its state is forgotten only once Rust confirms, so a
 *  reject keeps the list (links and data-source ids included) as it was. */
async function onDisconnect(): Promise<void> {
  if (state.formBusy) return;
  const gen = mountGen;
  const mine = ++seq;
  bumpGen();
  try {
    await invoke("notion_disconnect");
  } catch (e) {
    if (gen !== mountGen || mine !== seq || !view) return;
    state = { ...state, hint: e instanceof Error ? e.message : String(e) }; // the Rust text
    draw();
    return;
  }
  if (gen !== mountGen || !view) return;
  forget();
  if (mine !== seq) return;
  state = { ...state, mode: "form", top: blankTop(), source: null, formBusy: false, formError: null, hint: null };
  draw();
}

export function mountNotionView(parent: HTMLElement): HTMLElement {
  mountGen++;
  seq++;
  forget();
  state = blank();
  const topAdapter = makeAdapter("notion", { drill, type });
  view = buildNotionView({
    connectStart: () => { state = { ...state, mode: "form", formError: null, formBusy: false }; draw(); },
    cancel: () => { showNotice(); draw(); },
    hide: hideTab,
    submit: (token) => void onSubmit(token),
    openConnections: () => openLink(CONNECTIONS_URL),
    openTokens: () => openLink(TOKENS_URL),
    refresh: () => void refresh(),
    disconnect: () => void onDisconnect(),
    back,
  }, topAdapter);
  parent.appendChild(view.root);
  draw();
  return view.root;
}

export function onNotionShown(): void {
  if (!view || state.formBusy) return; // a Connect in flight owns the view
  if (state.top.busy || state.source?.busy) return; // so does a load in flight
  if (state.mode === "loading") { void refresh(); return; }
  if (state.mode !== "list") return;
  // stale (no load landed in 10 min) and due (no attempt in 10 min, failed ones included)
  if (state.source) { if (isStale(state.source.id) && dueOnShow(state.source.id)) void loadSourceLevel(); return; }
  if (isStale(TOP) && dueOnShow(TOP)) void refresh();
}

export function onNotionHidden(): void {
  seq++; // a read in flight is dropped; the next show reads again
  if (state.top.busy || state.source?.busy) {
    state = { ...state, top: { ...state.top, busy: false }, source: state.source ? { ...state.source, busy: false } : null };
    draw();
  }
}

export function disposeNotionView(): void {
  mountGen++;
  seq++;
  forget();
  view?.dispose();
  view = undefined;
  state = blank();
}
