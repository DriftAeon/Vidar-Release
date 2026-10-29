// Add Kit creates item runes and places its runeset in the focused session vault.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { mountBareView } = await import("../src/runes/bare/view.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const file = (path, kind, extra = {}) => ({ path, shown: path, kind, scope: "global", ticked: false, pickable: true, ...extra });
const sources = { memoryDir: null, guardsKey: false, files: [
  file("C:/home/.claude/skills/tidy", "skill"),
  file("C:/home/.claude/agents/helper.md", "agent"),
  file("C:/home/.claude/hooks/block.mjs", "hook", { guard: { event: "PreToolUse", matcher: "Bash", run: ["node", "C:/home/.claude/hooks/block.mjs"] } }),
  file("C:/home/.codex/skills/review", "skill", { agent: "codex" }),
  file("C:/home/.codex/agents/worker.toml", "agent", { agent: "codex" }),
  file("C:/home/.codex/hooks/check.mjs", "hook", { agent: "codex", guard: { event: "PreToolUse", matcher: "Bash", run: ["node", "C:/home/.codex/hooks/check.mjs"] } }),
] };
const KIT_OP = { op: "addRuneset", ref: { library: "kit", set: "kit" } };
const KIT_CODEX_OP = { op: "addRuneset", ref: { library: "kit", set: "kit-codex" } };

function mounted(agent, { local = sources, created = true, dropped = [], locked = false, start } = {}) {
  const calls = [];
  const vault = { version: 1, id: "v1", name: "Custom", createdUtc: "2026-10-25T00:00:00Z", from: null, runesets: [], runes: [],
    lockedUtc: locked ? "2026-10-25T00:01:00Z" : null, lockedBy: null, hash: "h1", pins: {} };
  const view = () => ({ vault: structuredClone(vault), drift: [], runes: [], warnings: [] });
  const io = {
    localSources: async () => local,
    kitSets: async () => [{ library: "kit", set: "kit" }, { library: "kit", set: "kit-codex" }],
    kitCreate: async (arg) => { calls.push(["kitCreate", arg]); if (created instanceof Error) throw created; return { created, dropped }; },
  };
  const vaultIo = {
    session: async () => ({ version: 1, createdUtc: "", agent, body: "rendered", tab: "t1", falconSession: null, threadId: null,
      vault: { id: "v1", hash: "h1" }, home: "", loadoutHash: "" }),
    read: async () => view(),
    lock: async () => vault,
  };
  const vaultEdit = {
    current: async () => structuredClone(vault),
    currentView: async () => view(),
    edit: async (a) => {
      calls.push(["edit", a]);
      if (vault.lockedUtc && a.mode === "unlocked") throw new Error("vault \"v1\" is locked");
      return { ...structuredClone(vault), id: a.mode === "variant" ? "v2" : "v1" };
    },
    respawn: async () => { calls.push(["respawn"]); },
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  io.generate = async (a) => { calls.push(["generate", a]); return { library: "gen-claude-0a1b2c3d", set: "gen", runes: 1, on: 1,
    encodedChars: null, costUsd: null, inputTokens: 10, outputTokens: 5, durationMs: 1000, warnings: [] }; };
  io.generateCancel = async () => null;
  const gen = { models: [{ value: "claude-sonnet-5", label: "Sonnet 5" }] };
  const handle = mountBareView(host, { agent, cwd: "C:/work", profile: "bare", vault: vaultIo, vaultEdit, gen: () => gen, ...(start ? { start } : {}) }, io);
  const modify = async () => { handle.modeButton.click(); await settle(); };
  return { host, calls, modify, dispose: () => { handle.dispose(); host.remove(); } };
}
const button = (host, text) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);

for (const agent of ["claude", "codex"]) {
  test(`Add Kit on ${agent} creates item runes and adds kit/kit to the vault`, async () => {
    const m = mounted(agent);
    await settle(); await m.modify();
    const add = button(m.host, "Add Kit");
    assert.ok(add, "a vault tab's Modify offers Add Kit");
    add.click();
    await settle();
    assert.deepEqual(m.calls.map(([name]) => name), ["kitCreate", "edit", "respawn"]);
    assert.deepEqual(m.calls[1][1], { id: "v1", ops: agent === "codex" ? [KIT_OP, KIT_CODEX_OP] : [KIT_OP], mode: "unlocked" });
    const layer = m.calls[0][1].layer;
    assert.deepEqual(layer.skills, ["C:/home/.claude/skills/tidy", "C:/home/.codex/skills/review"]);
    assert.deepEqual(layer.agents, ["C:/home/.claude/agents/helper.md"]);
    assert.equal(layer.guards.length, 1);
    assert.equal("codexSkills" in layer, false);
    assert.deepEqual(layer.codexAgents, ["C:/home/.codex/agents/worker.toml"]);
    assert.equal(layer.codexGuards.length, 1);
    m.dispose();
  });
}

