// Slack bench tab: the saved Slack connection and its recent mentions and DMs. Fetches on show when the
// last one is over 60 s old, on Refresh and after Connect; there is no interval poll (rate limits).
// The token goes from the form to slack_connect once and is never held here. Plan:
// docs/projects/slack/inbox-tab-plan.md. Model: slack/model.ts; DOM: slack/view.ts.
import { invoke } from "../ipc";
import type { SlackItem } from "../slack/ipc";
import { copyText } from "../clipboard";
import { laterTs, looksLikeUserToken, newestTs, sendText } from "../slack/model";
import { SLACK_MANIFEST } from "../slack/manifest";
import { buildView, type ErrorKind, type View, type ViewState } from "../slack/view";
import { getPref, setPref } from "../prefs";
import { getFocusedSession } from "./sessions/lookup";
import { writeToSession } from "./sessions";

const STALE_MS = 60_000;
const APPS_PAGE = "https://api.slack.com/apps";
const TOKEN_REFUSAL = "Paste the User OAuth Token, which starts with xoxp-.";

let view: View | undefined;
let gen = 0; // bumped by mount and dispose: a Connect from an older view drops its result
let seq = 0;
let loading = false;
let lastFetch = 0;
let state: ViewState = blank();

function blank(): ViewState {
  return { mode: "loading", host: "", items: [], truncated: false, error: null, formError: null, busy: false, note: null, copied: null, seen: null };
}

