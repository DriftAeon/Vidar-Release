import test from "node:test";
import assert from "node:assert/strict";
import { STARTER_TEMPLATES } from "../src/flow/templates.ts";
import { instantiateTemplate, adaptModelsToWired } from "../src/flow/store-core.ts";
import { validateGraph } from "../src/flow/validate.ts";
import { autoLayout } from "../src/flow/layout.ts";
import { prepareFlow, orderedNodes } from "../src/flow/control-core.ts";
import { flowCardRows } from "../src/control/flow-card.ts";
import { resolveNodeModes, modeFor } from "../src/flow/permission-mode.ts";

const sdk = () => "sdk";
const deps = () => ({ templates: STARTER_TEMPLATES, wiredIds: ["claude-sonnet-5", "claude-opus-5-5"], instantiateTemplate,
  adaptModelsToWired, validateGraph, autoLayout, now: () => "2026-10-18T00:00:00.000Z", newId: () => "graph-mode" });
const graph = () => prepareFlow({ action: "start", template_id: STARTER_TEMPLATES[0].id, input: "Go", cwd: "D:\\Work" }, deps());

test("the card shows each agent's effective mode and the spawn reads the same value", async () => {
  const g = graph();
  const asked = [];
  const modes = await resolveNodeModes(g, async (models) => { asked.push(models); return Object.fromEntries(models.map((m) => [m, m === "claude-opus-5-5" ? "acceptEdits" : "auto"])); }, sdk);
  const agents = orderedNodes(g).filter((n) => n.kind === "agent");
  const rows = flowCardRows(g, "Caller", orderedNodes, modes).filter(([k]) => k === "Permission Mode").map(([, v]) => v);
  const label = { default: "Default", acceptEdits: "Accept Edits", auto: "Auto" };
  assert.deepEqual(rows, agents.map((n) => label[modeFor(modes, n.id)]));
  assert.equal(asked.length, 1);
  assert.ok(rows.includes("Auto"));
  for (const n of agents) assert.equal(modes[n.id], n.model === "claude-opus-5-5" ? "acceptEdits" : "auto");
});

test("a failed lookup, an unknown value and a missing map all read Default", async () => {
  const g = graph();
  const failed = await resolveNodeModes(g, async () => { throw new Error("no"); }, sdk);
  const odd = await resolveNodeModes(g, async (models) => Object.fromEntries(models.map((m) => [m, "bypassPermissions"])), sdk);
  for (const modes of [failed, odd]) assert.ok(Object.values(modes).every((m) => m === "default"));
  assert.equal(flowCardRows(g, "Caller", orderedNodes).find(([k]) => k === "Permission Mode")[1], "Default");
  assert.equal(modeFor(undefined, "n1"), "default");
});
