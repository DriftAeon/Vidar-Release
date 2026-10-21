#!/usr/bin/env node
// lint-ui.mjs — deterministic UI lint for Vidar's CSS: the Tokens, Colour and Motion checks below.
// This lint is the authority for what it checks; `.claude/rules/ui-tokens.md` and `ui-look.md` keep only the judgement rules.
//
// Inputs: every *.css and *.ts under <root>/src (filesystem walk, so untracked files count), plus each
// --file <path>: a .css file, an .ts file, or an .html file whose <style> blocks are checked.
// In .ts only inline-style literals are scanned (`.style.x = "lit"`, `.style.setProperty("x", "lit")`,
// `style="…"`, `setAttribute("style", "…")`, `.style.cssText`) with the colour, family and token checks;
// selector is `ts:<enclosing function>`. Values built from variables (`${…}`, `+`) are skipped.
//
// Checks (declaration-aware; declarations inside `:root` and `html[data-theme="…"]` blocks are skipped):
//   token      px literal in padding*, margin*, gap/row-gap/column-gap, font-size, border*-radius,
//              height/min-height/max-height (row), line-height (line). 0 is fine. On the new-ui scale →
//              "use var(--…)" (always a finding). On the legacy scale or off the scale → a finding
//              unless the declaration's line carries a comment (the reason); the message names the
//              nearest new-ui token(s).
//   legacy     var(--space-3|5|6|10|20), var(--radius-3|5|8|12), var(--font-10|14|18), var(--accent2)
//              in a declaration, unless the line carries a comment.
//   family     font-family / font with a quoted name or a bare family keyword and no var(…):
//              use var(--font-ui) or var(--font-mono). `inherit` passes.
//   colour     #hex, rgb(, rgba(, hsl(, hsla( in a value.
//   motion     a duration over 250 ms in transition, transition-duration, animation, animation-duration
//              without a `/* motion: … */` comment on that line. In a shorthand the second time is a
//              delay and is ignored.
//   important  !important.
//
// Baseline: tools/ui/lint-baseline.json, a multiset keyed by file (repo-relative, forward slashes),
// selector, property, value, check → count. Line numbers are not part of the key.
//
// Flags:
//   --root <dir>        tree whose src/ is walked (default: the repo root)
//   --file <path>       extra .css/.html file to check (repeatable)
//   --update-baseline   rewrite the baseline from the current findings (refused with a non-default --root)
//   --all               print every finding, ignoring the baseline
// Exit: 1 if any finding is printed (new ones, or any with --all), else 0.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE = join(REPO, "tools", "ui", "lint-baseline.json");

// new-ui scale (the only values new rules use) and legacy scale (kept for existing rules).
const NEW_SCALE = {
  space: [2, 4, 8, 12, 16, 24, 32],
  font: [11, 12, 13, 16],
  radius: [2, 4, 6, 9999],
  row: [24, 28, 32],
  line: [16, 20],
};
const LEGACY_SCALE = {
  space: [3, 5, 6, 10, 20],
  font: [10, 14, 18],
  radius: [3, 5, 8, 12],
};
const TOKEN_PREFIX = { space: "--space-", font: "--font-", radius: "--radius-", row: "--row-", line: "--line-" };
const tokenName = (fam, n) => (fam === "radius" && n === 9999 ? "--radius-full" : `${TOKEN_PREFIX[fam]}${n}`);
const LEGACY_VAR = /var\(\s*--(?:space-(?:3|5|6|10|20)|radius-(?:3|5|8|12)|font-(?:10|14|18)|accent2)(?![\w-])/gi;
const MOTION_LIMIT_MS = 250;
const CHECKS = ["token", "legacy", "family", "colour", "motion", "important"];

// The new-ui token(s) closest to n in px (both when equidistant).
function nearestNew(fam, n) {
  const best = Math.min(...NEW_SCALE[fam].map((v) => Math.abs(v - n)));
  return NEW_SCALE[fam].filter((v) => Math.abs(v - n) === best).map((v) => `var(${tokenName(fam, v)})`).join(" or ");
}

// ---------- args ----------
function parseArgs(argv) {
  const a = { root: REPO, files: [], update: false, all: false, customRoot: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--root") { a.root = resolve(argv[++i]); a.customRoot = a.root !== REPO; }
    else if (k === "--file") a.files.push(resolve(argv[++i]));
    else if (k === "--update-baseline") a.update = true;
    else if (k === "--all") a.all = true;
    else { console.error(`lint:ui: unknown argument ${k}`); process.exit(2); }
  }
  return a;
}

// ---------- inputs ----------
function walkCss(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (n === "node_modules") continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walkCss(p, out);
    else if (/\.(css|ts)$/i.test(n) && !/\.d\.ts$/i.test(n)) out.push(p);
  }
  return out;
}

