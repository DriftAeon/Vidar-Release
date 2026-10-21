// layout-audit.mjs - live audit for zero-size children that still take a flex/grid gap.
//
// Why: `.character-controls:empty { display:none }` silently failed because the div held a newline,
// so an invisible 0-height flex child kept a 6px gap under the GATE select. This finds the class.
//
// Read-only: one `eval` through tools/drive/vidar-drive.mjs (a script, not a module, so it is spawned
// and its stdout parsed). No clicks, no state changes. Needs the DevTools port (`swap-release.ps1 -Debug`).
//
// Usage:  node tools/ui/layout-audit.mjs [--json]
//   default: one line per finding `<wasted>px  <container> > <child>  (<axis> gap <gap>)`, then `N findings, M px`
//   --json:  the finding array
// Exit 0 unless the tool itself fails; port closed prints `DevTools port not open: swap with -Debug`, exit 1.
//
// Checks: a rendered flex/grid container with gap > 0 whose in-flow element child (not display:none,
// absolute/fixed or contents) is 0 along the main axis (flex) or 0 in width or height (grid). Each such
// child wastes one gap; `count` is the length of the adjacent zero-size run it sits in.

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// ---- pure helpers (also embedded in the page expression via .toString(): no closures) ----

/** Class selector minus state classes, or null. Mirrors src/panels/inspect.ts classSelector. */
export function classSel(el) {
  const skip = ["active", "hidden", "named", "dead"];
  const cls = [...el.classList].filter((c) => skip.indexOf(c) < 0);
  return cls.length ? "." + cls.join(".") : null;
}

/** Nearest id, else classes minus state classes, with one id of context. Mirrors inspect.ts resolve(). */
export function shortSelector(start) {
  let own = start;
  while (own && own.tagName !== "BODY" && !own.id && !classSel(own)) own = own.parentElement;
  if (!own || own.tagName === "BODY" || own.tagName === "HTML") return start.tagName ? start.tagName.toLowerCase() : "?";
  if (own.id) return "#" + own.id;
  let sel = classSel(own);
  const anchor = own.parentElement && own.parentElement.closest("[id]");
  if (anchor && anchor.id !== "app") sel = "#" + anchor.id + " " + sel;
  return sel;
}

/** Which gap applies for a computed-style-like object. Returns { axis, gap } (px, 0 when `normal`). */
export function gapAxis(cs) {
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const col = px(cs.columnGap);
  const row = px(cs.rowGap);
  if (String(cs.display).indexOf("grid") >= 0) {
    return col >= row ? { axis: "row", gap: col } : { axis: "column", gap: row };
  }
  if (String(cs.flexDirection).indexOf("column") === 0) return { axis: "column", gap: row };
  return { axis: "row", gap: col };
}

/** One output line for a finding. */
export function formatFinding(f) {
  return `${f.wasted}px  ${f.container} > ${f.child}  (${f.axis} gap ${f.gap})`;
}

export function formatReport(findings) {
  const total = findings.reduce((s, f) => s + f.wasted, 0);
  return [...findings.map(formatFinding), `${findings.length} findings, ${total} px`].join("\n");
}

// ---- page side ----

/** Runs in the page; helpers are passed in by name. Returns a JSON string. */
export function auditPage() {
  const out = [];
  const rendered = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    return typeof el.checkVisibility === "function" ? el.checkVisibility() : el.offsetParent !== null;
  };
  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    const isGrid = cs.display.indexOf("grid") >= 0;
    if (cs.display.indexOf("flex") < 0 && !isGrid) continue;
    const { axis, gap } = gapAxis(cs);
    if (!(gap > 0) || !rendered(el)) continue;
    const kids = [];
    for (const k of el.children) {
      const kc = getComputedStyle(k);
      if (kc.display === "none" || kc.display === "contents") continue;
      if (kc.position === "absolute" || kc.position === "fixed") continue;
      const r = k.getBoundingClientRect();
      const zero = isGrid ? r.width === 0 || r.height === 0 : axis === "row" ? r.width === 0 : r.height === 0;
      kids.push({ k, zero });
    }
    let i = 0;
    while (i < kids.length) {
      if (!kids[i].zero) { i++; continue; }
      let j = i;
      while (j < kids.length && kids[j].zero) j++;
      for (let n = i; n < j; n++) {
        out.push({
          container: shortSelector(el),
          child: shortSelector(kids[n].k) + (shortSelector(kids[n].k) === shortSelector(el) ? " (" + kids[n].k.tagName.toLowerCase() + ")" : ""),
          axis, gap, wasted: gap, count: j - i,
        });
      }
      i = j;
    }
  }
  return JSON.stringify(out);
}

/** The expression sent to the page. */
export function pageExpression() {
  return `(() => { ${classSel.toString()}\n${shortSelector.toString()}\n${gapAxis.toString()}\nreturn (${auditPage.toString()})(); })()`;
}

// ---- CLI ----

function run(argv) {
  const drive = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drive", "vidar-drive.mjs");
  let raw;
  try {
    raw = execFileSync(process.execPath, [drive, "eval", pageExpression()], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  } catch (e) {
    const err = String(e.stderr ?? "") + String(e.message ?? "");
    if (/no DevTools|timed out|ECONNREFUSED|fetch failed/i.test(err) || e.status === 1) {
      console.error("DevTools port not open: swap with -Debug");
    } else {
      console.error(`layout-audit failed: ${err.trim()}`);
    }
    process.exit(1);
  }
  let findings;
  try {
    findings = JSON.parse(raw);
    if (typeof findings === "string") findings = JSON.parse(findings);
  } catch { console.error(`layout-audit: unreadable result: ${raw.slice(0, 200)}`); process.exit(1); }
  console.log(argv.includes("--json") ? JSON.stringify(findings, null, 2) : formatReport(findings));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run(process.argv.slice(2));
