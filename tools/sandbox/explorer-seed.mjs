// tools/sandbox/explorer-seed.mjs — the `explorer` sandbox seed (tests/fixtures/explorer/seed.json): cheap model
// and low effort defaults for sandbox agent tabs, a Claude deny list (MCP and connector tools, edits outside the
// fixture), `prefer_mxc` in both Codex homes, a git fixture project at <base>\work\explorer, and a revert.
// <base>\app\vidar.json gets the fixture project as a saved workspace (`locations`, label `workspace.label`) and
// `rulesLibrary`; no row or workspace holds sets (a session loads its Rune Vault only). The rune library files come
// from the runes-e2e seed (tests/fixtures/runes-e2e/seed.json, rendered by runes-seed.mjs `plan`), only the libraries
// the fixture's `runes.libraries` names plus its rulesLibrary, and no `row-*` sets. Other vidar.json keys are kept.
//
// Usage: node tools/sandbox/explorer-seed.mjs --to <base> [--dry-run] [--deny-root <dir>]...
//        node tools/sandbox/explorer-seed.mjs --to <base> --revert [--dry-run]
//        node tools/sandbox/explorer-seed.mjs --to <base> --check
//
// Homes: the default ones (<base>\profile\.claude, .codex) and the Bare ones, placed by agent-env.mjs
// `resolveHome(<base>\app, <base>\profile\AppData\Local)` (claude-config, codex-home); no home path is written here.
// Each run records, in <base>\.explorer-seed-manifest.json, every file it touched with the text it replaced (null when
// it made the file); --revert restores or removes them, removes the fixture project and deletes the manifest.
// --check prints the MCP servers the sandbox's Claude config names and exits 1 unless there are none.
// Refuses (exit 2): a <base> that neither holds .vidar-sandbox nor sits under %TEMP%.
// Fails (exit 1): git errors, a non-empty --check.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as pathResolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHome } from "../lib/agent-env.mjs";
import { resolve, root } from "../lib/paths.mjs";
import { SEED as RUNES_SEED, plan as runesPlan } from "./runes-seed.mjs";

export const MARKER = ".vidar-sandbox";
export const MANIFEST = ".explorer-seed-manifest.json";
export const SEED = join(root(), "tests", "fixtures", "explorer", "seed.json");

class Refused extends Error {}
class Failed extends Error {}

const key = (p) => pathResolve(p).toLowerCase();
const isUnder = (p, dir) => key(p).startsWith(key(dir).replace(/[\\/]+$/, "") + sep);
const fwd = (p) => pathResolve(p).replaceAll("\\", "/");
const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

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

/** Every path the seed names for `base`. */
export function layout(base) {
  const profile = join(base, "profile"), app = join(base, "app");
  const bare = resolveHome(app, join(profile, "AppData", "Local"));
  return {
    base, profile, app, bare, work: join(base, "work", "explorer"),
    config: resolve("config", { root: app }), imports: resolve("runeImports", { root: app }),
    claude: [join(profile, ".claude", "settings.json"), join(bare, "claude-config", "settings.json")],
    codex: [join(profile, ".codex", "config.toml"), join(bare, "codex-home", "config.toml")],
    claudeState: [join(profile, ".claude.json"), join(bare, "claude-config", ".claude.json")],
  };
}

/** Claude deny list: the seed's own entries, plus Edit/Write/Bash on every root outside the fixture. */
export function denyList(seed, l, extraRoots = []) {
  const roots = [l.app, l.profile, root(), ...extraRoots].map(fwd);
  const out = [...seed.claude.deny];
  for (const r of roots) out.push(`Edit(/${r}/**)`, `Write(/${r}/**)`, `Bash(*${r}*)`);
  return [...new Set(out)];
}

export function claudeSettings(prior, seed, deny) {
  const s = prior ? JSON.parse(prior) : {};
  s.model = seed.claude.model;
  s.effortLevel = seed.claude.effortLevel;
  s.env = { ...(s.env ?? {}), ...seed.claude.env };
  s.permissions = { ...(s.permissions ?? {}), deny: [...new Set([...(s.permissions?.deny ?? []), ...deny])] };
  return JSON.stringify(s, null, 2) + "\n";
}

