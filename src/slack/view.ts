// Slack bench tab DOM. The panel owns reads, writes and state; this view only draws and reports
// clicks. All remote text (sender, channel, message, error message) goes in through textContent or
// title. The token is read from its field once, on submit, and the field is emptied at once: no
// state, attribute or later render holds it.
import { lucide } from "../icons";
import { iconImg } from "../icon-img";
import { brandIcon, clearEmptyState, connectActions, fillEmptyState } from "../panels/empty-state";
import { relativeTime } from "../browser/when";
import { initial, isNewer, placeOf, sections, whenIso } from "./model";
import type { SlackItem } from "./ipc";

export type ErrorKind = "unset" | "auth" | "scope" | "rate" | "endpoint" | "network";

export interface ViewState {
  mode: "loading" | "notice" | "form" | "list";
  host: string;
  items: SlackItem[];
  /** The search was cut by its cap: the head count reads 50+. */
  truncated: boolean;
  /** Inbox-load failure shown in the list area (connected). */
  error: { kind: ErrorKind; message: string } | null;
  /** Form failure: a client or Rust text, or an error kind. */
  formError: { kind: ErrorKind | "text"; message: string } | null;
  busy: boolean;
  /** One-line hint under the head, e.g. "No tab to type into." */
  note: string | null;
  /** Result of Copy App Manifest, shown inside the form. */
  copied: string | null;
  /** `slack.seen` as it stood when the tab was shown; rows newer than it get the New dot. Null: nothing is new. */
  seen: string | null;
}

interface Handlers {
  connectStart(): void;
  cancel(): void;
  hide(): void;
  submit(token: string): void;
  refresh(): void;
  disconnect(): void;
  open(item: SlackItem): void;
  send(item: SlackItem): void;
  copyManifest(): void;
  openApps(): void;
}

export interface View {
  root: HTMLElement;
  render(state: ViewState): void;
}

const TITLES: Record<Exclude<ErrorKind, "unset">, string> = {
  auth: "Slack Rejected the Token",
  scope: "Slack Is Missing a Scope",
  rate: "Slack Is Rate Limiting",
  network: "Slack Is Unreachable",
  endpoint: "Slack Couldn't Load the Inbox",
};
const FORM_NOTE = "Create an app from the manifest at api.slack.com/apps, install it to your workspace, then paste its User OAuth Token. It is kept in Windows Credential Manager, never in vidar.json."; // note-ok: docs/projects/slack/inbox-tab-plan.md

export function errorTitle(kind: ErrorKind): string | null {
  return kind === "unset" ? null : TITLES[kind];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

function iconBtn(icon: Node, label: string, tip: string, cls = "cx-ico"): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.title = tip;
  b.setAttribute("aria-label", label);
  b.append(icon);
  return b;
}

function textBtn(label: string, cls: string, tip?: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.textContent = label;
  if (tip) b.title = tip;
  return b;
}

