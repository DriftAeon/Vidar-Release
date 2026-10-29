#!/usr/bin/env node
// Board generator: validates a board.json and renders it through template.html into
// bridge/display/board-<slug>.html (slug = the board.json's parent folder name).
//   node tools/board/board.mjs <path/to/board.json> [--check]
// --check validates only; exit 1 lists every failure. Node built-ins only.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, basename, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { resolve as resolveId } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const CARD_STATUS = ["todo", "doing", "decide", "done"];
const ROW_STATUS = ["open", "pass", "fail"];
const TEXT_MAX = 300;

const isStr = (v) => typeof v === "string" && v.trim() !== "";

function commitResolves(hash) {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return false;
  try {
    execFileSync("git", ["cat-file", "-e", `${hash}^{commit}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Evidence counts when it exists on disk or sits under a git-ignored path (the runs folder is
// gitignored, so a fresh worktree lacks it); a missing non-ignored path still fails.
function evidenceOk(p) {
  if (existsSync(join(ROOT, p))) return true;
  try {
    execFileSync("git", ["check-ignore", "-q", "--", p], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pathProblem(p) {
  if (!isStr(p)) return "is empty";
  if (p.includes("\\")) return `"${p}" uses backslashes (forward slashes only)`;
  if (/^[a-zA-Z]:/.test(p) || p.startsWith("/")) return `"${p}" is absolute (repo-relative only)`;
  if (p.split("/").includes("..")) return `"${p}" leaves the repo (no .. segments)`;
  return null;
}

export function validate(board) {
  const errs = [];
  if (board === null || typeof board !== "object") return ["board: not a JSON object"];
  for (const f of ["title", "goal", "notes"]) if (!isStr(board[f])) errs.push(`board: missing ${f}`);
  if (!Array.isArray(board.exitTest)) errs.push("board: exitTest must be an array");
  if (!Array.isArray(board.cards)) errs.push("board: cards must be an array");

  (board.exitTest ?? []).forEach((row, i) => {
    const at = `exitTest[${i}]`;
    if (!isStr(row?.text)) errs.push(`${at}: missing text`);
    if (!ROW_STATUS.includes(row?.status)) errs.push(`${at}: status "${row?.status}" not in ${ROW_STATUS.join("|")}`);
    if (row?.evidence !== undefined) {
      const bad = pathProblem(row.evidence);
      if (bad) errs.push(`${at}: evidence ${bad}`);
    }
    if (row?.status === "pass") {
      if (!isStr(row.evidence)) errs.push(`${at}: evidence required when status is pass`);
      else if (!pathProblem(row.evidence) && !evidenceOk(row.evidence))
        errs.push(`${at}: evidence "${row.evidence}" does not exist`);
    }
  });

  const seen = new Set();
  (board.cards ?? []).forEach((card, i) => {
    const id = isStr(card?.id) ? card.id : `cards[${i}]`;
    if (!isStr(card?.id)) errs.push(`${id}: missing id`);
    else if (seen.has(card.id)) errs.push(`${id}: duplicate id`);
    else seen.add(card.id);
    for (const f of ["kind", "title"]) if (!isStr(card?.[f])) errs.push(`${id}: missing ${f}`);
    if (!CARD_STATUS.includes(card?.status)) errs.push(`${id}: status "${card?.status}" not in ${CARD_STATUS.join("|")}`);
    const done = card?.status === "done";
    for (const f of ["goal", "doneWhen", "next"]) {
      const v = card?.[f];
      if (v === undefined && done) continue;
      if (!isStr(v)) errs.push(`${id}: missing ${f}`);
      else if (v.length > TEXT_MAX) errs.push(`${id}: ${f} is ${v.length} characters (max ${TEXT_MAX})`);
    }
    if (!Array.isArray(card?.evidence)) errs.push(`${id}: evidence must be an array`);
    const evidence = Array.isArray(card?.evidence) ? card.evidence : [];
    evidence.forEach((p) => {
      const bad = pathProblem(p);
      if (bad) errs.push(`${id}: evidence ${bad}`);
    });
    if (done) {
      if (!isStr(card.commit)) errs.push(`${id}: commit required when status is done`);
      else if (!commitResolves(card.commit)) errs.push(`${id}: commit "${card.commit}" does not resolve`);
      const onDisk = evidence.filter((p) => !pathProblem(p) && evidenceOk(p));
      if (onDisk.length === 0) errs.push(`${id}: evidence has no path that exists on disk`);
    }
  });
  return errs;
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function renderCard(c) {
  const ev = (c.evidence ?? []).map(esc).join(" · ");
  return `    <article class="card k-${esc(c.kind)} s-${c.status}">
      <details>
        <summary>
          <div class="bar"><span class="id">${esc(c.id)}</span></div>
          <div class="title"><span class="st"></span><h3>${esc(c.title)}</h3><span class="chev" aria-hidden="true"></span></div>
        </summary>
        <div class="body">
          <p><b>Goal.</b> ${esc(c.goal)}</p>
          <p><b>Done When.</b> ${esc(c.doneWhen)}</p>
          <p><b>Next.</b> ${esc(c.next)}</p>
${ev ? `          <p class="ev">${ev}</p>\n` : ""}        </div>
      </details>
    </article>`;
}

const GROUPS = [
  ["decide", "Decide", "Needs Your Call Before Work"],
  ["doing", "Doing", ""],
  ["todo", "Todo", ""],
];

export function render(board, template, source) {
  const out = [];
  out.push(`<h1>${esc(board.title)}</h1>`);
  const notesHref = relative(resolveId("display", { root: ROOT }), join(ROOT, board.notes)).replace(/\\/g, "/");
  out.push(`<p class="sub">Goal: ${esc(board.goal)} Notes: <a href="${esc(notesHref)}">${esc(board.notes)}</a></p>`);

  out.push(`<section class="group">\n  <h2>Exit Test</h2>\n  <ul class="rows">`);
  for (const r of board.exitTest) {
    const ev = r.evidence ? `<span class="ev">${esc(r.evidence)}</span>` : "";
    out.push(`    <li class="x-${r.status}"><span class="st"></span><span>${esc(r.text)}</span>${ev}</li>`);
  }
  out.push(`  </ul>\n</section>`);

  for (const [status, label, sub] of GROUPS) {
    const cards = board.cards.filter((c) => c.status === status);
    if (cards.length === 0) continue;
    const n = sub ? `<span class="n">${esc(sub)}</span>` : "";
    out.push(`<section class="group">\n  <h2>${label}${n}</h2>\n  <div class="cards">`);
    out.push(...cards.map(renderCard));
    out.push(`  </div>\n</section>`);
  }

  const done = board.cards.filter((c) => c.status === "done");
  if (done.length) {
    out.push(`<section class="group">\n  <h2>Shipped</h2>\n  <ul class="rows shipped">`);
    for (const c of done)
      out.push(`    <li><span class="id">${esc(c.id)}</span><span>${esc(c.title)}</span><span class="ev">${esc(c.commit)}</span></li>`);
    out.push(`  </ul>\n</section>`);
  }

  const fill = { title: esc(board.title), source: esc(source), body: out.join("\n") };
  return template.replace(/\{\{(title|source|body)\}\}/g, (_, k) => fill[k]);
}

function main(argv) {
  const args = argv.filter((a) => a !== "--check");
  const checkOnly = argv.includes("--check");
  if (args.length !== 1) {
    console.error("usage: node tools/board/board.mjs <path/to/board.json> [--check]");
    return 2;
  }
  const file = resolve(args[0]);
  let board;
  try {
    board = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`board: cannot read ${args[0]}: ${e.message}`);
    return 1;
  }
  const errs = validate(board);
  if (errs.length) {
    for (const e of errs) console.error(`FAIL ${e}`);
    console.error(`${errs.length} failure(s) in ${args[0]}`);
    return 1;
  }
  const source = relative(ROOT, file).replace(/\\/g, "/");
  if (checkOnly) {
    console.log(`ok ${source}`);
    return 0;
  }
  const template = readFileSync(join(HERE, "template.html"), "utf8");
  const outDir = resolveId("display", { root: ROOT });
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `board-${basename(dirname(file))}.html`);
  writeFileSync(outFile, render(board, template, source), "utf8");
  console.log(`ok ${source} -> ${relative(ROOT, outFile).replace(/\\/g, "/")}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
