#!/usr/bin/env node
// lint-copy.mjs — Title Case lint for short visible UI strings. Implements the Copy rule of
// `.claude/rules/ui-copy.md` (Title Case for labels, buttons, status values, chips, empty/error
// lines; sentence case only in full sentences). Static regex/tokenizer scan, not a TS AST.
//
// Sinks (a string literal counts only when it lands in one of these):
//   prop        `.textContent | .innerText | .title | .placeholder | .ariaLabel = "…"` (also the
//               arms of a ternary / `??` / `||` on the right-hand side)
//   attr        `setAttribute("title" | "aria-label" | "placeholder", "…")`
//   button      first literal argument of `button(` / `btn(`, and the third argument of
//               `button(doc, cls, "…")`
//   html        inside any literal (and in index.html): text of <button|label|option|th|span|p|a|
//               summary|legend|h1-6|strong|em|b> and title= / aria-label= / placeholder= values
//   label       `"label": "…"` in contracts/*.json
//   key         object-literal `placeholder: "…"` (askGate options); judged for Title Case too
// Placeholder rule (2026-10-11): in the prop, attr, html (placeholder=) and key sinks a value
// containing "optional" (any case) or " — " is a finding (sink `placeholder`); copy-ok suppresses it.
// Not seen (false negatives by design): strings built from variables or helpers outside the sinks,
// Rust-side strings, literals nested inside a template's `${…}`.
//
// Judging: `${…}` becomes `{}` and is never judged. Exempt: no letters; ends in . ? !; more than 6
// words; looks like code (/ \ = `--` :: or a backtick, or starts with - or .). Skipped per word:
// digits, units after a number, identifiers (camelCase, dots, underscores), small words (a, an, the,
// and, or, of, to, in, on, for, at, by, vs, via, per) after the first word. Any other word starting
// lowercase is a finding. `copy-ok: <reason>` in a comment on the line suppresses it.
//
// Note sink (descriptor text; docs/runs/2026-10-01-descriptor-text/plan.md §A). A literal that lands
// in a dim element is a sub-line, and a sub-line ships only if it reports a failure, shows a live
// value or is a transient loading word. Dim = a class token in the dim set: every single-class
// selector (`.x { … }`, whole selector) in src/**/*.css whose rule sets `color: var(--fg-dim)`,
// derived each run, minus controls (a class any selector gives `:hover`, or a `cursor: pointer`
// rule) and labels (classes ending -label, -title, -head), plus the tokens sub hint note desc
// caption as whole tokens or `-` suffixes. Text in a button, heading, th, option, summary, legend
// or a element is a label, never a sub-line.
// Where (the class is read from a literal argument; a class with no literal part is not a sink;
// the text may be the whole argument or an arm of a ternary / `??` / `||`):
//   text(cls, "…")   el(tag, cls, "…")   twoLineRow(parent, label, "…")
//   note("…"[, cls]) only when `note` is a local helper whose default class is dim
//   `x.className = "cls"` within 3 lines of `x.textContent = "…"`   template `<tag class="cls">…<`
//   `description: "…"` in a settings row or Shortcut object (addSettingRow / addShortcut argument,
//   or an element of a `…Row[]` / `Shortcut[]` array; class desc)
// Passes when: the class carries an error token (err, error, tool-err, or a -err / -error suffix);
// the text is exactly Querying… Loading… Connecting… Starting…; it is a live value (valueOnly:
// per segment between · — – | , values alone, an optional leading preposition, one trailing
// word; at most one bare Title Case word in the literal); or the line carries
// `// note-ok: <reason>` whose reason cites `user, YYYY-MM-DD` (a real date, not after today) or
// a git-tracked repo path outside docs/runs/ whose body holds the text. Any other note-ok is a
// finding. copy-ok does not pass a note.
// Note literals are also judged for Title Case (copy-ok suppresses only that part). Note findings
// are never baselined, never read from a baseline. Every run prints the dim set and the note-ok lines.
//
// Baseline: tools/ui/copy-baseline.json, a multiset keyed by file, sink, normalised text → count.
// Flags: --root <dir> (tree scanned; default repo), --update-baseline (refused with --root, and
// refused before writing while any note finding exists), --all.
// Exit: 1 if any finding is printed (new ones, or any with --all), else 0.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DIM_TOKENS, SKIP_DIRS, SMALL, dimClasses, isDim, judgeNote } from "./lint-copy-note.mjs";
export { citeOk, dimClasses, dimClassesFromCss, judgeNote, valueOnly } from "./lint-copy-note.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE = join(REPO, "tools", "ui", "copy-baseline.json");
const RULE = ".claude/rules/ui-copy.md";
const SRC_EXT = /\.(ts|tsx|js|mjs)$/i;
const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/i;

