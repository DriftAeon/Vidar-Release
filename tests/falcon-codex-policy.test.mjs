// In-process and Falcon-hosted Codex start threads under one policy table (contracts/codex-policy.json).
// The Rust half of this check is src-falcon/src/codex/driver/policy.rs, against the same fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codexTurnPolicy, threadParams } from "../src/agents/codex-permissions.ts";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const fixture = read("./fixtures/falcon-codex/thread-params.json");
const policy = read("../contracts/codex-policy.json");
const modes = read("../contracts/permission-modes.json");

test("TS builds the thread params the shared fixture pins", () => {
  assert.ok(fixture.cases.length > 0);
  for (const c of fixture.cases) assert.deepEqual(threadParams(c.cwd, c.mode, c.model), c.params, c.mode);
});

test("the policy contract names exactly the permission modes", () => {
  assert.deepEqual(Object.keys(policy.modes).sort(), [...modes].sort());
});

test("turn policy maps every thread sandbox to a turn sandbox type", () => {
  for (const mode of modes) {
    const turn = codexTurnPolicy(mode);
    assert.equal(typeof turn.sandboxPolicy.type, "string", mode);
    assert.equal(turn.approvalsReviewer, policy.modes[mode].approvalsReviewer);
  }
  assert.deepEqual(codexTurnPolicy("plan").sandboxPolicy, { type: "readOnly" });
  assert.deepEqual(codexTurnPolicy("auto").sandboxPolicy, { type: "workspaceWrite" });
});
