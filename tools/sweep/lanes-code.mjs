// Sweep lanes for code: knip, tsc-unused, rustc, allows, ipc-unused, same-name, tests-touched.
// Not a CLI; loaded by tools/sweep/scan.mjs. Usage: node tools/sweep/scan.mjs --lanes knip,tsc-unused
// Refuses (lane error, never "fixed"): unparseable knip JSON, tsc output with no recognisable diagnostics,
// a cargo check that fails to build. Vendor dirs and test files are skipped by the walkers.
import fs from "node:fs";
import path from "node:path";

const fail = (cmd, error) => ({ ok: false, cmd, error, findings: [] });
const posix = (p) => p.split(path.sep).join("/");
const CRATES = [
  { name: "tauri", dir: "src-tauri" },
  { name: "falcon", dir: "src-falcon" },
];

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

/* ---- knip ---- */
function knip(ctx) {
  const cmd = "npx --no -- knip --reporter json --no-exit-code";
  const r = ctx.exec(cmd);
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch (e) {
    return fail(cmd, `unparseable knip JSON (exit ${r.code}): ${e.message}; ${r.stderr.trim().slice(0, 200)}`);
  }
  const findings = [];
  for (const issue of j.issues || []) {
    for (const [type, items] of Object.entries(issue)) {
      if (!Array.isArray(items) || type === "file") continue;
      for (const it of items) {
        const name = Array.isArray(it) ? it.map((x) => x.name).join("|") : it.name;
        if (!name) continue;
        const line = Array.isArray(it) ? it[0]?.line : it.line;
        findings.push({
          key: `knip:${type}:${issue.file}:${name}`, file: issue.file, line, msg: `${type} ${name}`,
        });
      }
    }
  }
  return { ok: true, cmd, findings };
}

/* ---- tsc-unused ---- */
const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
function tscUnused(ctx) {
  const cmd = "npx --no -- tsc --noEmit --noUnusedLocals --pretty false";
  const r = ctx.exec(cmd); // exit 1 expected when diagnostics exist
  if (r.code !== 0 && r.code !== 1 && r.code !== 2) return fail(cmd, `exit ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
  const findings = [];
  for (const raw of r.stdout.split(/\r?\n/)) {
    const m = TSC_LINE.exec(raw);
    if (!m) continue;
    const [, file, line, , code, msg] = m;
    const f = posix(file);
    findings.push({ key: `tsc:${code}:${f}:${msg}`, file: f, line: Number(line), msg: `${code} ${msg}` });
  }
  if (r.code !== 0 && !findings.length) return fail(cmd, `exit ${r.code} with no parseable diagnostics: ${r.stdout.trim().slice(0, 300)}`);
  return { ok: true, cmd, findings };
}

/* ---- rustc warnings ---- */
function rustc(ctx) {
  const findings = [];
  const cmds = [];
  for (const c of CRATES) {
    const cmd = `cargo check --manifest-path ${c.dir}/Cargo.toml --message-format json`;
    cmds.push(cmd);
    const r = ctx.exec(cmd);
    if (r.code !== 0) return fail(cmds.join(" ; "), `${c.name}: cargo check exit ${r.code}: ${r.stderr.trim().slice(-300)}`);
    for (const raw of r.stdout.split(/\r?\n/)) {
      if (!raw.startsWith("{")) continue;
      let o;
      try {
        o = JSON.parse(raw);
      } catch {
        continue;
      }
      if (o.reason !== "compiler-message" || o.message?.level !== "warning") continue;
      const span = (o.message.spans || []).find((s) => s.is_primary) || o.message.spans?.[0];
      if (!span) continue; // the "N warnings emitted" summary has no span
      const code = o.message.code?.code ?? "none";
      const file = posix(path.posix.normalize(span.file_name));
      findings.push({
        key: `rustc:${c.name}:${code}:${file}:${o.message.message}`, file, line: span.line_start, msg: `${code} ${o.message.message}`,
      });
    }
  }
  return { ok: true, cmd: cmds.join(" ; "), findings };
}

/* ---- allows ---- */
const ALLOW = /^(\s*)#(!?)\[allow\(([^)]*)\)\](.*)$/;
const ITEM = /\b(?:fn|struct|enum|mod|const|static|type|trait|impl|use|union)\s+([\w:<>]+)/;
function allows(ctx) {
  const findings = [];
  for (const c of CRATES) {
    for (const file of walk(ctx.root, `${c.dir}/src`, (n) => n.endsWith(".rs"))) {
      const lines = read(ctx.root, file).split(/\r?\n/);
      lines.forEach((text, i) => {
        const m = ALLOW.exec(text);
        if (!m) return;
        const lints = m[3].replace(/\s+/g, " ").trim();
        // A reason is a trailing `//` comment or a `//` comment line directly above.
        const reason = /^\s*\/\/\s*\S/.test(m[4]) || /^\s*\/\/[/!]?\s*\S/.test(lines[i - 1] ?? "");
        let item = "(crate)";
        if (!m[2]) {
          item = "(next)";
          for (let j = i + 1; j < lines.length && j < i + 8; j++) {
            const l = lines[j].trim();
            if (!l || l.startsWith("#[") || l.startsWith("//")) continue;
            const im = ITEM.exec(l);
            item = im ? im[1] : l.slice(0, 40);
            break;
          }
        }
        findings.push({
          key: `allow:${file}:${lints}:${item}`, file, line: i + 1, msg: `allow(${lints}) on ${item}`,
          ...(reason ? {} : { detail: { bare: true } }),
        });
      });
    }
  }
  return { ok: true, cmd: `scan ${CRATES.map((c) => `${c.dir}/src`).join(" ")} for #[allow(`, findings };
}

