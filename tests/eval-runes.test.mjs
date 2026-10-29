// tools/bare/eval-runes.mjs on fixtures: no spawning, a fake runner writes (or withholds) the out file.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { grade, loadSuite, planSessions, runSuite, spawnRunner } from "../tools/bare/eval-runes.mjs";
import { TESTS } from "../tools/bare/probe-runes.mjs";

const tool = fileURLToPath(new URL("../tools/bare/eval-runes.mjs", import.meta.url));
const repoRunes = fileURLToPath(new URL("../runes", import.meta.url));
// runes/ is export-ignored, so the tests that load the real suites skip in a shipped tree.
const runesSkip = existsSync(join(repoRunes, "evals")) ? false : "runes/evals is not in this tree (runes not shipped)";
const readLine = (id, sep = "\\") =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: ["C:", "h", "skills", "vidar-runes", `${id}.md`].join(sep) } }] } });

function makeLib(spec) {
  const lib = mkdtempSync(join(tmpdir(), "eval-runes-lib-"));
  for (const [rune, cases] of Object.entries(spec)) {
    for (const [name, c] of Object.entries(cases)) {
      const d = join(lib, "evals", rune, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "prompt.md"), `prompt ${rune} ${name}\n`);
      writeFileSync(join(d, "case.json"), `﻿${JSON.stringify({ kind: "unprompted", fact: "GREEN", ...c })}`);
    }
  }
  return lib;
}

/** A runner that answers per (case, arm) from `script(body)` -> { result?, transcript? }; null result = no out file. */
function fakeRunner(script, log = []) {
  return (caseFile, outFile) => {
    const body = JSON.parse(readFileSync(caseFile, "utf8"));
    log.push(`${body.target}:${body.arm}:${body.model ?? "-"}`);
    const r = script(body);
    if (!r.result) return 0;
    const out = { stdout: "", ...r.result };
    if (r.transcript !== undefined) {
      const tp = join(tmpdir(), `eval-runes-tr-${process.pid}-${log.length}.jsonl`);
      writeFileSync(tp, r.transcript);
      out.transcript = tp;
    }
    writeFileSync(outFile, JSON.stringify(out));
    return 0;
  };
}

const run = (lib, script, opts = {}) => {
  const log = [];
  const outDir = mkdtempSync(join(tmpdir(), "eval-runes-out-"));
  const result = runSuite(loadSuite(lib), opts, fakeRunner(script, log), { outDir, tmp: outDir });
  return { result, log, outDir };
};

test("a backslash-path Read of the rune counts as a read", () => {
  const c = { target: "rule-a", kind: "unprompted", fact: "GREEN" };
  assert.equal(grade(c, "recall", { stdout: "GREEN" }, readLine("rule-a", "\\")).read, true);
  assert.equal(grade(c, "recall", { stdout: "GREEN" }, readLine("rule-a", "/")).pass, true);
  assert.equal(grade(c, "recall", { stdout: "GREEN" }, "").pass, false);
});

test("a forbidden read fails the session", () => {
  const c = { target: "rule-a", kind: "prompted", fact: "GREEN", forbiddenReads: ["rule-b"] };
  const g = grade(c, "recall", { stdout: "GREEN" }, `${readLine("rule-a")}\n${readLine("rule-b")}`);
  assert.equal(g.pass, false);
  assert.deepEqual(g.forbidden, ["rule-b"]);
  const u = { target: "rule-a", kind: "unrelated", fact: "GREEN" };
  assert.equal(grade(u, "recall", { stdout: "GREEN" }, readLine("rule-a")).pass, false);
});

test("a behaviour grader reads a cwdFiles path, backslashes normalised", () => {
  const c = { target: "r", kind: "prompted", behaviour: { path: "out/notes.md", pattern: "asked" } };
  assert.equal(grade(c, "off", { cwdFiles: [{ path: "out\\notes.md", text: "I asked" }] }, "").pass, true);
  assert.equal(grade(c, "off", { cwdFiles: [] }, "").pass, false);
});

test("a missing out file, a timeout and an error result all fail", () => {
  const lib = makeLib({ "rule-a": { one: {} } });
  const { result } = run(lib, () => ({ result: null }));
  assert.equal(result.runes["rule-a"].verdict, "Keep Always-On");
  const c = { target: "r", kind: "unprompted", fact: "GREEN" };
  assert.equal(grade(c, "off", null, "").why, "no out file");
  assert.equal(grade(c, "off", { stdout: "GREEN", timedOut: true }, "").pass, false);
  assert.equal(grade(c, "off", { error: "no description" }, "").pass, false);
});

