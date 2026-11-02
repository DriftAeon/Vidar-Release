import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({ answers: { rune_vault_library_runes: { runes: [], warnings: [] } } });
const { mountBareView } = await import("../src/runes/bare/view.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const SET = { library: "installed", set: "installed" };
const rune = (id, rest = {}) => ({ set: SET, library: "installed", id, kind: "rule", activate: "always",
  description: id, section: ["Work"], recall: false, body: `Body of ${id}`, drift: false, ...rest });

function harness({ headNote = undefined, locked = false, files = [], bundles = null,
  library = [], editFails = null } = {}) {
  const calls = [];
  dom.ipc.answers.rune_vault_library_runes = { runes: library, warnings: [] };
  const vault = { id: "daily", name: "Daily", hash: "abc", lockedUtc: locked ? "2026-10-25T00:00:00Z" : null,
    runesets: [{ source: SET, file: "installed.md", copiedUtc: "", sourceHash: "" }], runes: [], pins: {} };
  const view = { vault, runes: [rune("instruction")], warnings: [], drift: [] };
  const session = { vault: { id: "daily", hash: "abc" } };
  const vaultIo = {
    session: async () => { calls.push(["session"]); return session; },
    read: async (id, hash) => { calls.push(["read", id, hash]); return structuredClone(view); },
    lock: async (id, hash) => { calls.push(["lock", id, hash]); vault.lockedUtc = "now"; return vault; },
  };
  const vaultEdit = {
    read: async (id) => { calls.push(["current", id]); return structuredClone(view); },
    edit: async (args) => { calls.push(["edit", args]); if (editFails) throw new Error(editFails); return structuredClone(vault); },
    respawn: async () => { calls.push(["respawn"]); },
  };
  const io = {
    localSources: async () => ({ files, memoryDir: null, guardsKey: false }),
    moduleBundles: async () => bundles ?? { bundles: {}, warnings: [] },
    generate: async () => { throw Error("unused"); },
    generateCancel: async () => null,
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare",
    vault: vaultIo, vaultEdit, ...(headNote ? { headNote } : {}) }, io);
  return { calls, host, handle, view, vault, async modify() { await settle(); handle.modeButton.click(); await settle(); },
    async done() { handle.modeButton.click(); await settle(); },
    edits: () => calls.filter((c) => c[0] === "edit"),
    dispose() { handle.dispose(); host.remove(); } };
}

test("Modify and Done carry their own tooltips; Lock reads Lock on an unlocked vault", async () => {
  const h = harness();
  try {
    await settle();
    assert.equal(h.handle.modeButton.title, "Opens this tab's vault for changes.");
    assert.equal(h.handle.lockButton.textContent, "Lock");
    assert.equal(h.handle.lockButton.disabled, false);
    h.handle.modeButton.click();
    await settle();
    assert.equal(h.handle.modeButton.textContent, "Done");
    assert.equal(h.handle.modeButton.title, "Changes this tab's vault; before the vault locks, the tab restarts as a fresh session.");
  } finally { h.dispose(); }
});

test("A locked vault's Locked control says why; an unlocked one keeps the Lock tooltip", async () => {
  const locked = harness({ locked: true });
  const open = harness();
  try {
    await settle();
    assert.equal(locked.handle.lockButton.textContent, "Locked");
    assert.equal(locked.handle.lockButton.title, "An earlier session or run locked this vault; a change offers Make Variant or Edit Original.");
    assert.equal(open.handle.lockButton.title, "Locks this tab's vault now; the first message locks it too.");
  } finally { locked.dispose(); open.dispose(); }
});

test("View reads only the session vault revision and shows its rune", async () => {
  const h = harness();
  try {
    await settle();
    assert.deepEqual(h.calls.filter((c) => c[0] === "read"), [["read", "daily", "abc"]]);
    assert.ok(h.host.querySelector('[data-id="instruction"]'));
    assert.equal(h.host.querySelector('[data-id="instruction"] .runes-bare-switch'), null);
    assert.equal(h.host.querySelector(".runes-check, .runes-row, .has-check"), null, "read mode draws no checkbox");
    assert.equal(h.handle.modeButton.hidden, false);
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
    runesets: [{ source: SET, file: "installed.md", copiedUtc: "", sourceHash: "" }], runes: [], pins: {} };
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
    await h.done();
    [...h.host.querySelector(".runes-vault-choice").querySelectorAll("button")].find((b) => b.textContent === "Make Variant").click();
    await settle();
    assert.match(notes.at(-1) ?? "", /^Saved as .+\. New sessions can pick it\.$/);
    assert.equal(h.handle.modeButton.textContent, "Modify", "a landed pick closes Modify");
    assert.equal(h.host.querySelector(".runes-bare-note"), null);
    h.handle.modeButton.click();
    await settle();
    assert.equal(notes.at(-1), null);
  } finally { h.dispose(); }
});

