// Jira bench tab DOM. The panel owns reads, writes and state; this view only draws and reports
// clicks. All remote text (summary, status, error message) goes in through textContent or title.
// The token is read from its field once, on submit, and the field is emptied at once: no state,
// attribute or later render holds it.
import { lucide } from "../icons";
import { iconImg } from "../icon-img";
import { brandIcon, clearEmptyState, connectActions, fillEmptyState } from "../panels/empty-state";
import { groupIssues, statusLabel, statusTone, typeIcon, typeKind, type Group, type Issue, type Scope } from "./model";
import { renderTypeIcon } from "./type-icon";

export type ErrorKind = "unset" | "auth" | "jql" | "rate" | "endpoint" | "site" | "network";

export interface FormValues { site: string; email: string; token: string; jql: string }

export interface ViewState {
  mode: "loading" | "notice" | "form" | "list";
  site: string;
  email: string;
  jql: string;
  issues: Issue[];
  scope: Scope;
  /** A next page exists under the current query: the list ends in the Load 50 More row. */
  more: boolean;
  loadingMore: boolean;
  /** Issue-load failure shown in the list area (connected). */
  error: { kind: ErrorKind; message: string } | null;
  /** Form failure: a Rust text, the client-side site refusal ("address"), or an error kind. */
  formError: { kind: ErrorKind | "text" | "address"; message: string } | null;
  busy: boolean;
  /** One-line hint under the head, e.g. "No tab to type into." */
  note: string | null;
}

interface Handlers {
  connectStart(): void;
  cancel(): void;
  hide(): void;
  submit(values: FormValues): void;
  refresh(): void;
  setScope(scope: Scope): void;
  loadMore(): void;
  disconnect(): void;
  open(issue: Issue): void;
  send(issue: Issue): void;
  createToken(): void;
}

export interface View {
  root: HTMLElement;
  render(state: ViewState): void;
}

const TITLES: Record<Exclude<ErrorKind, "unset" | "site">, string> = {
  auth: "Jira Rejected the Token",
  jql: "Jira Rejected the JQL",
  network: "Jira Is Unreachable",
  rate: "Jira Is Rate Limiting",
  endpoint: "Jira Couldn't Load the Issues",
};
/** Only for the client-side normaliseSite refusal; a Rust `site` error takes the endpoint title. */
const SCOPES: [Scope, string, string][] = [
  ["mine", "Mine", "Your saved query, or your open items when none is saved."],
  ["all", "All", "Every open item you can see, 50 at a time."],
];
const MORE_LABEL = "Load 50 More";
const SITE_NOTE = "Use a name.atlassian.net address.";

