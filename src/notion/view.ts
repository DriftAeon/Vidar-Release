// Notion bench tab DOM (docs/projects/notion/plan.md § Views, S9). The panel owns reads and state; this view
// draws and reports clicks. Two browsers: the top level stays mounted (hidden) while a data source is open,
// so its scroll and filters are kept; the data-source browser is built on drill-in and disposed on Back,
// and focus returns to its row. The token is read from its field once, on submit, and the field is emptied
// at once. Remote text goes in through textContent or title only.
import { iconImg } from "../icon-img";
import { lucide } from "../icons";
import { brandIcon, buildEmptyState, connectActions } from "../panels/empty-state";
import { focusRow } from "../browser/keys";
import { buildBrowser } from "../browser/shell";
import type { Adapter, Browser, Facet, Item } from "../browser/types";
import type { NotionKind } from "./ipc";
import type { Copy } from "./model";

export const CONNECTIONS_URL = "https://app.notion.com/developers/connections";

export interface ErrView extends Copy {
  /** The message is a sentence shown under the title; otherwise it is the title's tooltip. */
  shown: boolean;
}

export interface LevelState { items: Item[]; facets: Facet[]; busy: boolean; note: string | null; error: ErrView | null }
export interface TopState extends LevelState { workspace: string; kind: NotionKind | null }
export interface SourceState extends LevelState { id: string; title: string; adapter: Adapter }

export interface ViewState {
  mode: "loading" | "notice" | "form" | "list";
  formBusy: boolean;
  formError: Copy | null;
  top: TopState;
  source: SourceState | null;
  /** One line for both levels, e.g. "No tab to type into."; wins over the level's note. */
  hint: string | null;
}

export interface Handlers {
  connectStart(): void;
  cancel(): void;
  hide(): void;
  submit(token: string): void;
  openConnections(): void;
  refresh(): void;
  disconnect(): void;
  back(): void;
}

