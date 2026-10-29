// The ordinary Runes view's set and card DOM (src/runes/cards.ts setSection), pinned byte for byte from the
// pre-refactor code so the shared card builder the Bare view reuses
// leaves it unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { setSection, runeIconKey } = await import("../src/runes/cards.ts");
const { runeLedger } = await import("../src/runes/ledger.ts");

const rune = (id, o = {}) => ({ id, kind: "rule", scope: ["global"], state: "active", activate: "always",
  description: `About ${id}`, path: `C:/lib/rules/${id}.md`, body: `Body of ${id}.`, ...o });
const RUNES = [
  rune("lib-keep-short"),
  rune("check-facts", { kind: "fact", scope: ["vidar", "!bare"], activate: "recall" }),
  rune("run-it", { kind: "procedure", scope: [], activate: "paths" }),
];
const set = (id, tier, members, o = {}) => ({ id, target: "CLAUDE.md", targetAbs: "C:/CLAUDE.md", activate: "always",
  paths: [], scope: ["global"], tier, members, ...o });
const S1 = set("main", 1, [{ id: "lib-keep-short", recall: false }, { id: "check-facts", recall: true }, { id: "gone", recall: false }]);
const S2 = set("touch", 2, [{ id: "run-it", recall: false }, { id: "lib-keep-short", recall: false }],
  { target: ".claude/rules/x.md", paths: ["src/**"], scope: ["vidar"] });
const T = {
  lib: { key: "vidar", root: "C:/lib", present: true, runes: RUNES, sets: [S1, S2] },
  sets: [{ set: S1, state: "Loaded" }, { set: S2, state: "On Touch" }],
  runeLoaded: new Map([["lib-keep-short", true], ["check-facts", false], ["run-it", null]]),
  setsOf: new Map([["lib-keep-short", ["main", "touch"]], ["check-facts", ["main"]], ["run-it", ["touch"]]]),
};
const CTX = { openInDocument: () => {}, note: () => {} };

// [set 1, set 2, set 1's second card opened: its frontmatter bar], captured before the refactor.
const PINNED = ["<details class=\"runes-set runes-card hue-claude\"><summary class=\"runes-set-head\" title=\"main\nCLAUDE.md\"><span class=\"runes-scp\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-sn\">CLAUDE</span><span class=\"runes-cond\"></span><span class=\"runes-sc\">3</span></summary><div class=\"runes-tray\"><details class=\"runes-rn\"><summary class=\"runes-blk card\" title=\"lib-keep-short\nAbout lib-keep-short\nAlso in touch\"><span class=\"runes-kslot\"><span class=\"runes-chip k\" title=\"Rule\" aria-label=\"Rule\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span><span class=\"runes-rname\">Lib Keep Short</span><span class=\"runes-chips\"><span class=\"runes-chip also\" title=\"Also in touch\">+1</span><span class=\"runes-chip\" title=\"Global\" aria-label=\"Global\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-chip\" title=\"Always\" aria-label=\"Always\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span></summary></details><details class=\"runes-rn is-dim\"><summary class=\"runes-blk card rc\" title=\"check-facts\nAbout check-facts\nRecall: pointer line only\"><span class=\"runes-kslot\"><span class=\"runes-chip k\" title=\"Fact\" aria-label=\"Fact\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span><span class=\"runes-rname\">Check Facts</span><span class=\"runes-chips\"><span class=\"runes-chip\" title=\"Vidar\" aria-label=\"Vidar\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-chip a-recall\" title=\"Recall\" aria-label=\"Recall\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span></summary></details><div class=\"runes-blk missing\"><span class=\"runes-rname\">Gone</span></div></div></details>","<details class=\"runes-set runes-card hue-path is-dim\"><summary class=\"runes-set-head\" title=\"touch\n.claude/rules/x.md\nsrc/**\"><span class=\"runes-scp\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-sn\">x</span><span class=\"runes-cond\" title=\"Load on Touch\nLoads when Claude touches:\nsrc/**\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-sc\">2</span></summary><div class=\"runes-tray\"><details class=\"runes-rn\"><summary class=\"runes-blk card ps\" title=\"run-it\nAbout run-it\"><span class=\"runes-kslot\"><span class=\"runes-chip k\" title=\"Procedure\" aria-label=\"Procedure\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span><span class=\"runes-rname\">Run It</span><span class=\"runes-chips\"><span class=\"runes-chip\" title=\"None\" aria-label=\"None\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-chip\" title=\"Paths\" aria-label=\"Paths\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span></summary></details><details class=\"runes-rn\"><summary class=\"runes-blk card ps\" title=\"lib-keep-short\nAbout lib-keep-short\nAlso in main\"><span class=\"runes-kslot\"><span class=\"runes-chip k\" title=\"Rule\" aria-label=\"Rule\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span><span class=\"runes-rname\">Lib Keep Short</span><span class=\"runes-chips\"><span class=\"runes-chip also\" title=\"Also in main\">+1</span><span class=\"runes-chip\" title=\"Global\" aria-label=\"Global\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-chip\" title=\"Always\" aria-label=\"Always\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span></summary></details></div></details>","<div class=\"runes-fmbar\"><span class=\"runes-fms\"><span class=\"runes-fm fname\"><span class=\"runes-fk\">Name</span><span class=\"runes-fv\">check-facts</span></span><span class=\"runes-fm\"><span class=\"runes-fk\">Kind</span><span class=\"runes-fv\">Fact</span></span><span class=\"runes-fm\"><span class=\"runes-fk\">Scope</span><span class=\"runes-fv\"><span class=\"runes-fsv\">Vidar, !bare</span></span></span><span class=\"runes-fm a-recall\"><span class=\"runes-fk\">Activate</span><span class=\"runes-fv\">Recall</span></span></span><span class=\"runes-acts\"><button class=\"runes-act\" type=\"button\" aria-label=\"Edit\" title=\"Edit\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></button><button class=\"runes-act\" type=\"button\" aria-label=\"Open Folder\" title=\"Open Folder\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></button></span></div>"];

