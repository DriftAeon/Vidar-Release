// Agent-literal ratchet (M1 root-fix guard). Counts, per tracked src/**/*.ts file and literal, the quoted agent
// ids ("claude" "codex" "gemini" "pi", any quote style) and the names "Claude" "Codex" "Claude Code", comments
// stripped. tests/agent-literals.test.mjs fails when a (file, literal) key is new or a count rises, and on the
// table-only patterns used outside table files; it never fails on a drop.
// Usage: node tools/agents/agent-literals.mjs            report counts against tests/fixtures/agent-literals.json
//        node tools/agents/agent-literals.mjs --write    lower the fixture where counts fell (never raises or adds)
//        node tools/agents/agent-literals.mjs --init     create the fixture from the current counts (refuses if it exists)
//        node tools/agents/agent-literals.mjs --init-rust [--dry]  add .rs keys (src-tauri/src, src-falcon/src) to the
//                                                 fixture; --dry only prints the per-tier totals
// Rust: table files (agent_spec.rs, protocol.rs) are uncapped; adapter and debt files are capped per key and only
// shrink. Dormant until the fixture holds a .rs key. Test code (*tests.rs, #[cfg(test)] items) is skipped.
// Lexical keys (scanners rust-keys.mjs, ts-keys.mjs, ps-keys.mjs, py-keys.mjs; `missing scanner: <lang>` when absent):
//        --lang rs,ts,ps,py   --report [--tiers] [--files a,b]   --strict-dry   --strict   --owns <lanes-owns.json>
//        --pin <file:line> --why <blank-is-claude|history-data|dev-probe|wire-name> [--test <name>]
//        --write [--reason "<text>"]   --rekey [--yes]   (fixture $schema 3: C caps, $strict ratchet, $ids $enums $adapters)
// Refuses: a rise or new key under --write (exit 1); --init over an existing fixture; --init-rust when any .rs key
// exists (exit 2). Like tools/gate/paths-allow.mjs.
// Scans tracked files only (git ls-files): git add a new file before running.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS, applyPins, capsOf, checkFixture, gather, nextFixture, ownsMatch, pinRefusal, scopeFiles, strictCounts, tierOf } from "./key-words.mjs";

// AGENT_LITERALS_ROOT / AGENT_LITERALS_FIXTURE point the CLI at a temp tree (tests only).
const ROOT = process.env.AGENT_LITERALS_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURE = process.env.AGENT_LITERALS_FIXTURE ?? join(ROOT, "tests", "fixtures", "agent-literals.json");
export const LITERALS = ["claude", "codex", "gemini", "pi", "Claude", "Codex", "Claude Code"];

/** Files that hold the per-agent tables (capped like the rest, but allowed to use AGENTS.claude / AGENT_IDS[0]). */
export const TABLE_FILES = new Set([
  "src/agents/id.ts",
  "src/agents/descriptor.ts",
  "src/agents/agent-profile.ts",
  "src/agents/login-tips.ts",
  "src/agents/primary.ts",
  "src/launcher/row-facts.ts",
  "src/panels/rendered/tool-class.ts",
  "src/settings/agent-selects.ts",
]);

export function kindOf(file) {
  if (TABLE_FILES.has(file)) return "table";
  if (/^src\/agents\/(claude|codex)[^/]*\.ts$/.test(file)) return "adapter";
  return "debt";
}

/** Split TS source into code (comments blanked) and the string-literal values found outside comments. */
export function lex(src) {
  let code = "";
  const strings = [];
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      code += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && !(c !== "`" && src[j] === "\n")) j += src[j] === "\\" ? 2 : 1;
      const lit = src.slice(i, j + 1);
      strings.push(src.slice(i + 1, j));
      code += lit;
      i = j + 1;
    } else {
      code += c;
      i++;
    }
  }
  return { code, strings };
}

