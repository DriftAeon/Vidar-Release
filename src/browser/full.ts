// Fullscreen (look C1, back arrow plus Esc): fills the module in place of the head, filter row and list.
// Top row: Back, key, status pill, Send, Open in Browser. Then the title, the row's fields plus the detail's
// extra fields, the body through `adapter.rich.render(body, ctx)`, the adapter's sections, and Comments
// (only when there are any) with Show Older Comments while more remain. A section row replaces the page.
import { lucide } from "../icons";
import { relativeTime } from "./when";
import { buildRow, fieldBar, iconButton, node, pill, sendButton } from "./list";
import type { Adapter, Comments, Detail, Item, RenderCtx } from "./types";

export interface FullHooks {
  back(): void;
  /** A section row was activated. */
  open(item: Item): void;
  ctx: RenderCtx;
}

export interface FullView {
  el: HTMLElement;
  /** Section rows in visual order, for the shell's arrow keys. */
  rows(): HTMLElement[];
}

function errorLine(e: { title: string; message: string }): HTMLElement {
  const err = node("div", "br-err", e.title);
  err.title = e.message;
  return err;
}

function sectionHead(title: string): HTMLElement {
  const head = node("div", "br-sec");
  head.append(node("span", "br-sec-title", title));
  return head;
}

function commentsBlock(adapter: Adapter, item: Item, first: Comments, ctx: RenderCtx): HTMLElement {
  const wrap = node("div", "br-stack-tight");
  const list = node("div", "br-comments");
  let shown = 0;
  const add = (c: Comments) => {
    for (const cm of c.items) {
      const one = node("div", "br-cm");
      const head = node("div", "br-cm-h");
      head.append(node("span", "br-who", cm.author), node("span", "br-when", relativeTime(cm.when)));
      one.append(head, adapter.rich.render(cm.body, ctx).el);
      list.appendChild(one);
    }
    shown += c.items.length;
  };
  add(first);
  wrap.append(sectionHead("Comments"), list);
  if (first.more) {
    const more = node("button", "br-link", "Show Older Comments");
    more.type = "button";
    more.addEventListener("click", () => {
      more.disabled = true;
      more.setAttribute("aria-busy", "true");
      void adapter.moreComments(item, shown).then((r) => {
        if (!ctx.alive()) return;
        more.disabled = false;
        more.removeAttribute("aria-busy");
        wrap.querySelector(".br-err")?.remove();
        if ("error" in r) { wrap.insertBefore(errorLine(r.error), more); return; }
        add(r.ok);
        if (!r.ok.more) more.remove();
      });
    });
    wrap.appendChild(more);
  }
  return wrap;
}

export function buildFull(adapter: Adapter, item: Item, h: FullHooks): FullView {
  const el = node("div", "br-full");
  el.tabIndex = -1;
  el.dataset.id = item.id;
  const top = node("div", "br-full-top");
  top.appendChild(iconButton("br-back", "arrow-left", "Back to List", h.back));
  if (item.key) top.appendChild(node("span", "br-key", item.key));
  const p = pill(item);
  if (p) top.appendChild(p);
  top.appendChild(node("span", "br-grow"));
  top.append(
    sendButton("br-act", adapter.sendTip, () => adapter.send(item)),
    iconButton("br-act", { color: "globe" }, "Open in Browser", () => adapter.open(item)),
  );
  const head = node("div", "br-stack-tight");
  const title = node("div", "br-full-title");
  if (item.lead && "emoji" in item.lead) title.appendChild(node("span", "br-full-icon", item.lead.emoji));
  title.appendChild(document.createTextNode(item.title));
  head.appendChild(title);
  let fields = fieldBar(item.fields);
  head.appendChild(fields);
  const rest = node("div", "br-stack");
  rest.appendChild(lucide("loader-circle", "icn br-spin"));
  rest.setAttribute("aria-busy", "true");
  el.append(top, head, rest);

  let rows: HTMLElement[] = [];
  const fill = (d: Detail) => {
    const next = fieldBar([...item.fields, ...d.extraFields]);
    fields.replaceWith(next);
    fields = next;
    const body = node("div", "br-rich");
    body.appendChild(adapter.rich.render(d.body, h.ctx).el);
    rest.appendChild(body);
    for (const s of d.sections) {
      if (!s.rows.length) continue;
      const sec = node("div", "br-stack-tight");
      sec.appendChild(sectionHead(s.title));
      for (const r of s.rows) {
        const row = buildRow(r.item, { relation: r.relation, showPill: true, activate: h.open });
        rows.push(row);
        sec.appendChild(row);
      }
      rest.appendChild(sec);
    }
    if (d.comments.total > 0) rest.appendChild(commentsBlock(adapter, item, d.comments, h.ctx));
  };

  void adapter.load(item).then((r) => {
    if (!h.ctx.alive()) return;
    rest.removeAttribute("aria-busy");
    rest.replaceChildren();
    rows = [];
    if ("error" in r) rest.appendChild(errorLine(r.error));
    else fill(r.ok);
  }, () => {
    if (h.ctx.alive()) rest.replaceChildren();
  });

  return { el, rows: () => rows };
}
