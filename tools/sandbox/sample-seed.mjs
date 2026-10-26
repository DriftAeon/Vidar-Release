// tools/sandbox/sample-seed.mjs — the `sample-project` and `sample-project-instructions` sandbox seeds
// (tests/fixtures/sample-project): a small git project planted at <base>\work\<set>, so the onboarding run opens on
// a realistic folder instead of an empty one. The project is slugkit, a toy CLI (README, package.json, src/, test/).
//   sample-project               no CLAUDE.md, AGENTS.md or .claude/: Local Files comes up empty (the Add Kit case).
//   sample-project-instructions  the same project plus CLAUDE.md, AGENTS.md and .claude/skills/changelog-entry/SKILL.md:
//                                Local Files lists sources, Create Runes has something to import and generate from.
// <base>\app\vidar.json gets `defaultCwd` set to the project (the first tab opens there) and the project as a saved
// workspace (`locations`, label "Sample Project"); other vidar.json keys are kept.
// A reused base keeps <base>\app\runtime\vidar-state.json, and a finished onboarding there skips the overlay, so the
// top-level `onboarding.*` keys are removed from it (when the file exists and holds any); every other key stays.
// Logins (<base>\profile, credentials, homes) are never touched.
//
// Usage: node tools/sandbox/sample-seed.mjs --to <base> --set <set> [--dry-run]
//        node tools/sandbox/sample-seed.mjs --to <base> --revert [--dry-run]
//
// Each run first removes the project folders an earlier run recorded in <base>\.sample-seed-manifest.json, then plants
// the project (fixture copy, git init, one commit) and records the manifest. --revert removes the recorded folders and
// the manifest; the unseeded launch.ps1 start does the same. --dry-run prints the plan and writes nothing.
// Refuses (exit 2): a <base> that neither holds .vidar-sandbox nor sits under %TEMP%; an unknown set.
// Fails (exit 1): git errors; a project folder that exists and no earlier run made.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as pathResolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve, root } from "../lib/paths.mjs";

export const MARKER = ".vidar-sandbox";
export const MANIFEST = ".sample-seed-manifest.json";
export const FIXTURE = join(root(), "tests", "fixtures", "sample-project");
export const SETS = ["sample-project", "sample-project-instructions"];
export const LABEL = "Sample Project";

class Refused extends Error {}
class Failed extends Error {}

const key = (p) => pathResolve(p).toLowerCase();
const isUnder = (p, dir) => key(p).startsWith(key(dir).replace(/[\\/]+$/, "") + sep);

function real(p) {
  const abs = pathResolve(p);
  if (existsSync(abs)) return realpathSync.native(abs);
  const up = dirname(abs);
  return up === abs ? abs : join(real(up), basename(abs));
}

function guardBase(base) {
  const b = real(base);
  if (existsSync(join(b, MARKER))) return b;
  const temp = real(tmpdir());
  if (isUnder(b, temp)) return b;
  throw new Refused(`${b} holds no ${MARKER} and is not under ${temp}`);
}

/** Where the set's project lands for `base`. */
export const workDir = (base, set) => join(base, "work", set);

/** vidar.json text with the project as defaultCwd and a saved workspace; other keys kept. */
export function vidarConfig(prior, work) {
  const c = prior ? JSON.parse(prior) : {};
  c.defaultCwd = work;
  const others = (Array.isArray(c.locations) ? c.locations : []).filter((x) => typeof x?.cwd !== "string" || key(x.cwd) !== key(work));
  c.locations = [...others, { label: LABEL, cwd: work }];
  return JSON.stringify(c, null, 2) + "\n";
}

/** State text without its top-level `onboarding.*` keys, or null when it has none (or is not a JSON object). */
export function withoutOnboarding(text) {
  let s;
  try { s = JSON.parse(text); } catch { return null; }
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const drop = Object.keys(s).filter((k) => k.startsWith("onboarding."));
  if (!drop.length) return null;
  for (const k of drop) delete s[k];
  return JSON.stringify(s, null, 2) + "\n";
}

