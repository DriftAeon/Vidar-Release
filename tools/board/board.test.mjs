import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rel } from "../lib/paths.mjs";
import { isExportedTree } from "../lib/release-layout.mjs";
import { validate } from "./board.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SCRIPT = join(HERE, "board.mjs");

// Card commits resolve against git: a source export or zip has no .git, so those tests skip.
const noGit = existsSync(join(ROOT, ".git")) ? false : ".git is not in this tree (export or zip); card commits cannot resolve";

const check = (file) => spawnSync(process.execPath, [SCRIPT, file, "--check"], { encoding: "utf8" });

test("a done card with an unresolvable commit and missing evidence fails --check with both messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-test-"));
  try {
    const file = join(dir, "board.json");
    writeFileSync(file, JSON.stringify({
      title: "T", goal: "G", notes: "docs/INDEX.md", exitTest: [],
      cards: [{ id: "X1", kind: "core", title: "Ghost", status: "done",
                commit: "0000000deadbeef", evidence: ["docs/no-such-file-for-board-test.md"] }],
    }));
    const r = check(file);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /X1: commit "0000000deadbeef" does not resolve/);
    assert.match(r.stderr, /X1: evidence has no path that exists on disk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate accepts missing git-ignored run evidence and still rejects missing tracked evidence", { skip: noGit }, () => {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const card = (evidence) => ({ id: "E1", kind: "core", title: "Ev", status: "done", commit, evidence });
  const board = (evidence) => ({ title: "T", goal: "G", notes: "docs/INDEX.md", exitTest: [], cards: [card(evidence)] });
  const ignored = `${rel("runs")}/2000-01-01-no-such-run/NOTES.md`; // gitignored, absent in a fresh worktree
  assert.deepEqual(validate(board([ignored])), []);
  assert.match(validate(board(["docs/no-such-file-for-board-test.md"])).join("\n"), /E1: evidence has no path that exists on disk/);
});

