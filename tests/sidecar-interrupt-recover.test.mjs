// An SDK throw right after an interrupt (A7): tools\claude-sidecar.mjs ends the turn and rebuilds the
// query on the same session instead of failing; any other throw still fails.
//
// Same harness as sidecar-falcon-permissions.test.mjs: the sidecar runs as a real child process
// against a STUB of @anthropic-ai/claude-agent-sdk in a temp dir. Nothing here starts claude.exe.
//
//   node --test tests\sidecar-interrupt-recover.test.mjs
//
// The stub plays one script per query() call (SIDECAR_STUB_SCRIPT is an array of scripts):
//   {"emit": {…}}                yield one SDK message verbatim
//   {"permission": {…}}          call canUseTool and keep the promise
//   {"awaitInterrupt": true}     wait until the sidecar calls interrupt() on this query
//   {"throw": "message"}         throw out of the stream
//   {"resumed": true}            yield a marker carrying this query's options.resume and permissionMode
//   {"swallowPrompt": true}      wait for the next prompt item and drop it (a dying CLI took it)
//   {"echoPrompt": true}         wait for the next prompt item and yield it
//   {"rejectInterrupt": true}    (anywhere) interrupt() rejects 50 ms later, as the SDK's teardown does
// Each query pulls its prompt stream from the start, as the SDK does.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR = fileURLToPath(new URL("../tools/claude-sidecar.mjs", import.meta.url));
const SIDECAR_MODULES = ["claude-sidecar-shrink.mjs", "claude-sidecar-statusline.mjs", "claude-sidecar-seed.mjs", "claude-sidecar-bare.mjs", "claude-sidecar-recover.mjs", "claude-sidecar-ledger.mjs", "claude-sidecar-trust.mjs"];

const STUB = `
import { readFileSync } from "node:fs";
const scripts = JSON.parse(readFileSync(process.env.SIDECAR_STUB_SCRIPT, "utf8"));
let calls = 0;
export async function getSessionMessages() { return []; }
export function query({ prompt, options }) {
  const script = scripts[calls++] ?? [];
  // like the real SDK, pull the prompt stream from the start, whatever the script is doing
  const inbox = [];
  let arrived = null;
  void (async () => { for await (const item of prompt) { inbox.push(item); arrived?.(); } })();
  const nextPrompt = async () => { while (!inbox.length) await new Promise((r) => { arrived = r; }); return inbox.shift(); };
  let interrupted, wasInterrupted = new Promise((r) => { interrupted = r; });
  async function* run() {
    for (const step of script) {
      if (step.emit) { yield step.emit; continue; }
      if (step.permission) {
        void options.canUseTool(step.permission.tool || "Bash", {}, { toolUseID: step.permission.toolUseID ?? null, suggestions: [], signal: new AbortController().signal });
        continue;
      }
      if (step.awaitInterrupt) { await wasInterrupted; continue; }
      if (step.throw) throw new Error(step.throw);
      if (step.resumed) { yield { type: "system", subtype: "stub_resumed", resume: options.resume ?? null, mode: options.permissionMode }; continue; }
      if (step.swallowPrompt) { await nextPrompt(); continue; }
      if (step.echoPrompt) { const value = await nextPrompt(); yield { type: "system", subtype: "stub_prompt", value }; }
    }
  }
  const it = run();
  // {"rejectInterrupt": true} anywhere in the script: interrupt() rejects as the SDK's cleanup does
  const rejects = script.some((s) => s.rejectInterrupt);
  return {
    [Symbol.asyncIterator]: () => it,
    initializationResult: async () => ({ models: [] }),
    interrupt: async () => { interrupted(); if (rejects) { await new Promise((r) => setTimeout(r, 50)); throw new Error("query closed"); } },
    setModel: async () => {},
    setPermissionMode: async () => {},
  };
}
`;

function workspace(scripts) {
  const dir = mkdtempSync(join(tmpdir(), "vidar-sidecar-int-"));
  const pkg = join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-stub", type: "module", main: "index.mjs", exports: "./index.mjs" }));
  writeFileSync(join(pkg, "index.mjs"), STUB);
  copyFileSync(SIDECAR, join(dir, "claude-sidecar.mjs"));
  for (const m of SIDECAR_MODULES) copyFileSync(fileURLToPath(new URL(`../tools/${m}`, import.meta.url)), join(dir, m));
  writeFileSync(join(dir, "script.json"), JSON.stringify(scripts));
  return dir;
}