/* ---- ipc-unused ---- */
function ipcUnused(ctx) {
  // Lanes are synchronous and the TS import is async: run it in a child node (type stripping, as tests/ipc-commands.test.mjs).
  const cmd = `node --input-type=module -e "import('./src/ipc-hosts.ts').then(m=>console.log(JSON.stringify(Object.keys(m.COMMAND_HOSTS))))"`;
  const r = ctx.exec(cmd);
  let names;
  try {
    names = JSON.parse(r.stdout.trim());
  } catch (e) {
    return fail(cmd, `cannot load COMMAND_HOSTS (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
  }
  const files = walk(ctx.root, "src", (n) => n.endsWith(".ts")).filter((f) => f !== "src/ipc.ts" && f !== "src/ipc-hosts.ts");
  const corpus = files.map((f) => read(ctx.root, f)).join("\n");
  const findings = [];
  for (const name of names) {
    if (new RegExp(`["'\`]${name}["'\`]`).test(corpus)) continue;
    findings.push({ key: `ipc:${name}`, file: "src/ipc-hosts.ts", msg: `command ${name} has no quoted use outside ipc.ts/ipc-hosts.ts` });
  }
  return { ok: true, cmd, findings };
}

/* ---- same-name ---- */
const TOP_DECL = /^(?:export\s+)?(?:(?:async\s+)?function\s*\*?\s*(\w+)|const\s+(\w+)\s*=\s*\()/;
function sameName(ctx) {
  const files = [
    ...walk(ctx.root, "src", (n, rel) => n.endsWith(".ts") && !n.endsWith(".d.ts") && !isTestFile(n, rel)),
    ...walk(ctx.root, "tools/lib", (n, rel) => n.endsWith(".mjs") && !isTestFile(n, rel)),
  ];
  const byName = new Map();
  for (const f of files) {
    for (const line of read(ctx.root, f).split(/\r?\n/)) {
      const m = TOP_DECL.exec(line);
      const name = m && (m[1] || m[2]);
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(f);
    }
  }
  const findings = [];
  for (const [name, set] of byName) {
    if (set.size < 2) continue;
    const list = [...set].sort();
    findings.push({ key: `dup:${name}`, msg: `${name} declared in ${list.length} files`, detail: { files: list } });
  }
  findings.sort((a, b) => a.key.localeCompare(b.key));
  return { ok: true, cmd: "scan src/**/*.ts tools/lib/*.mjs for top-level function/const arrow names", findings };
}

/* ---- tests-touched (delta) ---- */
function testsTouched(ctx) {
  const since = ctx.since;
  const c1 = `git diff --name-only ${since}..HEAD`;
  const a = ctx.exec(c1);
  if (a.code !== 0) return fail(c1, `exit ${a.code}: ${a.stderr.trim().slice(0, 300)}`);
  const c2 = `git diff -G"#\\[test\\]" --name-only ${since}..HEAD -- "*.rs"`;
  const b = ctx.exec(c2);
  if (b.code !== 0) return fail(c2, `exit ${b.code}: ${b.stderr.trim().slice(0, 300)}`);
  const files = new Set();
  for (const f of a.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (/\.test\.mjs$/.test(f) || f.startsWith("tests/")) files.add(f);
  }
  for (const f of b.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) files.add(f);
  const findings = [...files].sort().map((f) => ({ key: `test:${f}`, file: f, msg: `touched since ${since.slice(0, 7)}` }));
  return { ok: true, cmd: `${c1} ; ${c2}`, findings };
}

export const LANES = [
  { id: "knip", kind: "tracked", run: knip },
  { id: "tsc-unused", kind: "tracked", run: tscUnused },
  { id: "rustc", kind: "tracked", run: rustc },
  { id: "allows", kind: "tracked", run: allows },
  { id: "ipc-unused", kind: "tracked", run: ipcUnused },
  { id: "same-name", kind: "tracked", run: sameName },
  { id: "tests-touched", kind: "delta", run: testsTouched },
];
