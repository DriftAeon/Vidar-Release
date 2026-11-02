// Hermetic: no Codex spawn. sameSurface ignores only the version; mergeAccepted keeps other keys.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { breakingChanges, sameSurface } from "../tools/codex-schema/manifest.mjs";
import { mergeAccepted, verdict } from "../tools/codex-schema/verify.mjs";

const manifest = JSON.parse(readFileSync(new URL("../tools/codex-schema/manifest.json", import.meta.url), "utf8"));

/** A one-method-per-group manifest whose shapes are `client` (sent), `note` (read) and `ask`/`answer`. */
function tiny({ client, note, ask = { type: "object" }, answer = { type: "object" }, called = ["turn/start"], extra = {} }) {
  // The stand-in hash covers the definitions too, as the real contract hash does.
  const entry = (method, shape) => ({ method, paramsType: null, paramsSha256: JSON.stringify([shape, extra.definitions]) });
  return {
    format: 1, codexVersion: "x", experimental: true, called,
    clientRequests: [entry("turn/start", client), entry("review/start", extra.review ?? {})],
    serverRequests: [{ ...entry("item/ask", ask), response: answer }],
    notifications: [entry("item/completed", note)],
    shapes: {
      definitions: extra.definitions ?? {},
      clientRequests: { "turn/start": client, "review/start": extra.review ?? {} },
      serverRequests: { "item/ask": ask },
      notifications: { "item/completed": note },
    },
  };
}
const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const optional = (s) => ({ anyOf: [s, { type: "null" }] });

test("breakingChanges: additions and loosened reads are compatible", () => {
  const before = tiny({ client: obj({ input: str }, ["input"]), note: obj({ item: obj({ type: { enum: ["a"] }, result: str }, ["result"]) }) });
  const after = tiny({
    client: obj({ input: str, rootTurnId: optional(str) }, ["input"]),
    // `result` moves into an undiscriminated branch and is no longer required; a new optional field joins.
    note: obj({ item: { ...obj({ type: { enum: ["a", "b"] }, startedAtMs: optional({ type: "integer" }) }), anyOf: [obj({ result: str }, ["result"]), obj({ fileId: str }, ["fileId"])] } }),
    extra: { review: obj({ delivery: { enum: ["inline"] } }) },
  });
  assert.deepEqual(breakingChanges(before, after), []);
  assert.equal(verdict(before, after).compatible, true);
  assert.equal(verdict(before, after).same, false);
});

test("breakingChanges: what Vidar sends or reads breaking is named", () => {
  const before = tiny({ client: obj({ input: str, mode: { enum: ["a", "b"] } }, ["input"]), note: obj({ text: str, path: str }) });
  const after = tiny({ client: obj({ input: str, mode: { enum: ["a"] }, cwd: str }, ["input", "cwd"]), note: obj({ text: { type: "integer" } }) });
  assert.deepEqual(breakingChanges(before, after).sort(), [
    "item/completed: field path removed",
    "item/completed.text: may now be number",
    "turn/start.mode: values removed: b",
    "turn/start: field cwd is now required",
  ].sort());
  assert.equal(verdict(before, after).compatible, false);
});

test("breakingChanges: unsent requests are ignored, server request additions and removals of reads are not", () => {
  const before = tiny({ client: str, note: str, extra: { review: obj({ delivery: { enum: ["inline", "detached"] } }) } });
  const after = tiny({ client: str, note: str, extra: { review: obj({ delivery: { enum: ["inline"] } }) } });
  assert.deepEqual(breakingChanges(before, after), [], "review/start is not in `called`");
  assert.deepEqual(breakingChanges({ ...before, called: undefined }, after), ["review/start.delivery: values removed: detached"]);
  const grown = structuredClone(after);
  grown.serverRequests.push({ method: "item/new", paramsType: null, paramsSha256: "n", response: {} });
  grown.notifications = [];
  assert.deepEqual(breakingChanges(before, grown), ["item/new: a new server request Vidar has no card or refusal for", "item/completed: removed"]);
  // A server request answer Vidar writes: a removed decision value breaks.
  const ask = tiny({ client: str, note: str, answer: obj({ decision: { enum: ["accept", "decline"] } }) });
  const narrowed = tiny({ client: str, note: str, answer: obj({ decision: { enum: ["accept"] } }) });
  assert.deepEqual(breakingChanges(ask, narrowed), ["item/ask response.decision: values removed: decline"]);
  assert.deepEqual(breakingChanges({ ...before, shapes: undefined }, after), ["the pinned manifest has no shapes to compare against"]);
});

test("breakingChanges follows definitions and survives a recursive type", () => {
  const definitions = { Node: obj({ name: str, children: { type: "array", items: { $ref: "#/definitions/Node" } } }) };
  const changed = { Node: obj({ children: { type: "array", items: { $ref: "#/definitions/Node" } } }) };
  const before = tiny({ client: str, note: { $ref: "#/definitions/Node" }, extra: { definitions } });
  const after = tiny({ client: str, note: { $ref: "#/definitions/Node" }, extra: { definitions: changed } });
  assert.deepEqual(breakingChanges(before, after), ["item/completed: field name removed"]);
  assert.deepEqual(breakingChanges(manifest, manifest), [], "the pinned manifest against itself");
});

test("sameSurface ignores the version and sees one changed method", () => {
  assert.equal(sameSurface(manifest, { ...manifest, codexVersion: "9.9.9" }), true);
  const changed = structuredClone(manifest);
  changed.clientRequests[0].paramsSha256 = "0".repeat(64);
  assert.equal(sameSurface(manifest, changed), false);
  const removed = structuredClone(manifest);
  removed.notifications.pop();
  assert.equal(sameSurface(manifest, removed), false);
});

test("mergeAccepted creates the file, keeps other keys and leaves no tmp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vidar-codex-accepted-"));
  try {
    const file = join(dir, "sub", "codex-accepted.json");
    mergeAccepted(file, "0.163.0", { pinned: "0.162.1", same: true, atMs: 1 });
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), "0.160.0": { pinned: "0.159.0", same: false, atMs: 0 } }));
    const merged = mergeAccepted(file, "0.164.0", { pinned: "0.162.1", same: false, atMs: 2 });
    assert.deepEqual(Object.keys(merged).sort(), ["0.160.0", "0.163.0", "0.164.0"]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), merged);
    assert.deepEqual(readdirSync(join(dir, "sub")), ["codex-accepted.json"]);
    writeFileSync(file, "not json");
    assert.deepEqual(Object.keys(mergeAccepted(file, "0.165.0", { pinned: "x", same: true, atMs: 3 })), ["0.165.0"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
