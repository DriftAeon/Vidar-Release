// Third-agent compile check: add Grok in a disposable detached worktree and compare every compiler site.
// Usage: node tools/agents/third-agent-check.mjs [--rust] [--init [--yes]]
//        node tools/agents/third-agent-check.mjs --dry
//        node tools/agents/third-agent-check.mjs --checklist
// --rust also checks both Rust crates; --init prints the fixture diff, and --yes permits its write.
// --dry validates the fixture and scanner imports without a worktree or compiler. --checklist is read-only.
// Refuses unknown flags, --yes without --init, malformed/legacy fixtures in comparison mode,
// missing scanners, non-E0004 Rust errors, and any forced scanner key outside a compiler error site.
// The full check reads tracked HEAD; commit source edits before using it. It never touches an existing worktree.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gather } from "./key-words.mjs";
import { enumsOf, lex } from "./rust-keys.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "third-agent-tables.json");
const norm = (p) => p.replaceAll("\\", "/").replace(/^\.\//, "");
const siteKey = (s) => `${s.file}\0${s.kind}\0${s.anchor ?? s.lines?.join("-")}`;
const sortSites = (xs) => [...xs].sort((a, b) => siteKey(a).localeCompare(siteKey(b)));
const lineOf = (src, pos) => src.slice(0, pos).split("\n").length;

export function validateFixture(doc, allowLegacy = false) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("fixture must be an object");
  if (Array.isArray(doc.files) && !doc.sites && allowLegacy && doc.files.every((f) => typeof f === "string" && f && f === norm(f)) && new Set(doc.files).size === doc.files.length) return { legacy: true, sites: [] };
  if (!Array.isArray(doc.sites)) throw new Error("fixture needs a sites array; run --init --yes");
  const seen = new Set();
  for (const s of doc.sites) {
    if (!s || typeof s.file !== "string" || !s.file || s.file !== norm(s.file) || !["ts-record", "ts-switch", "rust-match"].includes(s.kind)) throw new Error(`invalid site: ${JSON.stringify(s)}`);
    if (!Array.isArray(s.lines) || s.lines.length !== 2 || !s.lines.every((n) => Number.isInteger(n) && n > 0) || s.lines[0] > s.lines[1]) throw new Error(`invalid line range: ${JSON.stringify(s)}`);
    if (s.kind.startsWith("ts-") && !/^\d+:\d+$/.test(s.anchor ?? "")) throw new Error(`invalid TypeScript anchor: ${JSON.stringify(s)}`);
    if (s.kind === "rust-match" && s.anchor !== undefined) throw new Error(`Rust site uses a line range: ${JSON.stringify(s)}`);
    const k = siteKey(s);
    if (seen.has(k)) throw new Error(`duplicate site: ${k}`);
    seen.add(k);
  }
  return { legacy: false, sites: sortSites(doc.sites) };
}

function tsBlocks(src) {
  const stack = [], blocks = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { i = src.indexOf("\n", i + 2); if (i < 0) break; continue; }
    if (c === "/" && n === "*") { i = src.indexOf("*/", i + 2) + 1; if (i === 0) break; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (i++; i < src.length; i++) { if (src[i] === "\\") { i++; continue; } if (src[i] === q) break; }
      continue;
    }
    if (c === "{") stack.push(i);
    else if (c === "}" && stack.length) blocks.push({ start: stack.pop(), end: i + 1 });
  }
  return blocks;
}

