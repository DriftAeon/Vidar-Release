// One Jira issue opened inside the module: the shared browser fullscreen (browser/full.ts) fed by a Jira adapter.
// The panel owns the list and its state; this host owns the fullscreen, a generation counter (bumped on open,
// Back, Connect, Disconnect and dispose) so a reply that lands after any of them is dropped, Esc = Back, and the
// list's scroll position. A section row (Parent, Subtasks) opens that issue in place.
import { buildFull } from "../browser/full";
import { attachKeys, focusRow } from "../browser/keys";
import type { Adapter, Comments, Detail, Item, Loaded, RenderCtx } from "../browser/types";
import { relativeTime } from "../browser/when";
import { invoke } from "../ipc";
import type { JiraCommentsPage, JiraIssueDetail, JiraRef } from "./ipc";
import { adfRenderer } from "./adf";
import { statusLabel, statusTone, type Issue } from "./model";

/** Comments shown at most; the Show Older Comments row stops here (or at an empty page). */
export const MAX_COMMENTS = 200;
const SEND_TIP = "Types the key and summary into the focused tab without sending it.";
const DEFAULT_TITLE = "Jira Couldn't Load the Issue";
const TITLES: Record<string, string> = { auth: "Jira Rejected the Token", rate: "Jira Is Rate Limiting", network: "Jira Is Unreachable" };

type ErrReply = { error: { kind: string; message: string } };

export function loadTitle(kind: string): string {
  return Object.hasOwn(TITLES, kind) ? TITLES[kind] : DEFAULT_TITLE;
}

/** The browser's Comments shape from one Rust page; `more` stops at an empty page or `MAX_COMMENTS` shown. */
export function toComments(page: JiraCommentsPage): Comments {
  const kept = page.items.slice(0, Math.max(0, MAX_COMMENTS - page.startAt));
  const shown = page.startAt + kept.length;
  return {
    total: page.total,
    items: kept.map((c) => ({ author: c.author || "Unknown", when: c.created, body: c.body })),
    more: kept.length > 0 && shown < page.total && shown < MAX_COMMENTS,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function failed(e: unknown): { error: { title: string; message: string } } {
  const err = e as Partial<ErrReply["error"]> | null;
  const isReply = err !== null && typeof err === "object" && typeof err.kind === "string";
  return { error: { title: isReply ? loadTitle(err.kind as string) : DEFAULT_TITLE, message: isReply ? String(err.message ?? "") : errText(e) } };
}

function toneItem(key: string, summary: string, status: string, category: string, updated: string): Item {
  const tone = statusTone(category, status);
  const label = statusLabel(status);
  return { id: key, key, title: summary, status: label, updated, group: { id: tone, label, tone, rank: 0 }, facets: {}, fields: [] };
}

function issueItem(i: Issue): Item {
  const item = toneItem(i.key, i.summary, i.status, i.statusCategory, i.updated);
  item.fields = [
    { label: "Type", value: i.type },
    { label: "Priority", value: i.priority },
    { label: "Updated", value: relativeTime(i.updated) },
  ];
  return item;
}

export interface DetailHooks {
  /** Types `KEY: Summary` into the focused tab, unsent. */
  send(issue: Pick<Issue, "key" | "summary">): void;
  /** Opens http/https in the system browser. */
  openUrl(url: string): void;
  /** The list's scroll box, for the saved position. */
  scroller(): HTMLElement | null;
  /** The pane hides its list chrome while an issue is open. */
  toggled(open: boolean): void;
}

export interface DetailHost {
  host: HTMLElement;
  isOpen(): boolean;
  open(issue: Issue): void;
  /** Back: closes and puts the list back where it was. */
  close(): void;
  /** Connect, Disconnect or a mode change: closes without moving focus and ends every pending reply. */
  reset(): void;
  dispose(): void;
}

export function buildDetail(h: DetailHooks): DetailHost {
  const host = document.createElement("div");
  host.className = "br-full-host";
  host.hidden = true;
  let gen = 0;
  let disposed = false;
  let current: { item: Item; rows: () => HTMLElement[] } | null = null;
  let listScroll = 0;
  const urls = new Map<string, string>();

  function ctx(): RenderCtx {
    const mine = gen;
    return {
      openUrl: (url) => h.openUrl(url),
      loadChildren: () => Promise.resolve({ error: { title: "Not Available", message: "Jira has no child blocks." } }),
      alive: () => !disposed && gen === mine,
    };
  }

  const refItem = (r: JiraRef): Item => {
    urls.set(r.key, r.url);
    return toneItem(r.key, r.summary, r.status, r.statusCategory, "");
  };

  async function load(item: Item): Promise<Loaded<Detail>> {
    let res;
    try {
      res = await invoke("jira_issue", { key: item.key });
    } catch (e) {
      return failed(e);
    }
    if ("error" in res) return failed(res.error);
    const d: JiraIssueDetail = res.issue;
    urls.set(d.key, d.url);
    const extra = item.fields.length
      ? []
      : [{ label: "Type", value: d.type }, { label: "Priority", value: d.priority }, { label: "Updated", value: relativeTime(d.updated) }];
    return {
      ok: {
        extraFields: [...extra, { label: "Assignee", value: d.assignee }],
        excerpt: adfRenderer.excerpt(d.description, 200),
        body: d.description,
        sections: [
          { title: "Parent", rows: d.parent ? [{ item: refItem(d.parent) }] : [] },
          { title: "Subtasks", rows: d.subtasks.map((s) => ({ item: refItem(s) })) },
        ],
        comments: toComments(d.comments),
      },
    };
  }

  async function moreComments(item: Item, from: number): Promise<Loaded<Comments>> {
    let res;
    try {
      res = await invoke("jira_comments", { key: item.key, startAt: from });
    } catch (e) {
      return failed(e);
    }
    if ("error" in res) return failed(res.error);
    return { ok: toComments(res.comments) };
  }

  const adapter: Adapter = {
    source: "jira",
    noun: "Issue",
    rich: adfRenderer,
    sendTip: SEND_TIP,
    load,
    moreComments,
    send: (item) => h.send({ key: item.key, summary: item.title }),
    open: (item) => { const url = urls.get(item.key); if (url) h.openUrl(url); },
    openUrl: (url) => h.openUrl(url),
  };

  function show(item: Item): void {
    gen++;
    const view = buildFull(adapter, item, { back: () => close(), open: (it) => show(it), ctx: ctx() });
    current = { item, rows: () => view.rows() };
    host.replaceChildren(view.el);
    host.hidden = false;
    view.el.focus();
  }

  const detach = attachKeys(host, {
    rows: () => current?.rows() ?? [],
    activate: (row) => row.click(),
    escape: () => { if (!current) return false; close(); return true; },
  });

  function end(): void {
    gen++;
    current = null;
    host.replaceChildren();
    host.hidden = true;
    h.toggled(false);
  }

  function close(): void {
    if (!current) return;
    const key = current.item.key;
    end();
    const list = h.scroller();
    if (list) list.scrollTop = listScroll;
    const row = [...(list?.querySelectorAll<HTMLElement>(".jx-key") ?? [])].find((n) => n.textContent === key)?.parentElement;
    if (row) focusRow([row], row);
  }

  return {
    host,
    isOpen: () => current !== null,
    open(issue) {
      if (disposed) return;
      urls.set(issue.key, issue.url);
      if (!current) listScroll = h.scroller()?.scrollTop ?? 0;
      h.toggled(true);
      show(issueItem(issue));
    },
    close,
    reset() {
      if (current) end(); else gen++;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detach();
      end();
    },
  };
}
