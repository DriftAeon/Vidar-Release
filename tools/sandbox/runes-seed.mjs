// tools/sandbox/runes-seed.mjs — materialises the runes e2e seed (tests/fixtures/runes-e2e/seed.json) into a
// sandbox base: <base>\app (token <APP>), <base>\profile (<HOME>), <base>\work\runes-e2e (<WORK>). The Rust e2e
// snapshot test materialises the same file the same way; the rules (tokens, JSON form, steps) are in
// tests/fixtures/runes-e2e/README.md.
//
// Usage: node tools/sandbox/runes-seed.mjs --to <base> [--dry-run]
//
// Each run: removes the files and folders the previous run recorded in <base>\.runes-seed-manifest.json that
// the seed no longer names, clears app\runtime\runes\, writes every seed file, records the manifest, then runs
// the seed's steps (git-worktree: git init, commit, git worktree add). --dry-run prints the same plan and
// writes nothing. Every path comes from <base>; only the %TEMP% guard reads the environment.
// Refuses (exit 2): a <base> that neither holds .vidar-sandbox nor sits under %TEMP%; a seed path outside its
// token root, under profile\AppData\Local\Vidar\homes, or named .credentials.json / auth.json.
// Fails (exit 1), before writing: a file discovery would list under profile\.claude or profile\.codex that the
// seed does not name and no earlier run wrote, or a <WORK>\.git no earlier run made.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as pathResolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve, root } from "../lib/paths.mjs";

export const MARKER = ".vidar-sandbox";
export const MANIFEST = ".runes-seed-manifest.json";
export const SEED = join(root(), "tests", "fixtures", "runes-e2e", "seed.json");
const CREDENTIALS = [".credentials.json", "auth.json"];

class Refused extends Error {}
class Failed extends Error {}

const key = (p) => pathResolve(p).toLowerCase();
const isUnder = (p, dir) => key(p).startsWith(key(dir).replace(/[\\/]+$/, "") + sep);

/** A path with links followed as far as it exists (a junction into the repo cannot pass as a sandbox). */
function real(p) {
  const abs = pathResolve(p);
  if (existsSync(abs)) return realpathSync.native(abs);
  const up = dirname(abs);
  return up === abs ? abs : join(real(up), basename(abs));
}

/** `memory_slug` (rules/import/memory.rs): every char not ASCII alphanumeric becomes `-`. */
export const memorySlug = (cwd) => Array.from(cwd, (c) => (/^[A-Za-z0-9]$/.test(c) ? c : "-")).join("");

/** `slug` (rules/import/split.rs): at most 4 words, 32 chars, lowercase, `-` runs collapsed. */
export function slug(body) {
  const words = body.split(/\s+/).map((w) => Array.from(w, (c) => (/^[A-Za-z0-9]$/.test(c) ? c.toLowerCase() : "-"))
    .join("").split("-").filter(Boolean).join("-")).filter(Boolean).slice(0, 4);
  const s = words.join("-").slice(0, 32).replace(/-+$/, "");
  return s || "rule";
}

/** Token values for `base`; the three roots are the only places a seed path may land. */
export function tokensFor(base) {
  const b = pathResolve(base);
  const t = { "<APP>": join(b, "app"), "<HOME>": join(b, "profile"), "<WORK>": join(b, "work", "runes-e2e") };
  t["<WORK_SLUG>"] = memorySlug(t["<WORK>"]);
  t["<MEMORY_LIB>"] = slug(`memory-${t["<WORK_SLUG>"]}`);
  return t;
}

const sub = (s, t) => Object.entries(t).reduce((acc, [k, v]) => acc.replaceAll(k, v), s);
function subJson(v, t) {
  if (typeof v === "string") return sub(v, t);
  if (Array.isArray(v)) return v.map((x) => subJson(x, t));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [sub(k, t), subJson(x, t)]));
  return v;
}

