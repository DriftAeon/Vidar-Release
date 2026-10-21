// Offline tests for the --falcon permission bookkeeping in tools\claude-sidecar.mjs.
//
// The sidecar is run as a real child process against a STUB of
// @anthropic-ai/claude-agent-sdk: the sidecar file is copied into a temp dir that carries its own
// node_modules\@anthropic-ai\claude-agent-sdk, so ESM resolution finds the stub instead of the
// real SDK. Nothing here starts claude.exe, spends quota or touches the network, and no file
// outside the temp dir is written.
//
//   node --test tests\sidecar-falcon-permissions.test.mjs
//
// The stub is driven by a JSON script (SIDECAR_STUB_SCRIPT), one step at a time:
//   {"permission": {"key": "a", "toolUseID": "tu-a", "tool": "Bash", "input": {…}}}
//        call canUseTool and keep the promise (the stream keeps running, as it does live)
//   {"awaitPermission": "a"}   wait for that callback to RETURN, then yield a marker message
//   {"emit": {…}}              yield one SDK message verbatim
//   {"awaitPrompt": true}      hold the stream open until the next user line on stdin (or stdin
//                              closes); the sidecar exits when the stream ends, so a test that
//                              must see a later stdin line handled parks the stream here
//   {"echoPrompt": true}       as awaitPrompt, then yield the SDK message the sidecar pushed
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR = fileURLToPath(new URL("../tools/claude-sidecar.mjs", import.meta.url));
// Sibling modules the sidecar imports by relative path; copied beside it like the bundle does.
const SIDECAR_MODULES = ["claude-sidecar-shrink.mjs", "claude-sidecar-statusline.mjs", "claude-sidecar-seed.mjs", "claude-sidecar-bare.mjs", "claude-sidecar-recover.mjs", "claude-sidecar-ledger.mjs", "claude-sidecar-trust.mjs"];

const STUB = `
import { readFileSync } from "node:fs";
const script = JSON.parse(readFileSync(process.env.SIDECAR_STUB_SCRIPT, "utf8"));
export async function getSessionMessages() { return []; }
export function query({ prompt, options }) {
  const inFlight = new Map();
  const prompts = prompt[Symbol.asyncIterator]();
  async function* run() {
    for (const step of script) {
      if (step.emit) { yield step.emit; continue; }
      if (step.awaitPrompt) { await prompts.next(); continue; }
      if (step.echoPrompt) { const { value } = await prompts.next(); yield { type: "system", subtype: "stub_prompt", value }; continue; }
      if (step.permission) {
        const p = step.permission;
        inFlight.set(p.key, options.canUseTool(p.tool || "Bash", p.input || {}, {
          toolUseID: p.toolUseID === undefined ? null : p.toolUseID,
          suggestions: [],
          signal: new AbortController().signal,
        }));
        continue;
      }
      if (step.awaitPermission) {
        let behavior = null;
        try { behavior = (await inFlight.get(step.awaitPermission)).behavior; } catch { behavior = "threw"; }
        yield { type: "system", subtype: "stub_callback_returned", key: step.awaitPermission, behavior };
      }
    }
  }
  const it = run();
  return {
    [Symbol.asyncIterator]: () => it,
    initializationResult: async () => ({ models: [] }),
    interrupt: async () => {},
    setModel: async () => {},
    setPermissionMode: async () => {},
  };
}
`;

/** A temp workspace holding the sidecar copy, the stub SDK and the step script. */
function workspace(script) {
  const dir = mkdtempSync(join(tmpdir(), "vidar-sidecar-"));
  const pkg = join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-stub", type: "module", main: "index.mjs", exports: "./index.mjs" }));
  writeFileSync(join(pkg, "index.mjs"), STUB);
  copyFileSync(SIDECAR, join(dir, "claude-sidecar.mjs"));
  for (const m of SIDECAR_MODULES) copyFileSync(fileURLToPath(new URL(`../tools/${m}`, import.meta.url)), join(dir, m));
  writeFileSync(join(dir, "script.json"), JSON.stringify(script));
  return dir;
}

/**
 * Run one scripted session. `onLine(message, child)` drives stdin (answering
 * permission cards); resolves with every stdout line, raw.
 */
