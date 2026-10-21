// slot.mjs against a temp library and a temp repo (--root/--repo); the real repo is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = join(dirname(fileURLToPath(import.meta.url)), "slot.mjs");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "slot-"));
  const root = join(dir, "lib");
  const repo = join(dir, "repo");
  mkdirSync(join(root, "fluent-color", "svg"), { recursive: true });
  mkdirSync(join(root, "brands"), { recursive: true });
  mkdirSync(join(root, "mystery"), { recursive: true });
  mkdirSync(join(repo, "contracts"), { recursive: true });
  mkdirSync(join(repo, "public", "icons", "color"), { recursive: true });
  writeFileSync(join(root, "fluent-color", "svg", "a.svg"), "<svg><path/></svg>");
  writeFileSync(join(root, "fluent-color", "svg", "b.svg"), "<svg><circle/></svg>");
  writeFileSync(join(root, "fluent-color", "svg", "c.png"), "PNGDATA");
  writeFileSync(join(root, "brands", "x.svg"), '<svg viewBox="0 0 1 1"><path/></svg>');
  writeFileSync(join(root, "mystery", "m.svg"), "<svg/>");
  writeFileSync(join(dir, "outside.svg"), "<svg/>");
  const m = { sets: { "fluent-color": { name: "Fluent Color", licence: "MIT" }, brands: { name: "Simple Icons", licence: "CC0" } }, icons: {}, tools: {}, backends: {} };
  writeFileSync(join(repo, "contracts", "icons.json"), JSON.stringify(m));
  return { dir, root, repo };
}
const run = (f, args) => spawnSync(process.execPath, [script, ...args, "--root", f.root, "--repo", f.repo], { encoding: "utf8" });
const manifest = (f) => JSON.parse(readFileSync(join(f.repo, "contracts", "icons.json"), "utf8"));
const snapshot = (f) => readFileSync(join(f.repo, "contracts", "icons.json"), "utf8");

test("slots a file, maps a tool and writes provenance", () => {
  const f = fixture();
  const r = run(f, ["mail", "fluent-color/svg/a.svg", "--tool", "SendMessage"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(manifest(f).tools.SendMessage, "mail");
  assert.ok(existsSync(join(f.repo, "public", "icons", "color", "mail.svg")));
  assert.match(readFileSync(join(f.repo, "public", "icons", "color", "PROVENANCE.md"), "utf8"), /\| mail\.svg \| fluent-color\/svg\/a\.svg \| Fluent Color, MIT \|/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("refusals exit non-zero and change nothing", () => {
  const f = fixture();
  assert.equal(run(f, ["mail", "fluent-color/svg/a.svg"]).status, 0);
  const before = snapshot(f);
  const cases = [
    ["Bad_Name", "fluent-color/svg/a.svg"],
    ["x1", "../outside.svg"],
    ["x2", "fluent-color/svg/missing.svg"],
    ["x3", "mystery/m.svg"],
    ["mail", "fluent-color/svg/b.svg"], // clash without --replace
    ["x4", "fluent-color/svg/a.svg", "--tool", "T", "--note"], // flag without value
    ["nope", "-"], // map-only on an unknown name
  ];
  for (const c of cases) {
    const r = run(f, c);
    assert.notEqual(r.status, 0, `expected refusal for ${c.join(" ")}`);
  }
  assert.equal(snapshot(f), before);
  assert.ok(!existsSync(join(f.repo, "public", "icons", "color", "x1.svg")));
  rmSync(f.dir, { recursive: true, force: true });
});

test("same source is a file no-op; --replace with a new extension removes the old file", () => {
  const f = fixture();
  const color = join(f.repo, "public", "icons", "color");
  run(f, ["mail", "fluent-color/svg/a.svg"]);
  writeFileSync(join(color, "mail.svg"), "EDITED");
  assert.equal(run(f, ["mail", "fluent-color/svg/a.svg", "--tool", "T"]).status, 0);
  assert.equal(readFileSync(join(color, "mail.svg"), "utf8"), "EDITED");
  assert.equal(manifest(f).tools.T, "mail");
  assert.equal(run(f, ["mail", "fluent-color/svg/c.png", "--replace"]).status, 0);
  assert.ok(existsSync(join(color, "mail.png")));
  assert.ok(!existsSync(join(color, "mail.svg")));
  rmSync(f.dir, { recursive: true, force: true });
});

test("map-only needs an existing icon; backend and brand fill", () => {
  const f = fixture();
  assert.notEqual(run(f, ["ghost", "-", "--tool", "X"]).status, 0);
  assert.equal(run(f, ["brand", "brands/x.svg", "--backend", "unreal"]).status, 0);
  assert.equal(manifest(f).backends.unreal, "brand");
  assert.match(readFileSync(join(f.repo, "public", "icons", "color", "brand.svg"), "utf8"), /fill="#e6e6e6"/);
  assert.equal(run(f, ["brand", "-", "--tool", "WebSearch"]).status, 0);
  rmSync(f.dir, { recursive: true, force: true });
});