test("harness errors are not misses; two in a row abort with the tail", () => {
  const lib = makeLib({ "rule-a": { c1: {} } });
  const mk = () => mkdtempSync(join(tmpdir(), "eval-runes-out-"));
  // Non-zero probe exit, no out file.
  let outDir = mk();
  let calls = 0;
  let result = runSuite(loadSuite(lib), {}, () => (calls++, { status: 101, tail: "panicked: boom" }), { outDir, tmp: outDir });
  assert.equal(calls, 2);
  assert.equal(result.aborted, true);
  assert.equal(result.tail, "panicked: boom");
  assert.equal(result.runes["rule-a"].verdict, "No Verdict: Harness Error");
  const first = JSON.parse(readFileSync(join(outDir, "sessions.jsonl"), "utf8").split("\n")[0]);
  assert.equal(first.harness, true);
  assert.match(first.why, /^Harness Error/);
  assert.match(readFileSync(join(outDir, "report.md"), "utf8"), /Harness Error/);
  // Agent auth failure (out file with status 1) and an error field.
  for (const out of [{ status: 1, stdout: "Failed to authenticate" }, { error: "no description" }]) {
    outDir = mk();
    calls = 0;
    result = runSuite(loadSuite(lib), {}, (cf, of) => (calls++, writeFileSync(of, JSON.stringify(out)), 101), { outDir, tmp: outDir });
    assert.equal(calls, 2);
    assert.equal(result.aborted, true);
  }
  // A harness error does not stop the rune; a good session resets the streak.
  outDir = mk();
  calls = 0;
  result = runSuite(loadSuite(lib), {}, (cf, of) => {
    calls++;
    if (calls === 1) return 101;
    writeFileSync(of, JSON.stringify({ status: 0, stdout: "GREEN" }));
    return 0;
  }, { outDir, tmp: outDir });
  assert.equal(result.aborted, undefined);
  assert.equal(calls, 5); // the harness error did not stop later recall turns or case checks
  assert.equal(result.runes["rule-a"].harness, 1);
  assert.equal(result.runes["rule-a"].unprompted.ran, 2);
  assert.equal(result.runes["rule-a"].verdict, "No Verdict: Harness Error");
  // timedOut stays a fail.
  outDir = mk();
  result = runSuite(loadSuite(lib), {}, (cf, of) => (writeFileSync(of, JSON.stringify({ timedOut: true, status: 1 })), 101), { outDir, tmp: outDir });
  assert.equal(result.aborted, undefined);
  assert.equal(result.runes["rule-a"].verdict, "Keep Always-On");
});

test("an unprompted recall miss still runs both check arms for every case", () => {
  const lib = makeLib({ "rule-a": { c1: {}, c2: {} }, "rule-b": { c1: {} } });
  const { result, log } = run(lib, (b) => (b.arm === "off" || b.target === "rule-a"
    ? { result: { stdout: b.arm === "off" ? "no" : "GREEN" }, transcript: "" }
    : { result: { stdout: "GREEN" }, transcript: readLine("rule-b") }));
  assert.equal(log.filter((l) => l === "rule-a:recall:-").length, 6);
  assert.equal(log.filter((l) => l === "rule-a:off:-").length, 2);
  assert.equal(log.filter((l) => l === "rule-a:always:-").length, 2);
  assert.ok(log.includes("rule-b:recall:-") && log.includes("rule-b:off:-") && log.includes("rule-b:always:-"));
  assert.equal(result.runes["rule-a"].verdict, "Keep Always-On");
  assert.equal(result.runes["rule-a"].readRate, 0);
});

test("Falcon off arm runs after all recall turns miss", { skip: runesSkip }, () => {
  const cases = loadSuite(repoRunes, ["falcon-strips-vidar-tab"]).filter((c) => c.kind === "unprompted");
  const outDir = mkdtempSync(join(tmpdir(), "eval-runes-out-"));
  const log = [];
  runSuite(cases, { model: "sonnet", confirmModel: "opus" }, fakeRunner(() => ({ result: { stdout: "no" }, transcript: "" }), log), { outDir, tmp: outDir });
  assert.deepEqual(log.slice(0, 6), [
    ...Array(3).fill("falcon-strips-vidar-tab:recall:sonnet"),
    ...Array(3).fill("falcon-strips-vidar-tab:recall:opus"),
  ]);
  assert.ok(log.includes("falcon-strips-vidar-tab:off:sonnet"));
  assert.ok(log.includes("falcon-strips-vidar-tab:always:sonnet"));
});

