// Agent-literal ratchet: quoted agent ids and names in src may only fall in number.
// Lower the fixture with `node tools/agents/agent-literals.mjs --write`; never raise it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE, TABLE_FILES, TABLE_USE, TWO_UNION, checkRust, countRust, hasRustKeys, kindOfRust, lex, scan, scanRust,
} from "../tools/agents/agent-literals.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "agents", "agent-literals.mjs");

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
const scanned = scan();

// After `--rekey --yes` the fixture is $schema 3 (C caps, strict ratchet, anchored pins): the lexical-key gate below
// replaces the literal ratchet, which only reads the old shape.
const v3 = fixture.$schema === 3;

test("lexical keys: caps, strict ratchet, pins, $enums and adapters hold ($schema 3)", (t) => {
  if (!v3) return t.skip("fixture is not $schema 3 yet (Step R runs --rekey --yes)");
  const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("agent literals do not rise above the fixture", (t) => {
  if (v3) return t.skip("superseded by the lexical-key gate");
  const bad = [];
  for (const [file, { literals }] of scanned) {
    for (const [lit, n] of Object.entries(literals)) {
      const cap = fixture[file]?.literals?.[lit];
      if (cap === undefined) bad.push(`${file} ${JSON.stringify(lit)}: ${n} (new key)`);
      else if (n > cap) bad.push(`${file} ${JSON.stringify(lit)}: ${n} > ${cap}`);
    }
  }
  assert.deepEqual(bad, [], "route these through src/agents (AGENTS, AGENT_PROFILE, isAgentId) instead of a literal");
});

test("table-only lookups stay in table files", (t) => {
  if (v3) return t.skip("superseded by S4 keys in the lexical-key gate");
  const bad = [];
  for (const [file, { code }] of scanned) {
    if (!TABLE_FILES.has(file) && fixture[file]?.kind !== "table" && TABLE_USE.test(code)) bad.push(file);
  }
  assert.deepEqual(bad, [], "AGENTS.claude / AGENT_PROFILE.codex / AGENT_IDS[n] belong to table files; iterate the table");
});

test("no inline two-member claude/codex union outside id.ts", () => {
  const bad = [];
  for (const [file, { code }] of scanned) {
    if (file !== "src/agents/id.ts" && TWO_UNION.test(code)) bad.push(file);
  }
  assert.deepEqual(bad, [], "alias AgentId from src/agents/id.ts");
});

test("the scanner strips comments and finds each quote style", () => {
  const { strings } = lex(`// "claude"\n/* 'codex' */ const a = "claude"; const b = 'pi'; const c = \`Codex\`; const u = "https://x";`);
  assert.deepEqual(strings, ["claude", "pi", "Codex", "https://x"]);
});

// ---- Rust (D6) ----

test("rust literals do not rise above the fixture once .rs keys exist", (t) => {
  if (v3) return t.skip("superseded by the lexical-key gate");
  if (!hasRustKeys(fixture)) return t.skip("no .rs keys in the fixture yet (--init-rust runs after landing)");
  assert.deepEqual(checkRust(scanRust(), fixture), [], "route agents through agent_spec (parse/spec), not a literal");
});

const K = (src, file = "src-tauri/src/x.rs") => countRust(src, file);

test("rust lexer: raw strings, byte strings, lifetimes, chars, comments", () => {
  assert.deepEqual(K(`let a = r#"say "claude" now"#; let b = "x";`), {});
  assert.deepEqual(K(`let a = r#"x"#; let b = "claude";`), { claude: 1 });
  assert.deepEqual(K(`let a = b"codex"; let b = r"pi";`), { codex: 1, pi: 1 });
  assert.deepEqual(K(`fn f<'a>(x: &'a str) -> &'a str { let q = '"'; let e = '\\''; "Codex" }`), { Codex: 1 });
  assert.deepEqual(K(`let q = '"'; let s = "claude";`), { claude: 1 });
  assert.deepEqual(K(`/* a /* "claude" */ "codex" */ let s = "Claude"; // "pi"\n`), { Claude: 1 });
  assert.deepEqual(K(`let s = "a\\"claude\\"";`), {});
});

test("rust keys: variants, comparisons, use and rename", () => {
  assert.deepEqual(K(`if a == Agent::Claude { } if b != Agent::Gemini { } match x { Agent::Codex => 1 }`), {
    "Agent::Claude": 1, "Agent::Codex": 1, "== Agent::": 2,
  });
  assert.deepEqual(K(`use crate::Agent::{Claude, Codex}; use x::Agent as A; use x::Agent;`), { "use Agent": 2 });
  assert.deepEqual(K(`use crate::Agent::{Claude};`, "src-tauri/src/agent_spec.rs"), {});
});

test("rust test code is skipped: tests.rs, cfg(test) use, bodiless mod, mod body", () => {
  assert.deepEqual(K(`#[cfg(test)] use x::Agent::{Claude}; let s = "claude";`), { claude: 1 });
  assert.deepEqual(K(`#[cfg(test)]\n#[path = "claude"]\nmod x;\nlet s = "codex";`), { codex: 1 });
  assert.deepEqual(K(`#[cfg(test)] mod t { fn f() { let a = "claude"; if x { } let b = Agent::Codex; } }\nlet s = "pi";`), { pi: 1 });
  assert.deepEqual(K(`#[cfg(not(test))] fn f() { "claude" }`), { claude: 1 });
  assert.equal(kindOfRust("src-tauri/src/agent_spec.rs"), "table");
  assert.equal(kindOfRust("src-tauri/src/bare/codex_payload.rs"), "adapter");
  assert.equal(kindOfRust("src-falcon/src/codex/driver/a.rs"), "adapter");
  assert.equal(kindOfRust("src-tauri/src/pty.rs"), "debt");
});

function tempTree(files) {
  const dir = mkdtempSync(join(tmpdir(), "agent-lit-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function run(dir, ...flags) {
  const fixture = join(dir, "fx.json");
  return spawnSync(process.execPath, [CLI, ...flags], {
    encoding: "utf8",
    env: { ...process.env, AGENT_LITERALS_ROOT: dir, AGENT_LITERALS_FIXTURE: fixture },
  });
}

test("--init-rust writes keys, refuses a second run; rises fail, drops pass", () => {
  const dir = tempTree({
    "src/a.ts": `export const a = 1;\n`,
    "src-tauri/src/pty.rs": `fn f() { let a = "claude"; let b = "codex"; }\n`,
    "src-tauri/src/agent_spec.rs": `const A: &str = "claude";\n`,
    "src-tauri/src/pty_tests.rs": `fn t() { "claude" }\n`,
  });
  try {
    writeFileSync(join(dir, "fx.json"), "{}\n");
    // dormant: no .rs keys, passes with the Rust literals present
    assert.equal(run(dir).status, 0);
    assert.equal(run(dir, "--init-rust", "--dry").status, 0);
    assert.equal(readFileSync(join(dir, "fx.json"), "utf8"), "{}\n");
    assert.equal(run(dir, "--init-rust").status, 0);
    const fx = JSON.parse(readFileSync(join(dir, "fx.json"), "utf8"));
    assert.deepEqual(Object.keys(fx), ["src-tauri/src/pty.rs"]);
    assert.deepEqual(fx["src-tauri/src/pty.rs"], { kind: "debt", literals: { claude: 1, codex: 1 } });
    const again = run(dir, "--init-rust");
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already exist/);
    assert.equal(run(dir).status, 0);
    // rise on an existing key, then a new key, then a new file: all fail
    writeFileSync(join(dir, "src-tauri/src/pty.rs"), `fn f() { "claude"; "claude"; "codex"; }\n`);
    assert.equal(run(dir).status, 1);
    writeFileSync(join(dir, "src-tauri/src/pty.rs"), `fn f() { "claude"; "codex"; "pi"; }\n`);
    assert.equal(run(dir).status, 1);
    writeFileSync(join(dir, "src-tauri/src/pty.rs"), `fn f() { "claude"; "codex"; }\n`);
    writeFileSync(join(dir, "src-tauri/src/new.rs"), `fn g() { Agent::Codex }\n`);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    assert.equal(run(dir).status, 1);
    execFileSync("git", ["rm", "-qf", "src-tauri/src/new.rs"], { cwd: dir });
    // a drop passes and --write lowers it
    writeFileSync(join(dir, "src-tauri/src/pty.rs"), `fn f() { "claude"; }\n`);
    assert.equal(run(dir).status, 0);
    assert.equal(run(dir, "--write").status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "fx.json"), "utf8"))["src-tauri/src/pty.rs"].literals, { claude: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the union and table patterns match what they should and no more", () => {
  assert.ok(TWO_UNION.test(`x: "claude" | "codex"`));
  assert.ok(TWO_UNION.test(`x: 'codex' | 'claude';`));
  assert.ok(!TWO_UNION.test(`x: "claude" | "codex" | "gemini"`));
  assert.ok(!TWO_UNION.test(`x: "gemini" | "claude" | "codex"`));
  assert.ok(TABLE_USE.test(`AGENTS.codex.label`));
  assert.ok(TABLE_USE.test(`AGENT_IDS[0]`));
  assert.ok(!TABLE_USE.test(`AGENTS[id].label`));
});