/** config.toml text with the seed's keys set: top-level model keys before the first table, prefer_mxc in [features]. */
export function codexConfig(prior, seed) {
  const top = [`model = "${seed.codex.model}"`, `model_reasoning_effort = "${seed.codex.model_reasoning_effort}"`];
  const lines = (prior ?? "").split(/\r?\n/);
  let table = "";
  const kept = [];
  for (const line of lines) {
    const t = /^\s*\[([^\]]+)\]/.exec(line);
    if (t) table = t[1].trim();
    const k = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1];
    if (!table && (k === "model" || k === "model_reasoning_effort")) continue;
    if (table === "features" && k === "prefer_mxc") continue;
    if (!table && k === "features.prefer_mxc") continue;
    kept.push(line);
  }
  const body = kept.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  const first = body.search(/^\s*\[/m);
  const head = first < 0 ? body : body.slice(0, first).replace(/\n+$/, "");
  let rest = first < 0 ? "" : body.slice(first);
  const flag = `prefer_mxc = ${seed.codex.prefer_mxc ? "true" : "false"}`;
  if (/^\s*\[features\]\s*$/m.test(rest)) rest = rest.replace(/^(\s*\[features\][^\n]*)$/m, `$1\n${flag}`);
  else rest = (rest ? rest + "\n\n" : "") + `[features]\n${flag}`;
  return [...top, ...(head ? ["", head] : []), "", rest].join("\n") + "\n";
}

/** The runes-e2e library pieces the fixture names: files (rendered for `l.base`) and their library dirs. The old
 *  per-row sets (`sets/row-*`) are left out. */
export function runeLibrary(seed, l, runesSeed = JSON.parse(readFileSync(RUNES_SEED, "utf8"))) {
  const cfg = runesSeed.files.find((f) => f.path === "<APP>/vidar.json")?.json ?? {};
  const rulesLibrary = cfg.rulesLibrary;
  const names = seed.runes?.libraries ?? [];
  const dirs = [...(rulesLibrary ? [join(l.app, rulesLibrary)] : []), ...names.map((n) => join(l.imports, n))];
  const files = runesPlan(runesSeed, l.base).files.filter((f) => dirs.some((d) => isUnder(f.abs, d)) && !/[\\/]sets[\\/]row-[^\\/]*$/.test(f.abs));
  return { rulesLibrary, dirs, files };
}

/** vidar.json text with the fixture project as a saved workspace and the rules library; other keys kept. */
export function vidarConfig(prior, seed, lib, work) {
  const c = prior ? JSON.parse(prior) : {};
  if (lib.rulesLibrary) c.rulesLibrary = lib.rulesLibrary;
  const others = (Array.isArray(c.locations) ? c.locations : []).filter((x) => typeof x?.cwd !== "string" || key(x.cwd) !== key(work));
  c.locations = [...others, { label: seed.workspace.label, cwd: work }];
  return JSON.stringify(c, null, 2) + "\n";
}

function readManifest(base) {
  const text = readText(join(base, MANIFEST));
  if (!text) return { entries: [], dirs: [] };
  const m = JSON.parse(text);
  const ok = (p) => typeof p === "string" && isUnder(p, base);
  return { entries: (m.entries ?? []).filter((e) => ok(e.path)), dirs: (m.dirs ?? []).filter(ok) };
}

function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Failed(`git ${args.join(" ")} failed in ${cwd}: ${(r.stderr || r.error?.message || "").trim()}`);
}

/** MCP servers named by the sandbox's Claude state and settings, and the fixture's .mcp.json. */
export function mcpServers(base) {
  const l = layout(base);
  const found = [];
  for (const f of [...l.claudeState, ...l.claude, join(l.work, ".mcp.json")]) {
    const text = readText(f);
    if (!text) continue;
    const names = Object.keys(JSON.parse(text).mcpServers ?? {});
    for (const n of names) found.push(`${n} (${f})`);
  }
  return found;
}

