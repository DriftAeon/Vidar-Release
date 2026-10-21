// Slot a colour icon from the icon library into the repo: copy the file to public/icons/color/,
// record it in contracts/icons.json, optionally map tools or proxy backends to it, and regenerate
// public/icons/color/PROVENANCE.md. The manifest is the only hand-maintained list; src/icon-img.ts
// and the Rendered chain read it, so no code edit is needed per icon.
//
// Usage:
//   node tools/icons/slot.mjs <name> <source-rel> [--tool <Tool>]... [--backend <name>]...
//        [--note "<text>"] [--replace] [--root <library>] [--repo <dir>]
//   node tools/icons/slot.mjs <name> - --tool <Tool>      map only: <name> must already exist
//   <source-rel>  path under the library root (default $VIDAR_ICON_LIBRARY, else Claude/icons two levels above the repo), e.g.
//                 fluent-color/svg/ic_fluent_mail_24_color.svg
//   --repo        repo root to write into (default: this repo); tests point it at a temp dir
//
// Refuses (exit 1, nothing written): a name outside ^[a-z0-9][a-z0-9-]*$; a source that is not
// .svg/.png, is missing, resolves outside the library root, or whose top folder is not in the
// manifest `sets` registry (the licence comes from there, never from the file name); an existing
// name with a different source unless --replace; --tool/--backend pointing at an unknown icon;
// "-" for a name that does not exist. An existing name with the same source never recopies the
// file (modified art such as close.svg stays) unless --replace.
// Writes are staged (tmp copies, then renames); an obsolete other-extension file is removed
// only after the renames succeed. Files are UTF-8 without BOM.

import { copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROOT = process.env.VIDAR_ICON_LIBRARY || resolve(defaultRepo(), "..", "..", "Claude", "icons").replaceAll("\\", "/");
export const BRAND_FILL = "#e6e6e6";
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MANIFEST_REL = "contracts/icons.json";
const COLOR_REL = "public/icons/color";

export function defaultRepo() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function extOf(source) {
  return extname(source).toLowerCase();
}

/** one line per entry so a diff of the manifest reads as one icon per line */
export function serializeManifest(m) {
  const block = (key, obj) => {
    const rows = Object.entries(obj).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    return `  ${JSON.stringify(key)}: {\n${rows.join(",\n")}\n  }`;
  };
  const ordered = { sets: m.sets, icons: m.icons, tools: m.tools ?? {}, backends: m.backends ?? {} };
  return `{\n${Object.entries(ordered).map(([k, v]) => block(k, v)).join(",\n")}\n}\n`;
}

function creditText(m, icon) {
  if (icon.credit) return icon.credit;
  const set = m.sets[icon.source.split("/")[0]];
  const base = `${set.name}, ${set.licence}`;
  if (!icon.note) return base;
  return `${base}${icon.note.startsWith("(") ? " " : "; "}${icon.note}`;
}

/** PROVENANCE.md text, generated from the manifest */
export function renderProvenance(m) {
  const rows = Object.entries(m.icons).map(([name, icon]) => `| ${name}${extOf(icon.source)} | ${icon.source} | ${creditText(m, icon)} |`);
  return [
    "# public/icons/color — provenance",
    "",
    "<!-- generated from contracts/icons.json by tools/icons/slot.mjs — do not hand-edit -->",
    "",
    "Copies checked into the repo (never links to the icon library on disk). Source set: the cas-icons library",
    "(cas-icons).",
    "",
    "| file | source | set / licence |",
    "|---|---|---|",
    ...rows,
    "",
    "Loaded by `src/icon-img.ts` (`iconImg(name)`).",
    "",
  ].join("\n");
}

export function applyBrandFill(svgText) {
  return svgText.replace(/<svg\b([^>]*)>/, (all, attrs) => (/\sfill\s*=/.test(attrs) ? all : `<svg${attrs} fill="${BRAND_FILL}">`));
}

function fail(msg) {
  throw new Error(msg);
}

function parseArgs(argv) {
  const o = { tools: [], backends: [], replace: false, root: DEFAULT_ROOT, repo: defaultRepo(), note: null, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? fail(`${a} needs a value`);
    if (a === "--tool") o.tools.push(val());
    else if (a === "--backend") o.backends.push(val());
    else if (a === "--note") o.note = val();
    else if (a === "--root") o.root = val();
    else if (a === "--repo") o.repo = val();
    else if (a === "--replace") o.replace = true;
    else if (a.startsWith("--")) fail(`unknown flag ${a}`);
    else o.pos.push(a);
  }
  if (o.pos.length !== 2) fail("usage: slot.mjs <name> <source-rel|-> [--tool T] [--backend B] [--note text] [--replace] [--root dir] [--repo dir]");
  return o;
}

export function slot(argv) {
  const o = parseArgs(argv);
  const [name, src] = o.pos;
  const manifestPath = join(o.repo, MANIFEST_REL);
  const colorDir = join(o.repo, COLOR_REL);
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.tools ??= {};
  m.backends ??= {};

  if (!NAME_RE.test(name)) fail(`invalid name "${name}" (must match ${NAME_RE})`);
  const existing = m.icons[name];
  let copy = null; // { from, to, text|null } when a file lands

  if (src === "-") {
    if (!existing) fail(`"${name}" is not in the manifest; give a source`);
    if (o.replace) fail("--replace needs a source");
  } else {
    const ext = extOf(src);
    if (ext !== ".svg" && ext !== ".png") fail(`source must be .svg or .png, got "${ext}"`);
    const root = resolve(o.root);
    const from = resolve(root, src);
    const rel = relative(root, from);
    if (rel.startsWith("..") || resolve(root, rel) !== from || rel === "") fail(`source "${src}" resolves outside the library root`);
    if (!existsSync(from) || !statSync(from).isFile()) fail(`source not found: ${from}`);
    const srcRel = rel.replace(/\\/g, "/");
    const setKey = srcRel.split("/")[0];
    const set = m.sets[setKey];
    if (!set) fail(`set "${setKey}" is not in the manifest sets registry; add it (name, licence) first`);
    if (existing && existing.source !== srcRel && !o.replace) fail(`"${name}" already slots ${existing.source}; pass --replace to change it`);
    const sameSource = existing && existing.source === srcRel;
    const entry = { source: srcRel };
    if (sameSource) Object.assign(entry, existing);
    if (o.note !== null) entry.note = o.note;
    if (!sameSource) {
      delete entry.credit;
      if (o.note === null) delete entry.note;
    }
    const needFile = !sameSource || o.replace || !existsSync(join(colorDir, name + ext));
    if (needFile) {
      let text = null;
      if (setKey === "brands" && ext === ".svg") {
        text = applyBrandFill(readFileSync(from, "utf8"));
        if (!entry.note) entry.note = `fill="${BRAND_FILL}" added on the root svg so it reads on dark panels`;
      }
      copy = { from, to: join(colorDir, name + ext), text };
    }
    m.icons[name] = entry;
  }

  for (const t of o.tools) m.tools[t] = name;
  for (const b of o.backends) m.backends[b] = name;
  for (const [kind, map] of Object.entries({ tools: m.tools, backends: m.backends })) {
    for (const [k, vs] of Object.entries(map)) for (const v of [vs].flat()) if (!m.icons[v]) fail(`${kind}.${k} points at unknown icon "${v}"`);
  }

  // stage, then rename into place
  const tag = `.tmp-${process.pid}-${Date.now()}`;
  const staged = []; // [tmp, final]
  try {
    if (copy) {
      const tmp = copy.to + tag;
      if (copy.text !== null) writeFileSync(tmp, copy.text, "utf8");
      else copyFileSync(copy.from, tmp);
      staged.push([tmp, copy.to]);
    }
    const mTmp = manifestPath + tag;
    writeFileSync(mTmp, serializeManifest(m), "utf8");
    staged.push([mTmp, manifestPath]);
    const pPath = join(colorDir, "PROVENANCE.md");
    const pTmp = pPath + tag;
    writeFileSync(pTmp, renderProvenance(m), "utf8");
    staged.push([pTmp, pPath]);
  } catch (e) {
    for (const [tmp] of staged) if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
  for (const [tmp, fin] of staged) renameSync(tmp, fin);
  // obsolete other-extension file, only after the renames succeeded
  const icon = m.icons[name];
  const keep = name + extOf(icon.source);
  for (const e of [".svg", ".png"]) {
    const f = join(colorDir, name + e);
    if (name + e !== keep && existsSync(f)) unlinkSync(f);
  }
  return { name, source: icon.source, copied: !!copy, tools: o.tools, backends: o.backends };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = slot(process.argv.slice(2));
    console.log(`slotted ${r.name} <- ${r.source}${r.copied ? "" : " (file unchanged)"}${r.tools.length ? ` tools: ${r.tools.join(", ")}` : ""}${r.backends.length ? ` backends: ${r.backends.join(", ")}` : ""}`);
  } catch (e) {
    console.error(`slot: ${e.message}`);
    process.exit(1);
  }
}
