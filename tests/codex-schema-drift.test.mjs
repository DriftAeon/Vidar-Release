// The committed manifest is the sole schema input: no CLI, network, or refresh here.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { KNOWN_NOTIFICATIONS, REFUSALS, SERVER_REQUESTS, UNSUPPORTED } from "../src/agents/codex-methods.ts";
import { contract, diffMethods, GROUPS } from "../tools/codex-schema/manifest.mjs";
import { missingInputs, guard } from "./helpers/optional-input.mjs";

const skipValidate = missingInputs(import.meta.url, "../tools/codex-schema/validate.mjs");
const { assertSupported, matches } = skipValidate ? {} : await import("../tools/codex-schema/validate.mjs");
const testV = guard(test, skipValidate);

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../tools/codex-schema/manifest.json"));
const names = (entries) => entries.map((entry) => entry.method).sort();
const handlerFile = existsSync(new URL("../src/agents/codex-requests.ts", import.meta.url))
  ? "../src/agents/codex-requests.ts" : "../src/agents/codex.ts";
const handler = read(handlerFile);
// Read only request classification, excluding answer branches and notifications.
const requestBody = handlerFile.endsWith("codex-requests.ts")
  ? handler.split("  request(")[1]?.split("  answer(")[0]
  : handler.split("  private serverRequest(")[1]?.split("  private notification(")[0];
