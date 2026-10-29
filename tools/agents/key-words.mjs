// Shared agent-key vocabulary for the lexical scanners. Every language scanner
// (rust-keys.mjs, ts-keys.mjs, ps-keys.mjs, py-keys.mjs) returns [{file, line, tok, cls, anchor, forced, tier}] and
// asks this module for ids, words, tiers, classes and anchors. Frozen contract (A1r):
//   ids(root)            -> { ids, ptyOnly, aliases, enumIds } read from src/agents/id.ts, agent-kind.ts, protocol.rs
//   words(tok)           -> lowercased words (camelCase, ACRONYMWord, letter/digit, all-caps id prefix)
//   tierOf(path)         -> table | adapter:<id> | test | harness | devtool | other
//   classOf(tok, ctx)    -> S1 | S2 | S3 | S4 | F | C | none; ctx { kind, condition, negated, fallbackArm, forcedArm,
//                           mergesNone }; kind is ident | literal | regex | positional
//   anchor(tokens, i, itemName) -> "<item>: <key +-3 tokens>"
// Beyond the contract: strictOf(entry) decides strict | cap | free | skip (R1, R2, R3, R9); pins, caps and the
// schema-3 fixture helpers live here so the CLI stays thin.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_IDS = { ids: ["claude", "codex"], ptyOnly: ["gemini", "pi"], aliases: { anthropic: "claude", openai: "codex" }, enumIds: [] };
let CUR = DEFAULT_IDS;
export const useIds = (x) => { CUR = x ?? DEFAULT_IDS; };
const idList = () => [...CUR.ids, ...CUR.ptyOnly];
export const isIdWord = (w) => idList().includes(w) || w in CUR.aliases;
const canon = (w) => (idList().includes(w) ? w : CUR.aliases[w] ?? null);

