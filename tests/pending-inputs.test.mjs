// tools/release/pending.ps1 decides build=yes|no from the mtimes under its $dirs and $files. A compile-time
// input outside that list (a change to only an icons contract) reads "nothing pending" and never
// ships. This tripwire collects every input the staged build reads and asserts the list covers it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", "target", "target-staging", "target-wt", "target-zip", "gen"]);

/** Parse the `$dirs` and `$files` arrays out of pending.ps1 text, as repo-relative forward-slash paths. */
export function parseLists(ps1) {
  const grab = (name) => {
    const m = new RegExp(`^\\$${name}\\s*=\\s*@\\((.*)\\)\\s*$`, "m").exec(ps1);
    assert.ok(m, `$${name} array not found in pending.ps1`);
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1].replace(/\\/g, "/"));
  };
  return { dirs: grab("dirs"), files: grab("files") };
}

/** True when `p` (repo-relative, forward slashes, no trailing slash) is a listed file or sits under a listed dir. */
export function covered(p, { dirs, files }) {
  return files.includes(p) || dirs.some((d) => p === d || p.startsWith(`${d}/`));
}

const lit = (s) => s.replace(/\\/g, "/");

/** Rust include_str!/include_bytes! targets in `text`, resolved against `fileRel` (repo-relative). The literal
 *  may sit on the next line; a concat!(...) keeps its leading literal, trimmed to the directory. */
export function rustIncludes(text, fileRel) {
  const out = [];
  const re = /include_(?:str|bytes)!\(\s*(concat!\(\s*)?"([^"]*)"/g;
  for (const m of text.matchAll(re)) {
    let target = m[2];
    if (m[1]) target = target.replace(/[^/]*$/, "");
    out.push(join(dirname(fileRel), target).split(sep).join("/").replace(/\/$/, ""));
  }
  return out;
}

/** Relative TS import specifiers, import() calls, `new URL(.., import.meta.url)` and import.meta.glob
 *  patterns, resolved against `fileRel`; only those that leave `src/` are returned. A glob keeps its
 *  literal directory prefix. */
export function tsOutside(text, fileRel) {
  const specs = [];
  for (const m of text.matchAll(/\b(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) specs.push(m[1]);
  for (const m of text.matchAll(/new URL\(\s*["'](\.[^"']*)["']\s*,\s*import\.meta\.url/g)) specs.push(m[1]);
  for (const m of text.matchAll(/import\.meta\.glob(?:<[^(]*>)?\(\s*\[?\s*["']([^"']+)["']/g)) {
    if (m[1].startsWith(".")) specs.push(m[1].replace(/[*{].*$/, ""));
  }
  const out = [];
  for (const s of specs) {
    const p = join(dirname(fileRel), s.replace(/\?.*$/, "")).split(sep).join("/").replace(/\/$/, "");
    if (!p.startsWith("src/")) out.push(p);
  }
  return out;
}

/** HTML entries listed in vite.config.ts via resolve(import.meta.dirname, "x.html"). */
export function viteHtml(text) {
  return [...text.matchAll(/resolve\(\s*import\.meta\.dirname\s*,\s*"([^"]+\.html)"/g)].map((m) => m[1]);
}

function walk(dir, ext, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, out);
    else if (ext.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (f) => relative(ROOT, f).split(sep).join("/");
const read = (r) => readFileSync(join(ROOT, r), "utf8");

test("synthetic: an uncovered input of each kind is reported", () => {
  const lists = { dirs: ["src", "src-tauri/src"], files: ["index.html"] };
  const rust = rustIncludes(`const A: &str = include_str!("../../elsewhere/a.json");`, "src-tauri/src/x.rs");
  assert.deepEqual(rust, ["elsewhere/a.json"]);
  assert.equal(covered(rust[0], lists), false);
  const ts = tsOutside(`import a from "../zz/b.json";\nconst g = import.meta.glob("../yy/*.json");`, "src/x.ts");
  assert.deepEqual(ts, ["zz/b.json", "yy"]);
  assert.ok(ts.every((p) => !covered(p, lists)));
  const html = viteHtml(`input: { x: resolve(import.meta.dirname, "extra.html") }`);
  assert.deepEqual(html, ["extra.html"]);
  assert.equal(covered(html[0], lists), false);
});

test("synthetic: covered inputs and src-internal imports pass", () => {
  const lists = { dirs: ["src", "src-tauri/src"], files: ["index.html"] };
  assert.equal(covered("src-tauri/src/a/b.rs", lists), true);
  assert.equal(covered("src-tauri/srcx/b.rs", lists), false);
  assert.equal(covered("index.html", lists), true);
  assert.deepEqual(tsOutside(`import a from "../b/c";`, "src/x/y.ts"), []);
});

// pending.ps1 is release tooling (tools/release/ is export-ignored).
const skipPending = existsSync(join(ROOT, "tools/release/pending.ps1")) ? false : "tools/release/pending.ps1 is not in this tree (not shipped)";

test("parseLists reads both arrays from pending.ps1", { skip: skipPending }, () => {
  const l = parseLists(read("tools/release/pending.ps1"));
  assert.ok(l.dirs.includes("src") && l.files.includes("package.json"));
});

test("pending.ps1 lists every compile-time input of the staged build", { skip: skipPending }, () => {
  const lists = parseLists(read("tools/release/pending.ps1"));
  const found = []; // [input, site]
  const rustFiles = walk(join(ROOT, "src-tauri", "src"), /\.rs$/).map(rel);
  rustFiles.push("src-tauri/build.rs");
  for (const f of rustFiles) for (const p of rustIncludes(read(f), f)) found.push([p, f]);
  for (const f of walk(join(ROOT, "src"), /\.ts$/).map(rel)) for (const p of tsOutside(read(f), f)) found.push([p, f]);
  for (const h of viteHtml(read("vite.config.ts"))) found.push([h, "vite.config.ts"]);
  assert.ok(found.length > 40, "the collectors found suspiciously few inputs");
  for (const [p] of found) assert.ok(existsSync(join(ROOT, p)), `${p} does not exist`);
  const bad = found.filter(([p]) => !covered(p, lists)).map(([p, f]) => `${p} (read by ${f})`);
  assert.deepEqual(bad, [], "add these to $dirs / $files in tools/release/pending.ps1");
  for (const p of [...lists.dirs, ...lists.files]) assert.ok(existsSync(join(ROOT, p)), `${p} is listed but missing`);
});
