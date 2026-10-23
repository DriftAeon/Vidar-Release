// row-heights.mjs - live audit for controls of different height on one horizontal row.
//
// Why: mismatched control heights on one row (Jira Type/Status pickers vs the search box) keep
// recurring. New UI work must pass this. (layout-audit.mjs checks a different thing, zero-size
// children that take a gap, so this is a sibling script, not an extension.)
//
// Read-only: one `eval` through tools/drive/vidar-drive.mjs. No clicks, typing or focus changes.
// Needs the DevTools port (`swap-release.ps1 -Debug`).
//
// LIMIT: it only sees what is currently laid out. Hidden panes and inactive tabs have no boxes, so
// the user must open a surface for it to be scanned. The header line names the visible surface.
//
// Usage:  node tools/ui/row-heights.mjs [--json] [--root <selector>]
//   default: header `surface: ...`, one line per flagged row, then `N rows flagged of M scanned`
//   --json:  { surface, scanned, flagged: [...] }
//   --root:  limit the scan to the subtree(s) matching the selector (e.g. .jira-pane)
// Exit 0 no row flagged, 1 any row flagged or the tool failed (port closed prints
// `DevTools port not open: swap with -Debug`).
//
// Rows: visible flex/inline-flex (row direction) or one-row grid containers with 2+ direct children
// that are controls (button, input, select, textarea, [role=button], [role=combobox], or a wrapper
// whose only control is one input). Flagged when outer heights differ by more than 1px or vertical
// centres differ by more than 1px. Wrapping rows are compared per line. Labels and text are ignored.

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// ---- pure helpers (embedded in the page expression via .toString(): no closures, no imports) ----

/**
 * controls: [{ cls, top, height }]. Returns the flagged lines as arrays of controls ([] when fine).
 * wrap: group by visual line first (a control starts a new line when its top is at/after the
 * current line's lowest bottom).
 */
export function compareRow(controls, wrap, tol) {
  const t = typeof tol === "number" ? tol : 1;
  let lines = [controls];
  if (wrap) {
    const sorted = controls.slice().sort((a, b) => a.top - b.top);
    lines = [];
    let cur = [];
    let bottom = -Infinity;
    for (const c of sorted) {
      if (cur.length && c.top >= bottom - t) { lines.push(cur); cur = []; bottom = -Infinity; }
      cur.push(c);
      bottom = Math.max(bottom, c.top + c.height);
    }
    if (cur.length) lines.push(cur);
  }
  const bad = [];
  for (const line of lines) {
    if (line.length < 2) continue;
    const hs = line.map((c) => c.height);
    const mids = line.map((c) => c.top + c.height / 2);
    const dh = Math.max(...hs) - Math.min(...hs);
    const dm = Math.max(...mids) - Math.min(...mids);
    if (dh > t || dm > t) bad.push(line);
  }
  return bad;
}

const r1 = (n) => Math.round(n * 10) / 10;

export function formatRow(f) {
  const cs = f.controls.map((c) => `${c.cls} ${r1(c.height)}px${c.source ? " [" + c.source + "]" : ""}`);
  return `${f.row}  ${cs.join(" | ")}`;
}

export function formatReport(result) {
  const lines = [`surface: ${result.surface || "unknown"}`];
  for (const f of result.flagged) lines.push(formatRow(f));
  lines.push(`${result.flagged.length} rows flagged of ${result.scanned} scanned`);
  return lines.join("\n");
}

// ---- page side ----

