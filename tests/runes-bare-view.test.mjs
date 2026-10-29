import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { mountBareView } = await import("../src/runes/bare/view.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const SET = { library: "kit", set: "kit" };
const rune = (id, rest = {}) => ({ set: SET, library: "kit", id, kind: "rule", activate: "always",
  description: id, section: ["Work"], recall: false, body: `Body of ${id}`, drift: false, ...rest });
const file = (path, kind, rest = {}) => ({ path, shown: path, kind, scope: "global", ticked: false, pickable: true, ...rest });

function harness({ headNote = undefined, locked = false, files = [], bundles = null, imported = [{ library: "kit", id: "imported", kind: "skill" }] } = {}) {
  const calls = [];
  const vault = { id: "daily", name: "Daily", hash: "abc", lockedUtc: locked ? "2026-10-25T00:00:00Z" : null,
    runesets: [{ source: SET, file: "kit.md", copiedUtc: "", sourceHash: "" }], runes: [], pins: {} };
  const view = { vault, runes: [rune("instruction")], warnings: [], drift: [] };
  const session = { vault: { id: "daily", hash: "abc" } };
  const vaultIo = {
    session: async () => { calls.push(["session"]); return session; },
    read: async (id, hash) => { calls.push(["read", id, hash]); return structuredClone(view); },
    lock: async (id, hash) => { calls.push(["lock", id, hash]); vault.lockedUtc = "now"; return vault; },
  };
  const vaultEdit = {
    current: async (id) => { calls.push(["current", id]); return structuredClone(vault); },
    currentView: async (id) => { calls.push(["currentView", id]); return structuredClone(view); },
    edit: async (args) => { calls.push(["edit", args]); return structuredClone(vault); },
    respawn: async () => { calls.push(["respawn"]); },
  };
  const io = {
    localSources: async () => ({ files, memoryDir: null, guardsKey: false }),
    moduleBundles: async () => bundles ?? { bundles: {}, warnings: [] },
    itemsImport: async (a) => { calls.push(["itemsImport", a]); return { runes: imported, dropped: [] }; },
    kitCreate: async () => ({ created: true, dropped: [] }),
    generate: async () => { throw Error("unused"); },
    generateCancel: async () => null,
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare",
    vault: vaultIo, vaultEdit, ...(headNote ? { headNote } : {}) }, io);
  return { calls, host, handle, view, vault, async modify() { await settle(); handle.modeButton.click(); await settle(); },
    dispose() { handle.dispose(); host.remove(); } };
}

test("View reads only the session vault revision and shows its rune", async () => {
  const h = harness();
  try {
    await settle();
    assert.deepEqual(h.calls.filter((c) => c[0] === "read"), [["read", "daily", "abc"]]);
    assert.ok(h.host.querySelector('[data-id="instruction"]'));
    assert.equal(h.host.querySelector('[data-id="instruction"] .runes-bare-switch'), null);
    assert.equal(h.host.querySelector(".runes-check, .runes-row, .has-check"), null, "read mode draws no checkbox");
    assert.equal(h.handle.modeButton.hidden, false);
    assert.equal(h.calls.some((c) => c[0] === "itemsImport"), false);
  } finally { h.dispose(); }
});

test("A session record written after the first read paints the vault and never No Vault Session", async () => {
  const h = harness();
  h.dispose();
  const host = document.createElement("div");
  document.body.appendChild(host);
  let n = 0;
  const seen = [];
  const vault = { id: "daily", name: "Daily", hash: "abc", lockedUtc: null,
    runesets: [{ source: SET, file: "kit.md", copiedUtc: "", sourceHash: "" }], runes: [], pins: {} };
  const view = { vault, runes: [rune("instruction")], warnings: [], drift: [] };
  const vaultIo = {
    session: async () => (++n < 2 ? null : { vault: { id: "daily", hash: "abc" } }),
    read: async () => structuredClone(view),
    lock: async () => vault,
  };
  const io = { localSources: async () => ({ files: [], memoryDir: null, guardsKey: false }),
    moduleBundles: async () => ({ bundles: {}, warnings: [] }) };
  const handle = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare", vault: vaultIo, retryMs: [5, 5] }, io);
  try {
    for (let i = 0; i < 20; i++) {
      seen.push(host.textContent.includes("No Vault Session"));
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.equal(seen.some(Boolean), false);
    assert.ok(host.querySelector('[data-id="instruction"]'));
  } finally { handle.dispose(); host.remove(); }
});

test("An absent session record shows No Vault Session once the backoff runs out", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const vaultIo = { session: async () => null, read: async () => { throw Error("unused"); }, lock: async () => null };
  const io = { localSources: async () => ({ files: [], memoryDir: null, guardsKey: false }),
    moduleBundles: async () => ({ bundles: {}, warnings: [] }) };
  const handle = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare", vault: vaultIo, retryMs: [2, 2] }, io);
  try {
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(host.textContent.includes("No Vault Session"));
  } finally { handle.dispose(); host.remove(); }
});

