// tools/sandbox/runes-seed.mjs — materialises the runes e2e seed (tests/fixtures/runes-e2e/seed.json) into a
// sandbox base: <base>\app (token <APP>), <base>\profile (<HOME>), <base>\work\runes-e2e (<WORK>). The rules are in
// tests/fixtures/runes-e2e/README.md.
//
// Usage: node tools/sandbox/runes-seed.mjs --to <base> [--dry-run]
//
// Each run: removes the files and folders the previous run recorded in <base>\.runes-seed-manifest.json that
// the seed no longer names, clears app\runtime\runes\ and app\runtime\vaults\ (every vault, sessions\, defaults.json;
// the app re-seeds stock-claude / stock-codex from profiles/bare/templates, vault/store.rs ensure_stock, so no run
// inherits an earlier run's vault edits), empties the saved Codex tabs in app\runtime\vidar-state.json
// (a boot restore would add a tab the journey did not open), writes every seed file and records the manifest.
// --dry-run prints the same plan and
// writes nothing. Every path comes from <base>; only the %TEMP% guard reads the environment.
// Refuses (exit 2): a <base> that neither holds .vidar-sandbox nor sits under %TEMP%; a seed path outside its
// token root, under profile\AppData\Local\Vidar\homes, or named .credentials.json / auth.json.
// Fails (exit 1), before writing: a file discovery would list under profile\.claude or profile\.codex that the
// seed does not name and no earlier run wrote.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as pathResolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve, root } from "../lib/paths.mjs";

export const MARKER = ".vidar-sandbox";
export const MANIFEST = ".runes-seed-manifest.json";
export const SEED = join(root(), "tests", "fixtures", "runes-e2e", "seed.json");
const CREDENTIALS = [".credentials.json", "auth.json"];

/** Case 11's throwaway import library (src-tauri/src/bare/library_delete.rs deletes only libraries under
 *  runtime\runes): two runes in a library of its own, so no earlier case reads them. The fixture seed.json is
 *  not edited; the default seed gains these entries here. */
export const DEL_LIBRARY = "runes-e2e-del";
export const DEL_RUNES = ["del-a", "del-b"];
export const delFiles = () => DEL_RUNES.map((id) => ({
  path: `<APP>/runtime/runes/${DEL_LIBRARY}/rules/${id}.md`,
  text: `---\nname: ${id}\nkind: rule\nscope: [global]\nstate: active\nactivate: always\n---\n\nThrowaway rune ${id}.\n`,
}));
const withDel = (seed) => ({ ...seed, files: [...(seed.files ?? []), ...delFiles()] });

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

/** Token values for `base`; the three roots are the only places a seed path may land. */
export function tokensFor(base) {
  const b = pathResolve(base);
  return { "<APP>": join(b, "app"), "<HOME>": join(b, "profile"), "<WORK>": join(b, "work", "runes-e2e") };
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

/** The Rune Vault files of `seed` for `base`, contents rendered. */
export function plan(seed, base) {
  const t = tokensFor(base);
  const files = (seed.files ?? []).map((f) => {
    const abs = seedPath(f.path, t);
    if ((f.text === undefined) === (f.json === undefined)) throw new Refused(`seed entry ${f.path} needs exactly one of text or json`);
    return { abs, content: f.text !== undefined ? sub(f.text, t) : JSON.stringify(subJson(f.json, t), null, 2) + "\n" };
  });
  if (seed.steps?.length) throw new Refused("Rune Vault seed does not run legacy git-worktree steps");
  return { tokens: t, files, steps: [] };
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

/** Saved tabs an earlier sandbox run left in the app's UI state (src/main.ts reopens `rendered.codexTabs` at boot as
 *  background tabs; e1 run 2026-10-28: an Explorer run's Codex tab came back as a stray hosted tab). */
export const RESTORE_KEYS = ["rendered.codexTabs"];
export function savedRestores(file) {
  if (!isFile(file)) return [];
  const s = JSON.parse(readFileSync(file, "utf8"));
  return RESTORE_KEYS.filter((k) => Array.isArray(s?.[k]) && s[k].length);
}
function dropRestores(file, keys) {
  const s = JSON.parse(readFileSync(file, "utf8"));
  for (const k of keys) s[k] = [];
  writeFileSync(file, JSON.stringify(s, null, 2) + "\n", "utf8");
}

/** One seeding run; returns `{ code, lines }` (0 done, 1 failed, 2 refused). */
export function run({ base, seed = withDel(JSON.parse(readFileSync(SEED, "utf8"))), dryRun = false }) {
  const lines = [];
  try {
    const b = guardBase(base);
    const p = plan(seed, b);
    const app = p.tokens["<APP>"];
    const imports = resolve("runeImports", { root: app });
    const vaults = resolve("runeVaults", { root: app });
    const old = readManifest(b);
    const want = new Set(p.files.map((f) => key(f.abs)));
    const stale = old.files.filter((f) => !want.has(key(f)));
    const ours = new Set([...want, ...old.files.map(key)]);
    const foreign = discoverable(p.tokens["<HOME>"]).filter((f) => !ours.has(key(f)));
    if (foreign.length) throw new Failed(`unexpected files the seed did not write:\n  ${foreign.join("\n  ")}`);
    const verb = dryRun ? "would" : "did";
    for (const f of stale) lines.push(`${verb} remove ${f}`);
    for (const d of old.dirs) lines.push(`${verb} remove ${d}`);
    lines.push(`${verb} clear ${imports}`);
    lines.push(`${verb} clear ${vaults}`);
    for (const f of p.files) lines.push(`${verb} write ${f.abs}`);
    const uiState = resolve("uiState", { root: app });
    const restores = savedRestores(uiState);
    if (restores.length) lines.push(`${verb} drop ${restores.join(", ")} from ${uiState}`);
    if (dryRun) return { code: 0, lines };
    if (restores.length) dropRestores(uiState, restores);
    for (const d of [imports, vaults, ...old.dirs]) if (!isUnder(real(d), b)) throw new Refused(`seed directory ${d} resolves outside sandbox ${b}`);
    for (const f of stale) rmSync(f, { force: true });
    for (const d of old.dirs) rmSync(d, { recursive: true, force: true });
    rmSync(imports, { recursive: true, force: true });
    rmSync(vaults, { recursive: true, force: true });
    for (const f of p.files) {
      mkdirSync(dirname(f.abs), { recursive: true });
      writeFileSync(f.abs, f.content, "utf8");
    }
    writeFileSync(join(b, MANIFEST), JSON.stringify({ version: 2, files: p.files.map((f) => f.abs), dirs: [] }, null, 2) + "\n", "utf8");
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