export function buildView(h: Handlers): View {
  const root = el("div", "slack-pane");
  root.id = "slack-view";
  root.style.display = "none";
  const head = el("div", "cx-head");
  const note = el("div", "jx-note");
  const list = el("div", "cx-list");
  const empty = el("div", "cx-empty");
  const form = el("form", "jx-form");
  root.append(head, note, list, empty, form);

  // form: built once; the token field is always emptied
  form.noValidate = true;
  const title = el("div", "jx-form-title");
  title.textContent = "Connect Slack";
  const formNote = el("div", "cx-note");
  formNote.setAttribute("role", "alert");
  const formMsg = el("span", "cx-note-msg");
  formNote.append(lucide("circle-alert"), formMsg);

  const wrap = el("label", "jx-field");
  const tokenIn = el("input", "jx-input");
  tokenIn.type = "password";
  tokenIn.placeholder = "Token";
  tokenIn.setAttribute("aria-label", "User OAuth Token");
  tokenIn.spellcheck = false;
  tokenIn.autocomplete = "new-password"; // no browser autofill of a saved password
  const label = el("span", "jx-field-label");
  label.textContent = "User OAuth Token";
  const hint = el("span", "jx-note");
  hint.textContent = FORM_NOTE; // note-ok: docs/projects/slack/inbox-tab-plan.md
  wrap.append(label, tokenIn, hint);

  const links = el("div", "jx-form-acts wb-actions");
  const copy = textBtn("Copy App Manifest", "cx-cancel wb-card-btn");
  copy.addEventListener("click", () => h.copyManifest());
  const apps = textBtn("Open Slack Apps", "cx-cancel wb-card-btn");
  apps.addEventListener("click", () => h.openApps());
  links.append(copy, apps);
  const copied = el("div", "jx-note");
  copied.setAttribute("role", "status");

  const acts = el("div", "jx-form-acts wb-actions");
  const connect = textBtn("Connect", "cx-primary wb-card-btn wb-card-btn-primary");
  connect.type = "submit";
  const cancel = textBtn("Cancel", "cx-cancel wb-card-btn");
  cancel.addEventListener("click", () => h.cancel());
  acts.append(connect, cancel);
  form.append(title, formNote, wrap, links, copied, acts);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const token = tokenIn.value;
    tokenIn.value = "";
    h.submit(token);
  });

  function drawHead(state: ViewState) {
    head.replaceChildren();
    const host = el("span", "jx-site pane-head-card");
    host.textContent = state.host;
    const pending = state.mode === "loading";
    const grow = el("span", "cx-grow");
    const buttons = el("span", "wb-actions");
    const refresh = iconBtn(iconImg("refresh"), "Refresh", "Refresh");
    refresh.disabled = state.busy || pending;
    if (pending) refresh.setAttribute("aria-busy", "true");
    refresh.addEventListener("click", () => h.refresh());
    const disconnect = iconBtn(iconImg("disconnect"), "Disconnect", "Disconnect");
    disconnect.disabled = state.busy;
    disconnect.addEventListener("click", () => h.disconnect());
    buttons.append(refresh, disconnect);
    head.append(host, grow, buttons);
  }

  function drawRow(item: SlackItem, seen: string | null): HTMLElement {
    const row = el("div", "cx-row");
    row.title = "Opens the message in Slack.";
    const isNew = isNewer(item.ts, seen);
    const dot = el("span", isNew ? "sx-dot sx-dot-new" : "sx-dot");
    if (isNew) {
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", "New");
      dot.title = "New since you last opened this tab.";
    } else {
      dot.setAttribute("aria-hidden", "true");
    }
    const av = el("span", "sx-av");
    av.setAttribute("aria-hidden", "true");
    av.dataset.place = placeOf(item);
    if (placeOf(item) === "group") av.append(lucide("users"));
    else if (item.sender === "Unknown" || !initial(item.sender)) av.append(lucide("user"));
    else av.textContent = initial(item.sender);
    const from = el("span", isNew ? "sx-from sx-from-new" : "sx-from");
    from.textContent = item.sender;
    from.title = item.sender;
    const summary = el("span", "sx-summary");
    summary.textContent = item.text;
    summary.title = item.text;
    const status = el("span", "sx-time");
    status.textContent = relativeTime(whenIso(item.ts));
    const racts = el("span", "cx-racts");
    const send = iconBtn(iconImg("comments"), "Send", "Types the sender and message into the focused tab without sending it.", "cx-ra");
    send.addEventListener("click", (e) => { e.stopPropagation(); h.send(item); });
    racts.append(send);
    row.append(dot, av, from, summary, status, racts);
    row.tabIndex = 0;
    row.addEventListener("click", () => h.open(item));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target === row) { e.preventDefault(); h.open(item); }
    });
    return row;
  }

  function drawEmpty(titleText: string, detail?: string) {
    clearEmptyState(empty);
    empty.replaceChildren();
    const t = el("span", "cx-empty-title");
    t.textContent = titleText;
    empty.append(t);
    if (detail) empty.title = detail; else empty.removeAttribute("title");
  }

  function render(state: ViewState) {
    const connected = state.mode === "list";
    head.hidden = !connected && state.mode !== "loading";
    list.hidden = !connected || !!state.error || !state.items.length;
    empty.hidden = state.mode === "form" || state.mode === "loading" ? true : connected && !state.error && !!state.items.length;
    form.hidden = state.mode !== "form";
    note.hidden = !connected || !state.note;
    note.textContent = state.note ?? ""; // note-ok: docs/projects/slack/inbox-tab-plan.md
    list.replaceChildren();
    empty.removeAttribute("role");

    if (state.mode === "form") {
      tokenIn.value = "";
      tokenIn.disabled = state.busy;
      connect.disabled = state.busy;
      cancel.disabled = state.busy;
      connect.textContent = state.busy ? "Connecting" : "Connect";
      copied.hidden = !state.copied;
      copied.textContent = state.copied ?? ""; // note-ok: docs/projects/slack/inbox-tab-plan.md
      const fe = state.formError;
      formNote.hidden = !fe;
      if (fe) {
        formMsg.textContent = fe.kind === "text" ? fe.message : errorTitle(fe.kind) ?? fe.message;
        formMsg.title = fe.kind === "text" ? "" : fe.message;
      }
      return;
    }
    tokenIn.value = "";

    if (state.mode === "loading") { drawHead(state); return; }
    if (state.mode === "notice") {
      empty.removeAttribute("title");
      fillEmptyState(empty, {
        icon: brandIcon("slack"),
        title: "Slack Not Connected",
        note: "Add a user token to list your recent mentions and DMs.", // note-ok: docs/projects/slack/inbox-tab-plan.md
        actions: connectActions(() => h.connectStart(), () => h.hide()),
      });
      return;
    }
    drawHead(state);
    if (state.error) {
      empty.setAttribute("role", "alert");
      drawEmpty(errorTitle(state.error.kind) ?? TITLES.endpoint, state.error.message);
      return;
    }
    if (!state.items.length) { drawEmpty("No Recent Mentions or DMs"); return; }
    const { dms, channels } = sections(state.items);
    if (dms.length) {
      const g = el("div", "sx-group");
      g.dataset.place = "dm";
      g.append(secHead(iconImg("person-dm"), "Direct Messages"), rows(dms, state.seen));
      list.append(g);
    }
    if (channels.length) {
      const g = el("div", "sx-group");
      g.append(secHead(lucide("hash"), "Channels"));
      for (const c of channels) {
        const conv = el("div", "sx-conv");
        conv.dataset.place = c.private ? "private" : "channel";
        const name = el("span", "sx-conv-name");
        name.textContent = c.name;
        name.title = c.name;
        conv.append(lucide(c.private ? "lock" : "hash"), name);
        g.append(conv, rows(c.items, state.seen));
      }
      list.append(g);
    }
  }

  function secHead(icon: Node, label: string): HTMLElement {
    const head = el("div", "cx-sec");
    const l = el("span", "cx-sec-label");
    l.textContent = label;
    head.append(icon, l);
    return head;
  }

  function rows(items: SlackItem[], seen: string | null): HTMLElement {
    const box = el("div", "cx-rows");
    for (const item of items) box.append(drawRow(item, seen));
    return box;
  }

  return { root, render };
}