// Keep only <style> contents; everything else becomes spaces (newlines kept) so offsets and lines hold.
function htmlToCss(html) {
  const out = html.replace(/[^\n]/g, " ").split("");
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) {
    const start = m.index + m[0].indexOf(">") + 1;
    for (let i = 0; i < m[1].length; i++) out[start + i] = m[1][i];
  }
  return out.join("");
}

// ---------- CSS scanning ----------
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

// Blank comments (keeping newlines) while respecting strings; record each comment's lines and text.
function stripComments(text, lineOf) {
  const out = text.split("");
  const comments = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") { if (text[i] === "\\") i++; i++; }
      i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      comments.push({ from: lineOf(i), to: lineOf(stop - 1), text: text.slice(i + 2, end < 0 ? text.length : end).trim() });
      for (let j = i; j < stop; j++) if (out[j] !== "\n") out[j] = " ";
      i = stop;
    } else i++;
  }
  return { code: out.join(""), comments };
}

function isRootOrTheme(prelude) {
  return prelude.split(",").every((s) => {
    const t = s.trim();
    return t === ":root" || /^(html)?\[data-theme(=(["']?)[\w-]+\3)?\]$/.test(t);
  });
}

// Yield { selector, property, value, from, to, skip } for every declaration.
function declarations(text) {
  const lineOf = lineIndex(text);
  const { code, comments } = stripComments(text, lineOf);
  const stack = []; // { prelude, skip }
  const decls = [];
  let segStart = 0, depth = 0, i = 0;
  const emit = (end) => {
    const raw = code.slice(segStart, end);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (!body || !stack.length) return;
    const colon = body.indexOf(":");
    if (colon < 0) return;
    const from = lineOf(segStart + lead);
    const to = lineOf(segStart + lead + body.length - 1);
    decls.push({
      selector: stack.map((s) => s.prelude).join(" "),
      property: body.slice(0, colon).trim().toLowerCase(),
      value: body.slice(colon + 1).trim().replace(/\s+/g, " "),
      from, to,
      skip: stack.some((s) => s.skip),
      comments: comments.filter((c) => c.from <= to && c.to >= from).map((c) => c.text),
    });
  };
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < code.length && code[i] !== c && code[i] !== "\n") { if (code[i] === "\\") i++; i++; }
      i++; continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === "{") {
      const prelude = code.slice(segStart, i).trim().replace(/\s+/g, " ");
      stack.push({ prelude, skip: isRootOrTheme(prelude) });
      segStart = i + 1;
    } else if (depth === 0 && c === ";") { emit(i); segStart = i + 1; }
    else if (depth === 0 && c === "}") { emit(i); stack.pop(); segStart = i + 1; }
    i++;
  }
  return decls;
}

// ---------- checks ----------
const maskValue = (v) => v.replace(/url\([^)]*\)/gi, "url()").replace(/"[^"]*"|'[^']*'/g, '""');

function tokenFamily(prop) {
  if (/^(padding|margin)(-|$)/.test(prop) || /^(row-|column-)?gap$/.test(prop)) return "space";
  if (prop === "font-size") return "font";
  if (/^border(-[a-z]+)*-radius$/.test(prop)) return "radius";
  if (/^(min-|max-)?height$/.test(prop)) return "row";
  if (prop === "line-height") return "line";
  return null;
}

function splitTop(value) {
  const parts = []; let d = 0, s = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") d++; else if (c === ")") d--; else if (c === "," && d === 0) { parts.push(value.slice(s, i)); s = i + 1; }
  }
  parts.push(value.slice(s));
  return parts;
}
const toMs = (n, unit) => (unit.toLowerCase() === "s" ? n * 1000 : n);
const TIME = /(?<![\w.-])(\d*\.?\d+)(ms|s)\b/gi;