test("Make Variant hands its notice to the pane head, adds no body line, and Modify clears it", async () => {
  const notes = [];
  const h = harness({ locked: true, headNote: (t) => notes.push(t) });
  try {
    await h.modify();
    h.host.querySelector(".runes-set-head.has-check > .runes-check").click();
    await settle();
    [...h.host.querySelector(".runes-vault-choice").querySelectorAll("button")].find((b) => b.textContent === "Make Variant").click();
    await settle();
    assert.match(notes.at(-1) ?? "", /^Saved as .+\. New sessions can pick it\.$/);
    assert.equal(h.host.querySelector(".runes-bare-note"), null);
    h.handle.modeButton.click();
    await settle();
    assert.equal(notes.at(-1), null);
  } finally { h.dispose(); }
});

test("Modify's runeset switch edits the vault and respawns the tab", async () => {
  const h = harness();
  try {
    await h.modify();
    h.host.querySelector(".runes-set-head.has-check > .runes-check").click();
    await settle();
    assert.deepEqual(h.calls.find((c) => c[0] === "edit")[1].ops,
      [{ op: "removeRuneset", ref: SET }]);
    assert.ok(h.calls.some((c) => c[0] === "respawn"));
  } finally { h.dispose(); }
});

test("A locked vault waits for Make Variant before writing", async () => {
  const h = harness({ locked: true });
  try {
    await h.modify();
    h.host.querySelector(".runes-set-head.has-check > .runes-check").click();
    await settle();
    assert.equal(h.calls.some((c) => c[0] === "edit"), false);
    const choice = h.host.querySelector(".runes-vault-choice");
    assert.ok(choice);
    [...choice.querySelectorAll("button")].find((b) => b.textContent === "Make Variant").click();
    await settle();
    assert.equal(h.calls.find((c) => c[0] === "edit")[1].mode, "variant");
    assert.equal(h.calls.some((c) => c[0] === "respawn"), false, "the tab keeps its vault");
    assert.equal(h.host.querySelector(".runes-vault-choice"), null, "the choice is answered");
    assert.match(h.host.querySelector(".runes-bare-note")?.textContent ?? "", /^Saved as .+\. New sessions can pick it\.$/);
  } finally { h.dispose(); }
});

test("A local path tick imports item runes and submits member ops", async () => {
  const h = harness({ files: [file("C:/skills/review", "skill")],
    imported: [{ library: "kit", id: "review", kind: "skill" }] });
  try {
    await h.modify();
    h.host.querySelector('[data-path="C:/skills/review"]').click();
    await settle();
    assert.deepEqual(h.calls.find((c) => c[0] === "itemsImport")[1],
      { library: "kit", layer: { skills: ["C:/skills/review"] } });
    assert.deepEqual(h.calls.find((c) => c[0] === "edit")[1].ops,
      [{ op: "member", ref: { library: "kit", runeset: "kit",
        rune: { library: "kit", id: "review" }, on: true } }]);
  } finally { h.dispose(); }
});

test("A module tick imports its items and submits member ops", async () => {
  const h = harness({ bundles: { warnings: [], bundles: { notion: {
    mcp: [{ name: "notion", hasUrl: true, hasCommand: false }], skills: [], agents: [], guards: [],
  } } }, imported: [{ library: "kit", id: "notion-notion", kind: "mcp" }] });
  try {
    await h.modify();
    const head = h.host.querySelector('[data-module="notion"] > .runes-set-head');
    assert.equal(head.firstElementChild.className, "runes-check", "the module head's checkbox sits at its left");
    assert.equal(head.querySelector(".runes-cond").childElementCount, 0, "no switch left in the cond slot");
    head.firstElementChild.click();
    await settle();
    assert.deepEqual(h.calls.find((c) => c[0] === "itemsImport")[1],
      { library: "kit", layer: { modules: { notion: { off: [] } } } });
    assert.equal(h.calls.find((c) => c[0] === "edit")[1].ops[0].op, "member");
  } finally { h.dispose(); }
});