/** One run; returns `{ code, lines }` (0 done, 1 failed, 2 refused). */
export function run({ base, seed = JSON.parse(readFileSync(SEED, "utf8")), dryRun = false, revert = false, check = false, denyRoots = [] }) {
  const lines = [];
  try {
    const b = guardBase(base);
    const l = layout(b);
    if (check) {
      const found = mcpServers(b);
      lines.push(found.length ? `MCP servers present: ${found.join(", ")}` : "MCP and connector list: empty");
      return { code: found.length ? 1 : 0, lines };
    }
    const verb = dryRun ? "would" : "did";
    const old = readManifest(b);
    if (revert) {
      for (const e of old.entries) lines.push(`${verb} ${e.before === null ? "remove" : "restore"} ${e.path}`);
      for (const d of old.dirs) lines.push(`${verb} remove ${d}`);
      if (dryRun) return { code: 0, lines };
      for (const e of old.entries) {
        if (e.before === null) rmSync(e.path, { force: true });
        else writeFileSync(e.path, e.before, "utf8");
      }
      for (const d of old.dirs) rmSync(d, { recursive: true, force: true });
      rmSync(join(b, MANIFEST), { force: true });
      return { code: 0, lines };
    }
    const before = new Map(old.entries.map((e) => [key(e.path), e.before]));
    const deny = denyList(seed, l, denyRoots);
    const lib = runeLibrary(seed, l);
    const writes = [
      ...l.claude.map((path) => ({ path, make: (prior) => claudeSettings(prior, seed, deny) })),
      ...l.codex.map((path) => ({ path, make: (prior) => codexConfig(prior, seed) })),
      { path: l.config, make: (prior) => vidarConfig(prior, seed, lib, l.work) },
      ...lib.files.map((f) => ({ path: f.abs, make: () => f.content })),
    ].map((w) => {
      const prior = before.has(key(w.path)) ? before.get(w.path) : readText(w.path);
      const current = readText(w.path);
      return { path: w.path, before: before.has(key(w.path)) ? before.get(key(w.path)) : prior, content: w.make(current) };
    });
    if (existsSync(join(l.work, ".git")) && !old.dirs.some((d) => key(d) === key(l.work))) {
      throw new Failed(`${l.work} holds a repo no earlier run made`);
    }
    // Library dirs this seed makes (or made on an earlier run) go to the manifest; a dir already there stays on revert.
    const madeDirs = new Set(old.dirs.map(key));
    const libDirs = lib.dirs.filter((d) => madeDirs.has(key(d)) || !existsSync(d));
    for (const w of writes) lines.push(`${verb} write ${w.path}`);
    lines.push(`${verb} run git init ${l.work}, commit ${seed.project}`);
    if (dryRun) return { code: 0, lines };
    for (const w of writes) {
      mkdirSync(dirname(w.path), { recursive: true });
      writeFileSync(w.path, w.content, "utf8");
    }
    writeFileSync(join(b, MANIFEST), JSON.stringify({ version: 1, entries: writes.map((w) => ({ path: w.path, before: w.before })), dirs: [l.work, ...libDirs] }, null, 2) + "\n", "utf8");
    rmSync(l.work, { recursive: true, force: true });
    mkdirSync(l.work, { recursive: true });
    cpSync(join(dirname(SEED), seed.project), l.work, { recursive: true });
    git(l.work, ["init", "-q", "-b", "main"]);
    git(l.work, ["add", "--", "."]);
    git(l.work, ["-c", "user.name=explorer", "-c", "user.email=explorer@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
    lines.push(`seeded ${writes.length} files and ${l.work}`);
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
    console.error("REFUSED: usage: node tools/sandbox/explorer-seed.mjs --to <base> [--dry-run] [--revert] [--check] [--deny-root <dir>]");
    process.exit(2);
  }
  const denyRoots = args.flatMap((a, i) => (a === "--deny-root" && args[i + 1] ? [args[i + 1]] : []));
  const r = run({ base, dryRun: args.includes("--dry-run"), revert: args.includes("--revert"), check: args.includes("--check"), denyRoots });
  for (const x of r.lines) (r.code ? console.error : console.log)(x);
  process.exit(r.code);
}
