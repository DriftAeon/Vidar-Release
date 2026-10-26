// Regression: nothing asked Astra for the ASTRA-DONE marker, so the notify
// hook never wrote done.json. astra-dispatch.ps1 now appends the report path, then the marker, to
// the typed text. Regression: callers waited on done.json after
// dispatch-result said ok:false; the script now waits for the verdict itself and fails on ok:false
// or on no claim. This runs the real script from a temp <vidar>\tools\desks so its $PSScriptRoot
// root resolves to the temp folder; the test plays Vidar's part by writing pending.json and
// dispatch-result.json. codex-meter.ps1 is deliberately NOT copied: it would walk the real
// ~\.codex\sessions; its absence is caught by the script's meter try/catch.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { missingInputs } from "./helpers/optional-input.mjs";

const SCRIPT = fileURLToPath(new URL("../tools/desks/astra-dispatch.ps1", import.meta.url));
const hasPwsh = process.platform === "win32" && !spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).error;
const skip = !hasPwsh ? "needs pwsh on Windows" : missingInputs(import.meta.url, "../tools/desks/astra-dispatch.ps1") ?? false;

function fakeVidar() {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "vidar-astra-")));
  const desks = join(tmp, "tools", "desks");
  mkdirSync(desks, { recursive: true });
  mkdirSync(join(tmp, "runtime", "bridge","review", "dispatch"), { recursive: true });
  mkdirSync(join(tmp, "runtime", "bridge","display"), { recursive: true });
  copyFileSync(SCRIPT, join(desks, "astra-dispatch.ps1"));
  // The script dot-sources tools/lib and resolves paths through contracts/paths.json (root marker: contracts/paths.json).
  const repo = fileURLToPath(new URL("../", import.meta.url));
  mkdirSync(join(tmp, "tools", "lib"));
  mkdirSync(join(tmp, "contracts"));
  for (const f of ["Paths.ps1", "BridgeIo.ps1"]) copyFileSync(join(repo, "tools", "lib", f), join(tmp, "tools", "lib", f));
  copyFileSync(join(repo, "contracts", "paths.json"), join(tmp, "contracts", "paths.json"));
  return { tmp, script: join(desks, "astra-dispatch.ps1"), dispatch: join(tmp, "runtime", "bridge","review", "dispatch") };
}

function run(script, args) {
  return new Promise((resolve) => {
    const p = spawn("pwsh", ["-NoProfile", "-File", script, ...args]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (status) => resolve({ status, out, err }));
  });
}

async function waitFor(path, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    if (existsSync(path)) return;
  }
  throw new Error(`timed out waiting for ${path}`);
}

