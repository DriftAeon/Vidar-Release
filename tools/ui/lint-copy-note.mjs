// lint-copy-note.mjs — the note-sink judge for lint-copy.mjs: which classes are dim (derived from
// CSS), whether a literal in a dim sink is a live value, and whether a `note-ok:` reason cites a
// real authority. lint-copy.mjs finds the sinks; this file decides what passes. Rule:
// .claude/rules/ui-copy.md.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rel as layoutRel } from "../lib/paths.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SKIP_DIRS = new Set(["node_modules", "vendor"]);
const RUNS = `${layoutRel("runs")}/`;
const DOCS = `${layoutRel("docs")}/`;

// Small words: Title Case skips them after the first word; here they join values ("8 to 48").
export const SMALL = new Set(["a", "an", "the", "and", "or", "nor", "but", "of", "to", "in", "on", "for", "at", "by", "vs", "via", "per", "as", "from", "with"]);
export const DIM_TOKENS = ["sub", "hint", "note", "desc", "caption"];
const ERR_TOKENS = ["err", "error", "tool-err"];
const TRANSIENT = new Set(["Querying…", "Loading…", "Connecting…", "Starting…"]);
const DIM_RULE = /(?:^|[;{\s])color\s*:\s*var\(\s*--fg-dim\s*\)/;
const NOTE_OK = /note-ok:([^\r\n]*)/;
const NOTE_CITE_FAIL = "note-ok needs a dated user decision or a tracked file containing the text";
// Words that scope a count instead of naming what it counts ("{} Only").
const SCOPE_WORDS = new Set(["only", "covered", "covers", "applied", "applies", "used", "uses", "included", "excluded", "affected"]);
// Prepositions that may lead a value ("As of {}", "Since {}").
const LEADS = new Set(["as of", "since", "until", "from", "of", "per", "at", "by", "in", "via", "up to"]);

const pad2 = (n) => String(n).padStart(2, "0");
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
function realPastDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && s <= todayIso();
}

// `git ls-files --error-unmatch` once per distinct root+path; the whitespace-normalised body when tracked.
const trackedCache = new Map();
function trackedBody(root, path) {
  const k = `${root}\0${path}`;
  if (trackedCache.has(k)) return trackedCache.get(k);
  let body = null;
  try {
    // No .git (an export or a zip download): every file on disk counts as tracked.
    if (existsSync(join(root, ".git"))) execFileSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: root, stdio: "ignore" });
    body = readFileSync(join(root, path), "utf8").replace(/\s+/g, " ");
  } catch { body = null; }
  trackedCache.set(k, body);
  return body;
}

// A note-ok reason passes when it cites `user, YYYY-MM-DD` (a real date, not after today) or a
// git-tracked repo path outside the run folders (and not the scanned file) whose body holds the text.
export function citeOk(reason, text, { root = REPO, file = "" } = {}) {
  for (const m of reason.matchAll(/\buser,\s*(\d{4}-\d{2}-\d{2})\b/g)) if (realPastDate(m[1])) return true;
  const pieces = text.split("{}").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (const m of reason.matchAll(/[\w.-]+(?:\/[\w.-]+)+/g)) {
    const p = m[0].replace(/[.,;:]+$/, "").replace(/^(?:\.\/)+/, "");
    if (p.startsWith(RUNS) || p.split("/").includes("..") || p === file) continue;
    // The public source tree ships no docs (docs-prune), so a docs citation cannot be checked there.
    if (p.startsWith(DOCS) && !existsSync(join(root, DOCS, "INDEX.md"))) return true;
    const body = trackedBody(root, p);
    if (body !== null && pieces.every((x) => body.includes(x))) return true;
  }
  return false;
}

const hasToken = (cls, names, set) => cls.split(/\s+/).filter(Boolean)
  .some((t) => (set && set.has(t)) || names.some((n) => t === n || t.endsWith(`-${n}`)));
export const isDim = (cls, dim) => hasToken(cls, DIM_TOKENS, dim);
const isErr = (cls) => hasToken(cls, ERR_TOKENS);

