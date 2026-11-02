import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findHits, familyCovers, covers, loadFamilies, compileShapes, judge, nextFrozen } from "./one-home.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CLI = join(HERE, "one-home.mjs");
const [CAP] = loadFamilies();

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const temp = () => mkdtempSync(join(tmpdir(), "one-home-"));
const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const family = (extra = {}) => ({
  id: "probe",
  home: ["lib/home.rs"],
  use: "the home helper",
  scan: { roots: ["lib"], ext: [".rs"] },
  shapes: [{ lit: "hand_rolled(" }, { re: "copy_of_\\w+\\(" }],
  frozen: {},
  ...extra,
});

test("one-home: each capitalizer shape is flagged", () => {
  for (const line of [
    "const a = s.charAt(0).toUpperCase() + s.slice(1);",
    "const a = s[0].toUpperCase() + s.slice(1);",
    "const a = `${s.charAt(0).toUpperCase()}${s.slice(1)}`;",
    "const a = s.toUpperCase() + t.slice(1);",
  ]) assert.equal(findHits(CAP, line).length, 1, line);
});

test("one-home: the mark on the line passes, plain uses pass", () => {
  assert.deepEqual(findHits(CAP, "const k = id.charAt(0).toUpperCase() + id.slice(1); // case-ok: wire key"), []);
  assert.deepEqual(findHits(CAP, "const k = e.key.toUpperCase();"), []);
});

test("one-home: lit and re shapes match, the default mark is home-ok:", () => {
  const f = family();
  assert.equal(findHits(f, "x = hand_rolled(1);").length, 1);
  assert.equal(findHits(f, "x = copy_of_thing(1);").length, 1);
  assert.deepEqual(findHits(f, "x = hand_rolled(1); // home-ok: wire"), []);
  assert.deepEqual(findHits(f, "x = other(1);"), []);
  assert.equal(compileShapes(f).length, 2);
});

test("one-home: covers skips tests, .d.ts, home files and other roots", () => {
  assert.equal(covers("src/a/b.ts"), true);
  assert.equal(covers("src/a/b.test.ts"), false);
  assert.equal(covers("src/types.d.ts"), false);
  assert.equal(familyCovers(CAP, "src/format.ts"), false, "a family skips its own home");
  assert.equal(covers("tools/x.ts"), false);
  assert.equal(covers("src/a/b.css"), false);
  assert.equal(covers("contracts/one-home.json"), true);
});

test("one-home: the CLI fails on a planted copy and passes on a marked line", () => {
  const root = temp();
  try {
    put(root, "src/probe.ts", "export const x = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);\n");
    const bad = run("--root", root);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /one-home: src\/probe\.ts:1 capitalizer — use label or titleWords from src\/format\.ts/);
    put(root, "src/probe.ts", "export const x = (s: string) => s.charAt(0).toUpperCase() + s.slice(1); // case-ok: probe\n");
    const ok = run("--root", root);
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one-home: frozen over fails, equal passes, under warns", () => {
  const hits = (n) => new Map([["a.ts", Array.from({ length: n }, (_, i) => ({ line: i + 1, text: "x" }))]]);
  const f = family({ frozen: { "a.ts": 2 } });
  assert.equal(judge([{ family: f, files: hits(3) }]).failures.length, 3);
  assert.deepEqual(judge([{ family: f, files: hits(2) }]), { failures: [], warnings: [] });
  const under = judge([{ family: f, files: hits(1) }]);
  assert.deepEqual(under.failures, []);
  assert.deepEqual(under.warnings, ["warning one-home: probe a.ts can drop to 1"]);
  assert.deepEqual(judge([{ family: f, files: new Map() }]).warnings, ["warning one-home: probe a.ts can drop to 0"]);
});

test("one-home: nextFrozen seeds and lowers, never raises", () => {
  const files = new Map([
    ["a.ts", [{ line: 1, text: "" }, { line: 2, text: "" }, { line: 3, text: "" }]],
    ["b.ts", [{ line: 1, text: "" }]],
    ["c.ts", [{ line: 1, text: "" }]],
  ]);
  const f = family({ frozen: { "a.ts": 2, "b.ts": 5, "gone.ts": 1 } });
  assert.deepEqual(nextFrozen(f, files), { "a.ts": 2, "b.ts": 1, "c.ts": 1 });
});

test("one-home: a .rs root under a throwaway family, with frozen and --write", () => {
  const root = temp();
  try {
    put(root, "lib/home.rs", "fn hand_rolled() {}\nhand_rolled(1);\n");
    put(root, "lib/a.rs", "let a = hand_rolled(1);\nlet b = hand_rolled(2);\n");
    put(root, "lib/a.test.rs", "hand_rolled(1);\n");
    const contract = join(root, "contract.json");
    writeFileSync(contract, JSON.stringify({ families: [family()] }));
    const bad = run("--root", root, "--contract", contract);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /one-home: lib\/a\.rs:1 probe — use the home helper/);
    assert.match(bad.stderr, /one-home: lib\/a\.rs:2 probe/);
    assert.doesNotMatch(bad.stderr, /home\.rs|a\.test\.rs/);

    const all = run("--root", root, "--contract", contract, "--all");
    assert.equal(all.status, 0);
    assert.match(all.stdout, /probe lib\/a\.rs:1:/);

    const seed = run("--root", root, "--contract", contract, "--write", "--family", "probe");
    assert.equal(seed.status, 0, seed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(contract, "utf8")).families[0].frozen, { "lib/a.rs": 2 });
    assert.equal(run("--root", root, "--contract", contract).status, 0);

    put(root, "lib/a.rs", "let a = hand_rolled(1);\n");
    const under = run("--root", root, "--contract", contract);
    assert.equal(under.status, 0);
    assert.match(under.stdout, /warning one-home: probe lib\/a\.rs can drop to 1/);
    assert.equal(run("--root", root, "--contract", contract, "--write", "--family", "probe").status, 0);
    assert.deepEqual(JSON.parse(readFileSync(contract, "utf8")).families[0].frozen, { "lib/a.rs": 1 });

    assert.equal(run("--write").status, 1);
    assert.equal(run("--family", "nope").status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one-home: contracts/one-home.json is sound (homes exist, regexes compile, ids unique)", () => {
  const families = loadFamilies();
  assert.ok(families.length >= 1);
  const ids = families.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate family id");
  for (const f of families) {
    assert.ok(f.id && f.use && f.origin, `${f.id}: id, use and origin are required`);
    assert.ok(f.home.length >= 1, `${f.id}: needs a home`);
    for (const h of f.home) assert.ok(existsSync(join(REPO, h)), `${f.id}: home ${h} is missing`);
    assert.ok(f.scan.roots.length && f.scan.ext.length, `${f.id}: scan roots and ext`);
    for (const r of f.scan.roots) assert.ok(existsSync(join(REPO, r)), `${f.id}: root ${r} is missing`);
    assert.ok(f.shapes.length >= 1, `${f.id}: needs a shape`);
    assert.doesNotThrow(() => compileShapes(f), `${f.id}: a shape does not compile`);
    for (const rel of Object.keys(f.frozen || {})) assert.ok(existsSync(join(REPO, rel)), `${f.id}: frozen ${rel} is missing`);
  }
});

test("one-home: the real tree is clean", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
});
