import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_GOAL_IDS } from "../tools/explorer/core-goals.mjs";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const fixture = (name) => join(here, "fixtures", "explorer-tools", name);
const script = (name) => join(here, "..", "tools", "explorer", name);
const run = (name, ...args) => spawnSync(process.execPath, [script(name), ...args], { cwd: join(here, ".."), encoding: "utf8" });
const audit = (name) => run("report-audit.mjs", "--run", fixture(name));

test("report audit: clean run", () => {
  const result = audit("clean");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});
test("report audit: planted unlogged press", () => {
  const result = audit("unlogged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /g1:.*inputs without detour:.*run-log\.jsonl:1\.\.run-log\.jsonl:7/);
});
test("report audit: unnoticed miss", () => {
  const result = audit("unnoticed");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /g1:.*unnoticed miss: run-log\.jsonl:1/);
});
test("report audit: unreported tail", () => {
  const result = audit("tail");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /g1:.*unreported tail:.*run-log\.jsonl:1\.\.run-log\.jsonl:7/);
});
test("report audit: invalid line", () => {
  const result = audit("bad-line");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /g1:.*invalid line: run-log\.jsonl:1: args/);
});
test("report audit: bad args", () => assert.equal(run("report-audit.mjs").status, 2));
test("report audit: sorts by time and detour resets the input span", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "explorer-audit-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(dir, { recursive: true, force: true }); });
  const at = (second) => `2026-10-24T00:00:${String(second).padStart(2, "0")}Z`;
  const logs = [1, 2, 3, 5, 6, 7, 8].reverse().map((second) => ({
    t: at(second), port: 1, episode: "g1", verb: "press", args: [], exit: 0,
  }));
  const finding = (second, kind) => ({ t: at(second), goal: "g1", step: second,
    intent: "Open", did: "Pressed", observed: "Open", expected: "Open", kind });
  await writeFile(join(dir, "run-log.jsonl"), `${logs.map(JSON.stringify).join("\n")}\n`);
  await writeFile(join(dir, "findings.jsonl"),
    `${[finding(9, "pass"), finding(4, "detour"), finding(0, "pass")].map(JSON.stringify).join("\n")}\n`);
  const result = run("report-audit.mjs", "--run", dir);
  assert.equal(result.status, 0, result.stderr);
});

test("report audit: finding episode wins over the time rule", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "explorer-audit-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(dir, { recursive: true, force: true }); });
  const at = (second) => `2026-10-24T00:00:${String(second).padStart(2, "0")}Z`;
  const log = (second, episode, extra = {}) => ({ t: at(second), port: 1, episode, verb: "press", args: [], exit: 0, ...extra });
  const logs = [log(1, "a", { hit: { ok: false } }), log(3, "b")];
  // By time the finding at second 5 falls into episode b; its episode field puts it in a.
  const finding = { t: at(5), goal: "other", episode: "a", step: 1, intent: "i", did: "d", observed: "o", expected: "x", kind: "fail" };
  await writeFile(join(dir, "run-log.jsonl"), `${logs.map(JSON.stringify).join("\n")}\n`);
  await writeFile(join(dir, "findings.jsonl"), `${JSON.stringify(finding)}\n`);
  assert.equal(run("report-audit.mjs", "--run", dir).status, 0);
  await writeFile(join(dir, "findings.jsonl"), `${JSON.stringify({ ...finding, episode: undefined })}\n`);
  const result = run("report-audit.mjs", "--run", dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unnoticed miss/);
});

test("render: expected headings, fields and relative shot link", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "explorer-render-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(out, { recursive: true, force: true }); });
  const result = run("render.mjs", "--run", fixture("clean"), "--out", out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(out, "report.md"));
  const report = await readFile(join(out, "report.md"), "utf8");
  const expected = (await readFile(fixture("render-expected.txt"), "utf8")).trim().split(/\r?\n/);
  for (const fragment of expected) assert.ok(report.includes(fragment), `missing ${fragment}`);
  for (const field of ["Intent: Open Settings", "Did: Pressed Settings", "Observed: Settings Open", "Expected: Settings Open"])
    assert.ok(report.includes(field), `missing ${field}`);
  assert.deepEqual((await readdir(out)).sort(), ["report.md", "shot-1.png"]);
  assert.deepEqual(await readFile(join(out, "shot-1.png")), await readFile(fixture("clean/shots/settings.png")));
});

async function goalDir(t, missing, badModel = false) {
  const dir = await mkdtemp(join(tmpdir(), "explorer-goals-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(dir, { recursive: true, force: true }); });
  const template = JSON.parse(await readFile(fixture("goal-template.json"), "utf8"));
  for (const id of CORE_GOAL_IDS) {
    if (id === missing) continue;
    const goal = { ...template, id, title: id };
    if (id === "core-fresh-model-claude" && badModel) goal.realModel = false;
    await writeFile(join(dir, `${id}.json`), JSON.stringify(goal));
  }
  return dir;
}
test("check goals: complete core set", async (t) => {
  const result = run("check-goals.mjs", "--dir", await goalDir(t));
  assert.equal(result.status, 0, result.stderr);
});
test("check goals: missing core id", async (t) => {
  const result = run("check-goals.mjs", "--dir", await goalDir(t, "core-fresh-cwd-codex"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing core goal id core-fresh-cwd-codex/);
});
test("check goals: duplicate id", async (t) => {
  const dir = await goalDir(t);
  const template = JSON.parse(await readFile(fixture("goal-template.json"), "utf8"));
  await writeFile(join(dir, "duplicate.json"), JSON.stringify(template));
  const result = run("check-goals.mjs", "--dir", dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate id core-fresh-model-claude/);
});
test("check goals: model tag requires realModel", async (t) => {
  const result = run("check-goals.mjs", "--dir", await goalDir(t, null, true));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /core-fresh-model-claude\.json: realModel: must be true/);
});
test("check goals: bad args", () => assert.equal(run("check-goals.mjs", "--wrong").status, 2));
