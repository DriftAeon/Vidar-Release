// Notion block renderer (src/notion/blocks.ts, rich-text.ts): the hostile fixture. Remote
// strings stay text, no element carries href/src/style/on*, only allowlisted tags and classes appear, unsafe
// links never reach openUrl, images and unknown types become markers, non-emoji callout icons drop.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { notionRenderer, renderDoc, ALLOWED_CLASSES, MAX_ROW_CELLS, MAX_TABLE_CELLS } = await import("../src/notion/blocks.ts");

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const PAGE = id(1);
const TAGS = new Set(["p", "h3", "h4", "h5", "ul", "ol", "li", "blockquote", "pre", "code", "strong", "em", "s", "u",
  "span", "div", "table", "tr", "th", "td", "details", "summary", "hr", "br"]);

const txt = (content, extra = {}) => ({ type: "text", text: { content, link: null }, plain_text: content, href: null, annotations: {}, ...extra });
const link = (content, url) => ({ type: "text", text: { content, link: { url } }, plain_text: content, href: url, annotations: {} });
const block = (n, type, data, more = {}) => ({ object: "block", id: id(n), type, has_children: false, [type]: data, ...more });

function makeCtx(children = {}) {
  const opened = [];
  const calls = [];
  const ctx = {
    openUrl: (u) => opened.push(u),
    loadChildren: async (bid, cursor) => {
      calls.push([bid, cursor]);
      return children[bid] ?? { ok: { blocks: [], next: null } };
    },
    alive: () => true,
  };
  return { ctx, opened, calls };
}

async function settle(walk) {
  for (let i = 0; i < 6; i++) {
    await walk?.idle;
    await new Promise((r) => setTimeout(r, 0));
  }
}

const tableRow = (n) => block(n, "table_row", { cells: Array.from({ length: 60 }, (_, i) => [txt(`c${i}`)]) });
const HOSTILE = [
  block(10, "paragraph", { color: "red; background:url(x)", rich_text: [
    txt("<img src=x onerror=alert(1)>", { annotations: { bold: true, italic: true, code: true, color: "javascript:alert" } }),
    link("bad", "javascript:alert(1)"),
    link("good", "https://example.com/a"),
    { type: "mention", mention: { type: "page", page: { id: id(2) } }, plain_text: "Mentioned", href: "javascript:void(0)", annotations: {} },
    txt("blue", { annotations: { color: "blue_background" } }),
  ] }),
  block(11, "image", { type: "file", file: { url: "https://files.example.com/x.png" }, caption: [txt("A caption")] }),
  block(12, "callout", { icon: { type: "custom_emoji", custom_emoji: { url: "https://example.com/e.png" } }, rich_text: [txt("custom")] }),
  block(13, "callout", { icon: { type: "external", external: { url: "https://example.com/e.png" } }, rich_text: [txt("external")] }),
  block(14, "callout", { icon: { type: "emoji", emoji: "\u{1F4A1}" }, rich_text: [txt("emoji")], color: "gray_background" }),
  block(15, "weird_future_type", { onclick: "x" }),
  block(16, "bookmark", { url: "javascript:alert(1)", caption: [] }),
  block(17, "embed", { url: "https://example.com/embed" }),
  block(18, "child_database", { title: "Example Tasks" }),
  block(19, "file", { name: "notes.pdf", file: { url: "https://files.example.com/n.pdf" } }),
  block(20, "video", { type: "external", external: { url: "https://example.com/v" } }),
  block(21, "code", { language: "<script>", rich_text: [txt("let a = '<b>';")] }),
  block(22, "table", { table_width: 60, has_column_header: true, has_row_header: false }, { has_children: true }),
  block(23, "unsupported", { block_type: "ai_block" }),
  block(24, "to_do", { checked: true, rich_text: [txt("done")] }),
  block(25, "heading_1", { rich_text: [txt("Head")], is_toggleable: false }),
  block(26, "divider", {}),
  "not a block",
];
const ROWS = Array.from({ length: 45 }, (_, i) => tableRow(100 + i));

async function renderHostile() {
  const c = makeCtx({ [id(22)]: { ok: { blocks: ROWS, next: null } } });
  const out = renderDoc({ pageId: PAGE, blocks: HOSTILE, next: null }, c.ctx);
  await settle(out.walk);
  return { ...c, root: out.el, out };
}

test("no element carries href, src, style or on*, and tags and classes are allowlisted", async () => {
  const { root, out } = await renderHostile();
  assert.equal(out.fellBack, false);
  for (const node of [root, ...root.querySelectorAll("*")]) {
    const tag = node.tagName.toLowerCase();
    assert.ok(TAGS.has(tag), `tag ${tag}`);
    for (const a of node.getAttributeNames()) {
      assert.ok(!/^(href|src|style|on)/i.test(a), `${tag} carries ${a}`);
    }
    for (const c of node.classList) assert.ok(ALLOWED_CLASSES.has(c), `class ${c}`);
  }
  assert.equal(root.querySelector("img, script, a, iframe, input"), null);
  assert.ok(root.textContent.includes("<img src=x onerror=alert(1)>"));
  const p = root.querySelector("p");
  assert.equal(p.className, "nb-p");
  assert.ok(p.querySelector("strong > em > code"));
  assert.ok(root.querySelector(".nb-bg-blue"));
});

test("a javascript: link never calls openUrl; an https one does", async () => {
  const { root, opened } = await renderHostile();
  const links = [...root.querySelectorAll(".rich-link")];
  const byText = (t) => links.find((n) => n.textContent === t);
  for (const t of ["bad", "Mentioned", "javascript:alert(1)"]) {
    const n = byText(t);
    assert.ok(n, t);
    n.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.equal(n.getAttribute("role"), null);
  }
  assert.deepEqual(opened, []);
  byText("good").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  byText("https://example.com/embed").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, ["https://example.com/a", "https://example.com/embed"]);
});

