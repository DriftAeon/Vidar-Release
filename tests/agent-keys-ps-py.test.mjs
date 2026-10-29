// PowerShell and Python agent-key scanners: every test feeds one small inline source.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IDS, strictOf, tierOf, useIds } from "../tools/agents/key-words.mjs";
import { scan as scanPs } from "../tools/agents/ps-keys.mjs";
import { scan as scanPy } from "../tools/agents/py-keys.mjs";
import { plan, stepEnv } from "../tools/gate/gate.mjs";

useIds(DEFAULT_IDS);
const att = (es) => es.map((e) => ({ ...e, strictness: strictOf(e) }));
const PS = (src, path = "tools/foo/x.ps1") => att(scanPs([{ path, src }], {}));
const PY = (src, path = "content/foo/x.py") => att(scanPy([{ path, src }], {}));
const find = (es, tok, nth = 0) => es.filter((e) => e.tok === tok)[nth];
const ADAPTER_PS = "tools/release/codex-x.ps1";
const ADAPTER_PY = "content/foo/claude_x.py";

test("ps: here-string body is a literal key", () => {
  const es = PS('$x = @"\ncodex\n"@\n$y = @\'\nclaude\n\'@\n');
  assert.equal(find(es, "codex").cls, "S2");
  assert.equal(find(es, "claude").cls, "S2");
});

test("ps: variables, braced variables and compound names", () => {
  const es = PS("$codex = 1\n${claude} = 2\n$codexHome = 3\nWrite-Host \"a $codex b\"\n");
  assert.equal(find(es, "codex", 0).cls, "S1");
  assert.equal(find(es, "claude").cls, "S1");
  assert.equal(find(es, "codexHome").cls, "C");
  assert.equal(es.filter((e) => e.tok === "codex").length, 2);
});

test("ps: hashtable key and bareword argument", () => {
  const es = PS("$t = @{ claude = 'x'; 'codex' = 'y' }\nInvoke-Thing codex\n");
  assert.equal(find(es, "claude").cls, "S1");
  assert.equal(es.filter((e) => e.tok === "codex").length, 2);
  assert.ok(es.every((e) => e.forced === false));
});

test("ps: -ne in an adapter file is strict (R1); plain own-id use is free", () => {
  const es = PS("$m = 'codex'\nif ($a -ne 'codex') { 1 }\n", ADAPTER_PS);
  assert.equal(es[0].tier, "adapter:codex");
  assert.equal(es[0].strictness, "free");
  assert.equal(es[1].strictness, "strict");
  assert.equal(es[1].ctx.negated, true);
});

test("ps: if-head member access is strict in an adapter (R2)", () => {
  const es = PS("if ($x.codex) { 1 }\n$y = $x.codex\n", ADAPTER_PS);
  assert.equal(es[0].tok, "codex");
  assert.equal(es[0].strictness, "strict");
  assert.equal(es[1].strictness, "free");
});

test("ps: -and operands, -not, switch label and default", () => {
  const es = PS("$a = ($p -and $c.codex)\n$b = -not $d.claude\nswitch ($k) { 'codex' { 1 } default { 'claude' } }\n", ADAPTER_PS);
  assert.equal(find(es, "codex", 0).ctx.condition, true);
  assert.equal(find(es, "claude", 0).ctx.negated, true);
  assert.equal(find(es, "codex", 1).ctx.condition, true);
  assert.equal(find(es, "claude", 1).ctx.fallbackArm, true);
});

test("ps: .codex is an id-file (S3); interpolated string keeps literal parts", () => {
  const es = PS('$p = Join-Path $h ".codex"\n$q = "$h\\.codex"\n');
  assert.equal(find(es, ".codex").cls, "S3");
  assert.equal(find(es, "\\.codex").cls, "S2");
});

test("ps: CLAUDECODE env name is a compound (C)", () => {
  const es = PS("$env:CLAUDECODE = $null\n");
  assert.equal(find(es, "CLAUDECODE").cls, "C");
});

test("ps: comments are skipped", () => {
  assert.deepEqual(PS("# codex\n<# claude\ncodex #>\n$x = 1 # claude\n"), []);
});

test("ps: harness tier is skipped, write-audit.ps1 is not harness", () => {
  assert.equal(tierOf("tools/sandbox/x.ps1"), "harness");
  assert.notEqual(tierOf("tools/sandbox/write-audit.ps1"), "harness");
  const es = PS("$x = 'codex'\n", "tools/sandbox/x.ps1");
  assert.equal(es[0].strictness, "skip");
});

test("ps: anchors carry the enclosing function and count repeats", () => {
  const es = PS("function Get-Thing {\n" + "  Write-Host 'codex'\n".repeat(5) + "}\n$b = 'codex'\n");
  assert.match(es[0].anchor, /^Get-Thing: /);
  assert.equal(es[2].n, 2);
  assert.match(es[5].anchor, /^x: /);
});

test("py: triple-quoted string and docstring", () => {
  const es = PY('"""codex module"""\n\ndef f():\n    """claude doc"""\n    return """codex"""\n');
  assert.deepEqual(es.map((e) => e.tok), ["codex"]);
  assert.equal(es[0].cls, "S2");
  assert.match(es[0].anchor, /^f: /);
});

test("py: f-string literal part and expression names", () => {
  const es = PY('x = f"claude-{codex}-end"\n');
  assert.equal(find(es, "claude-").cls, "S2");
  assert.equal(find(es, "codex").cls, "S1");
});

test("py: == against an id is strict in an adapter (R2); else body is a fallback", () => {
  const es = PY('if agent == "claude":\n    a = "claude"\nelse:\n    b = "claude"\n', ADAPTER_PY);
  assert.equal(es[0].strictness, "strict");
  assert.equal(es[1].strictness, "free");
  assert.equal(es[2].ctx.fallbackArm, true);
  assert.equal(es[2].strictness, "strict");
});

test("py: dict key and != negation", () => {
  const es = PY('d = {"codex": 1}\nif a != "claude":\n    pass\n');
  assert.equal(find(es, "codex").cls, "S2");
  assert.equal(find(es, "claude").ctx.negated, true);
});

test("py: comments are skipped", () => {
  assert.deepEqual(PY("# codex\nx = 1  # claude\n"), []);
});

test("gate: staged tools .ps1 or content .py selects npm test and tree scans", () => {
  for (const f of ["tools/foo/x.ps1", "content/foo/x.py"]) {
    const names = plan([f]).map((s) => s[0]);
    assert.ok(names.includes("npm test"), f);
    assert.ok(names.includes("tree scans"), f);
  }
  assert.deepEqual(plan(["docs/x.md"]), []);
});

test("gate: spawned steps run without GIT_INDEX_FILE", () => {
  const env = stepEnv({ GIT_INDEX_FILE: "C:/tmp/index.lock", KEEP: "1" });
  assert.equal("GIT_INDEX_FILE" in env, false);
  assert.equal(env.KEEP, "1");
});