export function errorTitle(kind: ErrorKind): string | null {
  return kind === "unset" ? null : kind === "site" ? TITLES.endpoint : TITLES[kind];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

function iconBtn(icon: Node, label: string, tip: string, cls = "cx-ico wb-card-btn"): HTMLButtonElement {
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
  const root = el("div", "jira-pane");
  root.id = "jira-view";
  root.style.display = "none";
  const head = el("div", "cx-head");
  const note = el("div", "jx-note");
  const list = el("div", "cx-list");
  const empty = el("div", "cx-empty");
  const form = el("form", "jx-form");
  root.append(head, note, list, empty, form);

  // form: built once so typed values survive a failed attempt; the token field is always emptied
  form.noValidate = true;
  const title = el("div", "jx-form-title");
  title.textContent = "Connect Jira";
  const formNote = el("div", "cx-note");
  formNote.setAttribute("role", "alert");
  const formMsg = el("span", "cx-note-msg");
  formNote.append(lucide("circle-alert"), formMsg);

  function field(label: string, tip: string | null, type: "text" | "password"): HTMLInputElement {
    const wrap = el("label", "jx-field");
    const input = el("input", "jx-input");
    input.type = type;
    input.placeholder = label;
    input.setAttribute("aria-label", label);
    input.spellcheck = false;
    input.autocomplete = "off";
    const name = el("span", "jx-field-label");
    name.textContent = label;
    wrap.append(name, input);
    if (tip) {
      const hint = el("span", "jx-note");
      hint.textContent = tip; // note-ok: docs/projects/jira/issues-tab-plan.md
      wrap.append(hint);
    }
    form.append(wrap);
    return input;
  }
  form.append(title, formNote);
  const siteIn = field("Site", "Your Jira Cloud address, like name.atlassian.net.", "text");
  const emailIn = field("Email", null, "text");
  const tokenIn = field("API Token", "Use a classic API token. It is kept in Windows Credential Manager, never in vidar.json.", "password");
  tokenIn.autocomplete = "new-password"; // no browser autofill of a saved password
  const create = textBtn("Create an API Token", "jx-link");
  create.addEventListener("click", () => h.createToken());
  tokenIn.parentElement!.append(create);
  const jqlIn = field("JQL", null, "text");
  const acts = el("div", "jx-form-acts wb-actions");
  const connect = textBtn("Connect", "cx-primary wb-card-btn wb-card-btn-primary");
  connect.type = "submit";
  const cancel = textBtn("Cancel", "cx-cancel wb-card-btn");
  cancel.addEventListener("click", () => h.cancel());
  acts.append(connect, cancel);
  form.append(acts);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const values: FormValues = { site: siteIn.value, email: emailIn.value, token: tokenIn.value, jql: jqlIn.value };
    tokenIn.value = "";
    h.submit(values);
  });

  let formShown = false;
  const collapsed = new Set<string>(); // section keys (level plus name), in memory only
  let last: ViewState | null = null;

  function drawHead(state: ViewState) {
    head.replaceChildren();
    const site = el("span", "jx-site pane-head-card");
    site.textContent = state.site.replace(/^https:\/\//, "");
    site.title = state.site;
    const scope = el("span", "jx-scope wb-actions");
    scope.setAttribute("role", "group");
    for (const [value, label, tip] of SCOPES) {
      const b = textBtn(label, value === state.scope ? "jx-scope-btn wb-card-btn on" : "jx-scope-btn wb-card-btn", tip);
      b.setAttribute("aria-pressed", String(value === state.scope));
      b.addEventListener("click", () => h.setScope(value));
      scope.append(b);
    }
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
    head.append(site, scope, grow, buttons);
  }

  function drawRow(issue: Issue): HTMLElement {
    const row = el("div", "cx-row");
    const ty = el("span", "ty");
    ty.append(renderTypeIcon(typeIcon(issue.typeLevel, issue.type)));
    if (issue.type) ty.title = issue.type;
    const key = el("span", "jx-key");
    key.textContent = issue.key;
    const summary = el("span", "jx-summary");
    summary.textContent = issue.summary;
    summary.title = issue.summary;
    const parent = issue.parent ? el("span", "jx-parent") : null;
    if (parent) {
      parent.textContent = issue.parent;
      parent.title = `Parent: ${issue.parent}`;
    }
    const status = el("span", `br-pill tone-${statusTone(issue.statusCategory, issue.status)}`);
    status.textContent = statusLabel(issue.status);
    status.title = issue.status;
    const racts = el("span", "cx-racts");
    const send = iconBtn(iconImg("comments"), "Send", "Types the key and summary into the focused tab without sending it.", "cx-ra");
    send.addEventListener("click", (e) => { e.stopPropagation(); h.send(issue); });
    racts.append(send);
    row.append(ty, key, summary, ...(parent ? [parent] : []), status, racts);
    row.tabIndex = 0;
    row.addEventListener("click", () => h.open(issue));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target === row) { e.preventDefault(); h.open(issue); }
    });
    return row;
  }

  function drawSection(group: Group): HTMLElement {
    const sec = el("div", "jx-sec");
    sec.dataset.kind = typeKind(group.level, group.label);
    const closed = collapsed.has(group.key);
    sec.classList.toggle("is-closed", closed);
    const headEl = el("div", "br-band tone-neutral");
    headEl.tabIndex = 0;
    headEl.setAttribute("role", "button");
    headEl.setAttribute("aria-expanded", String(!closed));
    const slot = el("span", "ty");
    slot.append(renderTypeIcon(typeIcon(group.level, group.label)));
    const label = el("span", "br-band-label");
    label.textContent = group.label;
    headEl.title = group.issues.length === 1 ? "1 Issue" : `${group.issues.length} Issues`; // count in the tooltip, not the band (user, 2026-10-22)
    headEl.append(slot, label);
    const fold = el("div", "jx-fold");
    fold.inert = closed;
    const toggle = () => {
      const nowClosed = !collapsed.has(group.key);
      if (nowClosed) collapsed.add(group.key); else collapsed.delete(group.key);
      sec.classList.toggle("is-closed", nowClosed);
      headEl.setAttribute("aria-expanded", String(!nowClosed));
      fold.inert = nowClosed;
    };
    headEl.addEventListener("click", toggle);
    headEl.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === headEl) { e.preventDefault(); toggle(); }
    });
    sec.append(headEl);
    const rows = el("div", "cx-rows");
    for (const issue of group.issues) rows.append(drawRow(issue));
    fold.append(rows);
    sec.append(fold);
    return sec;
  }

  function drawMore(loading: boolean): HTMLElement {
    const row = el("div", "cx-row jx-more");
    row.textContent = MORE_LABEL;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    if (loading) row.setAttribute("aria-busy", "true");
    row.addEventListener("click", () => h.loadMore());
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target === row) { e.preventDefault(); h.loadMore(); }
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
    last = state;
    const connected = state.mode === "list";
    head.hidden = !connected && state.mode !== "loading";
    list.hidden = !connected || !!state.error || !state.issues.length;
    empty.hidden = state.mode === "form" || state.mode === "loading" ? true : connected && !state.error && !!state.issues.length;
    form.hidden = state.mode !== "form";
    note.hidden = !connected || !state.note;
    note.textContent = state.note ?? ""; // note-ok: docs/projects/jira/issues-tab-plan.md
    list.replaceChildren();
    empty.removeAttribute("role");

    if (state.mode === "form") {
      if (!formShown) {
        siteIn.value = state.site;
        emailIn.value = state.email;
        jqlIn.value = state.jql;
      }
      formShown = true;
      tokenIn.value = "";
      for (const input of [siteIn, emailIn, tokenIn, jqlIn]) input.disabled = state.busy;
      connect.disabled = state.busy;
      cancel.disabled = state.busy;
      const fe = state.formError;
      formNote.hidden = !fe;
      if (fe) {
        const text = fe.kind === "address" ? SITE_NOTE : fe.kind === "text" ? fe.message : errorTitle(fe.kind) ?? fe.message;
        formMsg.textContent = text;
        formMsg.title = fe.kind === "address" || fe.kind === "text" ? "" : fe.message;
      }
      return;
    }
    formShown = false;
    tokenIn.value = "";

    if (state.mode === "loading") { drawHead(state); return; }
    if (state.mode === "notice") {
      empty.removeAttribute("title");
      fillEmptyState(empty, {
        icon: brandIcon("jira"),
        title: "Jira Not Connected",
        note: "Add your site, email and API token to list your issues.", // note-ok: docs/projects/jira/issues-tab-plan.md
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
    if (!state.issues.length) { drawEmpty("No Issues Match"); return; }
    for (const group of groupIssues(state.issues)) list.append(drawSection(group));
    if (state.more) list.append(drawMore(state.loadingMore));
  }

  return { root, render };
}
