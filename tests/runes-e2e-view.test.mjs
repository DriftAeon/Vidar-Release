// The DOM reader used for live E2E sees the session vault's cards.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";
import readRunes from "./helpers/runes-read.mjs";

setupDom();
const { mountBareView } = await import("../src/runes/bare/view.ts");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
test("a pinned vault revision supplies the View card and Modify supplies switches", async () => {
  const vault = { id: "daily", hash: "abc", name: "Daily", lockedUtc: null,
    runesets: [{ source: { library: "kit", set: "kit" } }], runes: [], pins: {} };
  const view = { vault, drift: [], warnings: [], runes: [
    { set: { library: "kit", set: "kit" }, library: "kit", id: "verdict-first",
      kind: "rule", activate: "always", description: "Verdict First", section: ["Work"],
      recall: false, body: "Verdict first.", drift: false },
  ] };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare",
    vault: { session: async () => ({ vault: { id: "daily", hash: "abc" } }),
      read: async () => view, lock: async () => vault },
    vaultEdit: { current: async () => vault, currentView: async () => view,
      edit: async () => vault, moveTab: async () => true } },
  { localSources: async () => ({ files: [], memoryDir: null, guardsKey: false }),
    itemsImport: async () => ({ runes: [], dropped: [] }), generate: async () => ({}),
    generateCancel: async () => null });
  try {
    await settle();
    const shown = readRunes(host);
    assert.deepEqual(shown.sets.map((s) => [s.head, s.runes.map((r) => r.id)]),
      [["Kit", ["verdict-first"]]]);
    assert.equal(host.querySelectorAll(".runes-bare-switch").length, 0);
    handle.modeButton.click();
    await settle();
    assert.ok(host.querySelectorAll(".runes-bare-switch").length >= 2);
  } finally { handle.dispose(); host.remove(); }
});
