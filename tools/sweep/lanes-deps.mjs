// Sweep lanes for dependencies: npm-outdated, npm-pins, npm-audit, cargo-audit (both crates).
// Not a CLI; loaded by tools/sweep/scan.mjs. Usage: node tools/sweep/scan.mjs --lanes npm-pins,npm-audit
// Refuses (lane error, never "fixed"): unparseable tool output, an npm error object (offline), cargo-audit
// failing to produce JSON. All four lanes need the network.
import fs from "node:fs";
import path from "node:path";

const CRATES = [
  { name: "tauri", lock: "src-tauri/Cargo.lock" },
  { name: "falcon", lock: "src-falcon/Cargo.lock" },
];

const fail = (cmd, error) => ({ ok: false, cmd, error, findings: [] });
const memo = new WeakMap();

function parseJson(text) {
  const t = text.trim();
  return t ? JSON.parse(t) : {};
}

/** `npm outdated --json` once per ctx; exit 0 or 1 are both normal. Returns {cmd, data} or {cmd, error}. */
function outdated(ctx) {
  if (memo.has(ctx)) return memo.get(ctx);
  const cmd = "npm outdated --json";
  const r = ctx.exec(cmd);
  let res;
  if (r.code !== 0 && r.code !== 1) res = { cmd, error: `exit ${r.code}: ${r.stderr.trim().slice(0, 300)}` };
  else {
    try {
      const data = parseJson(r.stdout);
      res = data.error ? { cmd, error: `npm: ${data.error.summary || data.error.code}` } : { cmd, data };
    } catch (e) {
      res = { cmd, error: `unparseable npm outdated output: ${e.message}` };
    }
  }
  memo.set(ctx, res);
  return res;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

function packageSpecs(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return { ...pkg.optionalDependencies, ...pkg.devDependencies, ...pkg.dependencies };
}

function cargoAudit(ctx) {
  const findings = [];
  const cmds = [];
  for (const c of CRATES) {
    const cmd = `cargo audit --json --file ${c.lock}`;
    cmds.push(cmd);
    const r = ctx.exec(cmd); // exit 1 when advisories are found: parse regardless
    let j;
    try {
      j = parseJson(r.stdout);
    } catch (e) {
      return fail(cmds.join(" ; "), `${c.name}: unparseable cargo audit output (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    }
    if (!j.vulnerabilities) return fail(cmds.join(" ; "), `${c.name}: no vulnerabilities section (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    const add = (kind, item) => {
      const adv = item.advisory;
      const id = adv?.id ?? "none";
      const pkg = item.package;
      findings.push({
        key: `rustsec:${c.name}:${kind}:${id}:${pkg.name}@${pkg.version}`,
        file: c.lock,
        msg: `${adv?.title ?? kind} (${pkg.name} ${pkg.version})`,
        detail: { kind, id, crate: pkg.name, version: pkg.version, patched: item.versions?.patched },
      });
    };
    for (const v of j.vulnerabilities.list || []) add("vulnerability", v);
    for (const [kind, items] of Object.entries(j.warnings || {})) for (const w of items) add(kind, w);
  }
  return { ok: true, cmd: cmds.join(" ; "), findings };
}

export const LANES = [
  {
    id: "npm-outdated",
    kind: "tracked",
    run(ctx) {
      const o = outdated(ctx);
      if (o.error) return fail(o.cmd, o.error);
      const findings = Object.entries(o.data).map(([name, raw]) => {
        const { current, wanted, latest } = first(raw);
        return { key: `outdated:${name}:${latest}`, msg: `${name} ${current} -> ${latest}`, detail: { current, wanted, latest } };
      });
      return { ok: true, cmd: o.cmd, findings };
    },
  },
  {
    id: "npm-pins",
    kind: "tracked",
    run(ctx) {
      const o = outdated(ctx);
      if (o.error) return fail(o.cmd, o.error);
      const specs = packageSpecs(ctx.root);
      const findings = [];
      for (const [name, raw] of Object.entries(o.data)) {
        const spec = specs[name];
        if (typeof spec !== "string" || !/^\d/.test(spec)) continue;
        const { current, latest } = first(raw);
        if (current === latest) continue;
        findings.push({ key: `pin:${name}:${latest}`, file: "package.json", msg: `${name} pinned ${spec}, latest ${latest}`, detail: { spec, current, latest } });
      }
      return { ok: true, cmd: o.cmd, findings };
    },
  },
  {
    id: "npm-audit",
    kind: "tracked",
    run(ctx) {
      const cmd = "npm audit --json";
      const r = ctx.exec(cmd); // exit 1 when vulnerabilities exist
      let j;
      try {
        j = parseJson(r.stdout);
      } catch (e) {
        return fail(cmd, `unparseable npm audit output (exit ${r.code}): ${e.message}`);
      }
      if (j.error) return fail(cmd, `npm: ${j.error.summary || j.error.code}`);
      if (!j.vulnerabilities) return fail(cmd, `no vulnerabilities section (exit ${r.code})`);
      const findings = Object.entries(j.vulnerabilities).map(([name, v]) => ({
        key: `npm-audit:${name}:${v.severity}`,
        msg: `${name} ${v.severity}`,
        detail: { range: v.range, fixAvailable: v.fixAvailable },
      }));
      return { ok: true, cmd, findings };
    },
  },
  { id: "cargo-audit", kind: "tracked", run: cargoAudit },
];
