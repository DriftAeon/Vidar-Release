import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { costBar } = await import("../src/runes/bare/cost-bar.ts");
const { mountBareView } = await import("../src/runes/bare/view.ts");

const brick = (id, body, state = "on", extra = {}) => ({
  id, section: ["Doc", id], studs: 1, on: state === "on", state,
  path: `C:/r/rules/${id}.md`, kind: "rule", activate: "always", description: id, body, ...extra,
});
const library = (bricks, extra = {}) => ({
  library: "kit", source: null, scope: "global", sourceGone: false, bricks,
  sets: [{ set: "kit", editable: true, skills: [], agents: [], guards: [], codexSkills: [], modules: {}, warnings: [] }],
  ...extra,
});

test("cost bar uses UTF-8 bytes and excludes inactive runes", () => {
  const bar = costBar(library([
    brick("café", "é"), brick("long", "ééééé"), brick("off", "a".repeat(4000), "off"),
    brick("shadow", "b".repeat(4000), "shadow"),
  ]));
  const label = bar.querySelector(".runes-cost-label");
  assert.equal(label.textContent, "4/4 Tokens");
  assert.equal(bar.querySelector(".runes-cost-bar"), null);
  assert.equal(bar.querySelector(".runes-cost-seg"), null);
  assert.match(label.title, /^Tokens loaded at launch out of all tokens in the set;/);
});

test("cost bar counts only always runes as loaded", () => {
  const bar = costBar(library([
    brick("a", "a".repeat(400)), brick("r", "a".repeat(800), "on", { activate: "recall" }), brick("p", "a".repeat(40), "on", { activate: "paths" }),
  ]));
  assert.equal(bar.querySelector(".runes-cost-label").textContent, "100/310 Tokens");
});

test("cost bar groups thousands and an empty set has no bar", () => {
  const bar = costBar(library([brick("large", "a".repeat(4000))]));
  assert.equal(bar.querySelector(".runes-cost-label").textContent, "1,000/1,000 Tokens");
  assert.equal(costBar(library([])), null);
  assert.equal(costBar(library([brick("off", "x", "off")])), null);
});

test("vault set head shows token cost in View and omits it in Modify", async () => {
  const vault = { id: "daily", hash: "abc", name: "Daily", lockedUtc: null,
    runesets: [{ source: { library: "kit", set: "kit" } }], runes: [], pins: {} };
  const read = { vault, drift: [], warnings: [], runes: [{
    set: { library: "kit", set: "kit" }, library: "kit", id: "one",
    kind: "rule", activate: "always", description: "One", section: ["Work"],
    recall: false, body: "é", drift: false,
  }] };
  const io = { localSources: async () => ({ files: [], memoryDir: null, guardsKey: false }),
    itemsImport: async () => ({ runes: [], dropped: [] }),
    generate: async () => ({}), generateCancel: async () => null };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare",
    vault: { session: async () => ({ vault: { id: "daily", hash: "abc" } }),
      read: async () => read, lock: async () => vault },
    vaultEdit: { current: async () => vault, currentView: async () => read,
      edit: async () => vault, moveTab: async () => true } }, io);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  try {
    await settle();
    const head = host.querySelector('.runes-set[data-library="kit"] > .runes-set-head');
    assert.equal(head.querySelector(".runes-cond .runes-cost-label").textContent, "1/1 Tokens");
    view.modeButton.click();
    await settle();
    assert.equal(host.querySelector('.runes-set[data-library="kit"] > .runes-set-head .runes-cost'), null);
  } finally {
    view.dispose();
    host.remove();
  }
});