const UNITS = new Set(["ms", "s", "sec", "min", "h", "m", "px", "b", "kb", "mb", "gb", "tb", "k", "x", "fps", "tok"]);
const MAX_WORDS = 6;

// ---------- judging ----------
// Returns the offending words (empty = passes or exempt).
export function judge(text) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!/\p{L}/u.test(t.replace(/\{\}/g, ""))) return [];
  if (/[.?!]["')\]]?$/.test(t)) return [];
  if (/[/\\=`]|--|::/.test(t) || /^[-.]/.test(t)) return [];
  const words = t.split(/[\s—–·|]+/).filter(Boolean);
  if (words.filter((w) => /\p{L}/u.test(w)).length > MAX_WORDS) return [];
  const bad = [];
  let prevNumeric = false, first = true;
  for (const raw of words) {
    const w = raw.replace(/^[(\[“"'«‹]+|[)\]”"'»›:;,…]+$/gu, "");
    const numeric = /\d|\{\}/.test(w);
    if (!/\p{L}/u.test(w)) { prevNumeric = numeric || prevNumeric; continue; }
    const isFirst = first; first = false;
    if (numeric) { prevNumeric = true; continue; }
    if (prevNumeric && UNITS.has(w.toLowerCase())) { prevNumeric = false; continue; }
    prevNumeric = false;
    if (/[._@#$%&*+~^<>]/.test(w) || /\p{Ll}\p{Lu}/u.test(w)) continue; // identifier / file name
    if (!/^\p{Ll}/u.test(w)) continue;
    if (!isFirst && SMALL.has(w.toLowerCase())) continue;
    bad.push(w);
  }
  return bad;
}

// ---------- tokenizing (JS/TS) ----------
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

const REGEX_PREV = /[(,=:[!&|?{};+\-*%<>~^]$|(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)$/;

// Walks source; returns { literals: [{ start, end, text }], masked } where masked has every literal
// interior and comment blanked (newlines kept). Template `${…}` becomes `{}` in text.
export function tokenize(src) {
  const masked = src.split("");
  const literals = [];
  const blank = (a, b) => { for (let j = a; j < b; j++) if (masked[j] !== "\n") masked[j] = " "; };

  function skipString(i, q) { // i at opening quote; returns index after closing quote
    let j = i + 1;
    while (j < src.length && src[j] !== q && src[j] !== "\n") { if (src[j] === "\\") j++; j++; }
    return j + 1;
  }
  function skipRegex(i) {
    let j = i + 1, cls = false;
    while (j < src.length && src[j] !== "\n") {
      const c = src[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "[") cls = true; else if (c === "]") cls = false;
      else if (c === "/" && !cls) { j++; break; }
      j++;
    }
    while (/[a-z]/i.test(src[j] || "")) j++;
    return j;
  }
  function skipExpr(i) { // i just after `${`; returns index after the matching `}`
    let depth = 1, j = i;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === '"' || c === "'") j = skipString(j, c);
      else if (c === "`") j = readTemplate(j).end;
      else if (c === "/" && src[j + 1] === "/") { while (j < src.length && src[j] !== "\n") j++; }
      else if (c === "/" && src[j + 1] === "*") { const e = src.indexOf("*/", j + 2); j = e < 0 ? src.length : e + 2; }
      else { if (c === "{") depth++; else if (c === "}") depth--; j++; }
    }
    return j;
  }
  function readTemplate(i) { // i at opening backtick
    let j = i + 1, text = "";
    while (j < src.length && src[j] !== "`") {
      if (src[j] === "\\") { text += src[j + 1] === "n" ? "\n" : src[j + 1]; j += 2; }
      else if (src[j] === "$" && src[j + 1] === "{") { j = skipExpr(j + 2); text += "{}"; }
      else { text += src[j]; j++; }
    }
    return { end: j + 1, text };
  }

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i); const stop = e < 0 ? src.length : e; blank(i, stop); i = stop;
    } else if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2); const stop = e < 0 ? src.length : e + 2; blank(i, stop); i = stop;
    } else if (c === '"' || c === "'") {
      const end = skipString(i, c);
      let text; try { text = JSON.parse('"' + src.slice(i + 1, end - 1).replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"') + '"'); } catch { text = src.slice(i + 1, end - 1); }
      literals.push({ start: i, end, text });
      blank(i + 1, end - 1); i = end;
    } else if (c === "`") {
      const { end, text } = readTemplate(i);
      literals.push({ start: i, end, text });
      blank(i + 1, end - 1); i = end;
    } else if (c === "/" && REGEX_PREV.test(masked.slice(Math.max(0, i - 12), i).join("").trimEnd())) {
      const end = skipRegex(i); blank(i + 1, end); i = end;
    } else i++;
  }
  return { literals, masked: masked.join("") };
}

