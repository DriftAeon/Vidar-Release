// finding verb: validated append to $VIDAR_EXPLORER_RUN/findings.jsonl; no CDP, no budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildFinding, appendFinding, findingMain } from "../tools/drive/verbs/finding.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "drive-finding-"));
const full = { t: "2026-10-24T10:00:00.000Z", goal: "g", step: 1, intent: "i", did: "d", observed: "o", expected: "e", kind: "fail", episode: "ep" };
const read = (run) => fs.readFileSync(path.join(run, "findings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a valid line is appended as is", () => {
  const run = tmp();
  appendFinding(JSON.stringify(full), { VIDAR_EXPLORER_RUN: run });
  appendFinding(JSON.stringify({ ...full, step: 2 }), { VIDAR_EXPLORER_RUN: run });
  assert.deepEqual(read(run), [full, { ...full, step: 2 }]);
});

test("an invalid line is refused and nothing is written", () => {
  const run = tmp();
  const r = appendFinding(JSON.stringify({ ...full, kind: "nope" }), { VIDAR_EXPLORER_RUN: run });
  assert.ok(r.errors.some((e) => /kind/.test(e)));
  assert.equal(appendFinding("{not json", { VIDAR_EXPLORER_RUN: run }).errors.length, 1);
  assert.equal(fs.existsSync(path.join(run, "findings.jsonl")), false);
});

test("t and episode are filled when missing; given ones are kept", () => {
  const { t, episode, ...bare } = full;
  const now = new Date("2026-10-25T01:02:03.000Z");
  const r = buildFinding(JSON.stringify(bare), { VIDAR_EXPLORER_RUN: "x", VIDAR_EXPLORER_EPISODE: "7" }, now);
  assert.equal(r.line.t, now.toISOString());
  assert.equal(r.line.episode, "7");
  assert.equal(buildFinding(JSON.stringify(full), { VIDAR_EXPLORER_RUN: "x", VIDAR_EXPLORER_EPISODE: "7" }, now).line.episode, "ep");
});

test("an unset run is refused", () => {
  const r = appendFinding(JSON.stringify(full), {});
  assert.match(r.errors[0], /VIDAR_EXPLORER_RUN is unset/);
  assert.equal(findingMain([JSON.stringify(full)], {}), 2);
});

test("@path reads a long payload", () => {
  const run = tmp(), file = path.join(run, "f.json");
  fs.writeFileSync(file, JSON.stringify(full));
  appendFinding(`@${file}`, { VIDAR_EXPLORER_RUN: run });
  assert.deepEqual(read(run), [full]);
  assert.match(buildFinding("@/no/such.json", { VIDAR_EXPLORER_RUN: run }).errors[0], /cannot read/);
});

test("the CLI answers without DevTools or a budget, in explorer mode", () => {
  const run = tmp();
  const env = { ...process.env, VIDAR_DRIVE_EXPLORER: "1", VIDAR_EXPLORER_RUN: run, VIDAR_EXPLORER_EPISODE: "cli", VIDAR_CDP_PORT: "1" };
  const bin = new URL("../tools/drive/vidar-drive.mjs", import.meta.url);
  const { t, episode, ...bare } = full;
  const ok = spawnSync(process.execPath, [bin.pathname.replace(/^\/(\w:)/, "$1"), "finding", JSON.stringify(bare)], { env, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(read(run)[0].episode, "cli");
  const bad = spawnSync(process.execPath, [bin.pathname.replace(/^\/(\w:)/, "$1"), "finding", "{}"], { env, encoding: "utf8" });
  assert.equal(bad.status, 2);
});
