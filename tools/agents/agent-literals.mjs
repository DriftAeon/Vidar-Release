// Agent-key gate (M1 root-fix guard). Lexical keys from the per-language scanners (rust-keys.mjs, ts-keys.mjs,
// ps-keys.mjs, py-keys.mjs; `missing scanner: <lang>` when absent) against tests/fixtures/agent-literals.json
// ($schema 3: C caps, $strict ratchet, $ids $enums $closed $adapters) and the anchored pins in agent-pins.json.
// Every agent id comes from the table (src/agents/id.ts, protocol.rs) through key-words.mjs; none is spelled here.
// Usage: node tools/agents/agent-literals.mjs   check caps, strict ratchet, derived lists and inline AgentId unions
//        --lang rs,ts,ps,py   --report [--tiers] [--files a,b]   --strict-dry   --strict   --owns <lanes-owns.json>
//        --pin <file:line> --why <blank-default|history-data|dev-probe|wire-name> [--test <name>]
//        --write [--reason "<text>"]   --rekey [--yes]
// Refuses: a rise under --write without --reason (exit 1); --rekey over a $schema 3 fixture; the removed v1 flags
// --init and --init-rust (exit 2). Like tools/gate/paths-allow.mjs.
// countRust / kindOfRust keep the per-file Rust literal counter (table strings and Agent:: variants) for callers
// that want raw counts; test code (#[cfg(test)] items) is skipped.
// Scans tracked files only (git ls-files): git add a new file before running.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../lib/json.mjs";
import { root as repoRoot } from "../lib/paths.mjs";
import { LANGS, applyPins, capsOf, checkFixture, gather, idUnionProblems, nextFixture, ownsMatch, pinRefusal, scopeFiles, strictCounts, tableIds, tierOf } from "./key-words.mjs";

// AGENT_LITERALS_ROOT / AGENT_LITERALS_FIXTURE point the CLI at a temp tree (tests only).
const ROOT = process.env.AGENT_LITERALS_ROOT ?? repoRoot();
export const FIXTURE = process.env.AGENT_LITERALS_FIXTURE ?? join(ROOT, "tests", "fixtures", "agent-literals.json");

// ---- Rust literal counter: ids from the table, adapters by path tier. ----

const TABLE = tableIds(ROOT);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Quoted Rust strings that count: every id and PTY-only id, plus each agent id's display spelling. */
export const RUST_STRINGS = [...TABLE.ids, ...TABLE.ptyOnly, ...TABLE.ids.map(cap)];
export const RUST_TABLE = new Set(["src-tauri/src/agent_spec.rs", "src-falcon/src/protocol.rs"]);

export function kindOfRust(file) {
  if (RUST_TABLE.has(file)) return "table";
  if (tierOf(file).startsWith("adapter:")) return "adapter";
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
      if (v?.t === "ident" && TABLE.enumIds.includes(v.v.toLowerCase())) add(`Agent::${v.v}`);
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

// ---- Lexical keys: scanners per language, tiers, classes, anchored pins, schema-3 fixture. ----

const PINS = process.env.AGENT_LITERALS_PINS ?? join(dirname(FIXTURE), "agent-pins.json");
const arg = (flags, name) => { const i = flags.indexOf(name); return i >= 0 && flags[i + 1] && !flags[i + 1].startsWith("--") ? flags[i + 1] : null; };
const readJsonOr = (p, d) => (existsSync(p) ? readJson(p) : d);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");
const CLASSES = ["S1", "S2", "S3", "S4", "F", "St", "C"];

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
  for (const o of g.enums.open ?? []) console.log(`open enum ${o.name}: ${o.file}:${o.line}`);
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
  const pinsDoc = readJsonOr(PINS,{ $schema: 1, pins: [] });
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
    const old = readJsonOr(FIXTURE, {});
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
    const { fx, refusals } = nextFixture(schema3 ? readJsonOr(FIXTURE, {}) : null, g, cur, arg(flags, "--reason"));
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
    const owns = readJsonOr(arg(flags, "--owns"), {});
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
    if (schema3 && !only) out.push(...checkFixture(readJsonOr(FIXTURE, {}), g, cur));
    out.push(...idUnionProblems(g.entries));
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
  const gone = flags.filter((f) => f === "--init" || f === "--init-rust");
  if (gone.length) { console.error(`${gone.join(", ")}: removed with the v1 literal ratchet; the fixture is $schema 3 (--rekey, --write)`); process.exit(2); }
  const schema3 = existsSync(FIXTURE) && JSON.parse(readFileSync(FIXTURE, "utf8")).$schema === 3;
  keysMain(flags, schema3).catch((e) => { console.error(e.stack ?? e); process.exit(2); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
