// Atlassian Document Format (Jira descriptions and comments) as safe DOM. The document is attacker-controlled by
// anyone with comment access, so elements come only from browser/rich.ts's allowlist with fixed `ja-*` classes,
// text goes in through textContent, and a link is an inert element (never an href) that opens only http/https.
// One traversal budget (depth 64, 20 000 nodes) bounds the structured render and the plain-text fallback; a
// document past it renders as plain text, capped at 100 000 characters.
import { el, inertLink } from "../browser/rich";
import type { RenderCtx, RichRenderer } from "../browser/types";

const MAX_DEPTH = 64;
const MAX_NODES = 20_000;
const MAX_PLAIN = 100_000;

class OverBudget extends Error {}

interface Budget { nodes: number }

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function kids(n: Json): unknown[] {
  return Array.isArray(n.content) ? n.content : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function attr(n: Json, name: string): unknown {
  return obj(n.attrs)?.[name];
}

function charge(b: Budget): void {
  if (++b.nodes > MAX_NODES) throw new OverBudget();
}

/** The text of a leaf node (text, mention, emoji, status, date, media), or null when it is not a leaf we read. */
function leafText(n: Json): string | null {
  switch (n.type) {
    case "text": return str(n.text);
    case "mention": return `@${str(attr(n, "text")).replace(/^@/, "")}`;
    case "emoji": return str(attr(n, "text")) || str(attr(n, "shortName"));
    case "status": return str(attr(n, "text"));
    case "date": {
      const ms = Number(attr(n, "timestamp"));
      return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString().slice(0, 10) : "";
    }
    case "media": {
      const alt = str(attr(n, "alt"));
      return alt ? `Image ${alt}` : "Image";
    }
    default: return null;
  }
}

const BLOCK_TAG: Record<string, string> = {
  paragraph: "p", bulletList: "ul", orderedList: "ol", listItem: "li", blockquote: "blockquote",
  table: "table", tableRow: "tr", tableHeader: "th", tableCell: "td",
};

const MARK_TAG: Record<string, string> = { strong: "strong", em: "em", code: "code", strike: "s", underline: "u" };

/** Wraps `inner` in the mark's element; a mark outside the allowlist (and the link mark, handled by the caller) adds nothing. */
function mark(inner: Node, m: Json): Node {
  const name = str(m.type);
  if (!Object.hasOwn(MARK_TAG, name)) return inner;
  const tag = MARK_TAG[name];
  const e = el(tag, `ja-${tag}`);
  e.append(inner);
  return e;
}

function inline(n: Json, ctx: RenderCtx): Node {
  const text = leafText(n) ?? "";
  const marks = Array.isArray(n.marks) ? n.marks.map(obj).filter((m): m is Json => m !== null) : [];
  const link = marks.find((m) => m.type === "link");
  let node: Node = link ? inertLink(text, str(attr(link, "href")), ctx.openUrl) : document.createTextNode(text);
  for (const m of marks) if (m !== link) node = mark(node, m);
  return node;
}

function build(n: Json, ctx: RenderCtx, b: Budget, depth: number): Node {
  if (depth > MAX_DEPTH) throw new OverBudget();
  charge(b);
  const type = str(n.type);
  const leaf = leafText(n);
  if (leaf !== null) return inline(n, ctx);
  const into = (host: HTMLElement) => {
    for (const c of kids(n)) {
      const child = obj(c);
      if (child) host.append(build(child, ctx, b, depth + 1));
    }
    return host;
  };
  switch (type) {
    case "heading": {
      const level = Number(attr(n, "level"));
      return into(level === 1 || level === 2 ? el("h4", "ja-h") : el("h5", "ja-h"));
    }
    case "codeBlock": {
      const pre = el("pre", "ja-pre");
      const code = el("code", "ja-code");
      for (const c of kids(n)) {
        const child = obj(c);
        if (!child) continue;
        charge(b);
        code.append(document.createTextNode(str(child.text)));
      }
      pre.append(code);
      return pre;
    }
    case "rule": return el("hr", "ja-hr");
    case "hardBreak": return el("br", "");
    case "paragraph": case "bulletList": case "orderedList": case "listItem": case "blockquote":
    case "table": case "tableRow": case "tableHeader": case "tableCell": {
      const tag = BLOCK_TAG[type];
      if (type === "table") {
        const table = el("table", "ja-table");
        const body = el("tbody", "");
        table.append(into(body));
        return table;
      }
      return into(el(tag, `ja-${tag}`));
    }
    default: {
      // an unknown node keeps what it holds as text, in a plain wrapper; its own fields never become markup
      const text = str(n.text);
      if (text) return document.createTextNode(text);
      return into(el("div", "ja-unknown"));
    }
  }
}

/** The document's text in reading order, without recursion: bounded by the node budget and `MAX_PLAIN`. */
function plain(doc: unknown, max = MAX_PLAIN): string {
  const b: Budget = { nodes: 0 };
  let out = "";
  const stack: (Json | string)[] = [];
  const root = obj(doc);
  if (root) stack.push(root);
  while (stack.length) {
    const item = stack.pop()!;
    if (typeof item === "string") { out += item; }
    else {
      if (++b.nodes > MAX_NODES) return `${out.slice(0, max)}…`;
      const leaf = leafText(item);
      if (leaf !== null) out += leaf;
      else {
        const t = str(item.type);
        if (t === "hardBreak") out += "\n";
        else if (t === "paragraph" || t === "heading" || t === "listItem" || t === "codeBlock" || t === "tableRow") stack.push("\n");
        const c = kids(item);
        for (let i = c.length - 1; i >= 0; i--) {
          const child = obj(c[i]);
          if (child) stack.push(child);
        }
      }
    }
    if (out.length > max) return `${out.slice(0, max)}…`;
  }
  return out;
}

export const adfRenderer: RichRenderer = {
  render(doc, ctx) {
    const root = obj(doc);
    const host = el("div", "ja-doc");
    if (!root) return { el: host, fellBack: false };
    try {
      const b: Budget = { nodes: 0 };
      for (const c of kids(root)) {
        const child = obj(c);
        if (child) host.append(build(child, ctx, b, 1));
      }
      return { el: host, fellBack: false };
    } catch (e) {
      if (!(e instanceof OverBudget)) throw e;
      const fallback = el("div", "ja-doc");
      const p = el("p", "ja-p ja-plain");
      p.textContent = plain(root);
      fallback.append(p);
      return { el: fallback, fellBack: { reason: "document too large to draw" } };
    }
  },
  excerpt(doc, max) {
    return plain(doc, max).replace(/\s+/g, " ").trim().slice(0, max);
  },
};
