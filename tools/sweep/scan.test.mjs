// Sweep scan: diff semantics and CLI checks with injected lanes and exec (no network, no tools).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffLane, main, uniqueKeys } from "./scan.mjs";

const f = (key, line) => ({ key, line, msg: key });

function sandbox(laneResults, { dirty = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-test-"));
  const out = [];
  const err = [];
  const lanes = Object.entries(laneResults).map(([id, res]) => ({ id, kind: "tracked", run: () => res }));
  const exec = (cmd) => ({
    code: 0, ms: 0, stderr: "",
    stdout: cmd.startsWith("git status") ? dirty : cmd.startsWith("git rev-parse") ? "abcdef1234567\n" : "",
  });
  const deps = {
    root: dir, exec, lanes, versions: { node: "v1" },
    stateDir: path.join(dir, "snapshots"), reviewsDir: path.join(dir, "reviews"),
    out: (s) => out.push(s), err: (s) => err.push(s), now: () => new Date(2026, 9, 9),
  };
  return { dir, deps, out, err };
}

test("a finding that moves lines stays persisting", () => {
  const d = diffLane("tracked", [f("k", 5)], { ok: true, findings: [f("k", 90)] });
  assert.equal(d.persisting.length, 1);
  assert.equal(d.persisting[0].line, 90);
  assert.deepEqual([d.new.length, d.fixed.length], [0, 0]);
});

test("an errored lane reports nothing fixed and carries findings forward as stale", () => {
  const d = diffLane("tracked", [f("a"), f("b")], { ok: false, error: "offline", findings: [] });
  assert.equal(d.fixed.length, 0);
  assert.equal(d.new.length, 0);
  assert.equal(d.findings.length, 2);
  assert.ok(d.findings.every((x) => x.stale === true));
});

test("new and fixed split against a seeded baseline", () => {
  const d = diffLane("tracked", [f("keep"), f("gone")], { ok: true, findings: [f("keep"), f("fresh")] });
  assert.deepEqual(d.new.map((x) => x.key), ["fresh"]);
  assert.deepEqual(d.fixed.map((x) => x.key), ["gone"]);
  assert.deepEqual(d.persisting.map((x) => x.key), ["keep"]);
});

test("repeated keys in one lane get an ordinal so the diff stays a set", () => {
  assert.deepEqual(uniqueKeys([f("x"), f("x"), f("y")]).map((x) => x.key), ["x", "x#2", "y"]);
});

test("--lanes rejects an unknown id with exit 2", () => {
  const s = sandbox({ one: { ok: true, cmd: "c", findings: [] } });
  assert.equal(main(["--lanes", "one,nope"], s.deps), 2);
  assert.match(s.err.join(""), /unknown lane id nope/);
});

test("--record refuses a dirty tree and writes nothing", () => {
  const s = sandbox({ one: { ok: true, cmd: "c", findings: [] } }, { dirty: " M src/x.ts\n" });
  assert.equal(main(["--record"], s.deps), 2);
  assert.equal(fs.existsSync(s.deps.stateDir), false);
});

test("--record on a seeded baseline writes the snapshot and no ledger", () => {
  const s = sandbox({ one: { ok: true, cmd: "c", findings: [f("keep"), f("fresh")] } });
  fs.mkdirSync(s.deps.stateDir, { recursive: true });
  const seed = path.join(s.deps.stateDir, "2026-10-02-1111111.json");
  fs.writeFileSync(seed, JSON.stringify({
    version: 1, date: "2026-10-02", head: "1111111", versions: { node: "v1" },
    lanes: { one: { ok: true, cmd: "c", findings: [f("keep"), f("gone")] } },
  }));
  assert.equal(main(["--record"], s.deps), 0);
  const snap = JSON.parse(fs.readFileSync(path.join(s.deps.stateDir, "2026-10-09-abcdef1.json"), "utf8"));
  assert.equal(snap.lanes.one.findings.length, 2);
  assert.match(s.out.join(""), /one/);
  assert.equal(fs.existsSync(path.join(s.dir, "sweeps.tsv")), false);
});

test("an errored lane exits 1 and the recorded snapshot keeps its stale findings", () => {
  const s = sandbox({ one: { ok: false, cmd: "c", error: "offline", findings: [] } });
  fs.mkdirSync(s.deps.stateDir, { recursive: true });
  fs.writeFileSync(path.join(s.deps.stateDir, "2026-10-02-1111111.json"), JSON.stringify({
    version: 1, date: "2026-10-02", head: "1111111", versions: {},
    lanes: { one: { ok: true, cmd: "c", findings: [f("a")] } },
  }));
  assert.equal(main(["--record"], s.deps), 1);
  const snap = JSON.parse(fs.readFileSync(path.join(s.deps.stateDir, "2026-10-09-abcdef1.json"), "utf8"));
  assert.equal(snap.lanes.one.findings[0].stale, true);
});
