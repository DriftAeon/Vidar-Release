import test from "node:test";
import assert from "node:assert/strict";
import { agentFiles, codexTicks, createBareFlow, defaultTicks, classifyGenError } from "../src/runes/bare/flow.ts";

const file = (path, kind, rest = {}) => ({ path, shown: path, kind, scope: "global", ticked: true, pickable: true, ...rest });
const io = {
  localSources: async () => ({ files: [], memoryDir: null, guardsKey: false }),
  itemsImport: async () => ({ runes: [], dropped: [] }),
  generate: async (a) => ({ library: "gen", set: "set", runes: a.paths.length, on: 1,
    encodedChars: null, costUsd: null, inputTokens: null, outputTokens: null, durationMs: 1, warnings: [] }),
  generateCancel: async () => null,
};

test("Load reads the session's pinned vault revision and has no launcher fallback", async () => {
  const calls = [];
  const flow = createBareFlow(io, {
    cwd: "C:/proj",
    session: async () => ({ vault: { id: "daily", hash: "abc123" } }),
    read: async (id, hash) => { calls.push([id, hash]); return { vault: { id }, runes: [], warnings: [], drift: [] }; },
  });
  assert.equal((await flow.load()).view.vault.id, "daily");
  assert.deepEqual(calls, [["daily", "abc123"]]);
  const noRecord = createBareFlow(io, { cwd: "C:/proj", session: async () => null,
    read: async () => assert.fail("no vault should be read") });
  assert.equal(await noRecord.load(), null);
});

test("Generate sends ticked rule paths and item-rune inputs without a row key", async () => {
  let sent;
  const flow = createBareFlow({ ...io, generate: async (a) => { sent = a; return io.generate(a); } },
    { cwd: "C:/proj", codex: true });
  const sources = { memoryDir: null, guardsKey: false, files: [
    file("C:/proj/AGENTS.md", "rules"),
    file("C:/skills/one", "skill", { agent: "codex" }),
    file("C:/agents/test.toml", "agent", { agent: "codex" }),
  ] };
  const r = await flow.generateAgent({ sources, ticked: new Set(sources.files.map((f) => f.path)),
    model: "gpt", effort: "medium", effortLevels: ["medium"] });
  assert.equal(r.state, "done");
  assert.deepEqual(sent.paths, ["C:/proj/AGENTS.md"]);
  assert.deepEqual(sent.items, [{ kind: "skill", path: "C:/skills/one" }, { kind: "agent", path: "C:/agents/test.toml" }]);
  assert.equal(sent.mergeEffort, "medium");
  assert.equal("rowKey" in sent, false);
});

test("Local source preselection and errors remain agent scoped", () => {
  const shared = file("/hook", "hook", { codexSupported: true });
  const claude = file("/claude", "skill", { agent: "claude" });
  const codex = file("/codex", "skill", { agent: "codex" });
  assert.deepEqual(agentFiles([shared, claude, codex], true), [shared, codex]);
  assert.deepEqual(defaultTicks([claude]).has("/claude"), true);
  assert.deepEqual(codexTicks([file("/AGENTS.md", "rules")]).has("/AGENTS.md"), true);
  assert.deepEqual(classifyGenError("invalid: bad"), { state: "rejected", error: "bad" });
});