function tsSite(src, file, line, col, code) {
  const lines = src.split("\n");
  if (line < 1 || line > lines.length) return null;
  const pos = lines.slice(0, line - 1).reduce((n, x) => n + x.length + 1, 0) + col - 1;
  const blocks = tsBlocks(src).filter((b) => b.start <= pos && pos <= b.end).sort((a, b) => a.end - a.start - (b.end - b.start));
  const switchBlock = blocks.find((b) => /\bswitch\s*\([^)]*\)\s*$/.test(src.slice(Math.max(0, b.start - 200), b.start)));
  const recordBlock = blocks.find((b) => /\bRecord\s*<[^>]+>[\s\S]*?=\s*$/.test(src.slice(Math.max(0, b.start - 300), b.start)) || pos === b.start);
  const block = Number(code) === 2345 ? switchBlock : recordBlock ?? switchBlock;
  if (!block) return null;
  const start = Number(code) === 2345 ? src.lastIndexOf("switch", block.start) : block.start;
  const startLine = lineOf(src, start), startCol = start - src.lastIndexOf("\n", start);
  return { file: norm(file), anchor: `${startLine}:${startCol}`, lines: [startLine, lineOf(src, block.end - 1)], kind: Number(code) === 2345 ? "ts-switch" : "ts-record" };
}

export function parseTsErrors(output, readSource) {
  const sites = [], other = [];
  for (const m of output.matchAll(/^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/gm)) {
    const [raw, path, row, col, code, message] = m;
    const file = norm(path), site = tsSite(readSource(file), file, Number(row), Number(col), code);
    const allowed = [2322, 2345, 2739, 2741, 2678, 2366].includes(Number(code));
    if (!allowed || !site || (Number(code) === 2345 && site.kind !== "ts-switch")) other.push(`${file}:${row}:${col} TS${code} ${message}`);
    else sites.push(site);
  }
  if (output.includes("error TS") && sites.length + other.length === 0) other.push("unparsed TypeScript diagnostic");
  return { sites: sortSites([...new Map(sites.map((s) => [siteKey(s), s])).values()]), other };
}

function rustMatches(src) {
  const toks = lex(src), matches = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].v !== "match" || toks[i].t !== "ident") continue;
    let open = i + 1;
    while (open < toks.length && toks[open].v !== "{") open++;
    if (open === toks.length) continue;
    let depth = 0, close = open;
    for (; close < toks.length; close++) {
      if (toks[close].v === "{") depth++;
      if (toks[close].v === "}" && --depth === 0) break;
    }
    matches.push([toks[i].line, toks[Math.min(close, toks.length - 1)].line]);
  }
  return matches;
}

export function parseRustErrors(output, readSource, crate = "", sourceRoot = ROOT) {
  const sites = [], other = [];
  for (const row of output.split(/\r?\n/)) {
    let d;
    try { d = JSON.parse(row); } catch { continue; }
    if (d.reason === "compiler-message") d = d.message;
    else if (!d.level) continue;
    if (d.level !== "error") continue;
    const code = d.code?.code ?? "uncoded";
    const span = d.spans?.find((s) => s.is_primary) ?? d.spans?.[0];
    if (code !== "E0004" || !span) { other.push(`${code}: ${d.message}`); continue; }
    const raw = norm(span.file_name);
    const file = norm(isAbsolute(raw) ? relative(sourceRoot, raw) : raw.startsWith("src/") ? join(crate, raw) : raw);
    const line = span.line_start;
    const ranges = rustMatches(readSource(file)).filter(([a, b]) => a <= line && line <= b);
    if (!ranges.length) { other.push(`E0004 without match site: ${file}:${line}`); continue; }
    const lines = ranges.sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]))[0];
    sites.push({ file, lines, kind: "rust-match" });
  }
  return { sites: sortSites([...new Map(sites.map((s) => [siteKey(s), s])).values()]), other };
}

export function compareSites(expected, actual) {
  const want = new Map(expected.map((s) => [siteKey(s), s]));
  const got = new Map(actual.map((s) => [siteKey(s), s]));
  return { missing: sortSites([...want].filter(([k]) => !got.has(k)).map(([, s]) => s)), extra: sortSites([...got].filter(([k]) => !want.has(k)).map(([, s]) => s)) };
}

export function forcedOutside(entries, sites) {
  return entries.filter((e) => e.forced && !sites.some((s) => s.file === e.file && e.line >= s.lines[0] && e.line <= s.lines[1] && ((e.lang === "rs") === (s.kind === "rust-match"))));
}

