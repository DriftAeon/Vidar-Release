// The ordinary Runes view's set and card DOM (src/runes/cards.ts setSection), pinned byte for byte from the
// pre-refactor code so the shared card builder the Bare view reuses (run 2026-10-17-bare-runes-flow, T4)
// leaves it unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { setSection, runeIconKey } = await import("../src/runes/cards.ts");

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
const PINNED = ["<details class=\"runes-set hue-claude\"><summary class=\"runes-set-head\" title=\"main\nCLAUDE.md\"><span class=\"runes-scp\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-sn\">CLAUDE</span><span class=\"runes-cond\"></span><span class=\"runes-sc\">3</span></summary><div class=\"runes-tray\"><details class=\"runes-rn\"><summary class=\"runes-blk card\" title=\"lib-keep-short\nAbout lib-keep-short\nAlso in touch\"><span class=\"runes-kslot\"><span class=\"runes-chip k\" title=\"Kind: Rule\" aria-label=\"Kind: Rule\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span><span class=\"runes-rname\">Lib Keep Short</span><span class=\"runes-chips\"><span class=\"runes-chip also\" title=\"Also in touch\">+1</span><span class=\"runes-chip\" title=\"Scope: Global\" aria-label=\"Scope: Global\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-chip\" title=\"Activate: Always\" aria-label=\"Activate: Always\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span></summary></details><details class=\"runes-rn is-dim\"><summary class=\"runes-blk card rc\" title=\"check-facts\nAbout check-facts\nRecall: pointer line only\"><span class=\"runes-kslot\"><span class=\"runes-chip k\" title=\"Kind: Fact\" aria-label=\"Kind: Fact\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span><span class=\"runes-rname\">Check Facts</span><span class=\"runes-chips\"><span class=\"runes-chip\" title=\"Scope: Vidar\" aria-label=\"Scope: Vidar\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-chip a-recall\" title=\"Activate: Recall\" aria-label=\"Activate: Recall\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span></summary></details><div class=\"runes-blk missing\"><span class=\"runes-rname\">gone</span></div></div></details>","<details class=\"runes-set hue-path is-dim\"><summary class=\"runes-set-head\" title=\"touch\n.claude/rules/x.md\nsrc/**\"><span class=\"runes-scp\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-sn\">x</span><span class=\"runes-cond\" title=\"Load on Touch\nLoads when Claude touches:\nsrc/**\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-sc\">2</span></summary><div class=\"runes-tray\"><details class=\"runes-rn\"><summary class=\"runes-blk card ps\" title=\"run-it\nAbout run-it\"><span class=\"runes-kslot\"><span class=\"runes-chip k\" title=\"Kind: Procedure\" aria-label=\"Kind: Procedure\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span><span class=\"runes-rname\">Run It</span><span class=\"runes-chips\"><span class=\"runes-chip\" title=\"Scope: None\" aria-label=\"Scope: None\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-chip\" title=\"Activate: Paths\" aria-label=\"Activate: Paths\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span></summary></details><details class=\"runes-rn\"><summary class=\"runes-blk card ps\" title=\"lib-keep-short\nAbout lib-keep-short\nAlso in main\"><span class=\"runes-kslot\"><span class=\"runes-chip k\" title=\"Kind: Rule\" aria-label=\"Kind: Rule\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span><span class=\"runes-rname\">Lib Keep Short</span><span class=\"runes-chips\"><span class=\"runes-chip also\" title=\"Also in main\">+1</span><span class=\"runes-chip\" title=\"Scope: Global\" aria-label=\"Scope: Global\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span><span class=\"runes-chip\" title=\"Activate: Always\" aria-label=\"Activate: Always\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"></span></span></summary></details></div></details>","<div class=\"runes-fmbar\"><span class=\"runes-fms\"><span class=\"runes-fm fname\"><span class=\"runes-fk\">Name</span><span class=\"runes-fv\">check-facts</span></span><span class=\"runes-fm\"><span class=\"runes-fk\">Kind</span><span class=\"runes-fv\">Fact</span></span><span class=\"runes-fm\"><span class=\"runes-fk\">Scope</span><span class=\"runes-fv\"><span class=\"runes-fsv\">Vidar, !bare</span></span></span><span class=\"runes-fm a-recall\"><span class=\"runes-fk\">Activate</span><span class=\"runes-fv\">Recall</span></span></span><span class=\"runes-acts\"><button class=\"runes-act\" type=\"button\" aria-label=\"Edit\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"><span class=\"\">Edit</span></button><button class=\"runes-act\" type=\"button\" aria-label=\"Open Folder\"><img class=\"icn\" src=\"\" alt=\"\" draggable=\"false\" aria-hidden=\"true\"><span class=\"\">Open Folder</span></button></span></div>"];

const html = (n) => n.outerHTML.replace(/src="[^"]*"/g, 'src=""');
const toggle = (d) => d.dispatchEvent(new d.ownerDocument.defaultView.Event("toggle"));

test("setSection draws the same set and card DOM", () => {
  assert.equal(html(setSection(T, T.sets[0], CTX)), PINNED[0]);
  assert.equal(html(setSection(T, T.sets[1], CTX)), PINNED[1]);
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

test("the ordinary key reads Global and Vidar", () => {
  const scope = runeIconKey().querySelectorAll(".runes-key-group")[1];
  assert.deepEqual([...scope.querySelectorAll(".runes-key-item")].map((i) => i.title), ["Global", "Vidar"]);
});