// ---------- sinks ----------
const PROP = /\.(textContent|innerText|title|placeholder|ariaLabel)\s*=(?!=)\s*(?:[^;\n=]*(?:\?\?|\|\||[?:])\s*)?$/;
const ATTR = /setAttribute\(\s*["'](title|aria-label|placeholder)["']\s*,\s*$/;
const BUTTON = /(?:^|[^\w$.])(?:button|btn)\(\s*$|(?:^|[^\w$.])button\(\s*doc\s*,\s*[^,()]*,\s*$/;
// Select option labels: `new Option("Label", …)` and the label of a `select([[value, "Label"], …])` pair.
const OPTION = /\bnew\s+Option\(\s*$|\bselect\(\s*\[[^;]*?\[\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*,\s*$/;
const HTML_TEXT =/<(button|label|option|th|span|p|a|summary|legend|h[1-6]|strong|em|b)\b[^<>]*>([^<>]+)</gi;
const HTML_ATTR = /\b(title|aria-label|placeholder)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

const HTML_CLASS = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

// `noteSink(text, cls, line)` returns true when it took the hit (dim class), so the plain html
// emit is skipped and the literal is judged once.
function htmlHits(text, baseLine, emit, noteSink = () => false) {
  const nl = (off) => (text.slice(0, off).match(/\n/g) || []).length;
  for (const m of text.matchAll(HTML_TEXT)) {
    const line = baseLine + nl(m.index + m[0].length - m[2].length - 1);
    const open = m[0].slice(0, m[0].length - m[2].length - 1);
    const c = open.match(HTML_CLASS);
    if (c && noteSink(m[2], c[1] ?? c[2], line, m[1])) continue;
    emit("html", m[2], line);
  }
  for (const m of text.matchAll(HTML_ATTR)) emit("html", m[2] ?? m[3], baseLine + nl(m.index), m[1].toLowerCase() === "placeholder");
}

// Placeholder hint rule (2026-10-11): a short noun, never "Optional", no em-dash qualifier.
// Returns the reason, or "" when the text passes.
export function placeholderIssue(text) {
  if (/optional/i.test(text)) return "placeholder must not say Optional; use a short noun (Notes, Comment)";
  if (/ — /.test(text)) return "placeholder must not carry a dash qualifier; use a short noun (Notes, Comment)";
  return "";
}

// ---------- note sink (judging lives in lint-copy-note.mjs) ----------
// Elements whose text is a label or heading, never a sub-line.
const LABEL_TAGS = /^(button|h[1-6]|th|option|summary|legend|a)$/i;

// The call whose argument list encloses `pos` in masked source: { name, index, argStart } or null
// (`argStart` is just after the `(` or `,` that opens the argument holding `pos`).
function enclosingCall(masked, pos) {
  let depth = 0, index = 0, argStart = -1;
  for (let j = pos - 1, n = 0; j >= 0 && n < 600; j--, n++) {
    const c = masked[j];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "[" || c === "{") { if (depth === 0) return null; depth--; }
    else if (c === "(") {
      if (depth > 0) { depth--; continue; }
      const m = masked.slice(Math.max(0, j - 40), j).match(/(?:^|[^\w$.])([\w$]+)\s*$/);
      return m ? { name: m[1], index, argStart: argStart < 0 ? j + 1 : argStart } : null;
    } else if (c === ";" && depth === 0) return null;
    else if (c === "," && depth === 0) { if (argStart < 0) argStart = j + 1; index++; }
  }
  return null;
}

// The unmatched opener before `pos` in masked source: { c, at } or null.
function enclosingOpen(masked, pos) {
  let depth = 0;
  for (let j = pos - 1, n = 0; j >= 0 && n < 4000; j--, n++) {
    const c = masked[j];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") { if (depth === 0) return { c, at: j }; depth--; }
  }
  return null;
}

// The class argument: the previous literal when only a comma separates it from this one
// (`text("dim sub", "…")`); a variable or expression class is not a sink.
function classArg(literals, i, masked) {
  const prev = literals[i - 1];
  if (!prev || !/^\s*,\s*$/.test(masked.slice(prev.end, literals[i].start))) return null;
  return prev.text;
}

// The literal that is the whole argument ending at the comma just before `argStart`, as an index.
function prevArgLiteral(literals, i, argStart, masked) {
  for (let j = i - 1; j >= 0; j--) {
    const p = literals[j];
    if (p.end > argStart) continue;
    if (!/^\s*,$/.test(masked.slice(p.end, argStart))) return -1;
    return /[(,]\s*$/.test(masked.slice(Math.max(0, p.start - 40), p.start)) ? j : -1;
  }
  return -1;
}

// A settings row or Shortcut object: the object literal is the argument of addSettingRow /
// addShortcut, or an element of an array typed `…Row[]` / `Shortcut[]`.
function isRowObject(masked, pos) {
  const obj = enclosingOpen(masked, pos);
  if (!obj || obj.c !== "{") return false;
  // blanked comments can leave long runs of spaces, so look back further than the code itself
  const before = masked.slice(Math.max(0, obj.at - 600), obj.at);
  if (/(?:^|[^\w$.])(?:addSettingRow|addShortcut)\(\s*$/.test(before)) return true;
  if (!/[[,]\s*$/.test(before)) return false;
  const arr = enclosingOpen(masked, obj.at);
  return !!arr && arr.c === "[" && /:\s*(?:[\w$]*Row|Shortcut)\[\]\s*=\s*$/.test(masked.slice(Math.max(0, arr.at - 600), arr.at));
}

// Local `note` helpers that create a dim element: [{ at, cls }] (cls = the class they default to).
function noteHelpers(src, masked, dim) {
  const out = [];
  for (const m of masked.matchAll(/(?:^|[^\w$.])(?:function\s+note\s*\(|(?:const|let)\s+note\s*=\s*(?:async\s*)?\()/g)) {
    const body = src.slice(m.index, m.index + 500);
    const params = body.slice(0, body.indexOf(")") + 1);
    const d = params.match(/\(\s*[\w$]+\s*(?::\s*[\w$]+)?\s*,\s*[\w$]+\s*=\s*["']([^"']+)["']/)
      || body.match(/className\s*=\s*["']([^"']+)["']/);
    if (d && isDim(d[1], dim)) out.push({ at: m.index, cls: d[1] });
  }
  return out;
}

// Findings for one JS/TS source: [{ line, sink, text, words, why? }]. copy-ok lines skip Title Case
// findings only; note findings (sink "note") pass only by judgeNote.
// `opts` ({ root, file }) locates paths a note-ok cites.
export function scanSource(src, dim = new Set(), opts = {}) {
  const { literals, masked } = tokenize(src);
  const helpers = noteHelpers(src, masked, dim);
  const lineOf = lineIndex(src);
  const lines = src.split("\n");
  const out = [];
  const emit = (sink, text, line, ph = false) => {
    const norm = text.replace(/\s+/g, " ").trim();
    if (!norm || /copy-ok:/.test(lines[line - 1] || "")) return;
    const issue = ph ? placeholderIssue(norm) : "";
    if (issue) out.push({ line, sink: "placeholder", text: norm, words: [], why: issue });
    const words = judge(norm);
    if (words.length) out.push({ line, sink, text: norm, words });
  };
  const note = (text, cls, line) => {
    const norm = text.replace(/\s+/g, " ").trim();
    if (!norm) return;
    const lineText = lines[line - 1] || "";
    const why = [];
    const desc = judgeNote(norm, cls, lineText, opts);
    if (desc) why.push(desc);
    const words = /copy-ok:/.test(lineText) ? [] : judge(norm);
    if (words.length) why.push(`lowercase: ${words.join(", ")}`);
    if (why.length) out.push({ line, sink: "note", text: norm, words, why: why.join("; ") });
  };
  const noteSink = (text, cls, line, tag = "") => {
    const c = cls.replace(/\{\}/g, " ");
    if (LABEL_TAGS.test(tag) || !isDim(c, dim)) return false;
    note(text, c, line);
    return true;
  };
  // `x.className = "cls"` within 3 lines of the literal's line (either order).
  const classNear = (id, line) => {
    const re = new RegExp(`(?:^|[^\\w$.])${id.replace(/\$/g, "\\$")}\\.className\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`)`);
    for (let n = Math.max(1, line - 3); n <= Math.min(lines.length, line + 3); n++) {
      const m = (lines[n - 1] || "").match(re);
      if (m) return (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, " ");
    }
    return null;
  };
  const tagNear = (id, line) => {
    const re = new RegExp(`(?:^|[^\\w$.])${id.replace(/\$/g, "\\$")}\\s*=\\s*document\\.createElement\\(\\s*["'](\\w+)["']`);
    for (let n = line; n >= Math.max(1, line - 8); n--) {
      const m = (lines[n - 1] || "").match(re);
      if (m) return m[1];
    }
    return "";
  };
  // The literal is a whole argument, or one arm of a ternary / `??` / `||` / `&&` that is the argument.
  const argArm = (lit, call) => /^\s*(?:[,)]|\?\?|\|\||&&|:)/.test(masked.slice(lit.end))
    && /^\s*$|(?:\?\?|\|\||&&|[?:])\s*$/.test(masked.slice(call.argStart, lit.start));

  literals.forEach((lit, i) => {
    const line = lineOf(lit.start);
    const before = masked.slice(Math.max(0, lit.start - 200), lit.start);
    const rawBefore = src.slice(Math.max(0, lit.start - 80), lit.start);
    let tookNote = false;
    const call = enclosingCall(masked, lit.start);
    if (call && argArm(lit, call)) {
      let cls = null;
      let tag = "";
      const prev = (call.index > 0) ? prevArgLiteral(literals, i, call.argStart, masked) : -1;
      if (call.name === "text" && call.index === 1 && prev >= 0) cls = literals[prev].text;
      else if (call.name === "el" && call.index === 2 && prev >= 0) {
        cls = literals[prev].text;
        tag = classArg(literals, prev, masked) ?? "";
      } else if (call.name === "twoLineRow" && call.index === 2) cls = "sub";
      else if (call.name === "note" && call.index === 0) {
        const h = helpers.filter((d) => d.at < lit.start).pop();
        if (h) {
          const after = masked.slice(lit.end);
          const next = literals[i + 1];
          if (/^\s*\)/.test(after)) cls = h.cls;
          else if (next && /^\s*,\s*$/.test(masked.slice(lit.end, next.start)) && /^\s*\)/.test(masked.slice(next.end))) cls = next.text;
        }
      }
      if (cls !== null) tookNote = noteSink(lit.text, cls, line, tag);
    }
    if (!tookNote && /(?:^|[{,\s])description\s*:\s*$/.test(before) && /^\s*[,}\n]/.test(masked.slice(lit.end)) && isRowObject(masked, lit.start)) {
      note(lit.text, "desc", line);
      tookNote = true;
    }
    if (!tookNote && PROP.test(before)) {
      const id = before.match(/([\w$]+)\.textContent\s*=(?!=)\s*(?:[^;\n=]*(?:\?\?|\|\||[?:])\s*)?$/);
      const cls = id ? classNear(id[1], line) : null;
      if (cls !== null) tookNote = noteSink(lit.text, cls, line, tagNear(id[1], line));
    }
    if (!tookNote) {
      if (PROP.test(before)) emit("prop", lit.text, line, PROP.exec(before)[1] === "placeholder");
      else if (ATTR.test(rawBefore)) emit("attr", lit.text, line, rawBefore.match(ATTR)[1] === "placeholder");
      else if (BUTTON.test(before)) emit("button", lit.text, line);
      else if (OPTION.test(before)) emit("option", lit.text, line);
      else if (/(?:^|[{,\s])placeholder\s*:\s*$/.test(before)) emit("key", lit.text, line, true);
    }
    if (/<[a-z]/i.test(lit.text)) htmlHits(lit.text, line, emit, noteSink);
  });
  return out;
}

// Every `note-ok:` line in a source, for the per-run listing.
export function noteOkLines(src) {
  const out = [];
  src.split("\n").forEach((l, n) => { if (/note-ok:/.test(l)) out.push({ line: n + 1, text: l.trim() }); });
  return out;
}

export function scanHtml(src) {
  const lines = src.split("\n");
  const code = src.replace(/<(style|script)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, (m) => m.replace(/[^\n]/g, " "));
  const out = [];
  htmlHits(code, 1, (sink, text, line, ph = false) => {
    const norm = text.replace(/\s+/g, " ").trim();
    if (!norm || /copy-ok:/.test(lines[line - 1] || "")) return;
    const issue = ph ? placeholderIssue(norm) : "";
    if (issue) out.push({ line, sink: "placeholder", text: norm, words: [], why: issue });
    const words = judge(norm);
    if (words.length) out.push({ line, sink, text: norm, words });
  });
  return out;
}

export function scanContract(src) {
  const out = [];
  src.split("\n").forEach((l, n) => {
    for (const m of l.matchAll(/"label"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      const text = JSON.parse(`"${m[1]}"`);
      const words = judge(text);
      if (words.length) out.push({ line: n + 1, sink: "label", text, words });
    }
  });
  return out;
}

// ---------- inputs ----------
function walk(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (SKIP_DIRS.has(n) || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SRC_EXT.test(n) && !SKIP_FILE.test(n)) out.push(p);
  }
  return out;
}

function collect(root, dim, noteOks = []) {
  const findings = [];
  const rel = (path) => relative(root, path).split("\\").join("/");
  const add = (path, list) => {
    const file = rel(path);
    for (const f of list) findings.push({ file, ...f });
  };
  for (const p of walk(join(root, "src")).sort()) {
    const src = readFileSync(p, "utf8");
    add(p, scanSource(src, dim, { root, file: rel(p) }));
    for (const o of noteOkLines(src)) noteOks.push({ file: rel(p), ...o });
  }
  const html = join(root, "index.html");
  try { add(html, scanHtml(readFileSync(html, "utf8"))); } catch { /* no index.html */ }
  let contracts = [];
  try { contracts = readdirSync(join(root, "contracts")).filter((n) => n.endsWith(".json")).sort(); } catch { /* none */ }
  for (const n of contracts) { const p = join(root, "contracts", n); add(p, scanContract(readFileSync(p, "utf8"))); }
  return findings;
}

// ---------- baseline ----------
const keyOf = (f) => JSON.stringify([f.file, f.sink, f.text]);

// Note findings are never grandfathered: dropped on read and on write.
export function baselineMap(data) {
  const m = new Map();
  for (const e of data.entries || []) {
    if (e.sink === "note") continue;
    m.set(keyOf(e), (m.get(keyOf(e)) || 0) + (e.count || 1));
  }
  return m;
}

function loadBaseline() {
  let data;
  try { data = JSON.parse(readFileSync(BASELINE, "utf8")); } catch { return new Map(); }
  return baselineMap(data);
}

export function baselineEntries(findings) {
  const m = new Map();
  for (const f of findings) {
    if (f.sink === "note") continue;
    const k = keyOf(f);
    const e = m.get(k) || { file: f.file, sink: f.sink, text: f.text, count: 0 };
    e.count++;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

function writeBaseline(findings) {
  const entries = baselineEntries(findings);
  const about = "lint:copy grandfathered Title Case findings (tools/ui/lint-copy.mjs). Rewrite with `node tools/ui/lint-copy.mjs --update-baseline`.";
  writeFileSync(BASELINE, JSON.stringify({ about, entries }, null, 2) + "\n");
}

// ---------- main ----------
function main() {
  const a = { root: REPO, update: false, all: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--root") a.root = resolve(argv[++i]);
    else if (k === "--update-baseline") a.update = true;
    else if (k === "--all") a.all = true;
    else { console.error(`lint:copy: unknown argument ${k}`); return 2; }
  }
  if (a.update && a.root !== REPO) {
    console.error("lint:copy: --update-baseline is refused with a non-default --root (it would baseline fixtures)");
    return 2;
  }
  const dim = dimClasses(a.root);
  const noteOks = [];
  const findings = collect(a.root, dim, noteOks);
  console.log(`lint:copy: dim classes (${dim.size} from CSS + tokens ${DIM_TOKENS.join(" ")}): ${[...dim].sort().join(" ")}`);
  for (const o of noteOks) console.log(`lint:copy: note-ok ${o.file}:${o.line}  ${o.text}`);
  console.log(`lint:copy: ${noteOks.length} note-ok lines`);
  if (a.update) {
    const notes = findings.filter((f) => f.sink === "note");
    if (notes.length) {
      for (const f of notes) console.log(`${f.file}:${f.line}  [note]  ${JSON.stringify(f.text)}  — ${f.why}`);
      console.error(`lint:copy: --update-baseline refused: ${notes.length} note findings; fix them first (never baselined)`);
      return 1;
    }
    writeBaseline(findings);
    console.log(`lint:copy: baseline rewritten, ${findings.length} findings`);
    return 0;
  }
  let shown = findings;
  if (!a.all) {
    const base = loadBaseline();
    shown = findings.filter((f) => {
      const k = keyOf(f), n = base.get(k) || 0;
      if (n > 0) { base.set(k, n - 1); return false; }
      return true;
    });
  }
  for (const f of shown) console.log(`${f.file}:${f.line}  [${f.sink}]  ${JSON.stringify(f.text)}  — ${f.why ?? `lowercase: ${f.words.join(", ")}`}`);
  if (shown.some((f) => f.sink !== "note")) console.log(`lint:copy: Title Case rule is ${RULE}; fix the copy, or add a \`copy-ok: <reason>\` comment on the line`);
  if (shown.some((f) => f.sink === "note")) console.log(`lint:copy: note findings: cut the text, use DASH for empty, move it to a tooltip, or add \`// note-ok: user, YYYY-MM-DD\` (or a tracked repo file that holds the text, outside docs/runs/); never baselined`);
  const scope = a.all ? "findings" : "new findings";
  console.log(`lint:copy: ${shown.length} ${scope}${a.all ? "" : ` (${findings.length - shown.length} baselined)`}`);
  return shown.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