export interface NotionView {
  root: HTMLElement;
  render(s: ViewState): void;
  /** Connection changed: the top browser drops its Fullscreen, open card and built cards (Browser.reset). */
  reset(): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function iconBtn(icon: Node, tip: string, run: () => void): HTMLButtonElement {
  const b = el("button", "nt-ico");
  b.type = "button";
  b.title = tip;
  b.setAttribute("aria-label", tip);
  b.append(icon);
  b.addEventListener("click", () => run());
  return b;
}

function textBtn(label: string, cls: string, run: () => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", () => run());
  return b;
}

interface Level {
  browser: Browser;
  head: HTMLElement;
  refresh: HTMLButtonElement;
  block: HTMLElement;
}

function buildLevel(adapter: Adapter, lead: HTMLElement[], tail: HTMLElement[], refresh: HTMLButtonElement): Level {
  const head = el("div", "nt-head");
  const acts = el("span", "nt-head-acts wb-actions");
  acts.append(refresh, ...tail);
  head.append(...lead, el("span", "nt-grow"), acts);
  const browser = buildBrowser(adapter, head);
  const block = el("div", "nt-state");
  block.hidden = true;
  head.after(block);
  return { browser, head, refresh, block };
}

function drawBlock(block: HTMLElement, title: string, sub: string | null, tip: string | null): void {
  block.replaceChildren(el("span", "nt-state-title", title));
  if (sub) block.append(el("span", "nt-sub", sub));
  if (tip) block.title = tip; else block.removeAttribute("title");
}

const EMPTY_CONNECTION = "In Notion, open a page, choose ••• then Add Connections, and pick this connection. Its subpages come with it."; // note-ok: docs/projects/notion/plan.md

function drawLevel(L: Level, s: LevelState, hint: string | null, empty: { title: string; sub: string | null }): void {
  L.browser.setItems(s.items, s.facets, { busy: s.busy, note: hint ?? s.note });
  L.refresh.disabled = s.busy;
  if (s.busy) L.refresh.setAttribute("aria-busy", "true"); else L.refresh.removeAttribute("aria-busy");
  L.block.removeAttribute("role");
  if (s.error) {
    L.block.setAttribute("role", "alert");
    drawBlock(L.block, s.error.title, s.error.shown ? s.error.message : null, s.error.shown ? null : s.error.message);
    L.block.hidden = false;
  } else if (!s.busy && s.items.length === 0) {
    drawBlock(L.block, empty.title, empty.sub, null);
    L.block.hidden = false;
  } else {
    L.block.hidden = true;
  }
}

export function buildNotionView(h: Handlers, topAdapter: Adapter): NotionView {
  const root = el("div", "notion-pane");
  root.id = "notion-view";
  root.style.display = "none";

  // unset notice
  const notice = buildEmptyState({
    icon: brandIcon("notion"),
    title: "Notion Not Connected",
    note: "Add a connection token to read the pages you share with it.", // note-ok: docs/projects/notion/plan.md
    actions: connectActions(() => h.connectStart(), () => h.hide()),
  }, "nt-notice");

  // connect form: built once; the token field is emptied on submit and on every render
  const form = el("form", "nt-form");
  form.noValidate = true;
  const formErr = el("div", "cx-note");
  formErr.setAttribute("role", "alert");
  const formMsg = el("span", "cx-note-msg");
  formErr.append(lucide("circle-alert"), formMsg);
  const field = el("label", "nt-field");
  const token = el("input", "nt-input");
  token.type = "password";
  token.placeholder = "Token";
  token.setAttribute("aria-label", "Token");
  token.spellcheck = false;
  token.autocomplete = "new-password";
  field.append(el("span", "nt-field-label", "Token"), token);
  const link = textBtn("Open Notion Connections", "nt-link", () => h.openConnections());
  const formNote = el("span", "nt-sub");
  formNote.textContent = "Create an internal connection with Read Content and Read User Information Without Email, then paste its token. It is kept in Windows Credential Manager, never in vidar.json."; // note-ok: docs/projects/notion/plan.md
  const formActs = el("div", "nt-actions wb-actions");
  const connect = el("button", "nt-primary wb-card-btn wb-card-btn-primary", "Connect");
  connect.type = "submit";
  const cancel = textBtn("Cancel", "nt-cancel wb-card-btn",() => h.cancel());
  formActs.append(connect, cancel);
  form.append(el("div", "nt-form-title", "Connect Notion"), formErr, field, link, formNote, formActs);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = token.value;
    token.value = "";
    h.submit(value);
  });

  // top level: workspace, count, Refresh, Disconnect
  const ws = el("span", "nt-head-title jx-site pane-head-card");
  const top = buildLevel(topAdapter, [ws], [iconBtn(iconImg("disconnect"), "Disconnect", () => h.disconnect())],
    iconBtn(iconImg("refresh"), "Refresh", () => h.refresh()));
  root.append(notice, form, top.browser.root);

  let src: (Level & { id: string; adapter: Adapter; title: HTMLElement }) | null = null;

  function closeSource(): string | null {
    if (!src) return null;
    const id = src.id;
    src.browser.dispose();
    src.browser.root.remove();
    src = null;
    return id;
  }

  function openSource(s: SourceState): void {
    closeSource();
    const title = el("span", "nt-head-title jx-site pane-head-card");
    const back = iconBtn(lucide("arrow-left"), "Back to Notion", () => h.back());
    const L = buildLevel(s.adapter, [back, title], [], iconBtn(iconImg("refresh"), "Refresh", () => h.refresh()));
    L.browser.root.tabIndex = -1;
    root.appendChild(L.browser.root);
    src = { ...L, id: s.id, adapter: s.adapter, title };
  }

  function render(s: ViewState): void {
    const listed = s.mode === "list" || s.mode === "loading";
    notice.hidden = s.mode !== "notice";
    form.hidden = s.mode !== "form";

    // form
    token.value = "";
    token.disabled = s.formBusy;
    connect.disabled = s.formBusy;
    cancel.disabled = s.formBusy;
    connect.textContent = s.formBusy ? "Connecting" : "Connect";
    if (s.formBusy) connect.setAttribute("aria-busy", "true"); else connect.removeAttribute("aria-busy");
    formErr.hidden = !s.formError;
    formMsg.textContent = s.formError?.title ?? "";
    formMsg.title = s.formError?.message ?? "";

    // data-source level
    let opened = false;
    let closed: string | null = null;
    if (listed && s.source) {
      if (!src || src.adapter !== s.source.adapter) { openSource(s.source); opened = true; }
      const cur = src!;
      cur.title.textContent = s.source.title;
      cur.title.title = s.source.title;
      drawLevel(cur, s.source, s.hint, { title: "No Pages Found", sub: null });
    } else {
      closed = closeSource();
    }

    // top level
    ws.textContent = s.top.workspace || "Notion";
    ws.title = s.top.workspace;
    const empty = s.top.kind === "personal"
      ? { title: "No Pages Found", sub: null }
      : { title: "Nothing Shared Yet", sub: EMPTY_CONNECTION };
    drawLevel(top, s.top, s.hint, empty);
    top.browser.root.hidden = !listed || !!src;

    if (opened && src) src.browser.root.focus();
    if (closed !== null && !top.browser.root.hidden) {
      const rows = [...top.browser.root.querySelectorAll<HTMLElement>(".br-list .br-row")];
      focusRow(rows, rows.find((r) => r.dataset.id === closed));
    }
  }

  return {
    root,
    render,
    reset() {
      top.browser.reset();
    },
    dispose() {
      closeSource();
      top.browser.dispose();
      root.remove();
    },
  };
}