export function trackedSrc(root = ROOT) {
  const out = execFileSync("git", ["ls-files", "src"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  return out.split("\n").map((s) => s.trim()).filter((s) => s.endsWith(".ts"));
}

/** Map file -> { literals: {lit: n}, code } for every tracked src ts file holding at least one literal. */
export function scan(root = ROOT) {
  const res = new Map();
  for (const file of trackedSrc(root)) {
    const p = join(root, file);
    if (!existsSync(p)) continue;
    const { code, strings } = lex(readFileSync(p, "utf8"));
    const literals = {};
    for (const s of strings) if (LITERALS.includes(s)) literals[s] = (literals[s] ?? 0) + 1;
    res.set(file, { literals, code });
  }
  return res;
}

const q = `["'\`]`;
export const TABLE_USE = /\b(AGENTS|AGENT_PROFILE)\.(claude|codex)\b|\bAGENT_IDS\[\d/;
// Exactly two members, either order: not part of a longer union.
export const TWO_UNION = new RegExp(
  `(?<!${q}[\\w-]+${q}\\s*\\|\\s*)${q}(claude|codex)${q}\\s*\\|\\s*${q}(?!\\1)(claude|codex)${q}(?!\\s*\\|\\s*${q})`,
);

// ---- Rust side (D6). Same fixture; `.rs` keys appear only after `--init-rust`, until then scanning is dormant. ----

export const RUST_STRINGS = ["claude", "codex", "gemini", "pi", "Claude", "Codex"];
export const RUST_TABLE = new Set(["src-tauri/src/agent_spec.rs", "src-falcon/src/protocol.rs"]);
const RUST_ADAPTER = [
  /^src-tauri\/src\/bare\/(claude|codex)_[^/]*\.rs$/,
  /^src-tauri\/src\/codex_[^/]*\.rs$/,
  /^src-tauri\/src\/flow\/(claude|codex)\.rs$/,
  /^src-tauri\/src\/rules\/import\/(claude_json|codex_home)\.rs$/,
  /^src-falcon\/src\/(claude|codex)\.rs$/,
  /^src-falcon\/src\/codex\/driver\//,
];

export function kindOfRust(file) {
  if (RUST_TABLE.has(file)) return "table";
  if (RUST_ADAPTER.some((r) => r.test(file))) return "adapter";
  return "debt";
}

const PUNCT2 = new Set(["::", "==", "!=", "=>", "->", "<=", ">=", ".."]);

/** Rust tokens: {t: "str"|"char"|"ident"|"punct"|"num"|"life", v}. Comments and whitespace dropped. */
export function lexRust(src) {
  const toks = [];
  const len = src.length;
  const readStr = (i) => {
    let j = i + 1;
    while (j < len && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
    toks.push({ t: "str", v: src.slice(i + 1, j) });
    return j + 1;
  };
  const readChar = (i) => {
    // src[i] is the opening quote of a char literal or a lifetime
    if (src[i + 1] === "\\") {
      const end = src.indexOf("'", i + 3);
      toks.push({ t: "char", v: "" });
      return end < 0 ? len : end + 1;
    }
    const L = String.fromCodePoint(src.codePointAt(i + 1) ?? 32).length;
    if (src[i + 1 + L] === "'") {
      toks.push({ t: "char", v: "" });
      return i + L + 2;
    }
    let j = i + 1;
    while (j < len && /[A-Za-z0-9_]/.test(src[j])) j++;
    toks.push({ t: "life", v: src.slice(i + 1, j) });
    return Math.max(j, i + 1);
  };
  for (let i = 0; i < len; ) {
    const c = src[i];
    const n = src[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && n === "/") { while (i < len && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") {
      let depth = 1;
      i += 2;
      while (i < len && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; }
        else if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < len && /[A-Za-z0-9_]/.test(src[j])) j++;
      const id = src.slice(i, j);
      if (id === "r" || id === "br" || id === "cr") {
        let h = 0;
        while (src[j + h] === "#") h++;
        if (src[j + h] === '"') {
          const close = '"' + "#".repeat(h);
          const end = src.indexOf(close, j + h + 1);
          const stop = end < 0 ? len : end;
          toks.push({ t: "str", v: src.slice(j + h + 1, stop) });
          i = end < 0 ? len : end + close.length;
          continue;
        }
      } else if ((id === "b" || id === "c") && src[j] === '"') { i = readStr(j); continue; }
      else if (id === "b" && src[j] === "'") { i = readChar(j); continue; }
      toks.push({ t: "ident", v: id });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < len && /[0-9A-Za-z_]/.test(src[j])) j++;
      toks.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"') { i = readStr(i); continue; }
    if (c === "'") { i = readChar(i); continue; }
    const two = c + (n ?? "");
    if (PUNCT2.has(two)) { toks.push({ t: "punct", v: two }); i += 2; continue; }
    toks.push({ t: "punct", v: c });
    i++;
  }
  return toks;
}

const isP = (t, v) => t?.t === "punct" && t.v === v;
const isI = (t, v) => t?.t === "ident" && t.v === v;

/** Index just past the item starting at k: `;` at depth 0, or the `}` that closes the first brace block. */
function skipItem(toks, k) {
  let depth = 0;
  while (k < toks.length) {
    const t = toks[k];
    if (t.t === "punct") {
      if (t.v === "{" || t.v === "[" || t.v === "(") depth++;
      else if (t.v === "}" || t.v === "]" || t.v === ")") {
        depth--;
        if (depth < 0) return k;
        if (depth === 0 && t.v === "}") return k + 1;
      } else if (t.v === ";" && depth === 0) return k + 1;
    }
    k++;
  }
  return k;
}

/** End index (past `]`) of the attribute whose `#` is at k, or -1. */
function attrEnd(toks, k) {
  if (!isP(toks[k], "#") || !isP(toks[k + 1], "[")) return -1;
  let depth = 0;
  for (let j = k + 1; j < toks.length; j++) {
    if (isP(toks[j], "[")) depth++;
    else if (isP(toks[j], "]") && --depth === 0) return j + 1;
  }
  return -1;
}

/** Literal counts for one Rust file's source; test code skipped (cfg(test) items). */
export function countRust(src, file = "") {
  const toks = lexRust(src);
  const lits = {};
  const add = (key) => { lits[key] = (lits[key] ?? 0) + 1; };
  const table = kindOfRust(file) === "table";
  for (let k = 0; k < toks.length; ) {
    const t = toks[k];
    if (isP(t, "#")) {
      const end = attrEnd(toks, k);
      if (end > 0 && isI(toks[k + 2], "cfg") && isP(toks[k + 3], "(") && isI(toks[k + 4], "test") && isP(toks[k + 5], ")") && end === k + 7) {
        let j = end;
        for (let e = attrEnd(toks, j); e > 0; e = attrEnd(toks, j)) j = e;
        k = skipItem(toks, j);
        continue;
      }
    }
    if (t.t === "str" && RUST_STRINGS.includes(t.v)) add(t.v);
    else if (isI(t, "Agent") && isP(toks[k + 1], "::")) {
      const v = toks[k + 2];
      if (isI(v, "Claude")) add("Agent::Claude");
      else if (isI(v, "Codex")) add("Agent::Codex");
      const prev = toks[k - 1];
      if (isP(prev, "==") || isP(prev, "!=")) add("== Agent::");
    } else if (isI(t, "use") && !table) {
      for (let j = k + 1; j < toks.length && !isP(toks[j], ";"); j++) {
        if (isI(toks[j], "Agent") && ((isP(toks[j + 1], "::") && (isP(toks[j + 2], "{") || isP(toks[j + 2], "*"))) || isI(toks[j + 1], "as"))) add("use Agent");
      }
    }
    k++;
  }
  return lits;
}

export function trackedRust(root = ROOT) {
  const out = execFileSync("git", ["ls-files", "src-tauri/src", "src-falcon/src"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  return out.split("\n").map((s) => s.trim()).filter((s) => s.endsWith(".rs") && !/tests\.rs$/.test(s));
}

/** Map file -> { kind, literals } for every tracked Rust file holding at least one key. */
export function scanRust(root = ROOT, files = trackedRust(root)) {
  const res = new Map();
  for (const file of files) {
    const p = join(root, file);
    if (!existsSync(p)) continue;
    const literals = countRust(readFileSync(p, "utf8"), file);
    if (Object.keys(literals).length) res.set(file, { kind: kindOfRust(file), literals });
  }
  return res;
}

export const hasRustKeys = (fx) => Object.keys(fx).some((f) => f.endsWith(".rs"));

/** Rises against the fixture for adapter and debt files; table files are uncapped. */
export function checkRust(counts, fx) {
  const rises = [];
  for (const [file, { kind, literals }] of counts) {
    if (kind === "table") continue;
    for (const [key, n] of Object.entries(literals)) {
      const cap = fx[file]?.literals?.[key];
      if (cap === undefined || n > cap) rises.push(`${file} ${JSON.stringify(key)}: ${n} > ${cap ?? "unlisted"}`);
    }
  }
  return rises;
}

export function rustTotals(counts) {
  const tiers = {};
  for (const [, { kind, literals }] of counts) {
    const t = (tiers[kind] ??= { files: 0, keys: {} });
    t.files++;
    for (const [k, n] of Object.entries(literals)) t.keys[k] = (t.keys[k] ?? 0) + n;
  }
  return tiers;
}

function printTotals(counts) {
  for (const [tier, { files, keys }] of Object.entries(rustTotals(counts))) {
    const total = Object.values(keys).reduce((a, b) => a + b, 0);
    console.log(`rust ${tier}: ${files} files, ${total} keys ${JSON.stringify(keys)}`);
  }
}

// ---- Lexical keys: scanners per language, tiers, classes, anchored pins, schema-3 fixture. ----

const PINS = process.env.AGENT_LITERALS_PINS ?? join(dirname(FIXTURE), "agent-pins.json");
const KEY_FLAGS = ["--report", "--strict-dry", "--strict", "--owns", "--pin", "--rekey", "--lang"];
const arg = (flags, name) => { const i = flags.indexOf(name); return i >= 0 && flags[i + 1] && !flags[i + 1].startsWith("--") ? flags[i + 1] : null; };
const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");
const CLASSES = ["S1", "S2", "S3", "S4", "F", "C"];

/** Modified or untracked paths among the fixtures and the scanned files only (L7); schemas under src-tauri/gen ignored. */
function dirtyScoped() {
  const watch = new Set([...scopeFiles(ROOT), rel(FIXTURE), rel(PINS)]);
  const out = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 });
  return out.split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""))
    .filter((f) => watch.has(f) || (f.endsWith("/") && [...watch].some((w) => w.startsWith(f))));
}

function printReport(g, unpinned, tiers) {
  const bad = new Set(unpinned);
  const row = {};
  for (const e of g.entries) {
    const r = (row[e.tier.startsWith("adapter") ? "adapter" : e.tier] ??= { files: new Set(), keys: 0, cls: {}, strict: 0, pinned: 0, cap: 0, free: 0, skip: 0 });
    r.files.add(e.file); r.keys++; r.cls[e.cls] = (r.cls[e.cls] ?? 0) + 1;
    if (e.strictness === "strict") r[bad.has(e) ? "strict" : "pinned"]++;
    else r[e.strictness]++;
  }
  const line = (name, r) => `${name.padEnd(10)} files ${String(r.files.size).padStart(4)} keys ${String(r.keys).padStart(5)} | ${CLASSES.map((c) => `${c} ${r.cls[c] ?? 0}`).join(" ")} | strict ${r.strict} pinned ${r.pinned} cap ${r.cap} free ${r.free} skip ${r.skip}`;
  for (const lang of g.loaded) {
    const n = g.entries.filter((e) => e.lang === lang);
    console.log(`${lang}: ${new Set(n.map((e) => e.file)).size} files, ${n.length} keys, ${n.filter((e) => bad.has(e)).length} unpinned strict`);
  }
  if (!tiers) {
    const all = { files: new Set(), keys: 0, cls: {}, strict: 0, pinned: 0, cap: 0, free: 0, skip: 0 };
    for (const r of Object.values(row)) { r.files.forEach((f) => all.files.add(f)); all.keys += r.keys; for (const k of ["strict", "pinned", "cap", "free", "skip"]) all[k] += r[k]; for (const [c, n] of Object.entries(r.cls)) all.cls[c] = (all.cls[c] ?? 0) + n; }
    console.log(line("all", all));
    return;
  }
  for (const t of ["table", "adapter", "other", "devtool"]) if (row[t]) console.log(line(t, row[t]));
  const files = {};
  for (const f of g.all) { const t = tierOf(f).replace(/:.*/, ""); (files[t] ??= []).push(f); }
  console.log(`scope files by tier: ${Object.entries(files).map(([t, l]) => `${t} ${l.length}`).join(", ")}`);
  const ad = g.adapters.reduce((o, f) => { const d = f.split("/")[0]; o[d] = (o[d] ?? 0) + 1; return o; }, {});
  console.log(`adapter files: ${g.adapters.length} ${JSON.stringify(ad)}`);
}

async function keysMain(flags, schema3) {
  const langs = (arg(flags, "--lang") ?? "rs,ts,ps,py").split(",");
  const only = arg(flags, "--files")?.split(",").map((s) => s.replace(/\\/g, "/")) ?? null;
  const pinTarget = arg(flags, "--pin");
  const g = await gather(ROOT, langs, pinTarget ? [pinTarget.replace(/:\d+$/, "").replace(/\\/g, "/")] : only);
  for (const l of g.missing) console.log(`missing scanner: ${l}`);
  const pinsDoc = readJson(PINS, { $schema: 1, pins: [] });
  const { unpinned, problems } = applyPins(g.entries, pinsDoc.pins ?? [], g.loaded, only);
  const cur = { caps: capsOf(g.entries), strict: strictCounts(unpinned) };
  const exit = (code) => process.exit(code);
  if (pinTarget) {
    const line = Number(pinTarget.match(/:(\d+)$/)?.[1]);
    const why = arg(flags, "--why"), test = arg(flags, "--test");
    const hits = unpinned.filter((e) => e.line === line);
    const base = { why, ...(test ? { test } : {}) };
    const bad = pinRefusal({ file: "x", anchor: "x", n: 0, ...base });
    if (bad) { console.error(`pin refused: ${bad}`); exit(2); }
    if (!hits.length) { console.error(`pin refused: no unpinned strict key at ${pinTarget}`); exit(2); }
    for (const e of hits) pinsDoc.pins.push({ file: e.file, anchor: e.anchor, n: e.n, ...base });
    pinsDoc.pins.sort((a, b) => a.file.localeCompare(b.file) || a.anchor.localeCompare(b.anchor));
    writeJson(PINS, pinsDoc);
    console.log(`pinned ${hits.length} key(s) at ${pinTarget}`);
    return;
  }
  if (flags.includes("--rekey")) {
    const old = readJson(FIXTURE, {});
    if (old.$schema === 3) { console.error("fixture is already $schema 3; --rekey refuses"); exit(2); }
    printReport(g, unpinned, true);
    const { fx } = nextFixture(null, g, cur, null);
    console.log(`rekey: old fixture ${Object.keys(old).filter((f) => !f.startsWith("$")).length} files; new fixture ${Object.keys(fx).filter((f) => !f.startsWith("$")).length} capped files, ${Object.keys(fx.$strict).length} files with strict keys (${unpinned.length} keys), $enums ${JSON.stringify(fx.$enums)}`);
    if (!flags.includes("--yes")) { console.log("dry run; --rekey --yes writes the fixture"); return; }
    const dirty = dirtyScoped();
    if (dirty.length) { console.error(`--rekey --yes needs a clean tree for the fixtures and scanned files:\n  ${dirty.join("\n  ")}`); exit(2); }
    const absent = Object.keys(LANGS).filter((l) => !g.loaded.includes(l));
    if (absent.length) { console.error(`--rekey --yes needs every scanner (missing: ${absent.join(", ")})`); exit(2); }
    writeJson(FIXTURE, fx);
    if (!existsSync(PINS)) writeJson(PINS, pinsDoc);
    console.log("fixture rekeyed ($schema 3)");
    return;
  }
  if (flags.includes("--write")) {
    if (!schema3) { console.error("--write on the keys fixture needs $schema 3; run --rekey --yes first"); exit(2); }
    const { fx, refusals } = nextFixture(schema3 ? readJson(FIXTURE, {}) : null, g, cur, arg(flags, "--reason"));
    if (refusals.length) { console.error(`refused:\n  ${refusals.join("\n  ")}`); exit(1); }
    writeJson(FIXTURE, fx);
    console.log("fixture written");
    return;
  }
  const out = [...problems];
  if (flags.includes("--report")) {
    if (only) for (const e of g.entries) console.log(`${e.file}:${e.line}\t${e.cls}\t${e.strictness}${unpinned.includes(e) || e.strictness !== "strict" ? "" : " pinned"}\t${e.tok}\t${e.anchor}`);
    printReport(g, unpinned, flags.includes("--tiers"));
    return;
  }
  if (flags.includes("--owns")) {
    const owns = readJson(arg(flags, "--owns"), {});
    const lanes = Object.entries(owns).filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, Array.isArray(v) ? v : v.owns ?? []]);
    for (const f of [...new Set(unpinned.map((e) => e.file))]) {
      const who = lanes.filter(([, l]) => l.some((o) => ownsMatch(o, f))).map(([k]) => k);
      if (who.length !== 1) out.push(`${f}: ${who.length ? `owned by ${who.join(", ")}` : "owned by no lane"}`);
    }
    console.log(`owns: ${new Set(unpinned.map((e) => e.file)).size} strict-hit files`);
  } else if (flags.includes("--strict-dry")) {
    for (const e of unpinned) console.log(`${e.file}:${e.line} ${e.cls} ${e.tok}\n  ${JSON.stringify({ file: e.file, anchor: e.anchor, n: e.n, why: "?" })}`);
    if (unpinned.length) out.push(`${unpinned.length} unpinned strict key(s)`);
  } else {
    if (schema3 && !only) out.push(...checkFixture(readJson(FIXTURE, {}), g, cur));
    if (flags.includes("--strict")) {
      if (unpinned.length) out.push(`${unpinned.length} unpinned strict key(s), first ${unpinned[0].file}:${unpinned[0].line}`);
      if (g.missing.length) out.push(`missing scanner: ${g.missing.join(", ")}`);
    }
  }
  if (out.length) { console.error(out.join("\n")); exit(1); }
  console.log("ok");
}