test("Modify's switches stage: no edit until Done, then one edit, a respawn, and Modify closes", async () => {
  const h = harness();
  try {
    await h.modify();
    assert.equal(h.handle.cancelButton.hidden, false, "Cancel shows in Modify");
    assert.equal(h.handle.lockButton.hidden, true, "Lock hides in Modify");
    // Done is a plain button: no aria-pressed, so .ws-btn[aria-pressed="true"] never paints it lit through Modify
    assert.equal(h.handle.modeButton.hasAttribute("aria-pressed"), false, "Done carries no pressed state");
    const box = () => h.host.querySelector(".runes-set-head.has-check > .runes-check");
    box().click();
    await settle();
    assert.equal(h.edits().length, 0, "a switch sends nothing");
    assert.equal(box().getAttribute("aria-checked"), "false");
    assert.ok(box().classList.contains("is-pending"), "the staged box carries the pending mark");
    await h.done();
    assert.equal(h.edits().length, 1);
    assert.deepEqual(h.edits()[0][1].ops, [{ op: "removeRuneset", ref: SET }]);
    assert.ok(h.calls.some((c) => c[0] === "respawn"));
    assert.equal(h.handle.modeButton.textContent, "Modify");
    assert.equal(h.handle.cancelButton.hidden, true);
  } finally { h.dispose(); }
});

test("Done with nothing staged closes Modify and sends nothing", async () => {
  const h = harness();
  try {
    await h.modify();
    const before = h.calls.length;
    await h.done();
    assert.equal(h.edits().length, 0);
    assert.equal(h.calls.slice(before).some((c) => c[0] === "current"), false, "no IPC at all");
    assert.equal(h.handle.modeButton.textContent, "Modify");
  } finally { h.dispose(); }
});

test("Cancel drops the staged changes and sends nothing", async () => {
  const h = harness();
  try {
    await h.modify();
    h.host.querySelector(".runes-set-head.has-check > .runes-check").click();
    await settle();
    const before = h.calls.length;
    h.handle.cancelButton.click();
    await settle();
    assert.equal(h.calls.length, before, "Cancel makes no call");
    assert.equal(h.handle.modeButton.textContent, "Modify");
    await h.modify();
    assert.equal(h.host.querySelector(".runes-set-head.has-check > .runes-check").getAttribute("aria-checked"), "true", "nothing carried over");
  } finally { h.dispose(); }
});

test("A refused Done keeps Modify and its staged changes, the error on the error line", async () => {
  const h = harness({ editFails: "store said no" });
  try {
    await h.modify();
    h.host.querySelector(".runes-set-head.has-check > .runes-check").click();
    await settle();
    await h.done();
    assert.equal(h.edits().length, 1);
    assert.equal(h.handle.modeButton.textContent, "Done", "Modify stays");
    const err = h.host.querySelector(".rp-error");
    assert.match(`${err?.textContent} ${err?.title}`, /store said no/);
    assert.ok(h.host.querySelector(".runes-set-head.has-check > .runes-check").classList.contains("is-pending"), "the change is kept");
  } finally { h.dispose(); }
});

test("Rune Library rows stage a one-off add and keep their order across a flip", async () => {
  const lib = (id) => ({ ...rune(id), set: null });
  const h = harness({ library: [lib("zeta"), lib("alpha"), lib("mid")] });
  try {
    await h.modify();
    const pane = h.handle.libraryRoot;
    assert.equal(pane.hidden, false);
    assert.equal(pane.querySelector(".runes-lib-title").textContent, "Rune Library");
    const order = () => [...pane.querySelectorAll(".runes-row [data-id]")].map((d) => d.dataset.id);
    const first = order();
    assert.deepEqual(first, ["alpha", "mid", "zeta"]);
    pane.querySelector('.runes-row:has([data-id="zeta"]) > .runes-check').click();
    await settle();
    assert.deepEqual(order(), first, "a flip never moves a row");
    assert.ok(pane.querySelector('.runes-row:has([data-id="zeta"]) > .runes-check.is-pending'));
    assert.equal(h.edits().length, 0);
    await h.done();
    assert.deepEqual(h.edits()[0][1].ops, [{ op: "addRune", ref: { library: "installed", id: "zeta" } }]);
    assert.equal(pane.hidden, true, "the library leaves with Modify");
  } finally { h.dispose(); }
});

test("A locked vault parks the batched ops on the choice card until Make Variant", async () => {
  const h = harness({ locked: true });
  try {
    await h.modify();
    h.host.querySelector(".runes-set-head.has-check > .runes-check").click();
    await settle();
    await h.done();
    assert.equal(h.edits().length, 0);
    const choice = h.host.querySelector(".runes-vault-choice");
    assert.ok(choice);
    assert.equal(h.handle.modeButton.textContent, "Done", "Modify stays while the card asks");
    assert.equal(h.host.querySelector(".runes-set-head.has-check > .runes-check").disabled, true, "the boxes hold still");
    [...choice.querySelectorAll("button")].find((b) => b.textContent === "Make Variant").click();
    await settle();
    assert.equal(h.edits()[0][1].mode, "variant");
    assert.deepEqual(h.edits()[0][1].ops, [{ op: "removeRuneset", ref: SET }]);
    assert.equal(h.calls.some((c) => c[0] === "respawn"), false, "the tab keeps its vault");
    assert.equal(h.host.querySelector(".runes-vault-choice"), null, "the choice is answered");
    assert.match(h.host.querySelector(".runes-bare-note")?.textContent ?? "", /^Saved as .+\. New sessions can pick it\.$/);
  } finally { h.dispose(); }
});