function draw() {
  view?.render(state);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Fetched = { items: SlackItem[]; truncated: boolean } | { error: { kind: ErrorKind; message: string } };

async function fetchInbox(): Promise<Fetched> {
  try {
    return await invoke("slack_inbox");
  } catch (e) {
    return { error: { kind: "network", message: errText(e) } };
  }
}

function showNotice() {
  state = { ...state, mode: "notice", items: [], truncated: false, error: null, formError: null, busy: false, note: null, copied: null };
}

/** Reads the saved connection and, when there is one, loads the inbox. */
async function refresh() {
  if (!view || loading) return;
  const mine = ++seq;
  loading = true;
  try {
    const st = await invoke("slack_status");
    if (mine !== seq) return;
    state = { ...state, host: st.host ?? "" };
    if (!st.host || !st.tokenSaved) {
      if (state.mode !== "form") showNotice();
      draw();
      return;
    }
    if (state.mode === "loading") draw();
    const res = await fetchInbox();
    if (mine !== seq) return;
    lastFetch = Date.now();
    if ("error" in res && res.error.kind === "unset") {
      if (state.mode !== "form") showNotice();
    } else if ("error" in res) {
      state = { ...state, mode: "list", items: [], truncated: false, error: res.error, note: null };
    } else {
      state = { ...state, mode: "list", items: res.items, truncated: res.truncated, error: null, note: null };
    }
  } catch (e) {
    if (mine !== seq) return;
    state = { ...state, mode: "list", items: [], truncated: false, error: { kind: "network", message: errText(e) } };
  } finally {
    if (mine === seq) loading = false;
  }
  draw();
}

function hideTab() {
  const key = "bench:slack";
  const hidden = getPref("modules.hidden") ?? [];
  if (hidden.includes(key)) return;
  if (setPref("modules.hidden", [...hidden, key])) document.dispatchEvent(new document.defaultView!.CustomEvent("vidar-modules-change"));
}

function formFail(error: NonNullable<ViewState["formError"]>) {
  state = { ...state, mode: "form", formError: error, busy: false };
  draw();
}

async function onSubmit(token: string) {
  if (state.busy) return;
  const mine = gen;
  seq++; // a status read in flight must not overwrite the form
  loading = false;
  if (!looksLikeUserToken(token)) {
    formFail({ kind: "text", message: TOKEN_REFUSAL });
    return;
  }
  state = { ...state, mode: "form", busy: true, formError: null };
  draw();
  let reply;
  try {
    reply = await invoke("slack_connect", { token });
  } catch (e) {
    if (mine !== gen) return;
    formFail({ kind: "text", message: errText(e) });
    return;
  }
  if (mine !== gen || !view) return;
  if ("error" in reply) {
    formFail(reply.error);
    return;
  }
  state = { ...state, host: reply.host };
  const res = await fetchInbox();
  if (mine !== gen || !view) return;
  if ("error" in res && (res.error.kind === "auth" || res.error.kind === "unset")) {
    // an auth failure drops the credential just saved and keeps the form with its notice
    if (res.error.kind === "auth") await invoke("slack_disconnect").catch(() => undefined);
    if (mine !== gen) return;
    formFail(res.error);
    return;
  }
  // the credential is saved: any other failure is a load error in the connected view
  lastFetch = Date.now();
  const loaded = "error" in res ? { items: [], truncated: false, error: res.error } : { items: res.items, truncated: res.truncated, error: null };
  state = { ...state, mode: "list", ...loaded, formError: null, busy: false, note: null, copied: null };
  draw();
}

async function onDisconnect() {
  if (state.busy) return;
  seq++;
  loading = false;
  try {
    await invoke("slack_disconnect");
  } catch (e) {
    state = { ...state, note: errText(e) }; // the Rust text, not a load title
    draw();
    return;
  }
  setPref("slack.seen", undefined);
  state = { ...state, mode: "form", items: [], truncated: false, error: null, formError: null, busy: false, note: null, copied: null, seen: null };
  draw();
}

async function onSend(item: SlackItem) {
  const id = getFocusedSession()?.id ?? null; // captured before any await
  const ok = id ? await writeToSession(id, sendText(item)) : false;
  state = { ...state, note: ok ? null : "No tab to type into." }; // note-ok: docs/projects/slack/inbox-tab-plan.md
  draw();
}

async function onCopyManifest() {
  const mine = gen;
  const ok = await copyText(SLACK_MANIFEST).catch(() => false);
  if (mine !== gen) return;
  state = { ...state, copied: ok ? "Manifest copied." : "Couldn't copy the manifest." }; // note-ok: docs/projects/slack/inbox-tab-plan.md
  draw();
}

export function mountSlackView(parent: HTMLElement): HTMLElement {
  gen++;
  state = blank();
  loading = false;
  lastFetch = 0;
  view = buildView({
    connectStart: () => { state = { ...state, mode: "form", formError: null, busy: false, copied: null }; draw(); },
    cancel: () => { showNotice(); draw(); },
    hide: hideTab,
    submit: (token) => void onSubmit(token),
    refresh: () => void refresh(),
    disconnect: () => void onDisconnect(),
    send: (item) => void onSend(item),
    copyManifest: () => void onCopyManifest(),
    openApps: () => { void invoke("open_url", { url: APPS_PAGE }).catch(console.error); },
  });
  view.root.style.display = "none";
  parent.appendChild(view.root);
  draw();
  return view.root;
}

export function onSlackShown() {
  // The New marks compare against what the tab showed up to the last hide; fixed until the next show.
  state = { ...state, seen: getPref("slack.seen") ?? null };
  if (state.busy) return; // a Connect in flight owns the view
  if (state.mode === "loading" || Date.now() - lastFetch > STALE_MS) void refresh();
  else draw();
}

export function onSlackHidden() {
  seq++; // a read in flight is dropped; the next show reads again
  loading = false;
  // Only a load that was on screen counts; an error, empty or never-loaded view writes nothing, and the
  // stored value never moves back (an older refresh after a newer one).
  if (state.mode !== "list" || state.error || !state.items.length) return;
  const newest = newestTs(state.items);
  const next = laterTs(getPref("slack.seen"), newest);
  if (next && next !== getPref("slack.seen")) setPref("slack.seen", next);
}

export function disposeSlackView() {
  gen++;
  seq++;
  loading = false;
  view?.root.remove();
  view = undefined;
  state = blank();
}