/** A seed path (`<ROOT>/a/b`) as an absolute path under its root (the root itself only for a step's repo). */
export function seedPath(p, t, rootOk = false) {
  const [head, ...rest] = String(p).split("/");
  if (!["<APP>", "<HOME>", "<WORK>"].includes(head)) throw new Refused(`seed path ${p} does not start with <APP>, <HOME> or <WORK>`);
  const parts = rest.map((s) => sub(s, t));
  if (parts.some((s) => !s || s === "." || s === ".." || /[\\:]/.test(s))) throw new Refused(`seed path ${p} has an empty, relative or drive segment`);
  const abs = join(t[head], ...parts);
  if (!(rootOk && !parts.length) && !isUnder(abs, t[head])) throw new Refused(`seed path ${p} leaves ${head}`);
  if (isUnder(abs, join(t["<HOME>"], "AppData", "Local", "Vidar", "homes"))) throw new Refused(`seed path ${p} is under the Bare agent homes`);
  if (CREDENTIALS.includes(basename(abs).toLowerCase())) throw new Refused(`seed path ${p} names a credential file`);
  return abs;
}

/** The files and steps of `seed` for `base`, contents rendered. */
export function plan(seed, base) {
  const t = tokensFor(base);
  const files = (seed.files ?? []).map((f) => {
    const abs = seedPath(f.path, t);
    if ((f.text === undefined) === (f.json === undefined)) throw new Refused(`seed entry ${f.path} needs exactly one of text or json`);
    return { abs, content: f.text !== undefined ? sub(f.text, t) : JSON.stringify(subJson(f.json, t), null, 2) + "\n" };
  });
  const steps = (seed.steps ?? []).map((s) => {
    if (s.op !== "git-worktree") throw new Refused(`unknown seed step ${s.op}`);
    const step = { op: s.op, repo: seedPath(s.repo, t, true), worktree: seedPath(s.worktree, t), branch: s.branch, add: s.add ?? [] };
    if (!isUnder(step.worktree, step.repo)) throw new Refused(`seed step worktree ${s.worktree} is not under ${s.repo}`);
    return step;
  });
  return { tokens: t, files, steps };
}

const files = (dir, keep = () => true) => {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && keep(e.name)).map((e) => join(dir, e.name)); } catch { return []; }
};
const dirs = (dir) => {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => join(dir, e.name)); } catch { return []; }
};
const md = (n) => n.toLowerCase().endsWith(".md");
const isFile = (p) => existsSync(p) && statSync(p).isFile();

/** Every file `local::discover` (and `codex_home.rs`) would list under the profile's `.claude` and `.codex`. */
export function discoverable(home) {
  const claude = join(home, ".claude"), codex = join(home, ".codex");
  return [
    join(claude, "CLAUDE.md"), join(claude, "settings.json"),
    ...files(join(claude, "rules"), md), ...files(join(claude, "agents"), md),
    ...dirs(join(claude, "skills")).map((d) => join(d, "SKILL.md")),
    ...dirs(join(claude, "projects")).flatMap((d) => files(join(d, "memory"), md)),
    join(codex, "AGENTS.md"), join(codex, "AGENTS.override.md"), join(codex, "config.toml"),
    join(codex, "memories", "memory_summary.md"), join(codex, "memories", "MEMORY.md"),
    ...dirs(join(codex, "skills")).map((d) => join(d, "SKILL.md")),
    ...dirs(join(codex, "memories", "skills")).map((d) => join(d, "SKILL.md")),
    ...files(join(codex, "agents"), (n) => !n.startsWith(".") && n.toLowerCase().endsWith(".toml")),
  ].filter(isFile);
}

function guardBase(base) {
  const b = real(base);
  if (existsSync(join(b, MARKER))) return b;
  const temp = real(tmpdir());
  if (isUnder(b, temp)) return b;
  throw new Refused(`${b} holds no ${MARKER} and is not under ${temp}`);
}

