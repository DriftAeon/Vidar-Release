import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { mountBareView } = await import("../src/runes/bare/view.ts");
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const rune = (library = "vidar") => ({ library, id: "guide", set: null, kind: "rule", activate: "always",
  description: "Guide", section: [], recall: false, body: "Guide", drift: false });
const vault = (id, name) => ({ id, name, hash: "h", lockedUtc: null, runesets: [],
  runes: [{ library: "vidar", id: "guide" }], pins: {} });
const view = (id, name) => ({ vault: vault(id, name), runes: [rune()], warnings: [], drift: [] });

function modify(id) {
  const root = document.createElement("div");
  root.className = "runes-bare";
  root.append(...vaultModify({ view: view(id, "Custom"), removed: [], pending: null, busy: false,
    card: { openInDocument() {}, note() {} }, trackOpen() {}, pick: async () => {} }));
  return root;
}

test("the vault name reaches the pane head hook, with the id as fallback", async () => {
  for (const [id, name, expected] of [["main-claude", "Daily Work", "Daily Work"],
    ["custom-abc123", "", "Custom Abc123"]]) {
    const host = document.createElement("div");
    const title = document.createElement("span");
    title.className = "runes-state pane-head-card";
    host.append(title);
    const v = view(id, name);
    const handle = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare",
      headName: (text) => { title.textContent = text ?? ""; },
      vault: { session: async () => ({ vault: { id, hash: "h" } }), read: async () => v,
        lock: async () => v.vault }, retry: false },
    { localSources: async () => ({ files: [], memoryDir: null, guardsKey: false }) });
    try { await settle(); assert.equal(title.textContent, expected); }
    finally { handle.dispose(); host.remove(); }
  }
});

test("no vault's Satchel head carries a floor tooltip (the Custom flow is gone)", () => {
  const head = (id) => modify(id).querySelector('.runes-satchel > .runes-set-head');
  assert.equal(head("custom-abc123").title, "");
  assert.equal(head("main-claude").title, "");
  assert.equal(head("claude-variant").title, "");
});

test("Local Files rows tick and their heads count chosen over total", async () => {
  const host = document.createElement("div");
  const files = ["C:/proj/CLAUDE.md", "C:/proj/other.md", "C:/proj/third.md"].map((path) =>
    ({ path, shown: path, kind: "rules", scope: "project", ticked: false, pickable: true }));
  const handle = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare", start: "files", retry: false },
    { localSources: async () => ({ files, memoryDir: null, guardsKey: false }) });
  try {
    await settle();
    const read = () => {
      const group = host.querySelector('[data-kind="rules"]');
      return { count: group.querySelector(".runes-sc").textContent,
        box: group.querySelector(".runes-row > .runes-check"), row: group.querySelector(".rp-source") };
    };
    assert.equal(read().count, "0/3");
    read().row.click();
    assert.equal(read().count, "1/3");
    assert.equal(read().box.getAttribute("aria-checked"), "true");
    assert.ok(read().box.querySelector("svg"));
    read().box.click();
    assert.equal(read().count, "0/3");
    assert.equal(read().box.getAttribute("aria-checked"), "false");
  } finally { handle.dispose(); }
});
