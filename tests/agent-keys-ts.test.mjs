// TypeScript / .mjs agent keys: ts-keys.mjs over small inline sources.
// Nothing here reads the repo's own fixtures; the scanner runs the TypeScript 7 API on an in-memory project.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_IDS, strictOf, useIds } from "../tools/agents/key-words.mjs";
import { lexTokens, scan } from "../tools/agents/ts-keys.mjs";
import { DETECTORS } from "../tools/sweep/lanes-systems.mjs";

useIds(DEFAULT_IDS);

/** Scan one inline source the way gather() does (strictness attached). */
const K = (src, path = "src/x/foo.ts") => scan([{ path, src }], {}).map((e) => ({ ...e, strictness: strictOf(e) }));
const at = (es, line) => es.filter((e) => e.line === line);
const row = (e) => `${e.tok}:${e.cls}:${e.strictness}`;

test("call argument literal is S2 and strict", () => {
  const es = K('load("codex");\n');
  assert.deepEqual(es.map(row), ["codex:S2:strict"]);
  assert.equal(es[0].ctx.kind, "literal");
});

test("regex literal is S2 (reScanSlashToken), division is not a regex", () => {
  const es = K("const r = /-(claude|codex)$/;\nconst n = a / b / 2;\nconst m = x.split(/codex/);\n");
  assert.deepEqual(at(es, 1).map((e) => [e.tok, e.cls, e.ctx.kind]), [["/-(claude|codex)$/", "S2", "regex"]]);
  assert.deepEqual(at(es, 3).map((e) => [e.tok, e.cls, e.ctx.kind]), [["/codex/", "S2", "regex"]]);
  assert.equal(at(es, 2).length, 0);
  assert.deepEqual(lexTokens("a / b / c").map((t) => t.text), ["a", "/", "b", "/", "c"]);
  assert.deepEqual(lexTokens("x = /a b/g;").map((t) => t.text), ["x", "=", "/a b/g", ";"]);
});

test("property access x.codex is S1; a compound property is C", () => {
  const es = K("const a = x.codex;\nconst b = x.codexHome;\n");
  assert.deepEqual(es.map((e) => `${e.line}:${row(e)}`), ["1:codex:S1:strict", "2:codexHome:C:cap"]);
});

test("computed key value is S2 on the value", () => {
  const es = K('const o = { ["claude"]: 1, [`codex`]: 2 };\n');
  assert.deepEqual(es.map(row), ["claude:S2:strict", "codex:S2:strict"]);
});

test(".mjs ternary on an id is a strict S2 in a condition", () => {
  const es = K('const x = id === "codex" ? 1 : 2;\n', "tools/release/pick.mjs");
  assert.deepEqual(es.map(row), ["codex:S2:strict"]);
  assert.deepEqual(K('const x = id === "codex" ? 1 : 2;\n', "tools/x/pick.mjs").map(row), ["codex:S2:cap"], "dev tools are capped (R9)");
  assert.equal(es[0].ctx.condition, true);
  assert.deepEqual(es[0].ctx.cmp, { op: "===", subject: "id" });
});

test("Record<AgentId, X> object literal keys are forced", () => {
  const es = K('type AgentId = "claude" | "codex";\nconst X: Record<AgentId, number> = {\n  claude: 1,\n  codex: 2,\n};\n');
  const keys = es.filter((e) => e.forced);
  assert.deepEqual(keys.map((e) => `${e.tok}:${e.strictness}`), ["claude:free", "codex:free"]);
  assert.deepEqual(keys.map((e) => e.line), [2, 2], "reported at the object literal start (the tsc anchor)");
  assert.equal(keys[0].base, "S1");
});

test("a partial or unrelated object literal is not forced", () => {
  const es = K('type AgentId = "claude" | "codex";\nconst P: Partial<Record<AgentId, number>> = { claude: 1 };\nconst Q = { claude: 1, codex: 2 };\n');
  assert.equal(es.filter((e) => e.forced).length, 0);
});

const SWITCH = (tail) => `type AgentId = "claude" | "codex";\ndeclare function unknownAgent(a: never): never;\nfunction f(a: AgentId) {\n  switch (a) {\n    case "claude": return 1;\n    case "codex": return 2;\n    default: ${tail}\n  }\n}\n`;

