// Loopback tests for tools\bus\bus-client.mjs against a LIVE Falcon host.
//
// Skipped entirely unless the session pipe actually answers a negotiate right
// now — this suite starts no host itself. Bring one up first:
//   pwsh -NoProfile -ExecutionPolicy Bypass -File tools\release\falcon-refresh.ps1 -Force
//   node --test tests\bus-client.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { connect, BusUnavailableError } from "../tools/bus/bus-client.mjs";

const CLIENT = fileURLToPath(new URL("../tools/bus/bus-client.mjs", import.meta.url));

async function hostReachable() {
  try {
    const client = await connect("bus-client-test-probe");
    client.close();
    return true;
  } catch (error) {
    if (error instanceof BusUnavailableError) return false;
    throw error;
  }
}

/** Spawn `node bus-client.mjs respond <topic>` and resolve once it prints "ready". */
function spawnResponder(topic, { noReply = false } = {}) {
  const args = [CLIENT, "respond", topic];
  if (noReply) args.push("--no-reply");
  const child = spawn(process.execPath, args, { windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const ready = new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (line.trim() === "ready") resolve();
    });
    child.on("exit", (code) => reject(new Error(`responder exited early (${code}): ${stderr}`)));
  });
  return { child, ready };
}

function runRequest(topic, payload, { timeoutMs } = {}) {
  const args = [CLIENT, "request", topic, "--json", JSON.stringify(payload)];
  if (timeoutMs !== undefined) args.push("--timeout", String(timeoutMs));
  const child = spawn(process.execPath, args, { windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("bus-client loopback (request/respond round trip and a no-responder timeout)", async (t) => {
  if (!(await hostReachable())) {
    t.skip("no live Falcon host on the session pipe (hand the user the tools\\release\\falcon-refresh.ps1 command to start one)");
    return;
  }

  await t.test("a request reaches a responder and the echo round-trips under 200ms", async () => {
    const topic = `bus-client-test.echo.${process.pid}.${Date.now()}`;
    const { child, ready } = spawnResponder(topic);
    try {
      await ready;
      const payload = { hello: "world" };
      const started = Date.now();
      const result = await runRequest(topic, payload);
      const elapsed = Date.now() - started;
      assert.equal(result.code, 0, result.stderr);
      const reply = JSON.parse(result.stdout);
      assert.deepEqual(reply, { ok: true, echo: payload });
      assert.ok(elapsed < 200, `round trip took ${elapsed}ms`);
    } finally {
      child.kill();
    }
  });

  await t.test("a request with no subscriber exits 3 immediately", async () => {
    const topic = `bus-client-test.silence.${process.pid}.${Date.now()}`;
    const started = Date.now();
    const result = await runRequest(topic, {}, { timeoutMs: 300_000 });
    const elapsed = Date.now() - started;
    assert.equal(result.code, 3, result.stderr);
    assert.ok(elapsed < 500, `should exit well under the 300s timeout, took ${elapsed}ms`);
  });

  await t.test("a subscriber that never replies still times out with exit 2", async () => {
    const topic = `bus-client-test.mute.${process.pid}.${Date.now()}`;
    const { child, ready } = spawnResponder(topic, { noReply: true });
    try {
      await ready;
      const started = Date.now();
      const result = await runRequest(topic, {}, { timeoutMs: 300 });
      const elapsed = Date.now() - started;
      assert.equal(result.code, 2, result.stderr);
      assert.ok(elapsed < 500, `timeout took ${elapsed}ms`);
    } finally {
      child.kill();
    }
  });
});