const html = (n) => n.outerHTML.replace(/src="[^"]*"/g, 'src=""');
const toggle = (d) => d.dispatchEvent(new d.ownerDocument.defaultView.Event("toggle"));

// PINNED holds the flat pre-grouping DOM: the set head and every card are still byte for byte what it pins; the
// cards now sit under nested kind heads (Modify's order, then KINDS order; a missing member under no head).
const heads = (sec) => [...sec.querySelectorAll(":scope > details.runes-set")].map((d) => ({
  kind: d.dataset.kindHead, hue: d.className, open: d.open,
  name: d.querySelector(".runes-sn").textContent, count: d.querySelector(".runes-sc").textContent,
  cards: [...d.querySelectorAll(".runes-rname")].map((n) => n.textContent),
}));

test("setSection draws the same set head and cards, grouped under kind heads", () => {
  for (const [i, n] of [[0, 0], [1, 1]]) {
    const sec = setSection(T, T.sets[n], CTX);
    assert.ok(PINNED[i].includes(html(sec.querySelector(":scope > summary"))));
    for (const card of sec.querySelectorAll(".runes-rn, .runes-blk.missing")) assert.ok(PINNED[i].includes(html(card)), html(card));
  }
  assert.deepEqual(heads(setSection(T, T.sets[0], CTX)), [
    { kind: "rule", hue: "runes-set hue-rule", open: true, name: "Rules", count: "1", cards: ["Lib Keep Short"] },
    { kind: "fact", hue: "runes-set hue-none", open: true, name: "Facts", count: "1", cards: ["Check Facts"] },
  ]);
  const sec0 = setSection(T, T.sets[0], CTX);
  assert.equal(sec0.querySelector(":scope > .runes-tray .missing .runes-rname").textContent, "Gone");
  assert.deepEqual(heads(setSection(T, T.sets[1], CTX)).map((h) => [h.name, h.count, h.cards]), [
    ["Rules", "1", ["Lib Keep Short"]], ["Procedures", "1", ["Run It"]],
  ]);
});

test("kind heads order skills, agents, hooks first, take their kind hue, and a closed head stays closed", () => {
  const mix = [rune("s1", { kind: "skill" }), rune("m1", { kind: "mcp" }), rune("h1", { kind: "hook" }), rune("a1", { kind: "agent" }), rune("r1")];
  const s = set("mix", 1, mix.map((r) => ({ id: r.id, recall: false })));
  const t = { ...T, lib: { ...T.lib, runes: mix }, sets: [{ set: s, state: "Loaded" }], setsOf: new Map() };
  const sec = setSection(t, t.sets[0], CTX);
  assert.deepEqual(heads(sec).map((h) => [h.name, h.hue]), [
    ["Skills", "runes-set hue-skill"], ["Agents", "runes-set hue-agent"], ["Hooks", "runes-set hue-hook"],
    ["Rules", "runes-set hue-rule"], ["MCPs", "runes-set hue-mcp"],
  ]);
  const first = sec.querySelector(":scope > details.runes-set");
  first.open = false; toggle(first);
  assert.equal(setSection(t, t.sets[0], CTX).querySelector(":scope > details.runes-set").open, false);
  first.open = true; toggle(first);
});

