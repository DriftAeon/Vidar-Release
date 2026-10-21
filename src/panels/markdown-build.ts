// Markdown/text -> inert DOM for Document, Rendered messages and plan cards.
//
// Rendering: markdown-it 14.3.1 as a TOKENIZER only — we walk md.parse()'s
// token stream and build DOM from text nodes ourselves. No md.render(), no
// innerHTML. html:false makes source HTML plain text; links become inert spans;
// images become a text marker (a Markdown image is a fetch). Every block that
// the parser gives a line map gets data-line-start/end (zero-based,
// end-exclusive, exactly markdown-it's map) — the anchor for passage comments.

import MarkdownIt from "markdown-it";

type Token = ReturnType<MarkdownIt["parse"]>[number];

const INPUT_CAP = 2 * 1024 * 1024;
const TOKEN_CAP = 200_000; // counts inline children; checked after parse (bounds the builder, not the parser)
const DEPTH_CAP = 64; // the builder's own; the parser's maxNesting stays at its default 100
const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });

interface Built { el: HTMLElement; dropped: Record<string, number>; fellBack: false | { reason: string } }

function bump(d: Record<string, number>, k: string) { d[k] = (d[k] ?? 0) + 1; }

// A leading YAML frontmatter block (--- ... ---) is not Markdown: unstripped, its closing --- turns
// the fields into a setext heading. Blanked line for line so the line maps stay true to the file.
export function blankFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? m[0].replace(/[^\n]/g, "") + text.slice(m[0].length) : text;
}

export interface RenderOpts { softBreaks?: "space" | "br" }

export function renderMarkdownOrText(name: string, text: string, opts?: RenderOpts): Built {
  const dropped: Record<string, number> = {};
  if (text.length > INPUT_CAP) return { el: document.createElement("div"), dropped, fellBack: { reason: "input over 2 MiB" } };
  if (!/\.md$/i.test(name)) return { el: plainText(text), dropped, fellBack: false };
  let tokens: Token[];
  try { tokens = md.parse(blankFrontmatter(text), {}); } catch (e) { return { el: document.createElement("div"), dropped, fellBack: { reason: `parse failed: ${e}` } }; }
  let count = 0;
  for (const t of tokens) count += 1 + (t.children?.length ?? 0);
  if (count > TOKEN_CAP) return { el: document.createElement("div"), dropped, fellBack: { reason: "over 200 000 tokens" } };
  return buildTokens(tokens, dropped, opts?.softBreaks === "br");
}

function plainText(text: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "doc-text";
  pre.textContent = text;
  const lines = text.length ? text.split("\n").length : 0;
  setMap(pre, [0, lines]);
  return pre;
}

function setMap(el: HTMLElement, map: [number, number] | null | undefined) {
  if (!map) return; // map is optional: cells, close tokens and inline children have none
  el.setAttribute("data-line-start", String(map[0]));
  el.setAttribute("data-line-end", String(map[1]));
}

/* A location gets its own class so it can be coloured apart from a symbol or a value: in a dense
   reply `src/styles.css` and `0.92em` were the same object. Shape is all there
   is to go on — Markdown gives a code span no type. A path separator settles it; failing that a
   filename needs an alphabetic extension AND a letter before the final dot, which is what keeps
   `0.92em`, `1.45em` and `v1.2` out. A span with whitespace is a command, not a path. */
const PATH_SEP = /[/\\]/;
const FILENAME = /^[\w.-]*[A-Za-z][\w.-]*\.[A-Za-z]{1,5}$/;
function isPathish(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t)) return false;
  return PATH_SEP.test(t) || FILENAME.test(t);
}

const HEADING = /^h[1-6]$/;
const ALIGN = /text-align\s*:\s*(left|center|right)/i;
const LANG = /^[A-Za-z0-9_+-]{1,20}$/;

