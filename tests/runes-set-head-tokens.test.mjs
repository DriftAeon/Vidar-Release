import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { mountBareView } = await import("../src/runes/bare/view.ts");

test("vault set head shows no token count in View or Modify", async () => {
  const vault = { id: "daily", hash: "abc", name: "Daily", lockedUtc: null,
    runesets: [{ source: { library: "installed", set: "installed" } }], runes: [], pins: {} };
  const read = { vault, drift: [], warnings: [], runes: [{
    set: { library: "installed", set: "installed" }, library: "installed", id: "one",
    kind: "rule", activate: "always", description: "One", section: ["Work"],
    recall: false, body: "é", drift: false,
  }] };
  const io = { localSources: async () => ({ files: [], memoryDir: null, guardsKey: false }),
    generate: async () => ({}), generateCancel: async () => null };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare",
    vault: { session: async () => ({ vault: { id: "daily", hash: "abc" } }),
      read: async () => read, lock: async () => vault },
    vaultEdit: { read: async () => read,
      edit: async () => vault } }, io);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  try {
    await settle();
    const head = host.querySelector('.runes-set[data-library="installed"] > .runes-set-head');
    assert.ok(head);
    assert.doesNotMatch(head.textContent, /Tokens/);
    view.modeButton.click();
    await settle();
    assert.doesNotMatch(host.textContent, /Tokens/);
  } finally {
    view.dispose();
    host.remove();
  }
});
