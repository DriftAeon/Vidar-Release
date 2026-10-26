import test from "node:test";
import assert from "node:assert/strict";
import { bareViewKey, driftOf, itemBody, readSessionVault, vaultLibraries } from "../src/runes/bare/cake.ts";

const set = { library: "kit", set: "kit" };
const rune = (library, id, o = {}) => ({ set: null, library, id, kind: "rule", activate: "always",
  description: "", section: [], recall: false, body: `${id} body`, drift: false, ...o });
const view = { runes: [
  rune("kit", "verdict", { set }),
  rune("stock", "gate-fact", { set, kind: "fact" }),
  rune("kit", "tip", { set, recall: true, activate: "recall" }),
  rune("ops", "drive", { kind: "mcp", body: "", drift: true,
    item: { id: "drive", kind: "mcp", label: "MCP Server", description: "", requiredByVidar: false, envNames: ["TOKEN"] } }),
] };

test("Vault cards group runeset members and one-off runes in first-seen order", () => {
  const out = vaultLibraries(view);
  assert.deepEqual(out.map((l) => [l.library, l.bricks.map((b) => b.id),
    (l.onDemand ?? []).map((b) => b.id)]),
  [["kit", ["verdict", "gate-fact"], ["tip"]], ["ops", ["drive"], []]]);
  assert.deepEqual(out.flatMap((l) => l.bricks).filter(driftOf).map((b) => b.id), ["drive"]);
});

test("Item cards show redacted names and no transport or environment values", () => {
  const body = itemBody({ id: "drive", kind: "mcp", label: "MCP Server", description: "",
    requiredByVidar: false, envNames: ["TOKEN"] });
  assert.equal(body, "MCP Server\n\nEnv: TOKEN");
  assert.ok(!JSON.stringify(vaultLibraries(view)).includes("secret-value"));
});

test("Session View reads the hash its session loaded and stops without a record", async () => {
  const calls = [];
  const io = { session: async () => ({ vault: { id: "daily", hash: "abc" } }),
    read: async (id, hash) => { calls.push([id, hash]); return view; },
    lock: async () => ({}) };
  assert.equal((await readSessionVault(io)).view, view);
  assert.deepEqual(calls, [["daily", "abc"]]);
  assert.equal(await readSessionVault({ ...io, session: async () => null }), null);
  assert.equal(bareViewKey("tab-1"), "tab|tab-1");
});