function readManifest(base) {
  const p = join(base, MANIFEST);
  if (!existsSync(p)) return { dirs: [] };
  const m = JSON.parse(readFileSync(p, "utf8"));
  return { dirs: (Array.isArray(m.dirs) ? m.dirs : []).filter((d) => typeof d === "string" && isUnder(d, base)) };
}

function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Failed(`git ${args.join(" ")} failed in ${cwd}: ${(r.stderr || r.error?.message || "").trim()}`);
}

/** One run; returns `{ code, lines }` (0 done, 1 failed, 2 refused). */
export function run({ base, set, dryRun = false, revert = false }) {
  const lines = [];
  try {
    const b = guardBase(base);
    const verb = dryRun ? "would" : "did";
    const old = readManifest(b);
    if (revert) {
      for (const d of old.dirs) lines.push(`${verb} remove ${d}`);
      if (!dryRun) {
        for (const d of old.dirs) rmSync(d, { recursive: true, force: true });
        rmSync(join(b, MANIFEST), { force: true });
      }
      return { code: 0, lines };
    }
    if (!SETS.includes(set)) throw new Refused(`unknown sample set '${set}' (known: ${SETS.join(", ")})`);
    const work = workDir(b, set);
    const config = resolve("config", { root: join(b, "app") });
    if (existsSync(work) && !old.dirs.some((d) => key(d) === key(work))) throw new Failed(`${work} exists and no earlier run made it`);
    for (const d of old.dirs) lines.push(`${verb} remove ${d}`);
    lines.push(`${verb} copy ${join(FIXTURE, "project")} to ${work}`);
    if (set === "sample-project-instructions") lines.push(`${verb} copy ${join(FIXTURE, "instructions")} over ${work}`);
    lines.push(`${verb} run git init ${work}, commit all`);
    lines.push(`${verb} write ${config} (defaultCwd ${work}, workspace ${LABEL})`);
    const state = resolve("uiState", { root: join(b, "app") });
    const cleared = existsSync(state) ? withoutOnboarding(readFileSync(state, "utf8")) : null;
    if (cleared !== null) lines.push(`${verb} clear onboarding state in ${state}`);
    if (dryRun) return { code: 0, lines };
    if (cleared !== null) writeFileSync(state, cleared, "utf8");
    for (const d of old.dirs) rmSync(d, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    cpSync(join(FIXTURE, "project"), work, { recursive: true });
    if (set === "sample-project-instructions") cpSync(join(FIXTURE, "instructions"), work, { recursive: true });
    writeFileSync(join(b, MANIFEST), JSON.stringify({ version: 1, set, dirs: [work] }, null, 2) + "\n", "utf8");
    git(work, ["init", "-q", "-b", "main"]);
    git(work, ["add", "--", "."]);
    git(work, ["-c", "user.name=sample", "-c", "user.email=sample@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Initial commit"]);
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, vidarConfig(existsSync(config) ? readFileSync(config, "utf8") : null, work), "utf8");
    lines.push(`seeded ${set} at ${work}`);
    return { code: 0, lines };
  } catch (e) {
    if (e instanceof Refused) return { code: 2, lines: [...lines, `REFUSED: ${e.message}`] };
    if (e instanceof Failed) return { code: 1, lines: [...lines, `FAILED: ${e.message}`] };
    throw e;
  }
}

if (process.argv[1] && pathResolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
  const base = val("--to");
  const revert = args.includes("--revert");
  if (!base || (!revert && !val("--set"))) {
    console.error("REFUSED: usage: node tools/sandbox/sample-seed.mjs --to <base> --set <set> [--dry-run] | --to <base> --revert [--dry-run]");
    process.exit(2);
  }
  const r = run({ base, set: val("--set"), dryRun: args.includes("--dry-run"), revert });
  for (const l of r.lines) (r.code ? console.error : console.log)(l);
  process.exit(r.code);
}
