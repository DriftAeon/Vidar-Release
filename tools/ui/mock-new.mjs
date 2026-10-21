#!/usr/bin/env node
// mock-new.mjs — start a UI mock for Display: template + kit, Vidar tokens resolved to literals.
//
//   node tools/ui/mock-new.mjs <slug>                       draft: runtime/bridge/mock-drafts/<slug>.html
//   node tools/ui/mock-new.mjs --publish <slug> [--theme <name>]   resolve the draft into Display
//
// Two steps so Display never shows an unfilled template with Approve/Deny on it.
// Draft: tools/ui/mock-kit/template.html with button.html's <style> in the head (kit classes to
// build with; its demo markup stays out of the page), tokens left as var() so the author writes in
// tokens. Publish: replaces every var(--x) / var(--x, fallback) (nested too) inside <style> blocks
// and style="" attributes with its literal value, drops custom-property declarations, and writes
// bridge/display/<slug>-<8 random hex>.html. The draft stays for revisions.
//
// Why resolve: Display renders HTML through src/panels/preview.ts, whose filterDecls (:136-145)
// drops every custom property and every declaration whose value uses var(). A token-authored mock
// would arrive unstyled. preview.ts also keeps only head <style>s (:233-239; a body <style> is
// dropped), has no <button> in HTML_KEEP, keeps no data-theme attribute and runs no script.
//
// Token values: every top-level :root block of src/styles.css in file order (later wins), then the
// named theme's html[data-theme="<name>"] block. styles.css is an @import manifest, inlined in
// order: the themes live in src/styles/tokens.css, the --agent-* :root in src/styles/leftbar.css. "onyx" is the :root set with no theme block.
// The script cannot know which theme the running Vidar shows; pass --theme to match it.
//
// Naming: <slug>-<8 hex>.html, a fresh id on every run (revisions too). The trailing 8-hex id is
// what puts Approve/Deny on screen.
//
// Exit 1 with no file written on: bad slug, unknown theme, unresolvable var(), missing marker.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { resolve as resolveId } from "../lib/paths.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STYLES = join(REPO, "src", "styles.css");
const KIT = join(resolveId("tools", { root: REPO }), "ui", "mock-kit");
const OUT_DIR = resolveId("display", { root: REPO });
const DRAFT_DIR = join(dirname(OUT_DIR), "mock-drafts"); // a sibling Display does not watch

const HELP = `usage: node tools/ui/mock-new.mjs <slug>
       node tools/ui/mock-new.mjs --publish <slug> [--theme <name>]

Step 1 writes a draft, runtime/bridge/mock-drafts/<slug>.html, from tools/ui/mock-kit/: three
empty variant frames, the kit's button classes in the head, tokens as var(). Fill it in there;
Display does not see it.
Step 2 (--publish) resolves every token to its literal value (Display drops var() and custom
properties) and writes bridge/display/<slug>-<8 hex>.html. A fresh id per publish; the id is
what gives the file Approve/Deny in Display. Republish after each revision.

  <slug>          lowercase letters, digits and hyphens, e.g. flow-inspector
  --theme <name>  token set to resolve against (default onyx). This script cannot see which
                  theme the running Vidar shows; pass the one you want the mock to match.
                  Themes are read from src/styles.css: onyx plus each html[data-theme] block.

Display runs no script: open an interactive mock in a browser instead.`;