test("switch over AgentId closed by unknownAgent is forced", () => {
  const es = K(SWITCH("return unknownAgent(a);"));
  assert.deepEqual(es.filter((e) => e.forced).map((e) => `${e.tok}:${e.line}:${e.strictness}`), ["claude:5:free", "codex:6:free"]);
});

test("switch with a never-typed default (no unknownAgent call) is forced", () => {
  const es = K(SWITCH("{ const n: never = a; throw new Error(String(n)); }"));
  assert.equal(es.filter((e) => e.forced).length, 2);
});

test("switch without a never-close is not forced and its cases are strict", () => {
  const es = K(SWITCH("return 0;"));
  assert.equal(es.filter((e) => e.forced).length, 0);
  const cases = es.filter((e) => e.line === 5 || e.line === 6);
  assert.deepEqual(cases.map(row), ["claude:S2:strict", "codex:S2:strict"]);
  assert.ok(cases.every((e) => e.ctx.wild));
});

test("!== claude in an adapter file is strict (R1); a bare use there is free", () => {
  const p = "src/panels/rendered/claude-login.ts";
  const es = K('const a = "claude";\nconst b = id !== "claude";\n', p);
  assert.equal(es[0].tier, "adapter:claude");
  assert.deepEqual(es.map((e) => `${e.line}:${row(e)}`), ["1:claude:S2:free", "2:claude:S2:strict"]);
  assert.equal(es[1].ctx.negated, true);
});

test("?.codexHome in an if is strict (R2); outside a condition it is free in an adapter", () => {
  const p = "src/bare/codex-home.ts";
  const es = K("if (cfg?.codexHome) { go(); }\nconst h = cfg.codexHome;\n", p);
  assert.deepEqual(es.map((e) => `${e.line}:${row(e)}`), ["1:codexHome:C:strict", "2:codexHome:C:free"]);
  assert.equal(es[0].ctx.condition, true);
});

test("template part with a path is C; a bare id-file literal is S3", () => {
  const es = K("const a = `${dir}/.codex/x`;\nconst b = \".codex\";\n");
  assert.deepEqual(es.map((e) => `${e.line}:${row(e)}`), ["1:/.codex/x:C:cap", "2:.codex:S3:strict"]);
  assert.equal(es[0].ctx.kind, "literal");
});

test("anchor survives a line shift and names the enclosing item", () => {
  const src = "function pick(id: string) {\n  return id === \"codex\" ? 1 : 2;\n}\n";
  const a = K(src)[0];
  const b = K("// header\n\n\n" + src)[0];
  assert.equal(a.anchor, b.anchor);
  assert.notEqual(a.line, b.line);
  assert.match(a.anchor, /^pick: /);
  assert.equal(a.n, 1);
  const twice = K("function pick(id: string) {\n  return id === \"codex\" ? 1 : 2;\n}\nfunction pick2(id: string) {\n  return id === \"codex\" ? 1 : 2;\n}\n");
  assert.notEqual(twice[0].anchor, twice[1].anchor, "a copy in another item has its own anchor");
});

test("comments and module specifiers are not keys", () => {
  const es = K('import { a } from "./claude-thing.js";\n// codex\n/* "claude" */\nconst s = 1;\n');
  assert.equal(es.length, 0);
});

test("sys-agent-branch delegates to the scanner and agrees with it on a fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "ts-keys-"));
  try {
    const files = {
      "src/agents/codex.ts": 'if (agent === "codex") {}\n',
      "src/launcher/x.ts": 'const a = agent === "codex" ? 1 : 2;\nconst b = agent === "codex";\nconst c = tab.kind !== "claude";\nconst d = other === "plain";\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const r = DETECTORS["sys-agent-branch"]({ root });
    assert.equal(r.ok, true, r.error);
    const viaScanner = K(files["src/launcher/x.ts"], "src/launcher/x.ts").filter((e) => e.cls === "S2" && e.ctx.cmp).map((e) => `${e.ctx.cmp.subject} ${e.ctx.cmp.op} "${e.tok}"`);
    assert.deepEqual(new Set(r.findings.map((f) => f.key.replace("sys-agent-branch:src/launcher/x.ts:", ""))), new Set(viaScanner));
    assert.deepEqual(r.findings.map((f) => f.key).sort(), ['sys-agent-branch:src/launcher/x.ts:agent === "codex"', 'sys-agent-branch:src/launcher/x.ts:tab.kind !== "claude"']);
    assert.equal(r.findings.find((f) => f.key.endsWith('agent === "codex"')).detail.count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