function buildTokens(tokens: Token[], dropped: Record<string, number>, softBr: boolean): Built {
  const rootEl = document.createElement("div");
  rootEl.className = "doc-md";
  // explicit element stack; opens push, closes pop by matching tag
  const stack: { el: HTMLElement; tag: string }[] = [{ el: rootEl, tag: "#root" }];
  const top = () => stack[stack.length - 1].el;
  const push = (el: HTMLElement, tag: string) => { top().appendChild(el); stack.push({ el, tag }); };
  const pop = (tag: string, type: string) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) { stack.length = i; return; }
    }
    bump(dropped, `unbalanced ${type}`); // no matching open: ignore, stack intact
  };
  const openEl = (tag: string, t: Token, cls?: string): HTMLElement => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    setMap(el, t.map as [number, number] | null);
    return el;
  };
  let fell: false | { reason: string } = false;

  for (const t of tokens) {
    if (stack.length > DEPTH_CAP) { fell = { reason: "nesting over 64 deep" }; break; }
    switch (t.type) {
      case "heading_open": {
        const tag = HEADING.test(t.tag) ? t.tag : "p";
        push(openEl(tag, t), "heading"); break;
      }
      case "heading_close": pop("heading", t.type); break;
      case "paragraph_open":
        if (t.hidden) { // tight-list paragraph: unwrapped; carry its map to the li if that has none
          const li = top();
          if (li.tagName === "LI" && !li.hasAttribute("data-line-start")) setMap(li, t.map as [number, number] | null);
          break;
        }
        push(openEl("p", t), "p"); break;
      case "paragraph_close": if (!t.hidden) pop("p", t.type); break;
      case "bullet_list_open": push(openEl("ul", t), "list"); break;
      case "ordered_list_open": {
        const ol = openEl("ol", t);
        const start = t.attrGet("start");
        if (start && /^\d+$/.test(start)) ol.setAttribute("start", start);
        push(ol, "list"); break;
      }
      case "bullet_list_close": case "ordered_list_close": pop("list", t.type); break;
      case "list_item_open": push(openEl("li", t), "li"); break;
      case "list_item_close": pop("li", t.type); break;
      case "blockquote_open": push(openEl("blockquote", t), "bq"); break;
      case "blockquote_close": pop("bq", t.type); break;
      case "hr": top().appendChild(openEl("hr", t)); break;
      case "code_block": case "fence": {
        const pre = openEl("pre", t);
        const code = document.createElement("code");
        const lang = (t.info ?? "").trim().split(/\s+/)[0];
        if (lang && LANG.test(lang)) code.setAttribute("data-lang", lang);
        code.textContent = t.content;
        pre.appendChild(code);
        top().appendChild(pre); break;
      }
      case "table_open": push(openEl("table", t), "table"); break;
      case "table_close": pop("table", t.type); break;
      case "thead_open": push(openEl("thead", t), "thead"); break;
      case "thead_close": pop("thead", t.type); break;
      case "tbody_open": push(openEl("tbody", t), "tbody"); break;
      case "tbody_close": pop("tbody", t.type); break;
      case "tr_open": push(openEl("tr", t), "tr"); break;
      case "tr_close": pop("tr", t.type); break;
      case "th_open": case "td_open": {
        const cell = openEl(t.type === "th_open" ? "th" : "td", t); // cells carry no map
        const st = t.attrGet("style"); // alignment arrives as style="text-align:…"
        const m = st ? ALIGN.exec(st) : null;
        if (m) cell.style.setProperty("text-align", m[1].toLowerCase());
        push(cell, "cell"); break;
      }
      case "th_close": case "td_close": pop("cell", t.type); break;
      case "inline": buildInline(t.children ?? [], top(), dropped, softBr); break;
      default:
        bump(dropped, t.type);
        top().appendChild(document.createTextNode(`[dropped: ${t.type}]`));
    }
  }
  if (fell) return { el: rootEl, dropped, fellBack: fell };
  return { el: rootEl, dropped, fellBack: false };
}

function buildInline(children: Token[], parent: HTMLElement, dropped: Record<string, number>, softBr = false) {
  const stack: { el: HTMLElement; tag: string }[] = [{ el: parent, tag: "#inline" }];
  const top = () => stack[stack.length - 1].el;
  const push = (el: HTMLElement, tag: string) => { top().appendChild(el); stack.push({ el, tag }); };
  const pop = (tag: string, type: string) => {
    for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; return; }
    bump(dropped, `unbalanced ${type}`);
  };
  for (const c of children) {
    switch (c.type) {
      case "text": case "text_special": case "html_inline": top().appendChild(document.createTextNode(c.content)); break;
      case "code_inline": {
        const code = document.createElement("code");
        code.textContent = c.content;
        if (isPathish(c.content)) code.className = "code-path";
        top().appendChild(code);
        break;
      }
      case "em_open": push(document.createElement("em"), "em"); break;
      case "em_close": pop("em", c.type); break;
      case "strong_open": push(document.createElement("strong"), "strong"); break;
      case "strong_close": pop("strong", c.type); break;
      case "s_open": push(document.createElement("s"), "s"); break;
      case "s_close": pop("s", c.type); break;
      case "softbreak": top().appendChild(softBr ? document.createElement("br") : document.createTextNode(" ")); break;
      case "hardbreak": top().appendChild(document.createElement("br")); break;
      case "link_open": { // inert: never an <a>; autolinks arrive here too
        const span = document.createElement("span");
        span.className = "doc-link";
        const href = c.attrGet("href");
        if (href) span.title = href;
        push(span, "link"); break;
      }
      case "link_close": pop("link", c.type); break;
      case "image": { // a Markdown image is a fetch: text marker, label from content/children
        const label = c.children?.length ? c.children.map((k) => k.content).join("") : c.content;
        top().appendChild(document.createTextNode(`[image: ${label}]`));
        bump(dropped, "image"); break;
      }
      default:
        bump(dropped, c.type);
        top().appendChild(document.createTextNode(`[dropped: ${c.type}]`));
    }
  }
}