assert.ok(requestBody, "Cannot locate the adapter's request classifier");
const cards = [...requestBody.matchAll(/(?:case "|if \(method === ")([^"]+)"/g)].map((match) => match[1]);
const refresh = "Run node tools/codex-schema/refresh.mjs and review adapter impact";

test("pinned notification and request tables cover the generated protocol exactly", () => {
  assert.equal(manifest.format, 1);
  assert.equal(manifest.experimental, true);
  const pin = read("../src/agents/codex-methods.ts").match(/pinned from the ([\d.]+) schema/)?.[1];
  assert.equal(pin, manifest.codexVersion, refresh);
  for (const group of GROUPS) {
    assert.ok(manifest[group].length > 0, `${group} must not be empty`);
    assert.equal(new Set(names(manifest[group])).size, manifest[group].length, `${group} has duplicates`);
  }
  assert.deepEqual([...KNOWN_NOTIFICATIONS].sort(), names(manifest.notifications), refresh);
  assert.ok(cards.length >= 2, "No approval request handlers found");
  assert.deepEqual([...new Set([...cards, ...Object.keys(REFUSALS)])].sort(), names(manifest.serverRequests), refresh);
});

test("the shared server-request table names every pinned request once, and cards match the handler", () => {
  const table = JSON.parse(read("../contracts/codex-server-requests.json"));
  assert.equal(table.codexVersion, manifest.codexVersion, refresh);
  assert.deepEqual(Object.keys(SERVER_REQUESTS).sort(), names(manifest.serverRequests), refresh);
  const drawn = Object.entries(SERVER_REQUESTS).filter(([, entry]) => entry.disposition === "card").map(([method]) => method);
  assert.deepEqual(drawn.sort(), [...new Set(cards)].sort(), "card dispositions must be the handler's drawn cards");
  for (const [method, entry] of Object.entries(SERVER_REQUESTS)) {
    assert.ok(["card", "refuse", "error"].includes(entry.disposition), `${method}: unknown disposition`);
    if (entry.disposition === "refuse") assert.ok(entry.refusal, `${method}: a refuse disposition needs a refusal`);
    // Falcon's unattended deny answers a card with its refusal (approvals.rs).
    if (entry.disposition === "card") assert.ok(entry.refusal, `${method}: a card needs a deny refusal`);
    if (entry.disposition === "error") assert.equal(entry.refusal, undefined, `${method}: an error carries no refusal`);
  }
  // Unknown methods get the same error in-process (codex.ts respondError) and hosted (requests.rs).
  assert.equal(UNSUPPORTED.code, -32601);
  assert.match(read("../src/agents/codex.ts"), new RegExp(`error: \\{ code: ${UNSUPPORTED.code}, message \\}`));
  assert.ok(UNSUPPORTED.message.includes("{method}"));
});

testV("every contract refusal satisfies its generated response contract", () => {
  const response = (method) => manifest.serverRequests.find((entry) => entry.method === method).response;
  const refused = Object.entries(SERVER_REQUESTS).filter(([, entry]) => entry.refusal);
  assert.ok(refused.length > 0, "the table has no refusals");
  for (const [method, { refusal }] of refused) {
    assert.ok(matches(response(method), refusal), `${method} contract refusal no longer matches Codex ${manifest.codexVersion}`);
  }
});

test("adapter-originated literal requests still exist in the pinned client protocol", () => {
  const known = new Set(names(manifest.clientRequests));
  const directory = new URL("../src/agents/", import.meta.url);
  const called = new Set();
  for (const name of readdirSync(directory).filter((name) => /^codex.*\.ts$/.test(name))) {
    const source = readFileSync(new URL(name, directory), "utf8");
    for (const match of source.matchAll(/\b(?:request|rpc)\("([^"]+)"/g)) called.add(match[1]);
  }
  assert.ok(called.size > 0, "No adapter requests found");
  for (const method of called) assert.ok(known.has(method), `${method} was removed or renamed; ${refresh}`);
});

testV("every non-error refusal satisfies its generated response contract", () => {
  for (const { method, response } of manifest.serverRequests) {
    assertSupported(response);
    const refusal = REFUSALS[method];
    if (refusal !== undefined && refusal !== "rpc-error") {
      assert.ok(matches(response, refusal), `${method} refusal no longer matches Codex ${manifest.codexVersion}`);
    }
  }
});

testV("answers Vidar sends for drawn cards satisfy their generated response contracts", (t) => {
  if (!handlerFile.endsWith("codex-requests.ts")) return t.skip("codex-requests.ts is absent");
  const response = (method) => manifest.serverRequests.find((entry) => entry.method === method).response;
  // Fixtures mirror src/agents/codex-requests.ts answer(), lines ~66-76.
  const permissions = { network: { enabled: true } };
  const answers = {
    "item/tool/requestUserInput": [{ answers: { q1: { answers: ["Yes"] } } }, { answers: {} }],
    "item/permissions/requestApproval": [{ permissions, scope: "turn" }, { permissions: {}, scope: "turn" }],
    "item/commandExecution/requestApproval": [{ decision: "accept" }, { decision: "decline" }],
    "item/fileChange/requestApproval": [{ decision: "accept" }, { decision: "decline" }],
  };
  for (const [method, [allow, deny]] of Object.entries(answers)) {
    assert.ok(cards.includes(method), `${method} is no longer a drawn card`);
    assert.ok(matches(response(method), allow), `${method} allow answer no longer matches ${manifest.codexVersion}`);
    assert.ok(matches(response(method), deny), `${method} deny answer no longer matches ${manifest.codexVersion}`);
  }
});

testV("the gate rejects unsafe or malformed refusals across response unions and references", () => {
  const response = (method) => manifest.serverRequests.find((entry) => entry.method === method).response;
  assert.equal(matches(response("applyPatchApproval"), { decision: "decline" }), false);
  assert.equal(matches(response("applyPatchApproval"), { decision: "denied" }), false);
  assert.equal(matches(response("execCommandApproval"), {}), false);
  assert.equal(matches(response("item/tool/requestUserInput"), { answers: { question: { answers: 7 } } }), false);
  assert.equal(matches(response("mcpServer/elicitation/request"), { action: "denied" }), false);
  assert.equal(matches(response("item/permissions/requestApproval"), { permissions: {}, scope: "forever" }), false);
  assert.equal(matches(response("item/tool/call"), { contentItems: [{ type: "inputText", text: 7 }], success: false }), false);
  assert.throws(() => assertSupported({ type: "object", futureConstraint: true }), /Unsupported/);
  assert.throws(() => assertSupported({ $ref: "#/definitions/Missing" }), /Unresolved/);
});

testV("trimming keeps validation and data names, pruning descriptions and unreachable definitions", () => {
  const schema = { title: "Example", type: "object", properties: { description: { $ref: "#/definitions/Used" } },
    required: ["description"], definitions: { Used: { type: "string", enum: ["denied"], description: "Docs" },
      Unused: { type: "number" } } };
  const trimmed = contract(schema);
  assert.deepEqual(Object.keys(trimmed.definitions), ["Used"]);
  assert.equal(trimmed.title, undefined);
  assert.equal(trimmed.definitions.Used.description, undefined);
  assert.ok(matches(trimmed, { description: "denied" }));
  assert.equal(matches(trimmed, { description: "accept" }), false);
  assert.equal(JSON.stringify(contract(trimmed)), JSON.stringify(trimmed));
  assert.throws(() => contract({ $ref: "#/definitions/Absent" }), /Unresolved/);
});

test("refresh diff distinguishes additions, removals, contract changes and possible renames", () => {
  const base = Object.fromEntries(GROUPS.map((group) => [group, []]));
  const before = { ...base, notifications: [{ method: "old", paramsType: "Same", paramsSha256: "a" },
    { method: "kept", paramsType: "Kept", paramsSha256: "a" }] };
  const after = { ...base, notifications: [{ method: "new", paramsType: "Same", paramsSha256: "a" },
    { method: "kept", paramsType: "Kept", paramsSha256: "b" }] };
  assert.deepEqual(diffMethods(before, after).notifications, { added: ["new"], removed: ["old"],
    changed: ["kept"], possibleRenames: [{ from: "old", to: "new" }] });
});
