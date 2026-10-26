// tools/sandbox/sample-seed.mjs: both sample sets plant the toy git project at <base>\work\<set>, only the
// instructions set carries CLAUDE.md, AGENTS.md and a skill, vidar.json gets defaultCwd and the workspace with its
// other keys kept, vidar-state.json loses only its onboarding.* keys, a re-run or other set replaces the folder, --revert removes it, a base outside %TEMP% is refused,
// and launch.ps1 dry-runs both sets and still refuses an unknown one. Temp bases only; nothing starts.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { rel, resolve } from "../lib/paths.mjs";
import { MANIFEST, SETS, run, workDir } from "./sample-seed.mjs";

const LAUNCH = join(dirname(fileURLToPath(import.meta.url)), "launch.ps1");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const pwsh = (args) => spawnSync("pwsh", ["-NoProfile", "-File", ...args], { encoding: "utf8", env });
const fresh = () => mkdtempSync(join(tmpdir(), "sample-seed-"));
const config = (base) => resolve("config", { root: join(base, "app") });
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", join(".claude", "skills", "changelog-entry", "SKILL.md")];

test("sample-project plants the project with no instruction files and points vidar.json at it", () => {
  const base = fresh();
  try {
    mkdirSync(dirname(config(base)), { recursive: true });
    writeFileSync(config(base), '{"theme":"dark","locations":[{"label":"Mine","cwd":"X:\\\\mine"}]}');
    const r = run({ base, set: "sample-project" });
    assert.equal(r.code, 0, r.lines.join("\n"));
    const work = workDir(base, "sample-project");
    for (const f of ["README.md", "package.json", join("src", "cli.js"), join("src", "slug.js"), join("test", "slug.spec.mjs")]) {
      assert.ok(existsSync(join(work, f)), f);
    }
    for (const f of INSTRUCTION_FILES) assert.ok(!existsSync(join(work, f)), `${f} must be absent`);
    assert.ok(!existsSync(join(work, ".claude")));
    assert.match(readFileSync(join(work, ".git", "HEAD"), "utf8"), /refs\/heads\/main/);
    const c = JSON.parse(readFileSync(config(base), "utf8"));
    assert.equal(c.defaultCwd, work);
    assert.equal(c.theme, "dark", "the user's key survives");
    assert.deepEqual(c.locations.map((l) => l.label), ["Mine", "Sample Project"]);
    assert.equal(c.locations[1].cwd, work);
    const t = spawnSync(process.execPath, ["--test", "test/slug.spec.mjs"], { cwd: work, encoding: "utf8", env });
    assert.equal(t.status, 0, t.stdout + t.stderr);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("sample-project-instructions adds CLAUDE.md, AGENTS.md and one skill; switching sets replaces the folder", () => {
  const base = fresh();
  try {
    assert.equal(run({ base, set: "sample-project" }).code, 0);
    const r = run({ base, set: "sample-project-instructions" });
    assert.equal(r.code, 0, r.lines.join("\n"));
    const work = workDir(base, "sample-project-instructions");
    for (const f of INSTRUCTION_FILES) assert.ok(existsSync(join(work, f)), f);
    assert.ok(existsSync(join(work, "src", "slug.js")));
    assert.ok(!existsSync(workDir(base, "sample-project")), "the earlier set's folder is gone");
    assert.equal(JSON.parse(readFileSync(config(base), "utf8")).defaultCwd, work);
    assert.equal(run({ base, set: "sample-project-instructions" }).code, 0, "a re-run is clean");
    assert.equal(run({ base, revert: true }).code, 0);
    assert.ok(!existsSync(work) && !existsSync(join(base, MANIFEST)));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a dry run writes nothing; an unknown set and a stray base are refused; a foreign folder is not overwritten", () => {
  const base = fresh();
  try {
    const d = run({ base, set: "sample-project", dryRun: true });
    assert.equal(d.code, 0, d.lines.join("\n"));
    assert.ok(!existsSync(join(base, "work")) && !existsSync(config(base)));
    assert.equal(run({ base, set: "nope" }).code, 2);
    mkdirSync(workDir(base, "sample-project"), { recursive: true });
    assert.equal(run({ base, set: "sample-project" }).code, 1, "a folder no earlier run made");
    const stray = join(parse(tmpdir()).root, `vidar-sample-seed-absent-${process.pid}`);
    assert.equal(run({ base: stray, set: "sample-project", dryRun: true }).code, 2);
    assert.ok(!existsSync(stray));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

const uiState = (base) => resolve("uiState", { root: join(base, "app") });

test("a sample seed removes onboarding.* keys from vidar-state.json and keeps the rest", () => {
  const base = fresh();
  try {
    mkdirSync(dirname(uiState(base)), { recursive: true });
    writeFileSync(uiState(base), '{"onboarding.progress":{"step":"runes","finished":true},"onboarding.dependenciesSeen":true,"theme":"x"}');
    const r = run({ base, set: "sample-project" });
    assert.equal(r.code, 0, r.lines.join("\n"));
    assert.deepEqual(JSON.parse(readFileSync(uiState(base), "utf8")), { theme: "x" });
    assert.ok(r.lines.includes(`did clear onboarding state in ${uiState(base)}`), r.lines.join("\n"));
    assert.ok(!readFileSync(uiState(base)).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "no BOM");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("no state file: no error and none created; no onboarding keys: file stays byte-identical", () => {
  const base = fresh();
  try {
    const r = run({ base, set: "sample-project-instructions" });
    assert.equal(r.code, 0, r.lines.join("\n"));
    assert.ok(!existsSync(uiState(base)));
    assert.ok(!r.lines.some((l) => l.includes("clear onboarding")));
    mkdirSync(dirname(uiState(base)), { recursive: true });
    const text = '{"theme":"x",  "other": [1,2]}';
    writeFileSync(uiState(base), text);
    const again = run({ base, set: "sample-project" });
    assert.equal(again.code, 0, again.lines.join("\n"));
    assert.equal(readFileSync(uiState(base), "utf8"), text);
    assert.ok(!again.lines.some((l) => l.includes("clear onboarding")));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

function withBox(fn) {
  const from = mkdtempSync(join(tmpdir(), "sample-from-"));
  const base = join(mkdtempSync(join(tmpdir(), "sample-base-")), "box");
  try {
    writeFileSync(join(from, "vidar.exe"), "x");
    fn(from, base);
  } finally {
    rmSync(from, { recursive: true, force: true });
    rmSync(dirname(base), { recursive: true, force: true });
  }
}

test("launch -Seed <sample set> -DryRun prints the seeder step and writes no project", () => {
  withBox((from, base) => {
    for (const set of SETS) {
      const r = pwsh([LAUNCH, "-From", from, "-Base", base, "-Seed", set, "-DryRun"]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, new RegExp(`seed ${set}: node .*sample-seed\\.mjs --to .* --set ${set} --dry-run`));
      assert.ok(r.stdout.includes(`would write ${join(base, "app", rel("config"))}`), r.stdout);
      assert.ok(!existsSync(join(base, "work")));
    }
  });
});

test("launch still refuses an unknown -Seed set and lists the sample sets; an unseeded start removes the project", () => {
  withBox((from, base) => {
    const r = pwsh([LAUNCH, "-From", from, "-Base", base, "-Seed", "nope", "-DryRun"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /unknown -Seed set 'nope' \(known: .*sample-project, sample-project-instructions/);
    assert.ok(!existsSync(base));
    assert.equal(pwsh([LAUNCH, "-From", from, "-Base", base, "-DryRun"]).status, 0);
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, ".vidar-sandbox"), "x");
    assert.equal(run({ base, set: "sample-project" }).code, 0);
    const work = workDir(base, "sample-project");
    assert.ok(existsSync(work));
    const again = pwsh([LAUNCH, "-From", from, "-Base", base, "-DryRun"]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.ok(!existsSync(work) && !existsSync(join(base, MANIFEST)));
  });
});