function main() {
  const flags = process.argv.slice(2);
  if (!flags.includes("--init") && !flags.includes("--init-rust")) {
    const schema3 = existsSync(FIXTURE) && JSON.parse(readFileSync(FIXTURE, "utf8")).$schema === 3;
    if (schema3 || flags.some((f) => KEY_FLAGS.includes(f))) {
      keysMain(flags, schema3).catch((e) => { console.error(e.stack ?? e); process.exit(2); });
      return;
    }
  }
  if (flags.includes("--init-rust")) {
    if (!existsSync(FIXTURE)) { console.error("fixture missing; run --init first"); process.exit(2); }
    const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
    if (hasRustKeys(fx)) { console.error(".rs keys already exist; use --write to lower them"); process.exit(2); }
    const rs = scanRust();
    printTotals(rs);
    if (flags.includes("--dry")) return;
    let added = 0;
    for (const [file, e] of [...rs].sort()) {
      if (e.kind === "table") continue;
      fx[file] = e;
      added++;
    }
    writeFileSync(FIXTURE, JSON.stringify(fx, null, 2) + "\n");
    console.log(`fixture written: ${added} rust files`);
    return;
  }
  const counts = scan();
  if (flags.includes("--init")) {
    if (existsSync(FIXTURE)) { console.error("fixture exists; use --write"); process.exit(1); }
    const fx = {};
    for (const [file, { literals }] of [...counts].sort()) {
      if (Object.keys(literals).length) fx[file] = { kind: kindOf(file), literals };
    }
    writeFileSync(FIXTURE, JSON.stringify(fx, null, 2) + "\n");
    console.log(`fixture written: ${Object.keys(fx).length} files`);
    return;
  }
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const rustOn = hasRustKeys(fx);
  const rs = scanRust();
  const rises = [];
  let dropped = 0;
  for (const [file, { literals }] of counts) {
    for (const [lit, n] of Object.entries(literals)) {
      const cap = fx[file]?.literals?.[lit];
      if (cap === undefined || n > cap) rises.push(`${file} ${JSON.stringify(lit)}: ${n} > ${cap ?? "unlisted"}`);
    }
  }
  if (rustOn) rises.push(...checkRust(rs, fx));
  for (const [file, e] of Object.entries(fx)) {
    if (file.startsWith("$")) continue;
    const now = file.endsWith(".rs") ? rs.get(file) : counts.get(file);
    for (const [lit, cap] of Object.entries(e.literals)) if ((now?.literals[lit] ?? 0) < cap) dropped++;
  }
  console.log(`${dropped} fixture keys above their current count`);
  if (!rustOn) {
    console.log("rust scanning dormant (no .rs keys in the fixture); --init-rust would write:");
    printTotals(rs);
  }
  if (rises.length) {
    console.error(`rise (fix the call site; never raise the fixture):\n  ${rises.join("\n  ")}`);
    process.exit(1);
  }
  if (flags.includes("--write")) {
    const next = {};
    for (const [file, e] of Object.entries(fx)) {
      if (file.startsWith("$")) { next[file] = e; continue; }
      const lits = {};
      const now = file.endsWith(".rs") ? rs.get(file) : counts.get(file);
      for (const [lit, cap] of Object.entries(e.literals)) {
        const n = now?.literals[lit] ?? 0;
        if (n > 0) lits[lit] = Math.min(cap, n);
      }
      if (Object.keys(lits).length) next[file] = { kind: e.kind, literals: lits };
    }
    writeFileSync(FIXTURE, JSON.stringify(next, null, 2) + "\n");
    console.log("fixture lowered");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