// Each test runs its own script in its own mkdtemp, so they overlap (wall time = the slowest, not the sum).
describe("astra-dispatch", { concurrency: true }, () => {
test("dispatch text names the report, ends with the marker, and ok:false exits non-zero", { skip }, async () => {
  const v = fakeVidar();
  try {
    // Forward slashes: the script normalises them before validating.
    const report = join(v.tmp, "runtime", "bridge","display", "r.md").replaceAll("\\", "/");
    const done = run(v.script, ["-Id", "0123abcd", "-Text", "x", "-Requester", "t", "-Report", report]);
    const req = join(v.dispatch, "0123abcd.json");
    await waitFor(req);
    const d = JSON.parse(readFileSync(req, "utf8"));
    assert.ok(d.text.endsWith("ASTRA-DONE 0123abcd"), d.text);
    assert.ok(d.text.includes(report.replaceAll("/", "\\")), d.text);
    const dir = join(v.tmp, "runtime", "bridge","review", "0123abcd");
    writeFileSync(join(dir, "pending.json"), "{}");
    // Tmp + rename: the script polls every 200 ms and must never read a half-written result.
    writeFileSync(join(dir, "dispatch-result.tmp"), '{"id":"0123abcd","ok":false,"reason":"no armed astra tab"}');
    renameSync(join(dir, "dispatch-result.tmp"), join(dir, "dispatch-result.json"));
    const r = await done;
    assert.equal(r.status, 1, r.out + r.err);
    assert.match(r.err, /no armed astra tab/);
  } finally {
    rmSync(v.tmp, { recursive: true, force: true });
  }
});

test("-Cwd naming astra-reports creates that folder; the script still exits on the claim window", { skip }, async () => {
  const v = fakeVidar();
  try {
    const reports = join(v.tmp, "runtime", "bridge","astra-reports");
    assert.ok(!existsSync(reports));
    const r = await run(v.script, ["-Id", "89abcdef", "-Text", "x", "-Requester", "t", "-Cwd", reports.replaceAll("\\", "/"), "-WaitSeconds", "1"]);
    assert.equal(r.status, 2, r.out + r.err);
    assert.ok(existsSync(reports), "astra-reports not created");
    const req = JSON.parse(readFileSync(join(v.tmp, "runtime", "bridge","review", "89abcdef", "request.json"), "utf8"));
    assert.equal(req.cwd, reports.replaceAll("\\", "/"));
    // Unclaimed: exit 2 above, the request is withdrawn to stale.
    assert.match(r.err, /withdrawn to/);
    assert.ok(!existsSync(join(v.dispatch, "89abcdef.json")), "request left in dispatch");
    assert.ok(readdirSync(join(v.dispatch, "stale")).some((f) => f.endsWith("-89abcdef.json")));
  } finally {
    rmSync(v.tmp, { recursive: true, force: true });
  }
});

test("common caller wording loses its duplicate marker and report sentence, then gets the script's own", { skip }, async () => {
  const v = fakeVidar();
  try {
    const report = join(v.tmp, "runtime", "bridge", "display", "r.md").replaceAll("\\", "/");
    const text = "Read and follow the brief at bench-codex-arm\\brief.md. Work only in reports\\bench-codex-arm. Report to runtime\\bridge\\astra-reports\\eadcd251-report.md, then end with ASTRA-DONE eadcd251.";
    const r = await run(v.script, ["-Id", "eadcd251", "-Text", text, "-Requester", "t", "-Report", report, "-WaitSeconds", "1"]);
    assert.equal(r.status, 2, r.out + r.err);
    const req = JSON.parse(readFileSync(join(v.tmp, "runtime", "bridge", "review", "eadcd251", "request.json"), "utf8"));
    const sent = JSON.parse(readFileSync(join(v.dispatch, "stale", readdirSync(join(v.dispatch, "stale")).find((f) => f.endsWith("-eadcd251.json"))), "utf8"));
    assert.equal(sent.text, `Follow Brief: bench-codex-arm\\brief.md | Work in: reports\\bench-codex-arm | Write Report: ${report.replaceAll("/", "\\")} | End Reply: ASTRA-DONE eadcd251`, req.id);
  } finally {
    rmSync(v.tmp, { recursive: true, force: true });
  }
});

// codex-notify.ps1 done path: done.json only from the tab Vidar typed into (tabCwd in dispatch-result.json).
async function notifyScenario({ tabCwd, eventCwd, withRequest = true }) {
  const v = fakeVidar();
  try {
    copyFileSync(fileURLToPath(new URL("../tools/desks/codex-notify.ps1", import.meta.url)), join(v.tmp, "tools", "desks", "codex-notify.ps1"));
    const dir = join(v.tmp, "runtime", "bridge","review", "0a1b2c3d");
    mkdirSync(dir, { recursive: true });
    const report = join(v.tmp, "runtime", "bridge","astra-reports", "r.md");
    mkdirSync(join(v.tmp, "runtime", "bridge","astra-reports"), { recursive: true });
    writeFileSync(report, "findings");
    writeFileSync(join(dir, "pending.json"), "{}");
    if (withRequest) writeFileSync(join(dir, "request.json"), JSON.stringify({ id: "0a1b2c3d", report, cwd: tabCwd }));
    if (tabCwd) writeFileSync(join(dir, "dispatch-result.json"), JSON.stringify({ ok: true, tab: "t1", tabCwd }));
    const ev = JSON.stringify({ type: "agent-turn-complete", "thread-id": "th", "turn-id": "tu", cwd: eventCwd, "last-assistant-message": "done\nASTRA-DONE 0a1b2c3d" });
    const r = await run(join(v.tmp, "tools", "desks", "codex-notify.ps1"), [ev]);
    assert.equal(r.status, 0, r.out + r.err);
    const log = existsSync(join(v.tmp, "runtime", "bridge","review", "hook-errors.log")) ? readFileSync(join(v.tmp, "runtime", "bridge","review", "hook-errors.log"), "utf8") : "";
    return { done: existsSync(join(dir, "done.json")), diag: existsSync(join(dir, "diag.json")), log };
  } finally {
    rmSync(v.tmp, { recursive: true, force: true });
  }
}

test("notify writes done.json when the event cwd equals tabCwd (case and separators aside)", { skip }, async () => {
  const cwd = "C:\\app\\Vidar\\runtime\\bridge\\astra-reports";
  const r = await notifyScenario({ tabCwd: cwd, eventCwd: cwd.toLowerCase().replaceAll("\\", "/") + "/" });
  assert.equal(r.done, true, r.log);
});

test("notify refuses a done event from another cwd: log line only, no done.json, no diag.json", { skip }, async () => {
  const r = await notifyScenario({ tabCwd: "C:\\app\\Vidar\\runtime\\bridge\\display", eventCwd: "C:\\app\\Vidar" });
  assert.equal(r.done, false);
  assert.equal(r.diag, false);
  assert.match(r.log, /not the armed tab's cwd/);
});

test("notify refuses a done event with no tabCwd recorded", { skip }, async () => {
  const r = await notifyScenario({ tabCwd: "", eventCwd: "C:\\x" });
  assert.equal(r.done, false);
  assert.match(r.log, /no tabCwd/);
});

test("notify refuses the legacy path (no request.json)", { skip }, async () => {
  const cwd = "C:\\app\\Vidar\\runtime\\bridge\\display";
  const r = await notifyScenario({ tabCwd: cwd, eventCwd: cwd, withRequest: false });
  assert.equal(r.done, false);
  assert.match(r.log, /legacy glob path refused/);
});

});