test("links: title is the normalised href, bookmarks label with the safe url, format controls never reach a label", async () => {
  const c = makeCtx();
  const out = renderDoc({ pageId: PAGE, blocks: [
    block(2, "paragraph", { rich_text: [link("Docs‮", "https://Example.com/a%20b")] }),
    block(3, "bookmark", { url: "https://example.com/‮gpj.exe", caption: [] }),
    block(4, "link_preview", { url: "HTTPS://EXAMPLE.com" }),
    block(5, "paragraph", { rich_text: [link("Spoof", "https://exa​mple.com/")] }),
  ], next: null }, c.ctx);
  await settle(out.walk);
  const links = [...out.el.querySelectorAll(".rich-link")];
  assert.deepEqual(links.map((n) => n.textContent),
    ["Docs", "https://example.com/gpj.exe", "https://example.com/", "Spoof"]);
  assert.deepEqual(links.map((n) => n.title), ["https://example.com/a%20b", "", "https://example.com/", ""]);
  assert.ok(!/\p{Cf}/u.test(out.el.textContent), "no format control in any text");
  for (const n of links) n.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(c.opened, ["https://example.com/a%20b", "https://example.com/"], "a url that changes under stripping is refused");
  assert.equal(links[1].getAttribute("role"), null);
});

test("a relative internal link opens on notion.so; other relative links stay plain", async () => {
  const c = makeCtx();
  const hex = "0123456789abcdef0123456789ABCDEF";
  const dashed = "01234567-89ab-cdef-0123-456789abcdef";
  const out = renderDoc({ pageId: PAGE, blocks: [block(2, "paragraph", { rich_text: [
    link("A", `/${hex}`), link("B", `/${dashed}?pvs=4`), link("C", "/settings"), link("D", `/${hex}x`),
  ] })], next: null }, c.ctx);
  await settle(out.walk);
  const links = [...out.el.querySelectorAll(".rich-link")];
  for (const n of links) n.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(c.opened, [`https://www.notion.so/${hex.toLowerCase()}`, `https://www.notion.so/${dashed.replace(/-/g, "")}`]);
  assert.deepEqual(links.map((n) => n.getAttribute("role")), ["link", "link", null, null]);
});

test("an image becomes a marker with its caption; files, databases and unknown types are markers", async () => {
  const { root } = await renderHostile();
  const markers = [...root.querySelectorAll(".nb-marker")].map((n) => n.textContent);
  assert.deepEqual(markers, ["Image", "Unsupported Block", "Database", "notes.pdf", "File", "Unsupported Block"]);
  assert.equal(root.querySelector(".nb-media .nb-caption").textContent, "A caption");
  assert.ok(root.querySelector(".nb-db").textContent.includes("Example Tasks"));
  assert.ok(!root.textContent.includes("files.example.com"));
});

test("only an emoji callout icon renders", async () => {
  const { root } = await renderHostile();
  const icons = [...root.querySelectorAll(".nb-callout")].map((c) => c.querySelector(".nb-callout-icon")?.textContent ?? null);
  assert.deepEqual(icons, [null, null, "\u{1F4A1}"]);
});

test("tables cap cells per row and per table", async () => {
  const { root } = await renderHostile();
  const rows = [...root.querySelectorAll(".nb-table tr")];
  assert.ok(rows.every((r) => r.children.length <= MAX_ROW_CELLS));
  assert.equal(rows[0].children.length, MAX_ROW_CELLS);
  assert.equal(rows[0].querySelector("th").textContent, "c0");
  assert.equal(rows[1].querySelector("th"), null);
  assert.equal(root.querySelectorAll(".nb-table th, .nb-table td").length, MAX_TABLE_CELLS);
});

test("to_do state is a text marker, code language a label, headings shift down", async () => {
  const { root } = await renderHostile();
  assert.equal(root.querySelector(".nb-todo-done .nb-check").textContent, "☑");
  assert.equal(root.querySelector(".nb-code-lang").textContent, "<script>");
  assert.equal(root.querySelector("h3").textContent, "Head");
  assert.ok(root.querySelector("hr.nb-hr"));
});

test("list items group into one list, across a page boundary too", async () => {
  const li = (n, t) => block(n, "bulleted_list_item", { rich_text: [txt(t)] });
  const c = makeCtx();
  c.ctx.loadChildren = async () => ({ ok: { blocks: [li(3, "c")], next: null } });
  const out = renderDoc({ pageId: PAGE, blocks: [li(1, "a"), li(2, "b")], next: "cursor-1" }, c.ctx);
  await settle(out.walk);
  assert.equal(out.el.querySelectorAll("ul").length, 1);
  assert.deepEqual([...out.el.querySelectorAll("li")].map((n) => n.textContent), ["a", "b", "c"]);
});

test("a malformed body falls back to a marker", () => {
  const out = notionRenderer.render({ blocks: "x" }, makeCtx().ctx);
  assert.notEqual(out.fellBack, false);
  assert.equal(out.el.textContent, "Unsupported Block");
});

test("excerpt is plain text from the first blocks, capped", () => {
  const doc = { pageId: PAGE, next: null, blocks: [
    block(1, "paragraph", { rich_text: [txt("Hello  "), txt("world", { annotations: { bold: true } })] }),
    block(2, "image", {}),
    block(3, "heading_2", { rich_text: [txt("Second\nline")] }),
  ] };
  assert.equal(notionRenderer.excerpt(doc, 400), "Hello world Second line");
  assert.equal(notionRenderer.excerpt(doc, 5), "Hello");
  assert.equal(notionRenderer.excerpt(null, 400), "");
});