export function fixtureDiff(oldDoc, sites) {
  const next = { note: "Compiler sites after adding Grok to AGENT_IDS and scanner-derived Rust enums.", sites: sortSites(sites) };
  const old = JSON.stringify(oldDoc, null, 2).split("\n"), now = JSON.stringify(next, null, 2).split("\n");
  if (old.join("\n") === now.join("\n")) return { next, diff: "fixture unchanged" };
  return { next, diff: [`--- third-agent-tables.json`, `+++ third-agent-tables.json`, ...old.map((s) => `-${s}`), ...now.map((s) => `+${s}`)].join("\n") };
}

export function initFixture(path, oldDoc, sites, yes = false) {
  const result = fixtureDiff(oldDoc, sites);
  if (yes) writeFileSync(path, `${JSON.stringify(result.next, null, 2)}\n`);
  return result.diff;
}

const CHECKLIST = `Manual checklist:
- CSS [data-*="claude|codex"] hue rows (8).
- JSON ids in profiles/bare/*.json, release sets/*.json, contracts/*.json.
- Pack routing: content/packs/*/pack.json profiles.runner (modules/manifest.rs:414).
- Re-grep the named payload-shape sites.
- Runtime-built ids and alias words without id text.
- First-id defaults, including src/flow/runner.ts:43.
- src-tauri/src/codex_cwd.rs:78-90 argv inference.
- Comments and docs; C-key growth.`;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
function addGrokToEnums(wt, names) {
  const files = git(wt, "ls-files", "src-tauri/src", "src-falcon/src").split(/\r?\n/).filter((f) => f.endsWith(".rs"));
  const found = new Set();
  for (const file of files) {
    const path = join(wt, file), src = readFileSync(path, "utf8");
    const local = enumsOf([{ path: norm(file), src }]);
    const next = src.replace(/\benum\s+([A-Za-z_]\w*)\b[^;{]*\{/g, (all, name) => {
      if (!names.has(name) || !local.has(name)) return all;
      found.add(name);
      return `${all}\n    Grok,`;
    });
    if (next !== src) writeFileSync(path, next);
  }
  const missing = [...names].filter((name) => !found.has(name));
  if (missing.length) throw new Error(`scanner enums not found for mutation: ${missing.join(", ")}`);
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  if (flags.size !== process.argv.length - 2 || [...flags].some((f) => !["--rust", "--init", "--yes", "--dry", "--checklist"].includes(f)) || (flags.has("--yes") && !flags.has("--init")) || (flags.has("--dry") && flags.size > 1) || (flags.has("--checklist") && flags.size > 1)) throw new Error("invalid flags; see header usage");
  if (flags.has("--checklist")) { console.log(CHECKLIST); return; }
  const oldDoc = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const fixture = validateFixture(oldDoc, flags.has("--dry") || flags.has("--init"));
  const scan = await gather(ROOT, ["rs", "ts"]);
  if (!scan.loaded.includes("rs")) throw new Error("Rust scanner import missing");
  if (flags.has("--dry")) { console.log(`third-agent dry: ok (${fixture.legacy ? "legacy" : fixture.sites.length + " sites"}; scanners: ${scan.loaded.join(", ")}${scan.missing.length ? "; missing: " + scan.missing.join(", ") : ""})`); return; }
  if (scan.missing.length) throw new Error(`missing scanner: ${scan.missing.join(", ")}`);

  const wt = mkdtempSync(join(tmpdir(), "vidar-third-agent-"));
  let registered = false;
  try {
    git(ROOT, "worktree", "add", "--detach", wt, "HEAD");
    registered = true;
    symlinkSync(join(ROOT, "node_modules"), join(wt, "node_modules"), "junction");
    const idPath = join(wt, "src/agents/id.ts"), before = readFileSync(idPath, "utf8");
    const after = before.replace(/(AGENT_IDS\s*=\s*\[)([^\]]*)(\]\s*as const)/, (_, a, b, c) => `${a}${b}, "grok"${c}`);
    if (after === before) throw new Error("AGENT_IDS declaration not found");
    writeFileSync(idPath, after);
    if (flags.has("--rust")) {
      addGrokToEnums(wt, new Set(scan.enums.keys()));
      for (const dir of ["dist", "dist-falcon"]) mkdirSync(join(wt, dir), { recursive: true });
    }
    const source = (file) => readFileSync(join(wt, file), "utf8");
    const tsRun = run(process.execPath, [join(wt, "node_modules/typescript/bin/tsc"), "--noEmit"], wt);
    if (tsRun.error || tsRun.status === null) throw new Error(`tsc failed to run: ${tsRun.error?.message ?? tsRun.signal}`);
    const tsc = parseTsErrors(`${tsRun.stdout}\n${tsRun.stderr}`, source);
    if (tsRun.status !== 0 && !tsc.sites.length && !tsc.other.length) tsc.other.push(`tsc exited ${tsRun.status} without diagnostics`);
    const probe = run(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `
      const d = await import('./src/agents/descriptor.ts');
      if (!d.isAgentId('grok')) throw new Error('isAgentId(grok) failed');
      if (!d.agentOrder(null).includes('grok')) throw new Error('agentOrder(null) omitted grok');
      let k;
      try { k = await import('./src/launcher/agent-kind.ts'); } catch { /* optional node load */ }
      if (k && k.agentKind('grok') !== 'grok') throw new Error('agentKind(grok) failed');
    `], wt);
    const probeErrors = probe.status === 0 ? [] : [`node probe: ${(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim().split("\n").slice(-3).join(" | ")}`];
    const rust = { sites: [], other: [] };
    if (flags.has("--rust")) for (const manifest of ["src-tauri/Cargo.toml", "src-falcon/Cargo.toml"]) {
      const r = run("cargo", ["check", "--message-format=json", "--manifest-path", manifest, "--target-dir", "src-tauri/target-third-agent"], wt);
      if (r.error || r.status === null) throw new Error(`cargo failed to run: ${r.error?.message ?? r.signal}`);
      const parsed = parseRustErrors(`${r.stdout}\n${r.stderr}`, source, dirname(manifest), wt);
      rust.sites.push(...parsed.sites); rust.other.push(...parsed.other);
      if (r.status !== 0 && !parsed.sites.length && !parsed.other.length) rust.other.push(`${manifest}: cargo exited ${r.status} without compiler diagnostics`);
    }
    const sites = sortSites([...new Map([...tsc.sites, ...rust.sites].map((s) => [siteKey(s), s])).values()]);
    const forced = forcedOutside(scan.entries.filter((e) => e.lang === "ts" || (flags.has("--rust") && e.lang === "rs")), sites);
    const { missing, extra } = flags.has("--init") ? { missing: [], extra: [] } : compareSites(fixture.sites.filter((s) => flags.has("--rust") || s.kind !== "rust-match"), sites);
    for (const [name, rows] of [["missing expected sites", missing], ["extra error sites", extra], ["non-target TS errors", tsc.other], ["non-E0004 Rust errors", rust.other], ["forced keys without error", forced], ["probe failures", probeErrors]]) if (rows.length) console.log(`${name}:\n${rows.map((x) => `  ${typeof x === "string" ? x : JSON.stringify(x)}`).join("\n")}`);
    if (flags.has("--init")) {
      const yes = flags.has("--yes") && !tsc.other.length && !rust.other.length && !forced.length && !probeErrors.length;
      const initSites = flags.has("--rust") ? sites : [...sites, ...fixture.sites.filter((s) => s.kind === "rust-match")];
      console.log(initFixture(FIXTURE, oldDoc, initSites, yes));
      if (yes) console.log("fixture written");
    }
    if (missing.length || extra.length || tsc.other.length || rust.other.length || forced.length || probeErrors.length) throw new Error("third-agent check: FAIL");
    console.log(`third-agent check: ok (${sites.length} sites${flags.has("--rust") ? ", Rust included" : ", TS only"})`);
  } finally {
    if (registered) git(ROOT, "worktree", "remove", "--force", wt);
    if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