// Single-class selectors whose rule sets `color: var(--fg-dim)`, from every CSS file under src/.
// Controls are dim too (ghost buttons, tabs): a class that any selector gives `:hover` or whose
// rule sets `cursor: pointer` is a control, not a sub-line, and is returned in `controls`.
export function dimClassesFromCss(css, controls = new Set()) {
  const out = new Set();
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const pointer = /(?:^|[;{\s])cursor\s*:\s*pointer\b/.test(m[2]);
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      for (const h of s.matchAll(/\.([\w-]+)(?=[\w.:#[\]()-]*:hover)/g)) controls.add(h[1]);
      if (pointer) { const last = s.split(/[\s>+~]+/).pop() || ""; for (const c of last.matchAll(/\.([\w-]+)/g)) controls.add(c[1]); }
      if (DIM_RULE.test(m[2]) && /^\.[\w-]+$/.test(s)) out.add(s.slice(1));
    }
  }
  return out;
}

function walkCss(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (SKIP_DIRS.has(n) || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkCss(p, out);
    else if (n.endsWith(".css")) out.push(p);
  }
  return out;
}

export function dimClasses(root) {
  const set = new Set(), controls = new Set();
  for (const p of walkCss(join(root, "src")).sort()) for (const c of dimClassesFromCss(readFileSync(p, "utf8"), controls)) set.add(c);
  for (const c of controls) set.delete(c);
  // Labels, titles and section heads are dim but name a thing; they are never sub-lines.
  for (const c of [...set]) if (/-(label|title|head)$/.test(c)) set.delete(c);
  return set;
}

// Why a note literal fails, or "" when it passes. `lineText` is the source line (note-ok).
// `opts` ({ root, file }) is where a cited path is looked up.
export function judgeNote(text, cls, lineText = "", opts = {}) {
  const norm = text.replace(/\s+/g, " ").trim();
  const ok = lineText.match(NOTE_OK);
  if (ok) return citeOk(ok[1], norm, opts) ? "" : NOTE_CITE_FAIL;
  if (isErr(cls) || TRANSIENT.has(norm) || valueOnly(norm)) return "";
  return `descriptor text in a dim sink (class "${cls}")`;
}

const isValueTok = (w) => /^[+\-−~≈]?[\d.,:%×/]*\d[\d.,:%×/]*(?:[a-z%]{0,3}|[KMGT])?$/i.test(w);
const isPathTok = (w) => /[\\/._@#$%&*+~^<>=]/.test(w) || /\p{Ll}\p{Lu}/u.test(w);

// A live-value line: split on · — – | , and judge each segment. A segment passes when it is
// values alone (numbers or `{}`, joined by small connectors: "8 to 48"), optionally led by a
// preposition ("As of {}") and followed by exactly one word that ends it ("{} Calls"), never a
// scope word ("{} Only"). A path or identifier is a value only standing alone in its segment.
// Across the literal at most one bare Title Case word (a lone label, or "Env:" before values).
export function valueOnly(norm) {
  let bare = 0;
  // `{}` becomes a digit in place, so a value glued to text stays one token (`characters\{}\`).
  for (const seg of norm.replace(/\{\}/g, "0").split(/[·—–|,]/)) {
    let toks = seg.split(/\s+/).filter(Boolean)
      .map((raw) => ({ raw, w: raw.replace(/^[(\[“"'«‹]+|[)\]”"'»›:;,.…!?]+$/gu, "") }))
      .filter((t) => /[\p{L}\p{N}]/u.test(t.w));
    if (!toks.length) continue;
    if (toks.length > 1 && /:$/.test(toks[0].raw) && /^\p{Lu}/u.test(toks[0].w) && !isValueTok(toks[0].w)) { bare++; toks = toks.slice(1); }
    const ws = toks.map((t) => t.w);
    if (ws.length === 1 && (isValueTok(ws[0]) || isPathTok(ws[0]))) continue;
    const first = ws.findIndex(isValueTok);
    if (first < 0) {
      for (let k = 0; k < ws.length; k++) {
        if (k > 0 && SMALL.has(ws[k].toLowerCase())) continue;
        if (isPathTok(ws[k]) || !/^\p{Lu}/u.test(ws[k])) return false;
        bare++;
      }
      continue;
    }
    let last = first;
    for (let k = ws.length - 1; k >= first; k--) if (isValueTok(ws[k])) { last = k; break; }
    const lead = ws.slice(0, first).join(" ").toLowerCase();
    if (lead && !LEADS.has(lead)) return false;
    for (let k = first; k <= last; k++) if (!isValueTok(ws[k]) && !SMALL.has(ws[k].toLowerCase())) return false;
    const after = ws.slice(last + 1);
    if (after.length > 1 || (after.length === 1 && SCOPE_WORDS.has(after[0].toLowerCase()))) return false;
  }
  return bare <= 1;
}