test("Astra case rejects a generic done marker and timeout answer", { skip: runesSkip }, () => {
  const [c] = loadSuite(repoRunes, ["astra-dispatch-wait"]).filter((c) => c.kind === "unprompted");
  assert.deepEqual(c.runes, ["astra-dispatch-wait"]);
  assert.equal(c.scaffold, undefined);
  const g = grade(c, "off", { stdout: "Wait for done.json, then read the report. Give it 20 min." }, "");
  assert.equal(g.pass, false);
  assert.equal(g.fact, false);
  assert.equal(g.behaviour, false);
});

test("recall read plus always pass without an off pass is Recall-Safe; an off pass says check the case", () => {
  const lib = makeLib({ "rule-a": { c1: {} } });
  const safe = run(lib, (b) => (b.arm === "off" ? { result: { stdout: "no" } } : { result: { stdout: "GREEN" }, transcript: readLine("rule-a") }));
  assert.equal(safe.result.runes["rule-a"].verdict, "Recall-Safe");
  assert.match(readFileSync(join(safe.outDir, "report.md"), "utf8"), /synthetic scaffold/);
  const off = run(lib, () => ({ result: { stdout: "GREEN" }, transcript: readLine("rule-a") }));
  assert.equal(off.result.runes["rule-a"].verdict, "Off Arm Passes: Check the Case");
});

test("the confirm model re-runs the unprompted recall arm", () => {
  const lib = makeLib({ "rule-a": { c1: {} } });
  const { log } = run(lib, () => ({ result: { stdout: "GREEN" }, transcript: readLine("rule-a") }), { model: "sonnet", confirmModel: "opus" });
  assert.deepEqual(log.slice(0, 6), [
    ...Array(3).fill("rule-a:recall:sonnet"), ...Array(3).fill("rule-a:recall:opus"),
  ]);
});

test("each model and case needs two of three recall passes", () => {
  const lib = makeLib({ "rule-a": { c1: {}, c2: {} } });
  const counts = new Map();
  const answer = (b) => {
    if (b.arm === "off") return { result: { stdout: "no" } };
    const key = `${b.model}:${b.prompt}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const misses = b.model === "opus" && b.prompt.includes("c2") ? 2 : 1;
    return { result: { stdout: "GREEN" }, transcript: n <= misses ? "" : readLine("rule-a") };
  };
  const { result } = run(lib, answer, { model: "sonnet", confirmModel: "opus" });
  assert.equal(result.runes["rule-a"].cases.c1.recall.pass, 2);
  assert.equal(result.runes["rule-a"].cases.c1.confirm.pass, 2);
  assert.equal(result.runes["rule-a"].cases.c2.confirm.pass, 1);
  assert.equal(result.runes["rule-a"].verdict, "Keep Always-On");
  counts.clear();
  const safe = run(makeLib({ "rule-a": { c1: {} } }), answer, { model: "sonnet", confirmModel: "opus" });
  assert.equal(safe.result.runes["rule-a"].verdict, "Recall-Safe");
});

test("the plan counts recall, confirm and case checks; alternate case order flips", () => {
  const lib = makeLib({ "rule-a": { c1: {}, c2: { kind: "prompted", arms: ["recall", "off"] } } });
  const plan = planSessions(loadSuite(lib), { confirmModel: "opus" });
  assert.deepEqual(plan.map((p) => `${p.phase}:${p.c.name}:${p.arm}`), [
    ...Array(3).fill("recall:c1:recall"), ...Array(3).fill("confirm:c1:recall"),
    "check:c1:off", "check:c1:always", "check:c2:off", "check:c2:recall",
  ]);
});

test("--dry prints the count; a real run refuses without a matching --confirm", () => {
  const lib = makeLib({ "rule-a": { c1: {} }, "rule-b": { c1: {} } });
  const dry = spawnSync("node", [tool, "--lib", lib, "--dry"], { encoding: "utf8" });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /10 sessions planned/);
  for (const args of [[], ["--confirm", "9"]]) {
    const r = spawnSync("node", [tool, "--lib", lib, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /planned count 10/);
  }
});

test("Codex selects its probe and plans the same count without running a session", () => {
  const calls = [];
  spawnRunner("C:/repo", "codex", (...args) => (calls.push(args), { status: 0, stdout: "", stderr: "" }))("case.json", "out.json", {});
  assert.ok(calls[0][1].includes(TESTS.codex));
  assert.ok(!calls[0][1].includes(TESTS.claude));

  const lib = makeLib({ "rule-a": { c1: {} }, "rule-b": { c1: {} } });
  const dry = spawnSync("node", [tool, "--lib", lib, "--agent", "codex", "--dry"], { encoding: "utf8" });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /10 sessions planned/);
  for (const flag of ["--model", "--confirm-model"]) {
    const refused = spawnSync("node", [tool, "--lib", lib, "--agent", "codex", flag, "sonnet", "--dry"], { encoding: "utf8" });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /Claude-only/);
  }
});