test("an opened card builds the same frontmatter bar and body, once", () => {
  const opened = [];
  const sec = setSection(T, T.sets[0], { ...CTX, openInDocument: (p) => opened.push(p) });
  const card = sec.querySelectorAll(".runes-rn")[1];
  card.open = true;
  toggle(card);
  toggle(card);
  assert.equal(card.childElementCount, 2);
  assert.equal(html(card.querySelector(".runes-fmbar")), PINNED[2]);
  assert.equal(card.querySelector(".runes-rd").textContent, "About check-facts");
  assert.ok(card.querySelector(".runes-rt").textContent.includes("Body of check-facts."));
  card.querySelector('.runes-act[aria-label="Edit"]').click();
  assert.deepEqual(opened, ["C:/lib/rules/check-facts.md"]);
});

test("the key's Kind group lists all eleven kinds in Title Case", () => {
  const kinds = runeIconKey().querySelectorAll(".runes-key-group")[0];
  assert.deepEqual([...kinds.querySelectorAll(".runes-key-item")].map((i) => i.title),
    ["Rule", "Fact", "Procedure", "Skill", "Agent", "Hook", "MCP Server", "Permission", "Plugin", "Output Style", "Model"]);
});

test("a missing member and a camelCase id read in Title Case", () => {
  const t = { ...T, lib: { ...T.lib, runes: [rune("openaiDeveloperDocs")] } };
  const s = set("x", 1, [{ id: "openaiDeveloperDocs", recall: false }, { id: "ghost_rune", recall: false }]);
  const sec = setSection({ ...t, sets: [{ set: s, state: "Loaded" }], setsOf: new Map() }, { set: s, state: "Loaded" }, CTX);
  assert.deepEqual([...sec.querySelectorAll(".runes-rname")].map((n) => n.textContent), ["Openai Developer Docs", "Ghost Rune"]);
});

test("runeName collapses a doubled id to one word; other ids keep their words", async () => {
  const { runeName } = await import("../src/runes/cards.ts");
  const n = (id) => runeName({ id, path: "runtime/runes/kit/mcp/" + id + ".md" });
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

test("the ordinary key reads Global and Vidar", () => {
  const scope = runeIconKey().querySelectorAll(".runes-key-group")[1];
  assert.deepEqual([...scope.querySelectorAll(".runes-key-item")].map((i) => i.title), ["Global", "Vidar"]);
});

test("a classic skill-file read undims its card and adds one load tooltip line", () => {
  const loaded = { source: "transcript", files: [], runeReads: ["check-facts"], truncated: false };
  const ledger = runeLedger(T, loaded);
  const card = setSection(T, T.sets[0], CTX, ledger).querySelectorAll(".runes-rn")[1];
  assert.equal(card.classList.contains("is-dim"), false);
  assert.equal(card.querySelector("summary").title, "check-facts\nAbout check-facts\nRecall: pointer line only\nLoaded: Recall");
  assert.equal(card.querySelectorAll(".runes-chips .runes-chip").length, 2, "no load chip");
});

test("opened page shows populated provenance and markdown, omitting empty values", () => {
  const full = { ...RUNES[1], origin: "Design note", closesWhen: "Retired", why: "**Because** it matters", example: "`Try this`" };
  const traced = { ...T, lib: { ...T.lib, runes: [RUNES[0], full, RUNES[2]] } };
  const card = setSection(traced, traced.sets[0], CTX).querySelectorAll(".runes-rn")[1];
  card.open = true; toggle(card);
  const fields = Object.fromEntries([...card.querySelectorAll(".runes-fm")].map((f) =>
    [f.querySelector(".runes-fk").textContent, f.querySelector(".runes-fv").textContent]));
  assert.equal(fields.Origin, "Design note");
  assert.equal(fields["Closes When"], "Retired");
  assert.deepEqual([...card.querySelectorAll(".runes-rt h4")].map((h) => h.textContent), ["Why", "Example"]);
  assert.match(card.querySelector(".runes-rbody").textContent, /Because it matters.*Try this/s);
  const empty = { ...T, lib: { ...T.lib, runes: [RUNES[0], { ...full, origin: " ", closesWhen: "", why: "", example: " " }, RUNES[2]] } };
  const emptyCard = setSection(empty, empty.sets[0], CTX).querySelectorAll(".runes-rn")[1];
  emptyCard.open = true; toggle(emptyCard);
  assert.equal(emptyCard.querySelector(".runes-fmbar").textContent.includes("Origin"), false);
  assert.equal(emptyCard.querySelector(".runes-fmbar").textContent.includes("Closes When"), false);
  assert.equal(emptyCard.querySelectorAll(".runes-rt h4").length, 0);
});