function runSidecar({ dir, onLine }) {
  const args = [join(dir, "claude-sidecar.mjs"), "--cwd", dir, "--permission-mode", "default", "--claude", join(dir, "claude.exe"), "--falcon"];
  const env = { ...process.env, SIDECAR_STUB_SCRIPT: join(dir, "script.json"), USERPROFILE: dir, HOME: dir, HOMEPATH: dir };
  const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const msgs = [];
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    msgs.push(m);
    onLine?.(m, child);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sidecar did not exit\n${JSON.stringify(msgs)}\n${stderr}`)), 20_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ msgs, code, stderr }); });
  });
}

const write = (child, m) => child.stdin.write(JSON.stringify(m) + "\n");
const INIT = { type: "system", subtype: "init", permissionMode: "default", session_id: "11111111-2222-3333-4444-555555555555" };
// the CLI entering plan mode itself (EnterPlanMode), seen only on the stream
const PLAN = { type: "system", subtype: "status", status: null, permissionMode: "plan", session_id: INIT.session_id };
const RESULT = { type: "result", subtype: "error_during_execution", is_error: true, session_id: INIT.session_id };

test("a throw right after an interrupt ends the turn and resumes the same session", { timeout: 30_000 }, async (t) => {
  const dir = workspace([
    [{ emit: INIT }, { emit: PLAN }, { permission: { toolUseID: "tu-a" } }, { awaitInterrupt: true }, { throw: "aborted mid-permission" }, { rejectInterrupt: true }],
    [{ resumed: true }, { echoPrompt: true }],
  ]);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  const { msgs, code } = await runSidecar({
    dir,
    onLine: (m, child) => {
      if (m.type === "permission_request") write(child, { type: "interrupt", cid: 7 });
      // sent once the interrupt has settled, so the sidecar is still up to report it
      if (m.type === "falcon" && m.subtype === "outcome" && m.cid === 7) write(child, { type: "user", content: "still here" });
    },
  });
  assert.equal(code, 0, JSON.stringify(msgs));
  assert.equal(msgs.filter((m) => m.type === "sidecar" && m.subtype === "error").length, 0, "no fail() on the interrupt's throw");

  const result = msgs.find((m) => m.type === "result");
  assert.ok(result, "the interrupted turn ends with a result");
  assert.equal(result.subtype, "error_during_execution");
  assert.equal(result.is_error, true);

  // the dead query's open permission is cancelled, never left pending
  const id = msgs.find((m) => m.type === "permission_request").id;
  const states = msgs.filter((m) => m.type === "falcon" && m.subtype === "permission" && m.id === id).map((m) => m.state);
  assert.deepEqual(states, ["opened", "cancelled"]);

  const resumed = msgs.find((m) => m.subtype === "stub_resumed");
  assert.equal(resumed.resume, INIT.session_id, "the rebuilt query resumes the same conversation");
  assert.equal(resumed.mode, "plan", "the mode the CLI entered on its own rides the rebuild");
  const outcome = msgs.find((m) => m.type === "falcon" && m.subtype === "outcome" && m.cid === 7);
  assert.equal(outcome?.state, "applied", "an interrupt rejected by its own teardown still did its job");
  assert.ok(msgs.indexOf(result) < msgs.indexOf(resumed), "the turn ends before the new query streams");
  const echoed = msgs.find((m) => m.subtype === "stub_prompt");
  assert.equal(echoed?.value?.message?.content, "still here", "a prompt after the recovery reaches the new query");
  assert.equal(msgs.filter((m) => m.subtype === "ready").length, 1, "ready goes out once");
});

test("an interrupted turn that already sent its result gets no second one", { timeout: 30_000 }, async (t) => {
  const dir = workspace([
    [{ emit: INIT }, { awaitInterrupt: true }, { emit: { type: "result", subtype: "error_during_execution", is_error: true, session_id: INIT.session_id } }, { throw: "late" }],
    [{ resumed: true }],
  ]);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  const { msgs, code } = await runSidecar({ dir, onLine: (m, child) => { if (m.subtype === "init") write(child, { type: "interrupt" }); } });
  assert.equal(code, 0, JSON.stringify(msgs));
  assert.equal(msgs.filter((m) => m.type === "result").length, 1);
  assert.ok(msgs.find((m) => m.subtype === "stub_resumed"));
});

test("a prompt the dying CLI took after its result reaches the rebuilt query once", { timeout: 30_000 }, async (t) => {
  const dir = workspace([
    [{ emit: INIT }, { awaitInterrupt: true }, { emit: RESULT }, { swallowPrompt: true }, { throw: "exited" }],
    [{ resumed: true }, { echoPrompt: true }],
  ]);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  const { msgs, code } = await runSidecar({
    dir,
    onLine: (m, child) => {
      if (m.subtype === "init") write(child, { type: "interrupt" });
      if (m.type === "result") write(child, { type: "user", content: "next prompt" }); // Falcon's next dispatch
    },
  });
  assert.equal(code, 0, JSON.stringify(msgs));
  assert.equal(msgs.filter((m) => m.type === "result").length, 1);
  const echoed = msgs.filter((m) => m.subtype === "stub_prompt");
  assert.deepEqual(echoed.map((m) => m.value?.message?.content), ["next prompt"]);
});

test("a new turn after the interrupted one's result closes the window", { timeout: 30_000 }, async (t) => {
  const dir = workspace([
    [{ emit: INIT }, { awaitInterrupt: true }, { emit: RESULT }, { emit: INIT }, { throw: "later" }],
    [{ resumed: true }],
  ]);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  let interrupted = false;
  const { msgs, code } = await runSidecar({
    dir,
    onLine: (m, child) => { if (m.subtype === "init" && !interrupted) { interrupted = true; write(child, { type: "interrupt" }); } },
  });
  assert.equal(code, 1);
  assert.ok(msgs.find((m) => m.type === "sidecar" && m.subtype === "error" && m.message === "query: later"));
  assert.equal(msgs.find((m) => m.subtype === "stub_resumed"), undefined, "no second query");
});

test("a throw with no interrupt before it still fails", { timeout: 30_000 }, async (t) => {
  const dir = workspace([[{ emit: INIT }, { throw: "boom" }], [{ resumed: true }]]);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  const { msgs, code } = await runSidecar({ dir });
  assert.equal(code, 1);
  assert.ok(msgs.find((m) => m.type === "sidecar" && m.subtype === "error" && m.message === "query: boom"));
  assert.equal(msgs.find((m) => m.subtype === "stub_resumed"), undefined, "no second query");
  assert.equal(msgs.find((m) => m.type === "result"), undefined);
});
