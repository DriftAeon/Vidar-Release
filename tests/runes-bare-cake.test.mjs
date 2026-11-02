import test from "node:test";
import assert from "node:assert/strict";
import { bareViewKey, driftOf, itemBody, vaultLibraries } from "../src/runes/bare/cake.ts";

const set = { library: "installed", set: "installed" };
const rune = (library, id, o = {}) => ({ set: null, library, id, kind: "rule", activate: "always",
  description: "", section: [], recall: false, body: `${id} body`, drift: false, ...o });
const view = { runes: [
  rune("installed", "verdict", { set }),
  rune("base", "gate-fact", { set, kind: "fact" }),
  rune("installed", "tip", { set, recall: true, activate: "recall" }),
  rune("ops", "drive", { kind: "mcp", body: "", drift: true,
    item: { id: "drive", kind: "mcp", label: "MCP Server", description: "", requiredByVidar: false, envNames: ["TOKEN"] } }),
] };

test("Vault cards group runeset members and one-off runes in first-seen order", () => {
  const out = vaultLibraries(view);
  assert.deepEqual(out.map((l) => [l.library, l.bricks.map((b) => b.id),
    (l.onDemand ?? []).map((b) => b.id)]),
  [["installed", ["verdict", "gate-fact"], ["tip"]], ["ops", ["drive"], []]]);
  assert.deepEqual(out.flatMap((l) => l.bricks).filter(driftOf).map((b) => b.id), ["drive"]);
});

test("A vault card with an empty path keeps it empty, and a verbatim or slashed path becomes plain", () => {
  const out = vaultLibraries({ runes: [
    rune("installed", "none", { path: "" }),
    rune("installed", "verb", { path: "\\\\?\\C:\\lib\\verb.md" }),
    rune("installed", "slash", { path: "C:/lib/slash.md" }),
    rune("installed", "unc", { path: "\\\\?\\UNC\\srv\\share\\unc.md" }),
  ] }).flatMap((l) => l.bricks);
  assert.deepEqual(out.map((b) => b.path), ["", "C:\\lib\\verb.md", "C:\\lib\\slash.md", ""]);
});

test("Item cards show redacted names and no transport or environment values", () => {
  const body = itemBody({ id: "drive", kind: "mcp", label: "MCP Server", description: "",
    requiredByVidar: false, envNames: ["TOKEN"] });
  assert.equal(body, "MCP Server\n\nEnv: TOKEN");
  assert.ok(!JSON.stringify(vaultLibraries(view)).includes("secret-value"));
});

test("a Bare view is keyed by its tab", () => {
  assert.equal(bareViewKey("tab-1"), "tab|tab-1");
});
