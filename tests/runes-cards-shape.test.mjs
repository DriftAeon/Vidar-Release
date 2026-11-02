// The rune card's opened body and the icon key (src/runes/cards.ts cardDetails, openedBody, runeIconKey): the shared
// card builder the Bare view uses, pinned byte for byte from the pre-refactor code.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { cardDetails, runeIconKey } = await import("../src/runes/cards.ts");

const rune = (id, o = {}) => ({ id, kind: "rule", scope: ["global"], state: "active", activate: "always",
  description: `About ${id}`, path: `C:/lib/rules/${id}.md`, body: `Body of ${id}.`, ...o });
const FACT = rune("check-facts", { kind: "fact", scope: ["vidar", "!bare"], activate: "recall" });
const CTX = { openInDocument: () => {}, note: () => {} };
const card = (r, ctx = CTX) => cardDetails(r, { name: r.id, dim: false, title: r.id }, ctx);

// the opened card's frontmatter bar, captured before the refactor
const BAR = "<div class=\"runes-fmbar\"><span class=\"runes-fms\"><span class=\"runes-fm fname\"><span class=\"runes-fk\">Name</span><span class=\"runes-fv\">check-facts</span></span><span class=\"runes-fm\"><span class=\"runes-fk\">Kind</span><span class=\"runes-fv\">Fact</span></span><span class=\"runes-fm\"><span class=\"runes-fk\">Scope</span><span class=\"runes-fv\"><span class=\"runes-fsv\">Vidar, !bare</span></span></span><span class=\"runes-fm a-recall\"><span class=\"runes-fk\">Activate</span><span class=\"runes-fv\">Recall</span></span></span><span class=\"runes-acts\"><button class=\"runes-act\" type=\"button\" aria-label=\"Edit\" title=\"Edit\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></button><button class=\"runes-act\" type=\"button\" aria-label=\"Open Folder\" title=\"Open Folder\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></button></span></div>";

const html = (n) => n.outerHTML.replace(/src="[^"]*"/g, 'src=""');
const toggle = (d) => d.dispatchEvent(new d.ownerDocument.defaultView.Event("toggle"));

test("an opened card builds the same frontmatter bar and body, once", () => {
  const opened = [];
  const c = card(FACT, { ...CTX, openInDocument: (p) => opened.push(p) });
  c.open = true;
  toggle(c);
  toggle(c);
  assert.equal(c.childElementCount, 2);
  assert.equal(html(c.querySelector(".runes-fmbar")), BAR);
  assert.equal(c.querySelector(".runes-rd").textContent, "About check-facts");
  assert.ok(c.querySelector(".runes-rt").textContent.includes("Body of check-facts."));
  c.querySelector('.runes-act[aria-label="Edit"]').click();
  assert.deepEqual(opened, ["C:\\lib\\rules\\check-facts.md"]);
});

test("an opened card with no drive-rooted path offers no Edit and no Open Folder", () => {
  for (const path of ["", "\\\\srv\\share\\a.md", "rel/a.md"]) {
    const c = card({ ...FACT, path });
    c.open = true;
    toggle(c);
    assert.equal(c.querySelectorAll(".runes-act").length, 0, JSON.stringify(path));
  }
});

test("the key's Kind group lists all twelve kinds in Title Case", () => {
  const kinds = runeIconKey().querySelectorAll(".runes-key-group")[0];
  assert.deepEqual([...kinds.querySelectorAll(".runes-key-item")].map((i) => i.title),
    ["Rule", "Fact", "Procedure", "Skill", "Agent", "Hook", "MCP Server", "Permission", "Plugin", "Output Style", "Model", "Setting"]);
});

test("runeName collapses a doubled id to one word; other ids keep their words", async () => {
  const { runeName } = await import("../src/runes/cards.ts");
  const n = (id) => runeName({ id, path: "runtime/runes/installed/mcp/" + id + ".md" });
  assert.equal(n("slack-slack"), "Slack");
  assert.equal(n("notion-notion"), "Notion");
  assert.equal(n("jira-atlassian"), "Jira Atlassian");
  assert.equal(n("unreal-proxy"), "Unreal Proxy");
});

test("itemBody adds a Style line for an output-style rune", async () => {
  const { itemBody } = await import("../src/runes/bare/cake.ts");
  assert.equal(itemBody({ id: "brief", kind: "output-style", label: "Output Style", description: "", requiredByVidar: false, style: "Explanatory" }),
    "Output Style\n\nStyle: Explanatory");
});

test("the key is one unlabelled Kind group: no Scope, no Activate (user, 2026-10-31)", () => {
  const key = runeIconKey();
  assert.equal(key.querySelectorAll(".runes-key-group").length, 1);
  assert.equal(key.querySelectorAll(".runes-key-label").length, 0);
});

test("opened page shows populated provenance and markdown, omitting empty values", () => {
  const full = { ...FACT, origin: "Design note", closesWhen: "Retired", why: "**Because** it matters", example: "`Try this`" };
  const c = card(full);
  c.open = true; toggle(c);
  const fields = Object.fromEntries([...c.querySelectorAll(".runes-fm")].map((f) =>
    [f.querySelector(".runes-fk").textContent, f.querySelector(".runes-fv").textContent]));
  assert.equal(fields.Origin, "Design note");
  assert.equal(fields["Closes When"], "Retired");
  assert.deepEqual([...c.querySelectorAll(".runes-rt h4")].map((h) => h.textContent), ["Why", "Example"]);
  assert.match(c.querySelector(".runes-rbody").textContent, /Because it matters.*Try this/s);
  const emptyCard = card({ ...full, origin: " ", closesWhen: "", why: "", example: " " });
  emptyCard.open = true; toggle(emptyCard);
  assert.equal(emptyCard.querySelector(".runes-fmbar").textContent.includes("Origin"), false);
  assert.equal(emptyCard.querySelector(".runes-fmbar").textContent.includes("Closes When"), false);
  assert.equal(emptyCard.querySelectorAll(".runes-rt h4").length, 0);
});