function die(msg) {
  process.stderr.write(`mock-new: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const a = { slug: null, theme: "onyx", publish: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "-h" || k === "--help") { process.stdout.write(HELP + "\n"); process.exit(0); }
    else if (k === "--theme") { a.theme = argv[++i]; if (!a.theme) die("--theme needs a name"); }
    else if (k === "--publish") a.publish = true;
    else if (k.startsWith("-")) die(`unknown flag ${k}`);
    else if (a.slug === null) a.slug = k;
    else die(`unexpected argument ${k}`);
  }
  if (!a.slug) die("missing <slug>\n\n" + HELP);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.slug)) die(`slug "${a.slug}": use lowercase letters, digits and single hyphens`);
  return a;
}

const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** Top-level rules of a stylesheet as { prelude, body }; at-rule contents are skipped whole. */
function topLevelBlocks(css) {
  const out = [];
  let depth = 0, start = 0, prelude = "", bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      if (depth === 0) { prelude = css.slice(start, i).trim(); bodyStart = i + 1; }
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) { out.push({ prelude, body: css.slice(bodyStart, i) }); start = i + 1; }
    } else if (c === ";" && depth === 0) {
      start = i + 1; // top-level statement such as @import
    }
  }
  return out;
}

/** Custom-property declarations of one block body, in order. */
function customProps(body) {
  const out = [];
  for (const decl of body.split(";")) {
    const m = /^\s*(--[\w-]+)\s*:([\s\S]*)$/.exec(decl);
    if (m) out.push([m[1], m[2].trim()]);
  }
  return out;
}

const THEME_PRELUDE = /^(?:html)?\[data-theme=(["']?)([\w-]+)\1\]$/;

// styles.css is an ordered @import manifest; inline it so :root blocks keep file order.
function readStyles() {
  return readFileSync(STYLES, "utf8").replace(/^@import\s+"([^"]+)";[^\n]*$/gm,
    (_, rel) => readFileSync(join(dirname(STYLES), rel), "utf8"));
}

function loadTokens(theme) {
  const blocks = topLevelBlocks(stripCssComments(readStyles()));
  const vars = new Map();
  const themes = new Map([["onyx", []]]); // onyx = :root only (src/styles/tokens.css :1-5)
  for (const b of blocks) {
    if (b.prelude === ":root") for (const [k, v] of customProps(b.body)) vars.set(k, v);
    const m = THEME_PRELUDE.exec(b.prelude);
    if (m) themes.set(m[2], [...(themes.get(m[2]) ?? []), ...customProps(b.body)]);
  }
  if (!themes.has(theme)) die(`unknown theme "${theme}"; styles.css has: ${[...themes.keys()].join(", ")}. No file written.`);
  for (const [k, v] of themes.get(theme)) vars.set(k, v);
  return vars;
}

/** Index of the ")" that closes the "(" at open, or -1. */
function closeParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Replaces every var() in s. Unresolvable names are added to `missing`. */
function resolveVars(s, vars, missing, seen = []) {
  let out = "", i = 0;
  const re = /var\s*\(/gi;
  let m;
  while ((m = re.exec(s))) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(s, open);
    if (close < 0) { missing.add(`unbalanced var( near "${s.slice(m.index, m.index + 40)}"`); return s; }
    const inner = s.slice(open + 1, close);
    // split name from fallback at the first top-level comma
    let depth = 0, comma = -1;
    for (let j = 0; j < inner.length; j++) {
      if (inner[j] === "(") depth++;
      else if (inner[j] === ")") depth--;
      else if (inner[j] === "," && depth === 0) { comma = j; break; }
    }
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    let val;
    if (vars.has(name) && !seen.includes(name)) val = resolveVars(vars.get(name), vars, missing, [...seen, name]);
    else if (fallback !== null) val = resolveVars(fallback, vars, missing, seen);
    else { missing.add(seen.includes(name) ? `${name} (cycle)` : name); val = ""; }
    out += s.slice(i, m.index) + val;
    i = close + 1;
    re.lastIndex = i;
  }
  return out + s.slice(i);
}

function writeDraft(args) {
  const draft = join(DRAFT_DIR, `${args.slug}.html`);
  if (existsSync(draft)) die(`${draft} exists: edit it, then --publish ${args.slug}. No file written.`);
  const template = readFileSync(join(KIT, "template.html"), "utf8");
  const button = readFileSync(join(KIT, "button.html"), "utf8");
  const kitStyles = [...button.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((x) => x[0]).join("\n");
  if (!template.includes("<!-- kit:styles -->")) die("template.html lost its <!-- kit:styles --> marker. No file written.");
  mkdirSync(DRAFT_DIR, { recursive: true });
  writeFileSync(draft, template.replace("<!-- kit:styles -->", kitStyles).replaceAll("{{slug}}", args.slug), "utf8");
  process.stdout.write(`${draft}\nFill it in, then: node tools/ui/mock-new.mjs --publish ${args.slug} --theme <name>\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.publish) return writeDraft(args);
  const draft = join(DRAFT_DIR, `${args.slug}.html`);
  if (!existsSync(draft)) die(`no draft at ${draft}; run without --publish first. No file written.`);
  const vars = loadTokens(args.theme);
  let doc = readFileSync(draft, "utf8");

  // a custom property declared in the kit joins the table (flat: no selector scoping)
  for (const st of doc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const b of topLevelBlocks(stripCssComments(st[1]))) for (const [k, v] of customProps(b.body)) vars.set(k, v);
  }

  const missing = new Set();
  doc = doc.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, a, css, z) => {
    let body = resolveVars(stripCssComments(css), vars, missing);
    body = body.replace(/(^|[;{\s])--[\w-]+\s*:[^;{}]*;?/g, "$1"); // custom-property declarations
    return a + body + z;
  });
  doc = doc.replace(/\bstyle="([^"]*)"/gi, (_, css) =>
    `style="${resolveVars(css, vars, missing).replace(/(^|[;\s])--[\w-]+\s*:[^;]*;?/g, "$1")}"`);

  if (missing.size) die(`unresolvable: ${[...missing].join(", ")} (theme ${args.theme}). No file written.`);
  if (/var\s*\(/i.test(doc)) die("a var( survived resolution. No file written.");

  let path;
  do path = join(OUT_DIR, `${args.slug}-${randomBytes(4).toString("hex")}.html`);
  while (existsSync(path));
  writeFileSync(path, doc, "utf8");
  process.stdout.write(`${path}\ntheme: ${args.theme}\nInteractive mocks: open this file in a browser; Display runs no script.\n`);
}

main();