const rd = (root, rel) => { const p = join(root, rel); return existsSync(p) ? readFileSync(p, "utf8") : null; };
const quoted = (s) => [...s.matchAll(/["']([\w-]+)["']/g)].map((m) => m[1]);

/** Id set read from the table at scan time; also becomes the current set for words/classOf. */
export function ids(root) {
  const out = { ids: DEFAULT_IDS.ids, ptyOnly: DEFAULT_IDS.ptyOnly, aliases: { ...DEFAULT_IDS.aliases }, enumIds: [] };
  const idTs = rd(root, "src/agents/id.ts");
  if (idTs) {
    const a = idTs.match(/AGENT_IDS\s*=\s*\[([^\]]*)\]/);
    if (a) out.ids = quoted(a[1]);
    const p = idTs.match(/PTY_ONLY_IDS\s*=\s*\[([^\]]*)\]/);
    if (p) out.ptyOnly = quoted(p[1]);
  }
  if (!idTs?.includes("PTY_ONLY_IDS")) {
    const f = rd(root, "src/launcher/agent-kind.ts")?.match(/function agentKind[\s\S]*?\n\}/);
    if (f) out.ptyOnly = [...f[0].matchAll(/id === ["'](\w+)["']/g)].map((m) => m[1]);
  }
  const en = rd(root, "src-falcon/src/protocol.rs")?.match(/pub enum Agent\s*\{([^}]*)\}/);
  if (en) out.enumIds = [...en[1].matchAll(/^\s*([A-Z]\w*)/gm)].map((m) => m[1].toLowerCase());
  CUR = out;
  return out;
}

/** Lowercased words: split on non-alphanumerics, camelCase, ACRONYMWord, letter/digit; an id is also split off the
 *  front of an all-caps piece (CLAUDECODE -> claude, code; R4), for ids and aliases of 4+ letters. */
export function words(tok) {
  const out = [];
  for (const piece of String(tok).split(/[^A-Za-z0-9]+/)) {
    if (!piece) continue;
    const caps = /^[A-Z]{5,}$/.test(piece);
    for (const w of piece.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []) {
      const lw = w.toLowerCase();
      const pre = caps && w === piece ? [...idList(), ...Object.keys(CUR.aliases)].find((i) => i.length >= 4 && lw.length > i.length && lw.startsWith(i)) : null;
      if (pre) out.push(pre, lw.slice(pre.length));
      else out.push(lw);
    }
  }
  return out;
}

/** Canonical ids named by the words of a token (aliases mapped: anthropic -> claude). */
export const idsIn = (tok) => [...new Set(words(tok).map(canon).filter(Boolean))];

const TABLE_FILES = new Set(["src-tauri/src/agent_spec.rs", "src/agents/id.ts", "src/agents/descriptor.ts", "tools/lib/FalconRuntimes.ps1"]);
const DEV_EXEMPT = /^tools\/(release|falcon|lib|runes|agents|gate)\/|^tools\/[^/]*sidecar[^/]*\.mjs$|^tools\/sandbox\/write-audit\.ps1$/;

export function tierOf(path) {
  const p = path.replace(/\\/g, "/");
  const file = p.split("/").pop();
  const stem = file.replace(/\.[^.]+$/, "");
  if (/(^|\/)tests\//.test(p) || /\.test\.mjs$/.test(file) || file === "tests.rs" || /_tests\.rs$/.test(file) || /^test_.*\.py$/.test(file)) return "test";
  if (!/^tools\/[^/]*sidecar-seed\.mjs$/.test(p) && ((p.startsWith("tools/sandbox/") && p !== "tools/sandbox/write-audit.ps1") || /(-smoke|-e2e|_smoke|smoke_test|-seed-data)$/.test(stem))) return "harness";
  if (TABLE_FILES.has(p)) return "table";
  // Dev tools stay capped even when their path names one agent (dev tools are capped).
  if (/^tools\//.test(p) && !DEV_EXEMPT.test(p)) return "devtool";
  const found = [...new Set(words(p.replace(/\.[^./]+$/, "")).map(canon).filter(Boolean))];
  if (found.length === 1) return `adapter:${found[0]}`;
  return "other";
}

const litAlt = () => [...idList(), ...Object.keys(CUR.aliases)].join("|");

function litClass(s) {
  if (!words(s).some(isIdWord)) return "none";
  if (/\s/.test(s)) return "C";
  const a = litAlt();
  if (new RegExp(`^(${a})$`, "i").test(s)) return "S2";
  if (new RegExp(`^\\.?(${a})(\\.\\w+)*$`, "i").test(s)) return "S3";
  if (new RegExp(`^(${a})[-_:/.\\\\]|[-_:/.\\\\](${a})$`, "i").test(s)) return "S2";
  return "C";
}

export function classOf(tok, ctx = {}) {
  let base;
  if (ctx.kind === "positional") base = "S4";
  else if (ctx.kind === "regex") base = words(tok).some(isIdWord) ? "S2" : "none";
  else if (ctx.kind === "literal") base = litClass(tok);
  else {
    const ws = words(tok);
    base = !ws.some(isIdWord) ? "none" : ws.length === 1 ? "S1" : "C";
  }
  if (base[0] === "S" && ctx.forcedArm && !ctx.mergesNone && !ctx.fallbackArm) return "F";
  return base;
}

export function anchor(tokens, i, item) {
  const tx = (t) => (typeof t === "string" ? t : t.text ?? String(t.v));
  const w = [];
  for (let k = Math.max(0, i - 3); k <= Math.min(tokens.length - 1, i + 3); k++) w.push(tx(tokens[k]));
  return `${item}: ${w.join(" ")}`;
}

/** strict | cap | free | skip for one scanner entry {cls, tier, ids, ctx}. */
export function strictOf(e) {
  const t = e.tier;
  if (t === "test" || t === "harness") return "skip";
  if (t === "table" || e.cls === "F") return "free";
  if (t === "devtool") return "cap";
  const c = e.ctx ?? {};
  const own = t.startsWith("adapter:") && e.ids.length > 0 && e.ids.every((i) => i === t.slice(8));
  const r1 = c.negated || c.fallbackArm || c.condition;
  if (e.cls[0] === "S") {
    if (c.mergesNone || c.wild) return "strict";
    return own && !r1 ? "free" : "strict";
  }
  if (c.condition) return "strict";
  if (own) return r1 ? "strict" : "free";
  return "cap";
}

// ---- files, scanners ----

export const LANGS = {
  rs: { mod: "rust-keys.mjs", re: /^(src-tauri|src-falcon)\/src\/.*\.rs$/ },
  ts: { mod: "ts-keys.mjs", re: /^(src\/.*\.ts|tools\/.*\.mjs)$/ },
  ps: { mod: "ps-keys.mjs", re: /^tools\/.*\.ps1$/ },
  py: { mod: "py-keys.mjs", re: /^content\/.*\.py$/ },
};
export const langOf = (f) => Object.keys(LANGS).find((l) => LANGS[l].re.test(f));

export function scopeFiles(root) {
  const out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 27 });
  return out.split("\n").map((s) => s.trim()).filter((f) => f && langOf(f) && existsSync(join(root, f)));
}

/** Load the scanner modules that exist; scan the (optionally filtered) scope. `missing` lists absent languages. */
export async function gather(root, langs, files = null) {
  const idv = ids(root);
  const all = scopeFiles(root);
  const entries = [], missing = [], loaded = [];
  let enums = new Map();
  for (const lang of langs) {
    const mp = join(HERE, LANGS[lang].mod);
    if (!existsSync(mp)) { missing.push(lang); continue; }
    const mod = await import(pathToFileURL(mp).href);
    loaded.push(lang);
    const live = all.filter((f) => LANGS[lang].re.test(f) && !["test", "harness"].includes(tierOf(f)))
      .map((path) => ({ path, src: readFileSync(join(root, path), "utf8") }));
    const ctx = { root, ids: idv, enums: new Map() };
    if (mod.enumsOf) ctx.enums = mod.enumsOf(live, ctx);
    if (lang === "rs") enums = ctx.enums;
    const sub = files ? live.filter((f) => files.includes(f.path)) : live;
    for (const e of mod.scan(sub, ctx)) entries.push({ ...e, lang, strictness: strictOf(e) });
  }
  const adapters = all.filter((f) => tierOf(f).startsWith("adapter:")).sort();
  return { entries, missing, loaded, idv, enums, adapters, all };
}

// ---- pins ----

export const WHY = ["blank-is-claude", "history-data", "dev-probe", "wire-name"];
const NEEDS_TEST = new Set(["blank-is-claude", "history-data"]);

export function pinRefusal(p) {
  if (!p.file || !p.anchor || !Number.isInteger(p.n)) return "needs file, anchor and integer n";
  if (!WHY.includes(p.why)) return `why must be one of ${WHY.join(", ")}`;
  if (NEEDS_TEST.has(p.why) && !p.test) return `${p.why} needs --test <name> of the test that exercises it`;
  return null;
}

/** Strict entries minus pinned ones, plus dead / off-n / malformed pin problems. `entries` carry `n`. */
export function applyPins(entries, pins, loaded, only = null) {
  const problems = [];
  const strict = entries.filter((e) => e.strictness === "strict");
  const live = new Map(strict.map((e) => [`${e.file}\0${e.anchor}`, e]));
  const pinned = new Set();
  for (const p of pins) {
    if (!loaded.includes(langOf(p.file)) || (only && !only.includes(p.file))) continue;
    const bad = pinRefusal(p);
    if (bad) { problems.push(`pin ${p.file} "${p.anchor}": ${bad}`); continue; }
    const e = live.get(`${p.file}\0${p.anchor}`);
    if (!e) problems.push(`dead pin ${p.file} "${p.anchor}"`);
    else if (e.n !== p.n) problems.push(`pin ${p.file} "${p.anchor}": n is ${e.n}, pinned ${p.n}`);
    else pinned.add(`${p.file}\0${p.anchor}`);
  }
  return { unpinned: strict.filter((e) => !pinned.has(`${e.file}\0${e.anchor}`)), problems };
}

// ---- schema-3 fixture: caps, strict ratchet, derived lists ----

export function capsOf(entries) {
  const caps = {};
  for (const e of entries) {
    if (e.strictness !== "cap") continue;
    for (const id of e.ids) { const c = (caps[e.file] ??= {}); c[id] = (c[id] ?? 0) + 1; }
  }
  return caps;
}

export function strictCounts(unpinned) {
  const out = {};
  for (const e of unpinned) out[e.file] = (out[e.file] ?? 0) + 1;
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const idSet = (idv) => [...new Set([...idv.ids, ...idv.ptyOnly])].sort();

/** Derived header: $ids, $enums, $adapters. */
export function derived(g) {
  return { $ids: idSet(g.idv), $enums: [...g.enums.keys()].sort(), $adapters: g.adapters };
}

/** Problems of a schema-3 fixture against the current scan; `inScope(file)` limits the files checked. */
export function checkFixture(fx, g, cur, inScope = () => true) {
  const out = [];
  const d = derived(g);
  if (!same(fx.$ids, d.$ids)) out.push(`$ids drift: fixture ${JSON.stringify(fx.$ids)}, table ${JSON.stringify(d.$ids)}`);
  if (g.loaded.includes("rs") && !same(fx.$enums, d.$enums)) out.push(`$enums drift: fixture ${JSON.stringify(fx.$enums)}, derived ${JSON.stringify(d.$enums)}`);
  for (const a of d.$adapters) if (inScope(a) && !(fx.$adapters ?? []).includes(a)) out.push(`new adapter path ${a} (review it, then --write)`);
  for (const [file, c] of Object.entries(cur.caps)) {
    if (!inScope(file)) continue;
    for (const [id, n] of Object.entries(c)) if (n > (fx[file]?.caps?.[id] ?? 0)) out.push(`cap rise ${file} ${id}: ${n} > ${fx[file]?.caps?.[id] ?? 0}`);
  }
  for (const [file, n] of Object.entries(cur.strict)) if (inScope(file) && n > (fx.$strict?.[file] ?? 0)) out.push(`strict rise ${file}: ${n} > ${fx.$strict?.[file] ?? 0}`);
  return out;
}

/** Next fixture from the old one and the scan: caps and $strict only fall; a rise needs `reason` (R6). */
export function nextFixture(old, g, cur, reason) {
  const refusals = [];
  const fx = { $schema: 3, ...derived(g), $strict: {} };
  const langs = g.loaded;
  const mine = (f) => langs.includes(langOf(f));
  for (const [file, e] of Object.entries(old ?? {})) {
    if (file.startsWith("$") || mine(file)) continue;
    fx[file] = e;
    if (old.$strict?.[file]) fx.$strict[file] = old.$strict[file];
  }
  for (const [file, c] of Object.entries(cur.caps)) {
    const ent = { tier: tierOf(file), caps: {} };
    const reasons = { ...(old?.[file]?.reasons ?? {}) };
    for (const [id, n] of Object.entries(c)) {
      const was = old?.[file]?.caps?.[id];
      const rise = old?.$schema === 3 && n > (was ?? 0);
      if (rise && !reason) { refusals.push(`cap rise ${file} ${id}: ${n} > ${was ?? 0} needs --reason`); continue; }
      if (rise) reasons[id] = reason;
      ent.caps[id] = old?.$schema === 3 && was !== undefined && !rise ? Math.min(was, n) : n;
    }
    if (Object.keys(reasons).length) ent.reasons = reasons;
    if (Object.keys(ent.caps).length) fx[file] = ent;
  }
  for (const [file, n] of Object.entries(cur.strict)) {
    const was = old?.$schema === 3 ? old.$strict?.[file] : undefined;
    if (was !== undefined && n > was) refusals.push(`strict rise ${file}: ${n} > ${was}`);
    fx.$strict[file] = was === undefined ? n : Math.min(was, n);
  }
  const sorted = { $schema: 3 };
  for (const k of Object.keys(fx).sort()) if (k !== "$schema") sorted[k] = fx[k];
  return { fx: sorted, refusals };
}

/** Does `path` match an owns entry: exact file, dir prefix ending in `/`, or a `*` / `**` glob. */
export function ownsMatch(entry, path) {
  if (entry === path) return true;
  if (entry.endsWith("/")) return path.startsWith(entry);
  if (!entry.includes("*")) return false;
  const re = entry.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}
