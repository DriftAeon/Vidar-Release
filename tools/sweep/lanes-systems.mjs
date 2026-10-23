// Sweep lanes for systems drift: one lane per detector (sys-relay, sys-approval-origins, sys-unions,
// sys-interfaces, sys-writers, sys-popover, sys-agent-branch, sys-dots). Each lane flags a second implementation of a shared system (relay, approvals, popovers, unions, writers).
// Not a CLI; loaded by tools/sweep/scan.mjs. Usage: node tools/sweep/scan.mjs --lanes sys-relay,sys-unions
// Findings are {key, file, line, msg, detail}; keys are file + normalised text, never line numbers.
// Static text scans (regex, no parsing): every detector is a heuristic that points at a place to look, not a verdict.
// Refuses (lane error, never "fixed"): a missing anchor file for sys-relay's owner, sys-approval-origins' union or
// contracts/paths.json for sys-writers. Vendor dirs and test files are skipped by the walkers.
import fs from "node:fs";
import path from "node:path";

const fail = (cmd, error) => ({ ok: false, cmd, error, findings: [] });
const RELAY_OWNER = "src/relay/source-approvals.ts";
const APPROVAL_TYPES = "src/asks/approval.ts";

function walk(root, dir, test, out = []) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (/^(node_modules|vendor|target)$/.test(e.name)) continue;
      walk(root, rel, test, out);
    } else if (test(e.name, rel)) out.push(rel);
  }
  return out;
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const isTestFile = (name, rel) => /\.test\.[mc]?[jt]s$/.test(name) || rel.startsWith("tests/") || rel.includes("/tests/");
const tsFiles = (root) => walk(root, "src", (n, rel) => n.endsWith(".ts") && !n.endsWith(".d.ts") && !isTestFile(n, rel));
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;
const sortFindings = (f) => f.sort((a, b) => a.key.localeCompare(b.key));