function readManifest(base) {
  const p = join(base, MANIFEST);
  if (!existsSync(p)) return { files: [], dirs: [] };
  const m = JSON.parse(readFileSync(p, "utf8"));
  const inside = (list) => (Array.isArray(list) ? list : []).filter((x) => typeof x === "string" && isUnder(x, base));
  return { files: inside(m.files), dirs: inside(m.dirs) };
}

function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Failed(`git ${args.join(" ")} failed in ${cwd}: ${(r.stderr || r.error?.message || "").trim()}`);
}

/** One seeding run; returns `{ code, lines }` (0 done, 1 failed, 2 refused). */
export function run({ base, seed = JSON.parse(readFileSync(SEED, "utf8")), dryRun = false }) {
  const lines = [];
  try {
    const b = guardBase(base);
    const p = plan(seed, b);
    const app = p.tokens["<APP>"];
    const imports = resolve("runeImports", { root: app });
    const old = readManifest(b);
    const want = new Set(p.files.map((f) => key(f.abs)));
    const stale = old.files.filter((f) => !want.has(key(f)));
    const ours = new Set([...want, ...old.files.map(key)]);
    const foreign = discoverable(p.tokens["<HOME>"]).filter((f) => !ours.has(key(f)));
    const madeDirs = new Set(old.dirs.map(key));
    for (const s of p.steps) {
      if (existsSync(join(s.repo, ".git")) && !madeDirs.has(key(join(s.repo, ".git")))) foreign.push(join(s.repo, ".git"));
    }
    if (foreign.length) throw new Failed(`unexpected files the seed did not write:\n  ${foreign.join("\n  ")}`);
    const verb = dryRun ? "would" : "did";
    for (const f of stale) lines.push(`${verb} remove ${f}`);
    for (const d of old.dirs) lines.push(`${verb} remove ${d}`);
    lines.push(`${verb} clear ${imports}`);
    for (const f of p.files) lines.push(`${verb} write ${f.abs}`);
    for (const s of p.steps) lines.push(`${verb} run ${s.op}: git init ${s.repo}, commit ${s.add.join(" ")}, worktree ${s.worktree} (${s.branch})`);
    if (dryRun) return { code: 0, lines };
    for (const f of stale) rmSync(f, { force: true });
    for (const d of old.dirs) rmSync(d, { recursive: true, force: true });
    rmSync(imports, { recursive: true, force: true });
    for (const f of p.files) {
      mkdirSync(dirname(f.abs), { recursive: true });
      writeFileSync(f.abs, f.content, "utf8");
    }
    const made = p.steps.flatMap((s) => [join(s.repo, ".git"), s.worktree]);
    writeFileSync(join(b, MANIFEST), JSON.stringify({ version: 1, files: p.files.map((f) => f.abs), dirs: made }, null, 2) + "\n", "utf8");
    for (const s of p.steps) {
      git(s.repo, ["init", "-q", "-b", "main"]);
      git(s.repo, ["add", "--", ...s.add]);
      git(s.repo, ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
      git(s.repo, ["worktree", "add", "-q", "-b", s.branch, s.worktree]);
    }
    lines.push(`seeded ${p.files.length} files into ${b}`);
    return { code: 0, lines };
  } catch (e) {
    if (e instanceof Refused) return { code: 2, lines: [...lines, `REFUSED: ${e.message}`] };
    if (e instanceof Failed) return { code: 1, lines: [...lines, `FAILED: ${e.message}`] };
    throw e;
  }
}

if (process.argv[1] && pathResolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--to");
  const base = at >= 0 ? args[at + 1] : undefined;
  if (!base) {
    console.error("REFUSED: usage: node tools/sandbox/runes-seed.mjs --to <base> [--dry-run]");
    process.exit(2);
  }
  const r = run({ base, dryRun: args.includes("--dry-run") });
  for (const l of r.lines) (r.code ? console.error : console.log)(l);
  process.exit(r.code);
}