function runSidecar({ dir, falcon, onLine }) {
  const args = [join(dir, "claude-sidecar.mjs"), "--cwd", dir, "--permission-mode", "default", "--claude", join(dir, "claude.exe")];
  if (falcon) args.push("--falcon");
  const env = { ...process.env, SIDECAR_STUB_SCRIPT: join(dir, "script.json"), USERPROFILE: dir, HOME: dir, HOMEPATH: dir };
  delete env.ANTHROPIC_MODEL; // would change the ready line's model between runs
  const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = [];
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    let m;
    try { m = JSON.parse(line); } catch { return; }
    onLine?.(m, child);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sidecar did not exit\n${lines.join("\n")}\n${stderr}`)), 20_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ lines, code, stderr }); });
  });
}

const parse = (lines) => lines.map((l) => JSON.parse(l));
const permissions = (msgs) => msgs.filter((m) => m.type === "falcon" && m.subtype === "permission");
const statesOf = (msgs, id) => permissions(msgs).filter((m) => m.id === id).map((m) => m.state);

/** Per-run randomness that is not part of the contract: the pid and the permission uuids. */
function normalize(lines) {
  return lines
    .map((l) => l.replace(/"pid":\d+/, '"pid":0').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"))
    .join("\n");
}

/** Allow every permission card as it arrives. */
const allowAll = (m, child) => {
  if (m.type === "permission_request") child.stdin.write(JSON.stringify({ type: "permission_response", id: m.id, behavior: "allow" }) + "\n");
};

// One permission settled by a tool_result, one by the turn's result message.
const LIFECYCLE = [
  { permission: { key: "a", toolUseID: "tu-a" } },
  { awaitPermission: "a" },
  { emit: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-a", content: "ok" }] } } },
  { permission: { key: "b", toolUseID: null } },
  { awaitPermission: "b" },
  { emit: { type: "result", subtype: "success", permission_denials: [] } },
];

test("a callback that merely returned is not settled", { timeout: 30_000 }, async (t) => {
  const dir = workspace(LIFECYCLE);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  const { lines, code } = await runSidecar({ dir, falcon: true, onLine: allowAll });
  assert.equal(code, 0);
  const msgs = parse(lines);

  const ids = [...new Set(permissions(msgs).map((m) => m.id))];
  assert.equal(ids.length, 2);
  const [a, b] = ids;

  assert.deepEqual(statesOf(msgs, a), ["opened", "responded", "returned", "settled"]);

  // The order is the claim: nothing said "settled" until the agent's tool_result arrived.
  const returnedAt = msgs.findIndex((m) => m.type === "falcon" && m.id === a && m.state === "returned");
  const toolResultAt = msgs.findIndex((m) => m.type === "user");
  const settledAt = msgs.findIndex((m) => m.type === "falcon" && m.id === a && m.state === "settled");
  assert.ok(returnedAt < toolResultAt && toolResultAt < settledAt, `returned ${returnedAt} < tool_result ${toolResultAt} < settled ${settledAt}`);
  assert.equal(permissions(msgs).find((m) => m.id === a && m.state === "settled").signal, "tool_result");

  // b has no tool_use_id, so only the turn's end can settle it — and it must not settle sooner.
  assert.deepEqual(statesOf(msgs, b), ["opened", "responded", "returned", "settled"]);
  const bSettled = permissions(msgs).find((m) => m.id === b && m.state === "settled");
  assert.equal(bSettled.signal, "result");
  const resultAt = msgs.findIndex((m) => m.type === "result");
  assert.ok(resultAt < msgs.indexOf(bSettled));
});

test("a permission with no agent signal stays returned, never settled", { timeout: 30_000 }, async (t) => {
  const dir = workspace([
    { permission: { key: "a", toolUseID: "tu-a" } },
    { awaitPermission: "a" },
    // a tool_result for a DIFFERENT tool use, and no result message for this turn
    { emit: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-other", content: "ok" }] } } },
  ]);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  const { lines } = await runSidecar({ dir, falcon: true, onLine: allowAll });
  const msgs = parse(lines);
  const id = permissions(msgs)[0].id;
  assert.deepEqual(statesOf(msgs, id), ["opened", "responded", "returned"], "an honest unknown, not a settle");
});

test("closing stdin cancels an unanswered permission and never reports it returned", { timeout: 30_000 }, async (t) => {
  const dir = workspace([{ permission: { key: "z", toolUseID: "tu-z" } }, { awaitPermission: "z" }]);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  const { lines, code } = await runSidecar({
    dir,
    falcon: true,
    onLine: (m, child) => { if (m.type === "permission_request") child.stdin.end(); },
  });
  assert.equal(code, 0);
  const msgs = parse(lines);
  const id = permissions(msgs)[0].id;
  assert.deepEqual(statesOf(msgs, id), ["opened", "cancelled"]);
  assert.equal(msgs.find((m) => m.subtype === "stub_callback_returned").behavior, "deny");
});

test("a second response for the same id is refused", { timeout: 30_000 }, async (t) => {
  // awaitPrompt keeps the stream open: without it the first response lets the stub finish and
  // the sidecar exits on stream end, sometimes before readline has delivered the second line.
  const dir = workspace([{ permission: { key: "a", toolUseID: "tu-a" } }, { awaitPermission: "a" }, { awaitPrompt: true }]);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  const { lines, code } = await runSidecar({
    dir,
    falcon: true,
    onLine: (m, child) => {
      if (m.type === "permission_request") {
        // Same id, twice: the first is the only one the sidecar's pending
        // map ever had a resolver for.
        child.stdin.write(JSON.stringify({ type: "permission_response", id: m.id, behavior: "allow" }) + "\n");
        child.stdin.write(JSON.stringify({ type: "permission_response", id: m.id, behavior: "allow" }) + "\n");
      }
      // The refusal has been written; release the stream so the sidecar can end.
      if (m.type === "sidecar" && m.subtype === "error" && m.message.startsWith("no pending permission")) {
        child.stdin.write(JSON.stringify({ type: "user", content: "release" }) + "\n");
      }
    },
  });
  assert.equal(code, 0);
  const msgs = parse(lines);
  const id = permissions(msgs)[0].id;
  const refusal = msgs.find((m) => m.type === "sidecar" && m.subtype === "error" && m.message === `no pending permission ${id}`);
  assert.ok(refusal, `expected a "no pending permission ${id}" error, got:\n${lines.join("\n")}`);
  // The first response is the only one that ever reaches "responded"; the fence is the pending map, nothing durable per-id.
  assert.deepEqual(statesOf(msgs, id).filter((s) => s === "responded"), ["responded"]);
});

// A Falcon steer writes a `user` line mid-turn; "next" makes the CLI fold it at the next tool
// boundary. Left unset, a CLI flag can turn the default into "later"; "now" would abort the turn.
test("a user line is pushed with priority next", { timeout: 30_000 }, async (t) => {
  const dir = workspace([{ echoPrompt: true }]);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  let sent = false;
  const { lines, code } = await runSidecar({
    dir,
    falcon: true,
    onLine: (m, child) => {
      if (sent) return;
      sent = true;
      child.stdin.write(JSON.stringify({ type: "user", content: "turn left", steer: true, cid: 4 }) + "\n");
    },
  });
  assert.equal(code, 0);
  const echoed = parse(lines).find((m) => m.subtype === "stub_prompt");
  assert.ok(echoed, `the stub never saw the prompt:\n${lines.join("\n")}`);
  assert.equal(echoed.value.priority, "next");
  assert.equal(echoed.value.message.content, "turn left");
});

test("without --falcon the stdout is the same bytes, minus nothing", { timeout: 60_000 }, async (t) => {
  const gated = workspace(LIFECYCLE);
  const plain = workspace(LIFECYCLE);
  t.after(() => { for (const d of [gated, plain]) try { rmSync(d, { recursive: true, force: true }); } catch { /* temp dir */ } });

  const withFlag = await runSidecar({ dir: gated, falcon: true, onLine: allowAll });
  const noFlag = await runSidecar({ dir: plain, falcon: false, onLine: allowAll });
  assert.equal(noFlag.code, 0);

  // guard against a vacuous pass: both runs really did stream the scripted session
  assert.ok(withFlag.lines.filter((l) => l.includes('"falcon"')).length >= 8, "the gated run must carry the permission records");
  assert.ok(noFlag.lines.length >= 8, `too little output to compare: ${noFlag.lines.join("\n")}`);
  assert.equal(noFlag.lines.filter((l) => l.includes('"falcon"')).length, 0, "no falcon record may escape the gate");
  assert.equal(
    normalize(noFlag.lines),
    normalize(withFlag.lines.filter((l) => JSON.parse(l).type !== "falcon")),
    "the gate must add records and change nothing else (pid and permission uuids normalized)",
  );
});
