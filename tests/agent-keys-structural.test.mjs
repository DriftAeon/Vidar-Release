// Structural class St (rust-structural.mjs) and the Q2 rules (own-id C free in an adapter, prose strict only as a
// direct comparison operand). Every test feeds small inline sources; each rule carries one mutation that must flip.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IDS, strictOf, useIds } from "../tools/agents/key-words.mjs";
import { enumsOf, scan, testDeclared } from "../tools/agents/rust-keys.mjs";
import { scan as scanPs } from "../tools/agents/ps-keys.mjs";
import { scan as scanPy } from "../tools/agents/py-keys.mjs";
import { scan as scanTs } from "../tools/agents/ts-keys.mjs";

useIds(DEFAULT_IDS);
const ENUMS = new Map([["Agent", ["Claude", "Codex"]]]);
const ALL = new Set(["src-tauri/src/main.rs", "src-tauri/src/codex.rs", "src-tauri/src/claude.rs", "src-tauri/src/claude/codex.rs",
  "src-tauri/src/generic.rs", "src-tauri/src/bridge_golden.rs"]);
const att = (es) => es.map((e) => ({ ...e, strictness: strictOf(e) }));
const R = (src, path = "src-tauri/src/generic.rs") => att(scan([{ path, src }], { enums: ENUMS, all: ALL }));
const pick = (es, tok, nth = 0) => es.filter((e) => e.tok === tok)[nth];
const cs = (e) => `${e.cls}:${e.strictness}`;

test("St-mod: mod X; resolving to adapter X is free; a file outside the adapters is not", () => {
  assert.equal(cs(pick(R("mod codex;\n", "src-tauri/src/main.rs"), "codex")), "St:free");
  // mutation: claude.rs's `mod codex;` resolves to claude/codex.rs, which names two agents (tier other)
  assert.equal(cs(pick(R("mod codex;\n", "src-tauri/src/claude.rs"), "codex")), "S1:strict");
});

test("St-use: an id segment resolving to its adapter is free; an `as` rename stays strict", () => {
  assert.equal(cs(pick(R("use crate::codex::run;\n"), "codex")), "St:free");
  assert.equal(cs(pick(R("use crate::{codex, claude::go};\n"), "claude")), "St:free");
  assert.equal(cs(pick(R("use crate::codex as fallback;\n"), "codex")), "S1:strict");
});

test("St-handler: generate_handler ids resolving to adapters are free; a non-adapter module is not", () => {
  const ok = R("fn main() { tauri::generate_handler![codex::go, claude::go]; }\n", "src-tauri/src/main.rs");
  assert.deepEqual(ok.filter((e) => e.tok === "codex" || e.tok === "claude").map(cs), ["St:free", "St:free"]);
  const bad = R("fn main() { tauri::generate_handler![claude::codex::go]; }\n", "src-tauri/src/main.rs");
  assert.equal(cs(pick(bad, "claude")), "St:free");
  assert.equal(cs(pick(bad, "codex")), "S1:strict");
});

test("St-sig: X:: in a signature is free; the same path in a body or an else stays strict", () => {
  const es = R("fn f(x: codex::Cfg) -> codex::Out { codex::run(); if a { 1 } else { codex::foo() } }\n");
  assert.deepEqual(es.filter((e) => e.tok === "codex").map(cs), ["St:free", "St:free", "S1:strict", "S1:strict"]);
});

test("St-arm: tokens naming only X inside a forced X arm are free; cross-id, nested _ and guards are not", () => {
  const ok = R('fn f(a: Agent) { match a { Agent::Codex => { let codex_home = 1; run("codex") } Agent::Claude => { run("claude") } } }\n');
  assert.deepEqual([pick(ok, "codex_home"), pick(ok, "codex")].map(cs), ["St:free", "St:free"]);
  assert.equal(cs(pick(ok, "claude")), "St:free");
  const cross = R('fn f(a: Agent) { match a { Agent::Codex => { run("claude") } Agent::Claude => {} } }\n');
  assert.equal(cs(pick(cross, "claude")), "S2:strict");
  const nested = R("fn f(a: Agent) { match a { Agent::Codex => { match m { 1 => 2, _ => codex } } Agent::Claude => {} } }\n");
  assert.equal(cs(pick(nested, "codex")), "S1:strict");
  const guard = R("fn f(a: Agent) { match a { Agent::Codex if ok => { codex } _ => {} } }\n");
  assert.equal(cs(pick(guard, "codex")), "S1:strict");
});

