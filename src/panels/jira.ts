// Jira bench tab: the saved Jira Cloud connection and its issues, 50 a page. Fetches on show when the
// last read is over 60 s old and only one page is loaded, on Refresh and after Connect; there is no
// interval poll (rate limits). The token goes from the form to jira_connect once and is never held here.
// Plan: docs/projects/jira/all-types-plan.md § D1-D5; docs/projects/jira/issues-tab-plan.md § D8.
// Model: jira/model.ts; DOM: jira/view.ts.
import { invoke } from "../ipc";
import { buildDetail, type DetailHost } from "../jira/detail";
import { buildFilterBar, type FilterBar, type Opt } from "../jira/filters";
import {
  DEFAULT_JQL, applicable, blankFilters, isBlankJql, mergePage, normaliseSite, sendText, sortTypes, toFilters,
  type FilterState, type Issue, type Scope,
} from "../jira/model";
import type { Filters } from "../jira/ipc";
import { buildView, errorTitle, type ErrorKind, type FormValues, type View, type ViewState } from "../jira/view";
import { getPref, setPref } from "../prefs";
import { getFocusedSession } from "./sessions/lookup";
import { writeToSession } from "./sessions";

const STALE_MS = 60_000;
const SEARCH_DEBOUNCE_MS = 400;
const TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";

type Types = Opt<{ name: string; level: number }>;
type Projects = Opt<{ key: string; name: string }>;
const loadingOpts = () => ({ types: { status: "loading", items: [] } as Types, projects: { status: "loading", items: [] } as Projects });

let view: View | undefined;
let bar: FilterBar | undefined;
/** The open issue's fullscreen; closed on Connect, Disconnect, dispose and any mode but the list. */
let detail: DetailHost | undefined;
/** Filter bar state, in memory only; `applied` is what the current query was sent with. */
let filters: FilterState = blankFilters();
let applied: Filters | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** Picker options, loaded once per connection (keyed by site plus email); each list fails on its own. */
let options = loadingOpts();
let optionsKey = "";
let optionsGen = 0;
/** Goes up on mount, dispose, scope change, refresh, Connect and Disconnect. Page 1 and Load 50 More
 *  carry it, and a reply that comes back under an older value is dropped. */
let query = 0;
let lastFetch = 0;
let lastEmail = "";
let pages = 0; // pages merged under the current query
let nextToken: { value: string; q: number } | null = null;
let seenTokens = new Set<string>();
let state: ViewState = blank();

function blank(): ViewState {
  return {
    mode: "loading", site: "", email: "", jql: "", issues: [], scope: "mine", more: false, loadingMore: false,
    error: null, formError: null, busy: false, note: null,
  };
}

function draw() {
  if (state.mode === "form" || state.mode === "notice") detail?.reset();
  syncPaging();
  view?.render(state);
  drawBar();
}

function drawBar() {
  if (!bar) return;
  const shown = state.mode === "list" || state.mode === "loading";
  bar.root.hidden = !shown;
  if (!shown) { bar.close(); return; }
  bar.render({ scope: state.scope, blankJql: isBlankJql(state.jql), filters, types: options.types, projects: options.projects });
}

function curPayload(): Filters | null {
  return toFilters(filters, state.scope, isBlankJql(state.jql));
}

/** A filter change starts a new query: the old replies are dropped by the counter and page 1 reloads. */
function onFilters(next: FilterState, typing: boolean) {
  filters = next;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = undefined;
  if (typing) {
    searchTimer = setTimeout(applyFilters, SEARCH_DEBOUNCE_MS);
    drawBar();
    return;
  }
  applyFilters();
}

function applyFilters() {
  searchTimer = undefined;
  if (!view || state.busy || (state.mode !== "list" && state.mode !== "loading")) return;
  void refresh();
}

/** Types and projects load once per connection and fail apart: a failed list only disables its own picker. */
function loadOptions(key: string) {
  if (optionsKey === key) return;
  optionsKey = key;
  const gen = ++optionsGen;
  options = loadingOpts();
  drawBar();
  void (async () => {
    let next: Types;
    try {
      const res = await invoke("jira_types");
      next = "types" in res ? { status: "ready", items: sortTypes(res.types) } : { status: "failed", items: [] };
    } catch {
      next = { status: "failed", items: [] };
    }
    if (gen !== optionsGen) return;
    options = { ...options, types: next };
    drawBar();
  })();
  void (async () => {
    let next: Projects;
    try {
      const res = await invoke("jira_projects");
      next = "projects" in res ? { status: "ready", items: res.projects } : { status: "failed", items: [] };
    } catch {
      next = { status: "failed", items: [] };
    }
    if (gen !== optionsGen) return;
    options = { ...options, projects: next };
    drawBar();
  })();
}