test("where lists an open park under its run card and in Parked; closed and near-miss lines stay out", () => {
  const dir = mkdtempSync(join(tmpdir(), "where-test-"));
  try {
    const run = "2026-10-01-fx";
    const at = (rel) => join(dir, ...rel.split("/"));
    for (const d of ["tools/lib", "contracts", "docs/projects/x", `docs/runs/${run}`]) mkdirSync(at(d), { recursive: true });
    writeFileSync(at("contracts/paths.json"), "");
    writeFileSync(at("docs/projects/x/board.json"), JSON.stringify({
      title: "Fixture", goal: "G", notes: `docs/runs/${run}/NOTES.md`,
      exitTest: [{ text: "It works", status: "open" }],
      cards: [{ id: "C1", kind: "core", title: "Park Card", status: "doing", goal: "g", doneWhen: "d", next: "n",
                run, evidence: ["docs/projects/x/board.json"] }],
    }));
    writeFileSync(at(`docs/runs/${run}/NOTES.md`),
      ["- parked A1: x", "- parked A2: y", "- unparked A2: z", "- parkedish: w", "- parked the migration until Monday", ""].join("\n"));
    const r = spawnSync(process.execPath, [join(HERE, "where.mjs"), "--root", dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /## Handoff/);
    const [head, tail] = r.stdout.split("## Git");
    const [boardsPart, parkedPart] = head.split("## Parked");
    assert.match(boardsPart, /C1 · Park Card[\s\S]*parked A1: x/);
    assert.match(parkedPart, /parked A1: x/);
    assert.doesNotMatch(head, /\bA2\b/);
    assert.doesNotMatch(head, /parkedish/);
    assert.doesNotMatch(head, /migration/);
    const runsPart = tail.split("## Runs")[1];
    assert.match(runsPart, /- parkedish: w/);
    assert.match(runsPart, /- parked the migration until Monday/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("where closes a park by an unpark with a paren or at end of line, and skips filed runs in Parked and Close-out gaps", () => {
  const dir = mkdtempSync(join(tmpdir(), "where-test-"));
  try {
    const live = "2026-10-20-live";
    const filed = "2026-10-20-filed";
    const runsDir = join(dir, ...rel("runs").split("/"));
    for (const d of ["tools/lib", "contracts"]) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, "contracts", "paths.json"), "");
    const archive = join(dirname(runsDir), "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "INDEX.md"), `## Runs\n\n- ../runs/${filed}/ — filed run; closed\n`);
    const park = ["- parked P1: a", "- parked P2: b", "- parked P3: c", "- parked P4: d", "- unparked P1 (note): done", "- unparked P2", "- unparked P3: ok", ""].join("\n");
    mkdirSync(join(runsDir, live), { recursive: true });
    writeFileSync(join(runsDir, live, "NOTES.md"), park);
    mkdirSync(join(runsDir, filed), { recursive: true });
    writeFileSync(join(runsDir, filed, "NOTES.md"), "- parked F1: filed\nrun closed\n");
    const r = spawnSync(process.execPath, [join(HERE, "where.mjs"), "--root", dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const [, parkedPart, gapsPart] = r.stdout.split(/^## (?:Parked|Close-out gaps)$/m);
    assert.match(parkedPart, /parked P4: d/);
    assert.doesNotMatch(parkedPart, /P1|P2|P3/);
    assert.doesNotMatch(parkedPart, /F1|filed/);
    assert.doesNotMatch(gapsPart.split("## Git")[0], /filed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("where keeps an open exit row visible when every card is done",{ skip: noGit }, () => {
  const dir = mkdtempSync(join(tmpdir(), "where-test-"));
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  try {
    for (const d of ["tools/lib", "contracts", "docs/projects/x", rel("runs")]) mkdirSync(join(dir, ...d.split("/")), { recursive: true });
    writeFileSync(join(dir, "contracts", "paths.json"), "");
    writeFileSync(join(dir, "docs/projects/x/board.json"), JSON.stringify({
      title: "Fixture", goal: "G", notes: "package.json",
      exitTest: [{ text: "Push still unverified", status: "open" }],
      cards: [{ id: "C1", kind: "core", title: "Finished", status: "done", commit, evidence: ["package.json"] }], // validate resolves both against the real repo
    }));
    const r = spawnSync(process.execPath, [join(HERE, "where.mjs"), "--root", dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const boardsPart = r.stdout.split("## Parked")[0];
    assert.match(boardsPart, /\[open\] Push still unverified/);
    assert.match(boardsPart, /all done \(1 cards\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("where has no Handoff section and its Git section lists the newest commits", { skip: noGit }, () => {
  const r = spawnSync(process.execPath, [join(HERE, "where.mjs"), "--root", ROOT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /^## Handoff$/m);
  const git = r.stdout.split(/^## Git$/m)[1].split(/^## Runs$/m)[0];
  const [, list] = git.split("recent commits:\n");
  assert.ok(list, "Git section has a recent commits list");
  const commits = list.split("\n").filter((l) => /^ {2}[0-9a-f]{7,} /.test(l));
  assert.ok(commits.length >= 1 && commits.length <= 5, `commits listed: ${commits.length}`);
});

test("where exits 1 with a where: message on stderr when the Display write throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "where-test-"));
  try {
    mkdirSync(join(dir, "tools/lib"), { recursive: true });
    mkdirSync(join(dir, "contracts"), { recursive: true });
    writeFileSync(join(dir, "contracts", "paths.json"), "");
    const display = join(dir, ...rel("display").split("/"));
    mkdirSync(dirname(display), { recursive: true });
    writeFileSync(display, "not a directory"); // mkdir of the Display folder now fails
    const r = spawnSync(process.execPath, [join(HERE, "where.mjs"), "--display", "--root", dir], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^where: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function boards(dir, found = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) boards(p, found);
    else if (e.name === "board.json") found.push(p);
  }
  return found;
}

const docsSkip = noGit || (isExportedTree(ROOT) ? "docs/ is not in this tree (docs not shipped)" : false);

test("every docs/**/board.json passes --check", { skip: docsSkip }, () => {
  const found = boards(join(ROOT, "docs"));
  assert.ok(found.length > 0, "no board.json under docs/");
  // In-process validate (the same call --check makes); the spawned --check path is the first test's CLI smoke.
  for (const f of found) {
    const errs = validate(JSON.parse(readFileSync(f, "utf8")));
    assert.deepEqual(errs, [], f);
  }
});