test("St-decl: a closed enum's variant declarations are free; a product if-let opens the enum", () => {
  const decl = "enum Mode { Claude, Codex }\n";
  const arms = "fn f(m: Mode) { match m { Mode::Claude => 1, Mode::Codex => 2 } }\n";
  const closed = att(scan([{ path: "src-tauri/src/generic.rs", src: decl + arms }], { all: ALL }));
  assert.deepEqual(closed.filter((e) => e.line === 1 && e.cls !== "none").map(cs), ["St:free", "St:free"]);
  assert.ok(enumsOf([{ path: "src-tauri/src/generic.rs", src: decl + arms }]).closed.has("Mode"));
  const planted = decl + arms + "fn g(m: Mode) { if let Mode::Codex = m {} }\n";
  const open = att(scan([{ path: "src-tauri/src/generic.rs", src: planted }], { all: ALL }));
  assert.deepEqual(open.filter((e) => e.line === 1).map(cs), ["S1:strict", "S1:strict"]);
  const en = enumsOf([{ path: "src-tauri/src/generic.rs", src: planted }]);
  assert.equal(en.closed.has("Mode"), false);
  assert.deepEqual(en.open, [{ name: "Mode", file: "src-tauri/src/generic.rs", line: 1 }]);
});

test("test tier by declaration: a cfg(test) mod hides its file, a plain mod keeps it", () => {
  const f = (src) => [{ path: "src-tauri/src/main.rs", src }];
  assert.deepEqual([...testDeclared(f("#[cfg(test)]\nmod bridge_golden;\n"), { all: ALL })], ["src-tauri/src/bridge_golden.rs"]);
  assert.deepEqual([...testDeclared(f("mod bridge_golden;\n"), { all: ALL })], []);
  assert.deepEqual([...testDeclared(f("#[cfg(test)]\nmod bridge_golden;\nmod bridge_golden;\n"), { all: ALL })], []);
});

test("static import resolving to its adapter is St; a dynamic import() string stays a literal", () => {
  const all = new Set(["src/x/codex.ts", "src/x/foo.ts"]);
  const T = (src) => att(scanTs([{ path: "src/x/foo.ts", src }], { all }));
  assert.equal(cs(pick(T('import { run } from "./codex";\n'), "./codex")), "St:free");
  assert.equal(cs(pick(T('const m = await import("./codex");\n'), "./codex")), "S2:strict");
});

const ADAPTER = "src-tauri/src/codex.rs";

test("Q2 (b): own-id C in an adapter is free in a condition, negated or fallback; cross-id C and own-id S2 are not", () => {
  const own = R("fn f() { if !codex_home.is_some() { 1 } else { codex_home } }\n", ADAPTER);
  assert.deepEqual(own.filter((e) => e.tok === "codex_home").map(cs), ["C:free", "C:free"]);
  const cross = R("fn f() { if claude_home.is_some() { 1 } }\n", ADAPTER);
  assert.equal(cs(pick(cross, "claude_home")), "C:strict");
  const s2 = R('fn f(agent: &str) { if agent != "codex" { 1 } }\n', ADAPTER);
  assert.equal(cs(pick(s2, "codex")), "S2:strict");
});

test("Q2 (a): prose is strict only as a direct comparison operand", () => {
  const errIn = 'fn f() { if !ok { return Err("Codex failed to start".into()); } }\n';
  assert.equal(cs(pick(R(errIn, ADAPTER), "Codex failed to start")), "C:free");
  // mutation: outside an adapter the same prose no longer counts as a condition key
  assert.equal(cs(pick(R(errIn), "Codex failed to start")), "C:cap");
  assert.equal(cs(pick(R('fn f() { if x.contains("Claude Code") { 1 } }\n'), "Claude Code")), "C:strict");
  assert.equal(cs(pick(R('fn f() { x.starts_with("Claude Code"); }\n'), "Claude Code")), "C:strict");
  assert.equal(cs(pick(R('fn f(s: &str) { match s { "Codex x" => 1, _ => 2 } }\n'), "Codex x")), "C:strict");
  assert.equal(cs(pick(R('fn f(s: &str) { if s == "Codex x" { 1 } }\n'), "Codex x")), "C:strict");
  assert.equal(cs(pick(R('fn f() { let a = format!("Codex x"); }\n'), "Codex x")), "C:cap");
});

test("Q2 (a): PowerShell, Python and TypeScript comparisons set the flag", () => {
  const ps = (src) => att(scanPs([{ path: "tools/release/x.ps1", src }], {}));
  assert.equal(cs(pick(ps('if ($x -eq "Codex is here") { 1 }\n'), "Codex is here")), "C:strict");
  assert.equal(cs(pick(ps('if ($ok) { Write-Host "Codex is here" }\n'), "Codex is here")), "C:cap");
  const py = (src) => att(scanPy([{ path: "content/foo/x.py", src }], {}));
  assert.equal(cs(pick(py('if x == "Codex is here":\n    pass\n'), "Codex is here")), "C:strict");
  assert.equal(cs(pick(py('print("Codex is here")\n'), "Codex is here")), "C:cap");
  const ts = (src) => att(scanTs([{ path: "src/x/foo.ts", src }], {}));
  assert.equal(cs(pick(ts('if (s.startsWith("Codex is here")) {}\n'), "Codex is here")), "C:strict");
  assert.equal(cs(pick(ts('if (a && log("Codex is here")) {}\n'), "Codex is here")), "C:cap");
});