function resetOptions() {
  optionsKey = "";
  optionsGen++;
  options = loadingOpts();
}

/** The Load 50 More row needs a token fetched under the current counter. */
function syncPaging() {
  state = { ...state, more: !!nextToken && nextToken.q === query };
}

function openUrl(url: string) {
  void invoke("open_url", { url }).catch(console.error);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Fetched = { issues: Issue[]; nextPageToken: string | null } | { error: { kind: ErrorKind; message: string } };

async function fetchPage(scope: Scope, pageToken: string | null, sent: Filters | null): Promise<Fetched> {
  try {
    return await invoke("jira_issues", { scope, filters: sent, pageToken });
  } catch (e) {
    return { error: { kind: "network", message: errText(e) } };
  }
}

/** Starts a new query: every older reply is dropped and the paging state of the old one is cleared. */
function bump(): number {
  query++;
  nextToken = null;
  seenTokens = new Set();
  pages = 0;
  state = { ...state, loadingMore: false };
  return query;
}

function landPage1(res: { issues: Issue[]; nextPageToken: string | null }, q: number) {
  pages = 1;
  seenTokens = new Set();
  nextToken = null;
  if (res.nextPageToken) {
    seenTokens.add(res.nextPageToken);
    nextToken = { value: res.nextPageToken, q };
  }
  state = { ...state, issues: mergePage([], res.issues) };
}

function showNotice() {
  state = { ...state, mode: "notice", issues: [], error: null, formError: null, busy: false, note: null };
}

/** Reads the saved connection and, when there is one, loads page 1. */
async function refresh() {
  if (!view) return;
  const q = bump();
  const scope = state.scope;
  draw(); // the bump already removed Load 50 More
  try {
    const st = await invoke("jira_status");
    if (q !== query) return;
    if (st.email) lastEmail = st.email;
    state = { ...state, site: st.site ?? "", email: st.email ?? lastEmail, jql: st.jql ?? DEFAULT_JQL };
    if (!st.site || !st.email || !st.tokenSaved) {
      if (state.mode !== "form") showNotice();
      draw();
      return;
    }
    applied = curPayload();
    loadOptions(`${st.site}|${st.email}`);
    if (state.mode === "loading") draw();
    const res = await fetchPage(scope, null, applied);
    if (q !== query) return;
    lastFetch = Date.now();
    if ("error" in res && res.error.kind === "unset") {
      if (state.mode !== "form") showNotice();
    } else if ("error" in res) {
      state = { ...state, mode: "list", issues: [], error: res.error, note: null };
    } else {
      landPage1(res, q);
      state = { ...state, mode: "list", error: null, note: null };
    }
  } catch (e) {
    if (q !== query) return;
    state = { ...state, mode: "list", issues: [], error: { kind: "network", message: errText(e) } };
  }
  draw();
}

async function loadMore() {
  const t = nextToken;
  if (!view || !t || t.q !== query || state.loadingMore) return;
  const q = query;
  state = { ...state, loadingMore: true, note: null };
  draw();
  const res = await fetchPage(state.scope, t.value, applied);
  if (q !== query) return;
  if ("error" in res) {
    // the token stays, so the row can be tried again
    state = { ...state, loadingMore: false, note: errorTitle(res.error.kind) ?? res.error.message };
    draw();
    return;
  }
  pages++;
  const again = res.nextPageToken;
  nextToken = again && !seenTokens.has(again) ? { value: again, q } : null; // stops on a missing or repeated token
  if (again) seenTokens.add(again);
  state = { ...state, loadingMore: false, issues: mergePage(state.issues, res.issues) };
  lastFetch = Date.now();
  draw();
}

function setScope(scope: Scope) {
  if (state.busy || scope === state.scope) return;
  filters = applicable(filters, scope, isBlankJql(state.jql)); // keeps what applies; Project goes on Mine
  state = { ...state, scope, mode: "loading", issues: [], error: null, note: null };
  draw();
  void refresh();
}

function hideTab() {
  const key = "bench:jira";
  const hidden = getPref("modules.hidden") ?? [];
  if (hidden.includes(key)) return;
  if (setPref("modules.hidden", [...hidden, key])) document.dispatchEvent(new document.defaultView!.CustomEvent("vidar-modules-change"));
}

function formFail(error: NonNullable<ViewState["formError"]>) {
  state = { ...state, mode: "form", formError: error, busy: false };
  draw();
}

async function onSubmit(values: FormValues) {
  if (state.busy) return;
  const site = normaliseSite(values.site);
  const email = values.email.trim();
  const jql = values.jql.trim();
  const token = values.token;
  const mine = bump(); // a status read in flight must not overwrite the form
  detail?.reset();
  if (!site) {
    state = { ...state, mode: "form", formError: { kind: "address", message: "" }, site: values.site, email, jql };
    draw();
    return;
  }
  lastEmail = email;
  state = { ...state, mode: "form", busy: true, formError: null, site, email, jql };
  draw();
  try {
    // the default is stored as "" so vidar.json keeps no copy of it
    await invoke("patch_settings", { key: "jira", value: { site, jql: jql === DEFAULT_JQL ? "" : jql } });
    await invoke("jira_connect", { site, email, token });
  } catch (e) {
    if (mine !== query) return;
    formFail({ kind: "text", message: errText(e) });
    return;
  }
  if (mine !== query) return;
  const scope = state.scope;
  resetOptions(); // a new connection: the pickers load again, once the credential is accepted
  applied = curPayload();
  const res = await fetchPage(scope, null, applied);
  if (mine !== query || !view) return;
  if ("error" in res && (res.error.kind === "auth" || res.error.kind === "unset")) {
    // an auth failure drops the credential just saved and keeps the form with its notice
    if (res.error.kind === "auth") await invoke("jira_disconnect").catch(() => undefined);
    if (mine !== query) return;
    formFail(res.error);
    return;
  }
  // the credential is saved: any other failure is a load error in the connected view
  loadOptions(`${site}|${email}`);
  lastFetch = Date.now();
  if ("error" in res) state = { ...state, issues: [], error: res.error };
  else {
    landPage1(res, mine);
    state = { ...state, error: null };
  }
  state = { ...state, mode: "list", formError: null, busy: false, note: null };
  draw();
}

async function onDisconnect() {
  if (state.busy) return;
  bump();
  detail?.reset();
  try {
    await invoke("jira_disconnect");
  } catch (e) {
    state = { ...state, note: errText(e) }; // the Rust text, not a load title
    draw();
    return;
  }
  resetOptions();
  filters = blankFilters();
  state = { ...state, mode: "form", issues: [], error: null, formError: null, busy: false, note: null };
  // the form prefills from the saved site and jql, and the email this view last saw
  draw();
}

async function onSend(issue: Pick<Issue, "key" | "summary">) {
  const id = getFocusedSession()?.id ?? null; // captured before any await
  const ok = id ? await writeToSession(id, sendText(issue)) : false;
  state = { ...state, note: ok ? null : "No tab to type into." };
  draw();
}

export function mountJiraView(parent: HTMLElement): HTMLElement {
  state = blank();
  bump();
  lastFetch = 0;
  filters = blankFilters();
  applied = null;
  resetOptions();
  bar = buildFilterBar({ change: onFilters });
  view = buildView({
    connectStart: () => { state = { ...state, mode: "form", formError: null, busy: false }; draw(); },
    cancel: () => { showNotice(); draw(); },
    hide: hideTab,
    submit: (values) => void onSubmit(values),
    refresh: () => void refresh(),
    setScope,
    loadMore: () => void loadMore(),
    disconnect: () => void onDisconnect(),
    open: (issue) => detail?.open(issue),
    send: (issue) => void onSend(issue),
    createToken: () => openUrl(TOKEN_PAGE),
  });
  const pane = view.root;
  detail = buildDetail({
    send: (issue) => void onSend(issue),
    openUrl,
    scroller: () => pane.querySelector<HTMLElement>(".cx-list"),
    toggled: (open) => pane.classList.toggle("jx-detail-open", open),
  });
  view.root.insertBefore(bar.root, view.root.children[1] ?? null); // under the head
  view.root.append(detail.host); // last: the pane hides everything else but the note while an issue is open
  view.root.style.display = "none";
  parent.appendChild(view.root);
  draw();
  return view.root;
}

export function onJiraShown() {
  if (state.busy) return; // a Connect in flight owns the view
  if (pages > 1) return; // a refresh would throw away the pages the user loaded
  if (state.mode === "loading" || Date.now() - lastFetch > STALE_MS) void refresh();
}

export function onJiraHidden() {
  // nothing to drop: a reply that lands while hidden still carries its counter, and the loaded pages stay
}

export function disposeJiraView() {
  bump();
  detail?.dispose();
  detail = undefined;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = undefined;
  bar?.close();
  bar = undefined;
  resetOptions();
  view?.root.remove();
  view = undefined;
  state = blank();
}