// `only`: optional Set of check ids to run (the TS inline-style scan runs token, colour, family).
function check(d, only) {
  const out = [];
  const on = (id) => !only || only.has(id);
  const v = maskValue(d.value);
  const add = (checkId, message) => out.push({ check: checkId, message });
  const hasReason = d.comments.some((c) => c.length > 0);

  const fam = on("token") ? tokenFamily(d.property) : null;
  if (fam) {
    for (const m of v.matchAll(/(?<![\w.-])-?(\d*\.?\d+)px\b/gi)) {
      const n = Number(m[1]);
      if (n === 0) continue;
      if (NEW_SCALE[fam].includes(n)) {
        add("token", `${m[0]} is on the scale; use var(${tokenName(fam, n)})`);
      } else if (!hasReason) {
        const kind = LEGACY_SCALE[fam]?.includes(n) ? "a legacy" : "off the";
        add("token", `${m[0]} is ${kind} ${fam} value; use ${nearestNew(fam, n)}, or give a reason in a comment on the line`);
      }
    }
  }

  if (on("legacy") && !hasReason) {
    for (const m of v.matchAll(LEGACY_VAR)) {
      add("legacy", `${m[0]}) is a legacy token; use the new-ui set, or give a reason in a comment on the line`);
    }
  }

  if (on("family") && (d.property === "font-family" || d.property === "font")
      && !/var\(/i.test(d.value) && (/["']/.test(d.value) || /(?<![\w-])(?:sans-serif|serif|monospace|system-ui)(?![\w-])/i.test(d.value))) {
    add("family", "font family literal; use var(--font-ui) or var(--font-mono)");
  }

  if (on("colour")) for (const m of v.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi)) {
    add("colour", `colour literal ${m[0]}; use a role/status token`);
  }

  if (on("motion") && /^(transition|animation)(-duration)?$/.test(d.property) && !d.comments.some((c) => /^motion:/i.test(c))) {
    const shorthand = !d.property.endsWith("-duration");
    for (const item of splitTop(v)) {
      const times = [...item.matchAll(TIME)];
      const durations = shorthand ? times.slice(0, 1) : times;
      for (const t of durations) {
        const ms = toMs(Number(t[1]), t[2]);
        if (ms > MOTION_LIMIT_MS) add("motion", `${t[0]} > ${MOTION_LIMIT_MS}ms; shorten or add /* motion: reason */ on the line`);
      }
    }
  }

  if (on("important") && /!\s*important/i.test(v)) add("important", "!important");
  return out;
}

// ---------- TS inline styles ----------
const TS_CHECKS = new Set(["token", "colour", "family"]);
const kebab = (p) => p.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const SCOPE_SKIP = new Set(["if", "for", "while", "switch", "catch", "return"]);
const SCOPE_RE = new RegExp([
  String.raw`^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)`,
  String.raw`^(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>`,
  String.raw`^ {2}(?:(?:private|public|static|async)\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$`,
].map((s) => `(?:${s})`).join("|"));
const RE_STYLE_ASSIGN = new RegExp(String.raw`\.style\.(\w+)\s*=\s*(["'\x60])((?:\\.|(?!\2).)*)\2\s*(?=[;,)\]}]|$|//)`, "g");
const RE_SET_PROP = /\.style\.setProperty\(\s*(["'`])([\w-]+)\1\s*,\s*(["'`])((?:\\.|(?!\3).)*)\3\s*[,)]/g;
const RE_SET_ATTR = /\.setAttribute\(\s*(["'`])style\1\s*,\s*(["'`])((?:\\.|(?!\2).)*)\2\s*[,)]/g;
const RE_ATTR = /\bstyle=\\?(["'])((?:(?!\1).)*?)\\?\1/g;

function splitSemi(s) {
  const parts = []; let d = 0, st = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") d++; else if (c === ")") d--; else if (c === ";" && d === 0) { parts.push(s.slice(st, i)); st = i + 1; }
  }
  parts.push(s.slice(st));
  return parts;
}

function tsDeclarations(text) {
  const out = [];
  let scope = "top", inBlock = false;
  text.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (inBlock) { if (t.includes("*/")) inBlock = false; return; }
    if (t.startsWith("/*")) { if (!t.includes("*/")) inBlock = true; return; }
    if (t.startsWith("//")) return;
    const sm = SCOPE_RE.exec(line);
    if (sm) { const name = sm[1] || sm[2] || sm[3]; if (name && !SCOPE_SKIP.has(name)) scope = name; }
    const cm = /\s\/\/\s*(\S.*)$/.exec(line);
    const comments = cm ? [cm[1].trim()] : [];
    const push = (property, value) => {
      value = value.trim().replace(/\s+/g, " ");
      if (!property || !value || value.includes("${") || value.includes("}")) return;
      out.push({ selector: `ts:${scope}`, property: property.trim().toLowerCase(), value, from: i + 1, to: i + 1, skip: false, comments });
    };
    const pushText = (css) => {
      for (const part of splitSemi(css)) {
        const colon = part.indexOf(":");
        if (colon > 0) push(part.slice(0, colon), part.slice(colon + 1));
      }
    };
    for (const m of line.matchAll(RE_STYLE_ASSIGN)) {
      if (m[1] === "cssText") pushText(m[3]); else push(kebab(m[1]), m[3]);
    }
    for (const m of line.matchAll(RE_SET_PROP)) push(m[2], m[4]);
    for (const m of line.matchAll(RE_SET_ATTR)) pushText(m[3]);
    for (const m of line.matchAll(RE_ATTR)) pushText(m[2]);
  });
  return out;
}

// Lint one file's text; kind is "css" (default) or "ts". Returns findings without the file name.
function lintText(text, kind = "css") {
  const findings = [];
  const decls = kind === "ts" ? tsDeclarations(text) : declarations(text);
  for (const d of decls) {
    if (d.skip) continue;
    for (const r of check(d, kind === "ts" ? TS_CHECKS : undefined)) {
      findings.push({ line: d.from, selector: d.selector, property: d.property, value: d.value, check: r.check, message: r.message });
    }
  }
  return findings;
}

// ---------- baseline ----------
const keyOf = (f) => JSON.stringify([f.file, f.selector, f.property, f.value, f.check]);

function loadBaseline() {
  let data;
  try { data = JSON.parse(readFileSync(BASELINE, "utf8")); } catch { return new Map(); }
  const m = new Map();
  for (const e of data.entries || []) m.set(keyOf(e), (m.get(keyOf(e)) || 0) + (e.count || 1));
  return m;
}

function writeBaseline(findings) {
  const m = new Map();
  for (const f of findings) {
    const k = keyOf(f);
    const e = m.get(k) || { file: f.file, selector: f.selector, property: f.property, value: f.value, check: f.check, count: 0 };
    e.count++;
    m.set(k, e);
  }
  const entries = [...m.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const data = {
    about: "lint:ui grandfathered findings (tools/ui/lint-ui.mjs). Rewrite with `npm run lint:ui -- --update-baseline`.",
    entries,
  };
  writeFileSync(BASELINE, JSON.stringify(data, null, 2) + "\n");
}

// ---------- main ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.update && args.customRoot) {
    console.error("lint:ui: --update-baseline is refused with a non-default --root (it would baseline fixtures)");
    process.exit(2);
  }
  const inputs = [...walkCss(join(args.root, "src")).sort(), ...args.files];
  const findings = [];
  for (const path of inputs) {
    let text;
    try { text = readFileSync(path, "utf8"); } catch { console.error(`lint:ui: cannot read ${path}`); process.exit(2); }
    const ext = extname(path).toLowerCase();
    if (ext === ".html" || ext === ".htm") text = htmlToCss(text);
    const file = relative(REPO, path).split("\\").join("/");
    for (const f of lintText(text, ext === ".ts" ? "ts" : "css")) findings.push({ file, ...f });
  }

  if (args.update) {
    writeBaseline(findings);
    const counts = Object.fromEntries(CHECKS.map((c) => [c, findings.filter((f) => f.check === c).length]));
    console.log(`lint:ui: baseline rewritten, ${findings.length} findings (${CHECKS.map((c) => `${c} ${counts[c]}`).join(", ")})`);
    return 0;
  }

  let shown = findings;
  if (!args.all) {
    const base = loadBaseline();
    shown = findings.filter((f) => {
      const k = keyOf(f), n = base.get(k) || 0;
      if (n > 0) { base.set(k, n - 1); return false; }
      return true;
    });
  }
  const byFile = new Map();
  for (const f of shown) { if (!byFile.has(f.file)) byFile.set(f.file, []); byFile.get(f.file).push(f); }
  for (const [file, list] of byFile) {
    console.log(file);
    for (const f of list) console.log(`  ${f.line}  [${f.check}]  ${f.selector} { ${f.property}: ${f.value} }  — ${f.message}`);
  }
  const scope = args.all ? "findings" : "new findings";
  console.log(`lint:ui: ${shown.length} ${scope}${args.all ? "" : ` (${findings.length - shown.length} baselined)`}`);
  return shown.length ? 1 : 0;
}

export { check, declarations, lintText };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