/** Members of a `type X = "a" | "b"` right-hand side, or null when any member is not a string literal. */
function literalMembers(rhs) {
  const parts = rhs.split("|").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = /^(["'])([^"']*)\1$/.exec(p);
    if (!m) return null;
    out.push(m[2]);
  }
  return out;
}

const UNION_DECL = /(?:^|\n)\s*(?:export\s+)?type\s+(\w+)\s*=\s*((?:\|?\s*["'][^"'\n]*["']\s*)+);/g;

/** All string-literal union aliases in a file: [{name, members(sorted), line}]. */
function unionsIn(text) {
  const out = [];
  UNION_DECL.lastIndex = 0;
  let m;
  while ((m = UNION_DECL.exec(text))) {
    const members = literalMembers(m[2]);
    if (members) out.push({ name: m[1], members: [...new Set(members)].sort(), line: lineOf(text, m.index + 1) });
  }
  return out;
}

/* ---- sys-relay ---- */
function sysRelay(ctx) {
  const findings = [];
  const owner = path.join(ctx.root, RELAY_OWNER);
  const cmd = `scan src/**/*.ts for kind "card" RelayItems outside ${RELAY_OWNER}`;
  if (!fs.existsSync(owner)) return fail(cmd, `${RELAY_OWNER} not found`);
  for (const file of tsFiles(ctx.root)) {
    if (file === RELAY_OWNER) continue;
    const text = read(ctx.root, file);
    const m = /kind:\s*["']card["']/.exec(text);
    if (!m || !/\bRelayItem\b/.test(text)) continue;
    findings.push({
      key: `sys-relay:${file}:builds a card RelayItem`, file, line: lineOf(text, m.index),
      msg: `builds a card RelayItem outside ${RELAY_OWNER}`,
    });
  }
  return { ok: true, cmd, findings: sortFindings(findings) };
}

/* ---- sys-approval-origins ---- */
function sysApprovalOrigins(ctx) {
  const cmd = `scan ${APPROVAL_TYPES} ApprovalOrigin against src/**/*.ts openApproval/setApprovalSlice callers`;
  if (!fs.existsSync(path.join(ctx.root, APPROVAL_TYPES))) return fail(cmd, `${APPROVAL_TYPES} not found`);
  const text = read(ctx.root, APPROVAL_TYPES);
  const m = /type\s+ApprovalOrigin\s*=\s*((?:\|?\s*["'][^"'\n]*["']\s*)+);/.exec(text);
  const origins = m && literalMembers(m[1]);
  if (!origins) return fail(cmd, `ApprovalOrigin union not found in ${APPROVAL_TYPES}`);
  const producers = tsFiles(ctx.root)
    .filter((f) => f !== APPROVAL_TYPES)
    .map((f) => ({ f, t: read(ctx.root, f) }))
    .filter(({ t }) => /\b(openApproval|setApprovalSlice)\s*\(/.test(t));
  const findings = [];
  for (const o of origins) {
    const re = new RegExp(`["'\`]${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
    if (producers.some(({ t }) => re.test(t))) continue;
    findings.push({
      key: `sys-approval-origins:${o}`, file: APPROVAL_TYPES, line: lineOf(text, m.index),
      msg: `ApprovalOrigin "${o}" has no producer calling openApproval or setApprovalSlice with it`,
    });
  }
  return { ok: true, cmd, findings };
}

/* ---- sys-unions ---- */
const UNION_MIN_MEMBERS = 3;
function sysUnions(ctx) {
  const byKey = new Map();
  for (const file of tsFiles(ctx.root)) {
    for (const u of unionsIn(read(ctx.root, file))) {
      if (u.members.length < UNION_MIN_MEMBERS) continue;
      const k = u.members.join("|");
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({ file, name: u.name, line: u.line });
    }
  }
  const findings = [];
  for (const [k, uses] of byKey) {
    const files = [...new Set(uses.map((u) => u.file))].sort();
    if (files.length < 2) continue;
    findings.push({
      key: `sys-unions:${k}`, file: files[0], line: uses.find((u) => u.file === files[0]).line,
      msg: `identical union ${k.split("|").map((s) => `"${s}"`).join(" | ")} in ${files.length} files`,
      detail: { files, names: uses.map((u) => `${u.name}@${u.file}`).sort() },
    });
  }
  return { ok: true, cmd: `scan src/**/*.ts for identical string-literal unions (>= ${UNION_MIN_MEMBERS} members) in 2+ files`, findings: sortFindings(findings) };
}

/* ---- sys-interfaces ---- */
const IFACE_MIN_SHARED = 4;
function interfacesIn(text) {
  const out = [];
  const re = /(?:^|\n)\s*(?:export\s+)?interface\s+(\w+)(?:<[^>{]*>)?(?:\s+extends\s+[^{]+)?\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    const start = i;
    while (i < text.length && depth > 0) {
      const c = text[i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const body = text.slice(start, i - 1);
    // Top-level fields only: depth-0 lines of the body.
    const fields = new Set();
    let d = 0;
    for (const raw of body.split("\n")) {
      if (d === 0) {
        const fm = /^\s*(?:readonly\s+)?(\w+)\??\s*:/.exec(raw);
        if (fm) fields.add(fm[1]);
      }
      for (const c of raw) {
        if (c === "{") d++;
        else if (c === "}") d--;
      }
    }
    out.push({ name: m[1], fields, line: lineOf(text, m.index + 1) });
  }
  return out;
}

function sysInterfaces(ctx) {
  const all = [];
  for (const file of tsFiles(ctx.root)) {
    for (const i of interfacesIn(read(ctx.root, file))) {
      if (i.fields.size >= IFACE_MIN_SHARED) all.push({ ...i, file });
    }
  }
  const findings = [];
  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      const x = all[a];
      const y = all[b];
      if (x.file === y.file) continue;
      const shared = [...x.fields].filter((f) => y.fields.has(f)).sort();
      if (shared.length < IFACE_MIN_SHARED) continue;
      const [p, q] = [x, y].sort((l, r) => `${l.file}:${l.name}`.localeCompare(`${r.file}:${r.name}`));
      findings.push({
        key: `sys-interfaces:${p.file}:${p.name}~${q.file}:${q.name}`, file: p.file, line: p.line,
        msg: `${p.name} and ${q.name} (${q.file}) share ${shared.length} fields: ${shared.join(", ")}`,
        detail: { shared },
      });
    }
  }
  return { ok: true, cmd: `scan src/**/*.ts for interface pairs across files sharing >= ${IFACE_MIN_SHARED} field names`, findings: sortFindings(findings) };
}

/* ---- sys-writers ---- */
const WRITE_CALL = /\b(fs::write|fs::create_dir_all|fs::create_dir|fs::rename|fs::copy|fs::remove_file|File::create|OpenOptions|write_all|create_dir_all|tokio::fs::write)\b/;
function sysWriters(ctx) {
  const cmd = "heuristic: scan src-tauri/src/**/*.rs for files that resolve a contracts/paths.json id and call a write API";
  const contractFile = path.join(ctx.root, "contracts", "paths.json");
  if (!fs.existsSync(contractFile)) return fail(cmd, "contracts/paths.json not found");
  let ids;
  try {
    ids = Object.keys(JSON.parse(fs.readFileSync(contractFile, "utf8")).ids || {});
  } catch (e) {
    return fail(cmd, `unparseable contracts/paths.json: ${e.message}`);
  }
  const rsFiles = walk(ctx.root, "src-tauri/src", (n) => n.endsWith(".rs"));
  // Accessor fns in paths.rs: `pub fn name() ... { p("id") ... }` map a fn name to its id.
  const accessors = new Map();
  const pathsRs = "src-tauri/src/paths.rs";
  if (rsFiles.includes(pathsRs)) {
    const t = read(ctx.root, pathsRs);
    const re = /pub fn (\w+)\([^)]*\)[^{]*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(t))) {
      const idm = /\b(?:p|rel|resolve)\(\s*(?:root\s*,\s*)?"(\w+)"/.exec(m[2]) || /contract::resolve\([^"]*"(\w+)"/.exec(m[2]);
      if (idm && ids.includes(idm[1])) accessors.set(m[1], idm[1]);
    }
  }
  const writersById = new Map();
  for (const file of rsFiles) {
    if (file === pathsRs || file.startsWith("src-tauri/src/paths/")) continue;
    const t = read(ctx.root, file);
    if (!WRITE_CALL.test(t)) continue;
    const used = new Set();
    for (const id of ids) {
      if (new RegExp(`\\b(?:rel|resolve)\\([^)]*"${id}"`).test(t)) used.add(id);
    }
    for (const [fn, id] of accessors) {
      if (new RegExp(`\\bpaths::${fn}\\s*\\(`).test(t)) used.add(id);
    }
    for (const id of used) {
      if (!writersById.has(id)) writersById.set(id, []);
      writersById.get(id).push(file);
    }
  }
  const findings = [];
  for (const [id, files] of writersById) {
    if (files.length < 2) continue;
    files.sort();
    findings.push({
      key: `sys-writers:${id}`, file: files[0],
      msg: `heuristic: paths.json id ${id} is resolved in ${files.length} Rust files that also call a write API`,
      detail: { files },
    });
  }
  return { ok: true, cmd, findings: sortFindings(findings) };
}

/* ---- sys-popover ---- */
const POPOVER_IMPORT = /from\s+["'][^"']*(modules\/popover|\/popover|panels\/dropdown|\/dropdown|context-menu)["']/;
function sysPopover(ctx) {
  const findings = [];
  for (const file of tsFiles(ctx.root)) {
    if (/(^|\/)(popover|dropdown|context-menu)[^/]*\.ts$/.test(file)) continue;
    const text = read(ctx.root, file);
    const body = /document\.body\.(append|appendChild)\(/.exec(text);
    if (!body) continue;
    const outside = /(document|window)\.addEventListener\(\s*["'](pointerdown|mousedown|click)["']/.test(text);
    const escape = /["']Escape["']/.test(text);
    if (!outside || !escape) continue;
    if (POPOVER_IMPORT.test(text)) continue;
    findings.push({
      key: `sys-popover:${file}`, file, line: lineOf(text, body.index),
      msg: "appends to document.body and handles outside-click and Escape itself, without modules/popover, panels/dropdown or context-menu",
    });
  }
  return { ok: true, cmd: "scan src/**/*.ts for a hand-rolled popover (body append + outside-click + Escape)", findings: sortFindings(findings) };
}

/* ---- sys-agent-branch ---- */
function sysAgentBranch(ctx) {
  const findings = [];
  for (const file of tsFiles(ctx.root)) {
    if (file.startsWith("src/agents/") || file === "src/panels/rendered/agent-profile.ts") continue;
    const text = read(ctx.root, file);
    const seen = new Map();
    const re = /\bagent\s*(===|!==)\s*["'](\w+)["']/g;
    let m;
    while ((m = re.exec(text))) {
      const norm = `agent ${m[1]} "${m[2]}"`;
      if (!seen.has(norm)) seen.set(norm, { line: lineOf(text, m.index), n: 0 });
      seen.get(norm).n++;
    }
    for (const [norm, v] of seen) {
      findings.push({
        key: `sys-agent-branch:${file}:${norm}`, file, line: v.line, msg: `${norm} outside src/agents/ and agent-profile.ts`,
        detail: { count: v.n },
      });
    }
  }
  return { ok: true, cmd: "scan src/**/*.ts for agent === \"<id>\" outside src/agents/ and agent-profile.ts", findings: sortFindings(findings) };
}

/* ---- sys-dots ---- */
function sysDots(ctx) {
  const findings = [];
  for (const file of walk(ctx.root, "src", (n) => n.endsWith(".css"))) {
    const text = read(ctx.root, file).replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(text))) {
      const selector = m[1].trim().replace(/\s+/g, " ");
      if (!/dot/i.test(selector) || /^:root\b/.test(selector)) continue;
      for (const decl of m[2].split(";")) {
        const dm = /^\s*([\w-]+)\s*:\s*(.+)$/s.exec(decl);
        if (!dm || dm[1].startsWith("--")) continue;
        if (!/#[0-9a-fA-F]{3,8}\b/.test(dm[2])) continue;
        findings.push({
          key: `sys-dots:${file}:${selector}:${dm[1]}`, file, line: lineOf(text, m.index + m[0].indexOf(decl)),
          msg: `${selector} sets ${dm[1]} to raw hex, not a --dot-* token`,
        });
      }
    }
  }
  return { ok: true, cmd: "scan src/**/*.css dot rules for raw hex values", findings: sortFindings(findings) };
}

export const DETECTORS = {
  "sys-relay": sysRelay,
  "sys-approval-origins": sysApprovalOrigins,
  "sys-unions": sysUnions,
  "sys-interfaces": sysInterfaces,
  "sys-writers": sysWriters,
  "sys-popover": sysPopover,
  "sys-agent-branch": sysAgentBranch,
  "sys-dots": sysDots,
};

export const LANES = Object.entries(DETECTORS).map(([id, run]) => ({ id, kind: "tracked", run }));
