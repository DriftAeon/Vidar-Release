// The Bare rune payload from the spawn reply rides every thread/start as developerInstructions and
// never thread/resume.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { CodexAdapter } = await import("../src/agents/codex.ts");

function open(start) {
  const adapter = new CodexAdapter();
  const wire = [];
  adapter.attach((line) => wire.push(JSON.parse(line)));
  adapter.start({ cwd: "C:/work", permissionMode: "default", ...start });
  const request = (method) => wire.findLast((m) => m.method === method);
  adapter.feed(JSON.stringify({ id: request("initialize").id, result: {} }));
  return { adapter, wire, request };
}

test("thread/start carries developerInstructions, thread/resume does not", () => {
  const text = "x".repeat(16000);
  assert.equal(open({ developerInstructions: text }).request("thread/start").params.developerInstructions, text);
  const resumed = open({ developerInstructions: text, resume: "thread-9" });
  assert.equal(resumed.request("thread/resume").params.developerInstructions, undefined);
  assert.equal(resumed.request("thread/start"), undefined);
});

test("a failed resume starts a fresh thread that still carries the payload; none sends no field", () => {
  const { adapter, request } = open({ developerInstructions: "rules", resume: "gone" });
  adapter.feed(JSON.stringify({ id: request("thread/resume").id, error: { message: "no rollout" } }));
  assert.equal(request("thread/start").params.developerInstructions, "rules");
  assert.ok(!("developerInstructions" in open({}).request("thread/start").params));
});