/** Runs in the page. `root` is a selector or "". Returns a JSON string. */
export function auditPage(root) {
  const CTRL = "button, input, select, textarea, [role=button], [role=combobox]";
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    if (el.closest("[hidden]")) return false;
    return typeof el.checkVisibility === "function" ? el.checkVisibility() : el.offsetParent !== null;
  };
  const clsOf = (el) => {
    const c = [...el.classList].filter((x) => ["active", "hidden", "named", "dead"].indexOf(x) < 0);
    return el.tagName.toLowerCase() + (c.length ? "." + c.join(".") : "");
  };
  const sel = (el) => {
    if (el.id) return "#" + el.id;
    const parts = [];
    let p = el;
    while (p && p.tagName !== "BODY" && parts.length < 3) {
      parts.unshift(p.id ? "#" + p.id : clsOf(p));
      if (p.id) break;
      p = p.parentElement;
    }
    return parts.join(" > ");
  };
  const source = (el) => {
    const found = [];
    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        const walk = (list) => {
          for (const rule of list) {
            if (rule.cssRules && !rule.selectorText) { walk(rule.cssRules); continue; }
            if (!rule.selectorText || !rule.style) continue;
            const h = rule.style.getPropertyValue("height");
            const m = rule.style.getPropertyValue("min-height");
            if (!h && !m) continue;
            let hit = false;
            try { hit = el.matches(rule.selectorText); } catch { hit = false; }
            if (hit) found.push(rule.selectorText + " {" + (h ? " height:" + h : "") + (m ? " min-height:" + m : "") + " }");
          }
        };
        walk(rules);
      }
    } catch { /* ignore */ }
    const inl = el.style && (el.style.height || el.style.minHeight);
    if (inl) found.push("inline " + (el.style.height ? "height:" + el.style.height : "") + (el.style.minHeight ? " min-height:" + el.style.minHeight : ""));
    const cs = getComputedStyle(el);
    const base = "height:" + cs.height + (cs.minHeight && cs.minHeight !== "0px" && cs.minHeight !== "auto" ? " min-height:" + cs.minHeight : "");
    return found.length ? found[found.length - 1] + " (computed " + base + ")" : "computed " + base;
  };
  const controlOf = (k) => {
    if (k.matches(CTRL)) return k;
    const inner = k.querySelectorAll(CTRL);
    if (inner.length === 1 && inner[0].tagName === "INPUT") return k;
    return null;
  };
  const surfaceNames = [];
  for (const a of document.querySelectorAll(".active, [aria-selected=true]")) {
    if (!visible(a)) continue;
    const t = (a.getAttribute("aria-label") || a.getAttribute("title") || a.textContent || "").trim().replace(/\s+/g, " ");
    const name = clsOf(a) + (t && t.length <= 24 ? ' "' + t + '"' : "");
    if (surfaceNames.length < 8 && surfaceNames.indexOf(name) < 0) surfaceNames.push(name);
  }
  const roots = root ? [...document.querySelectorAll(root)] : [document.body];
  const flagged = [];
  let scanned = 0;
  const seen = new Set();
  for (const rt of roots) {
    for (const el of [rt, ...rt.querySelectorAll("*")]) {
      if (seen.has(el)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      let rowLike = false;
      let wrap = false;
      if (cs.display === "flex" || cs.display === "inline-flex") {
        rowLike = cs.flexDirection.indexOf("row") === 0;
        wrap = cs.flexWrap !== "nowrap";
      } else if (cs.display === "grid" || cs.display === "inline-grid") {
        rowLike = cs.gridTemplateRows.trim().split(/\s+/).length === 1;
      }
      if (!rowLike || !visible(el)) continue;
      const ctrls = [];
      for (const k of el.children) {
        const kc = getComputedStyle(k);
        if (kc.display === "none" || kc.display === "contents") continue;
        if (kc.position === "absolute" || kc.position === "fixed") continue;
        if (!visible(k)) continue;
        if (!controlOf(k)) continue;
        const r = k.getBoundingClientRect();
        ctrls.push({ el: k, cls: clsOf(k), top: r.top, height: r.height });
      }
      if (ctrls.length < 2) continue;
      scanned++;
      const bad = compareRow(ctrls, wrap, 1);
      for (const line of bad) {
        flagged.push({
          row: sel(el),
          controls: line.map((c) => ({ cls: c.cls, height: c.height, top: c.top, source: source(c.el) })),
        });
      }
    }
  }
  return JSON.stringify({ surface: surfaceNames.join(", "), scanned, flagged });
}

/** The expression sent to the page. */
export function pageExpression(root) {
  return `(() => { ${compareRow.toString()}\nreturn (${auditPage.toString()})(${JSON.stringify(root || "")}); })()`;
}

// ---- CLI ----

function run(argv) {
  const ri = argv.indexOf("--root");
  const root = ri >= 0 ? argv[ri + 1] : "";
  if (ri >= 0 && !root) { console.error("row-heights: --root needs a selector"); process.exit(1); }
  const drive = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drive", "vidar-drive.mjs");
  let raw;
  try {
    raw = execFileSync(process.execPath, [drive, "eval", pageExpression(root)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  } catch (e) {
    const err = String(e.stderr ?? "") + String(e.message ?? "");
    if (/no DevTools|timed out|ECONNREFUSED|fetch failed/i.test(err) || e.status === 1) {
      console.error("DevTools port not open: swap with -Debug");
    } else {
      console.error(`row-heights failed: ${err.trim()}`);
    }
    process.exit(1);
  }
  let result;
  try {
    result = JSON.parse(raw);
    if (typeof result === "string") result = JSON.parse(result);
  } catch { console.error(`row-heights: unreadable result: ${raw.slice(0, 200)}`); process.exit(1); }
  console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : formatReport(result));
  process.exit(result.flagged.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run(process.argv.slice(2));
