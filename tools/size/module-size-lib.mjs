// Module-size gate: counting, tree scan, ledger render and the --write / --accept updates.
// Data lives in contracts/module-size.json.
// Pure Node, no deps. The CLI is module-size.mjs; the test is tests/module-size.test.mjs.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const CONTRACT = "contracts/module-size.json";
export const DOC = "docs/reference/module-boundaries.md";
export const START = "<!-- ledger:start -->";
export const END = "<!-- ledger:end -->";
export const CLI = "node tools/size/module-size.mjs";
// Extensions that look like code. One found in the scan set without a line in the JSON fails the
// test, so a new language can't slip past the gate. Python and .html are out: the rule has no line.
export const CODE_LIKE = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".ps1", ".psm1", ".css", ".scss", ".sass", ".less", ".rs"];

export const BOM = String.fromCharCode(0xfeff);
export const readText = (abs) => {
  const text = readFileSync(abs, "utf8");
  return text.startsWith(BOM) ? text.slice(1) : text;
};
export const loadContract = (root = ROOT) => JSON.parse(readText(join(root, CONTRACT)));

// Lines = count of "\n", plus 1 when the text doesn't end in one.
export function totalLines(text) {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n : n + 1;
}

// Rust inline test span, 1-based inclusive: the top-level #[cfg(test)] before `mod tests {` through
// the first following line that is exactly "}" (rustfmt's column-0 close). No brace counting:
// fixtures hold '{' and raw JSON. The span is not always at the end of the file.
export function rustTestSpan(text) {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  for (let i = 0; i < lines.length; i++) {
    if (!/^(pub(\([^)]*\))? )?mod tests \{\s*$/.test(lines[i])) continue;
    let start = -1;
    for (let j = i - 1; j >= 0 && lines[j].startsWith("#["); j--) if (lines[j].trim() === "#[cfg(test)]") start = j;
    if (start < 0) continue;
    for (let k = i + 1; k < lines.length; k++) if (lines[k] === "}") return { start: start + 1, end: k + 1 };
    return null;
  }
  return null;
}

export function countFile(abs) {
  const text = readText(abs);
  const total = totalLines(text);
  if (extname(abs).toLowerCase() !== ".rs") return { total, code: total, testLines: null, span: null };
  const span = rustTestSpan(text);
  const testLines = span ? span.end - span.start + 1 : 0;
  return { total, code: total - testLines, testLines, span };
}

function skipFile(name, patterns) {
  return patterns.some((p) => (p.startsWith("*") ? name.endsWith(p.slice(1)) : name === p));
}

// Every scanned file (not only code), as repo-relative forward-slash paths.
export function scanFiles(contract, root = ROOT) {
  const skipDirs = new Set(contract.skip.dirs);
  const skipPaths = contract.skip.paths.map((p) => p.path);
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (skipDirs.has(e.name) || e.name.startsWith(".") || skipPaths.includes(child)) continue;
        walk(child);
      } else if (e.isFile() && !skipFile(e.name, contract.skip.files)) out.push(child);
    }
  };
  for (const rel of contract.scan) if (existsSync(join(root, rel))) walk(rel);
  return out.sort();
}

// Current state of the tree against the contract.
export function measure(contract, root = ROOT) {
  const over = [];
  const unknownExt = [];
  const counts = new Map();
  for (const rel of scanFiles(contract, root)) {
    const ext = extname(rel).toLowerCase();
    const line = contract.lines[ext];
    if (line === undefined) {
      if (CODE_LIKE.includes(ext)) unknownExt.push(rel);
      continue;
    }
    const c = { ...countFile(join(root, rel)), line };
    counts.set(rel, c);
    if (c.code > line) over.push({ path: rel, ...c });
  }
  over.sort((a, b) => b.code - a.code || a.path.localeCompare(b.path));
  return { over, unknownExt, counts };
}

// Paths under a .gitattributes export-ignore prefix never reach the release export.
const exportIgnored = (contract, path) =>
  (contract.exportIgnored ?? []).some((p) => path === p || path.startsWith(`${p}/`));