test("an empty Local Files view offers Add Kit and an existing Kit reports Kit Attached", async () => {
  // a vault tab reaches Local Files through the entry's `start` (its View draws the vault, with no Create Runes)
  const m = mounted("claude", { local: { memoryDir: null, guardsKey: false, files: [] }, created: false, start: "files" });
  await settle();
  assert.equal(m.host.querySelector(".rp-actions button")?.textContent, "Add Kit");
  m.host.querySelector(".rp-actions button").click();
  await settle();
  assert.deepEqual(m.calls[0][1], { layer: {} });
  assert.match(m.host.textContent, /Kit Attached/);
  m.dispose();
});

test("dropped config items leave a success chip with the skipped count", async () => {
  const m = mounted("claude", { dropped: [{ id: "agents/bad.md", reason: "Invalid agent" }] });
  await settle(); await m.modify();
  button(m.host, "Add Kit").click();
  await settle();
  assert.equal([...m.host.querySelectorAll(".runes-chip")].find((c) => c.textContent === "Kit")?.title, "Add Kit · 1 Skipped");
  m.dispose();
});

test("a failed create shows Add Kit Failed and edits no vault", async () => {
  const m = mounted("claude", { created: new Error("create refused") });
  await settle(); await m.modify();
  button(m.host, "Add Kit").click();
  await settle();
  assert.deepEqual(m.calls.map(([name]) => name), ["kitCreate"]);
  const error = m.host.querySelector(".rp-error");
  assert.equal(error?.textContent, "Add Kit Failed");
  assert.match(error?.title ?? "", /create refused/);
  m.dispose();
});

test("Add Kit on a locked vault sends no edit until Make Variant, which leaves the tab on its vault", async () => {
  const m = mounted("claude", { locked: true });
  await settle(); await m.modify();
  button(m.host, "Add Kit").click();
  await settle();
  assert.deepEqual(m.calls.map(([name]) => name), ["kitCreate"], "a locked vault is never edited before the pick");
  const card = m.host.querySelector(".blk-notice-card");
  assert.ok(card, "the choice card is up");
  assert.equal(card.querySelector(".blk-notice").textContent,
    "This vault is locked. Earlier sessions on this vault become invalid. Edit Original restarts this tab on the edited vault.");
  assert.ok(button(card, "Edit Original"));
  button(card, "Make Variant").click();
  await settle();
  assert.deepEqual(m.calls.slice(1), [["edit", { id: "v1", ops: [KIT_OP], mode: "variant" }]], "Make Variant neither moves nor respawns the tab");
  assert.ok(!m.host.querySelector(".blk-notice-card"), "the card leaves once the pick lands");
  assert.ok(!m.calls.some(([name]) => name === "rowSetAppend"), "no launcher row is written");
  m.dispose();
});

test("Edit Original on a locked vault edits in place with mode invalidate, then respawns the tab", async () => {
  const m = mounted("claude", { locked: true });
  await settle(); await m.modify();
  button(m.host, "Add Kit").click();
  await settle();
  button(m.host.querySelector(".blk-notice-card"), "Edit Original").click();
  await settle();
  assert.deepEqual(m.calls.slice(1), [["edit", { id: "v1", ops: [KIT_OP], mode: "invalidate" }], ["respawn"]]);
  m.dispose();
});

test("Add to Vault on the generate Done line adds the generated runeset to the tab's vault", async () => {
  const ticked = { memoryDir: null, guardsKey: false, files: [file("C:/work/CLAUDE.md", "rules", { ticked: true, library: "work-claude-md", scope: "project" })] };
  const m = mounted("claude", { local: ticked, start: "files" });
  await settle();
  const g = button(m.host, "Generate");
  assert.ok(!g.disabled, "a ticked rules file enables Generate");
  g.click();
  await settle();
  const add = button(m.host, "Add to Vault");
  assert.ok(add, "the Done line offers Add to Vault");
  assert.ok(add.classList.contains("ws-btn"));
  add.click();
  await settle();
  assert.deepEqual(m.calls.filter(([n]) => n === "edit").map(([, a]) => a),
    [{ id: "v1", ops: [{ op: "addRuneset", ref: { library: "gen-claude-0a1b2c3d", set: "gen" } }], mode: "unlocked" }]);
  assert.ok(!button(m.host, "Add to Vault"), "the button leaves once the add landed");
  m.dispose();
});

