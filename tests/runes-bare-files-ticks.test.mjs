import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { importMembers } = await import("../src/runes/bare/set-attach.ts");
const { itemRuneInputs, kitItems } = await import("../src/runes/bare/kit-add.ts");
const { moduleLayer } = await import("../src/runes/bare/module-ticks.ts");
const file = (path, kind, rest = {}) => ({ path, shown: path, kind, scope: "global",
  ticked: true, pickable: true, ...rest });

test("Path ticks turn into item-rune inputs without a sidecar write", () => {
  const files = [file("C:/skills/review", "skill", { agent: "codex" }),
    file("C:/agents/check.toml", "agent", { agent: "codex" })];
  assert.deepEqual(itemRuneInputs(files, new Set(files.map((f) => f.path)), null, true),
    { skills: ["C:/skills/review"], codexAgents: ["C:/agents/check.toml"] });
  assert.deepEqual(kitItems(files, null), { skills: ["C:/skills/review"],
    codexAgents: ["C:/agents/check.toml"] });
});

test("A command hook value never enters item import arguments", () => {
  const f = file("C:/hooks/probe", "hook", { guard: { event: "Stop", command: "secret-value" } });
  assert.deepEqual(itemRuneInputs([f], new Set([f.path]), null, false), {});
});

test("Module import inputs exclude hidden agent items and unselected siblings", () => {
  const bundle = { mcp: [{ name: "visible" }, { name: "claude-only", agents: ["claude"] }],
    skills: ["modules/review"], agents: [], guards: [{ event: "Stop", run: ["hooks/check.mjs"] }] };
  assert.deepEqual(moduleLayer("audit", bundle, ["mcp:visible"]), { modules: { audit: { off: [
    "mcp:claude-only", "skill:review", "guard:Stop||check.mjs",
  ] } } });
});

test("A member off edit uses only refs already in the vault copy", async () => {
  const ops = [];
  const io = { itemsImport: async () => ({ runes: [
    { library: "kit", id: "there", kind: "skill" }, { library: "kit", id: "absent", kind: "skill" },
  ], dropped: [] }) };
  await importMembers(io, { library: "kit", set: "kit" }, { skills: ["C:/skills/review"] }, false,
    [{ library: "kit", id: "there" }], async (next) => { ops.push(...next); });
  assert.deepEqual(ops, [{ op: "member", ref: { library: "kit", runeset: "kit",
    rune: { library: "kit", id: "there" }, on: false } }]);
});

test("A member off edit can remove a cross-library slot", async () => {
  const edits = [];
  const io = { itemsImport: async () => ({ runes: [{ library: "kit", id: "review", kind: "skill" }], dropped: [] }) };
  const existing = { library: "shared", id: "review", kind: "skill" };
  await importMembers(io, { library: "kit", set: "kit" }, { skills: ["C:/skills/review"] }, false,
    [existing], async (ops) => { edits.push(...ops); }, [existing]);
  assert.deepEqual(edits[0].ref.rune, { library: "shared", id: "review" });
});