// Problems for the "JSON covers the tree" test; each names the file, both numbers and the fix.
export function treeProblems(contract, root = ROOT) {
  const { over, unknownExt, counts } = measure(contract, root);
  const byPath = new Map(contract.entries.map((e) => [e.path, e]));
  const problems = [];
  for (const f of over) {
    const e = byPath.get(f.path);
    if (!e) problems.push(`${f.path}: ${f.code} code lines, over its line of ${f.line}, no entry in ${CONTRACT}; extract a seam, or ask the main thread for \`--accept\``);
    else if (f.code > e.code) problems.push(`${f.path}: ${f.code} code lines, above its recorded ceiling of ${e.code}; extract a seam, or ask the main thread for \`--accept\``);
  }
  for (const e of contract.entries) {
    const c = counts.get(e.path);
    if (!c && exportIgnored(contract, e.path)) continue; // absent by design in the release export
    // A source export (no .git) omits files its set leaves out: an entry whose file is absent is not a miss there.
    if (!c && !existsSync(join(root, ".git")) && !existsSync(join(root, e.path))) continue;
    if (!c) problems.push(`${e.path}: missing from the scan set (recorded ceiling ${e.code}); run \`${CLI} --write\``);
    else if (c.code <= c.line) problems.push(`${e.path}: ${c.code} code lines, under its line of ${c.line} (recorded ceiling ${e.code}); run \`${CLI} --write\``);
  }
  for (const rel of unknownExt) problems.push(`${rel}: extension ${extname(rel)} has no line in ${CONTRACT}; ask the main thread to add one, or rename the file`);
  return problems;
}

const cell = (s) => String(s ?? "").replaceAll("|", "\\|");

// The generated ledger block (between the markers), from the JSON fields only: no live counts.
export function renderLedger(contract) {
  const rows = [...contract.entries].sort((a, b) => b.code - a.code || a.path.localeCompare(b.path));
  const lines = ["| file | code ceiling | status | seams | note |", "|---|---|---|---|---|"];
  for (const e of rows) lines.push(`| \`${e.path}\` | ${e.code} | ${e.status} | ${cell(e.seams)} | ${cell(e.note)} |`);
  return lines.join("\n");
}

// The block as it stands in the doc (EOL-normalised), or null when the markers are missing.
export function ledgerInDoc(docText) {
  const t = docText.replace(/\r\n/g, "\n");
  const a = t.indexOf(START);
  const b = t.indexOf(END);
  if (a < 0 || b < a) return null;
  return t.slice(a + START.length, b).replace(/^\n/, "").replace(/\n$/, "");
}

// Replace the block, keeping the doc's existing EOL.
export function spliceLedger(docText, block) {
  const eol = docText.includes("\r\n") ? "\r\n" : "\n";
  const t = docText.replace(/\r\n/g, "\n");
  const a = t.indexOf(START);
  const b = t.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${DOC}: ledger markers not found`);
  const out = `${t.slice(0, a + START.length)}\n${block}\n${t.slice(b)}`;
  return eol === "\n" ? out : out.replace(/\n/g, eol);
}

// --write: lower ceilings, drop entries under the line or gone. Never raises a count and never
// creates an entry (a new over-line file enters only through --accept). Returns the new contract
// and a change log.
export function applyWrite(contract, root = ROOT) {
  const { over } = measure(contract, root);
  const overBy = new Map(over.map((f) => [f.path, f]));
  const log = [];
  const entries = [];
  for (const e of contract.entries) {
    const f = overBy.get(e.path);
    if (!f) { log.push(`drop ${e.path} (under its line or gone)`); continue; }
    if (f.code < e.code) { log.push(`lower ${e.path} ${e.code} -> ${f.code}`); entries.push({ ...e, code: f.code }); }
    else entries.push(e);
  }
  return { contract: { ...contract, entries }, log };
}

// --accept: the only raise, and the only way in for a new over-line file. Main thread only. Sets
// the ceiling to the actual count and appends the reason to the note; a new entry is owed, empty seams.
export function applyAccept(contract, path, reason, root = ROOT) {
  if (!reason) throw new Error("--accept needs --reason \"<text>\"");
  const f = measure(contract, root).over.find((x) => x.path === path);
  if (!f) throw new Error(`${path}: not a scanned file over its line; nothing to accept`);
  const e = contract.entries.find((x) => x.path === path);
  if (!e) {
    const entries = [...contract.entries, { path, code: f.code, status: "owed", seams: "", note: reason }]
      .sort((a, b) => a.path.localeCompare(b.path));
    return { contract: { ...contract, entries }, from: null, to: f.code };
  }
  if (f.code <= e.code) throw new Error(`${path}: ${f.code} code lines, ceiling ${e.code}; nothing to raise`);
  const entries = contract.entries.map((x) =>
    x === e ? { ...x, code: f.code, note: x.note ? `${x.note}; ${reason}` : reason } : x);
  return { contract: { ...contract, entries }, from: e.code, to: f.code };
}
