// Agent-key gate: the schema-3 lexical-key check over the repo, the inline AgentId union guard, and the Rust
// literal counter. The v1 literal ratchet (LITERALS, TABLE_USE, --init, --init-rust) is gone.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE, RUST_STRINGS, countRust, kindOfRust } from "../tools/agents/agent-literals.mjs";
import { DEFAULT_IDS, gather, idUnionProblems, strictOf, tierOf, useIds } from "../tools/agents/key-words.mjs";
import { scan as scanTs } from "../tools/agents/ts-keys.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CLI = join(HERE, "..", "tools", "agents", "agent-literals.mjs");

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));

test("lexical keys: caps, strict ratchet, pins, $enums, adapters and AgentId unions hold ($schema 3)", () => {
  assert.equal(fixture.$schema, 3);
  const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("strict identity keys hold at zero unpinned", () => {
  const r = spawnSync(process.execPath, [CLI, "--strict"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("harness files take the test tier's exclusion; the strict tool paths stay strict", () => {
  for (const f of ["tools/sandbox/anything.mjs", "tools/claude-sidecar-seed.mjs", "tools/x/foo-e2e.mjs", "tools/x/foo-smoke.ps1"]) {
    assert.equal(tierOf(f), "harness", f);
    assert.equal(strictOf({ tier: tierOf(f), cls: "S1", ids: [], ctx: {} }), "skip", f);
  }
  for (const f of ["tools/falcon/falcon-vidar-smoke.ps1", "tools/release/x-seed.mjs", "tools/lib/y-e2e.ps1"]) {
    assert.notEqual(tierOf(f), "harness", f);
    assert.notEqual(strictOf({ tier: tierOf(f), cls: "S1", ids: [], ctx: {} }), "skip", f);
  }
});

test("the removed v1 flags are refused", () => {
  for (const f of ["--init", "--init-rust"]) {
    const r = spawnSync(process.execPath, [CLI, f], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /removed with the v1 literal ratchet/);
  }
});

// ---- AgentId union guard (ported from TWO_UNION): only src/agents/id.ts spells the union inline ----

useIds(DEFAULT_IDS);
const [A, B] = DEFAULT_IDS.ids;
const U = (src, path = "src/x/foo.ts") => scanTs([{ path, src }], {}).map((e) => ({ ...e, strictness: strictOf(e) }));

test("an inline AgentId union outside id.ts is strict and a problem, in any order", () => {
  for (const src of [`type T = "${A}" | "${B}";\n`, `let x: '${B}' | '${A}';\n`]) {
    const es = U(src).filter((e) => e.ctx.idUnion);
    assert.equal(es.length, 2, src);
    assert.ok(es.every((e) => e.strictness === "strict"));
    assert.deepEqual(idUnionProblems(es), ["inline AgentId union src/x/foo.ts:1: alias AgentId from src/agents/id.ts"]);
  }
  const dev = U(`type T = "${A}" | "${B}";\n`, "tools/x/probe.mjs").filter((e) => e.ctx.idUnion);
  assert.ok(dev.length && dev.every((e) => e.strictness === "strict"), "a dev tool gets no cap for it");
});

test("a longer union, a one-member type and the table file are not the guard's", () => {
  assert.equal(U(`type T = "${A}" | "${B}" | "acme";\n`).filter((e) => e.ctx.idUnion).length, 0);
  assert.equal(U(`type T = "acme" | "${A}" | "${B}";\n`).filter((e) => e.ctx.idUnion).length, 0);
  assert.equal(U(`type T = "${A}" | "${A}";\n`).filter((e) => e.ctx.idUnion).length, 0);
  const table = U(`export type T = "${A}" | "${B}";\n`, "src/agents/id.ts");
  assert.ok(table.every((e) => e.strictness === "free"));
  assert.deepEqual(idUnionProblems(table), []);
});

test("no inline AgentId union in the repo's TypeScript outside id.ts", async () => {
  const g = await gather(ROOT, ["ts"]);
  assert.deepEqual(idUnionProblems(g.entries), [], "alias AgentId from src/agents/id.ts");
});

// ---- Rust literal counter ----

const K = (src, file = "src-tauri/src/x.rs") => countRust(src, file);

test("rust counter reads its strings and variants from the table", () => {
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  assert.deepEqual(RUST_STRINGS, [...DEFAULT_IDS.ids, ...DEFAULT_IDS.ptyOnly, ...DEFAULT_IDS.ids.map(cap)]);
});

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
  assert.deepEqual(K(`if a == Agent::Claude { } if b != Agent::Pi { } match x { Agent::Codex => 1 }`), {
    "Agent::Claude": 1, "Agent::Codex": 1, "== Agent::": 2,
  });
  assert.deepEqual(K(`use crate::Agent::{Claude, Codex}; use x::Agent as A; use x::Agent;`), { "use Agent": 2 });
  assert.deepEqual(K(`use crate::Agent::{Claude};`, "src-tauri/src/agent_spec.rs"), {});
});

test("rust test code is skipped: cfg(test) use, bodiless mod, mod body; tiers by path", () => {
  assert.deepEqual(K(`#[cfg(test)] use x::Agent::{Claude}; let s = "claude";`), { claude: 1 });
  assert.deepEqual(K(`#[cfg(test)]\n#[path = "claude"]\nmod x;\nlet s = "codex";`), { codex: 1 });
  assert.deepEqual(K(`#[cfg(test)] mod t { fn f() { let a = "claude"; if x { } let b = Agent::Codex; } }\nlet s = "pi";`), { pi: 1 });
  assert.deepEqual(K(`#[cfg(not(test))] fn f() { "claude" }`), { claude: 1 });
  assert.equal(kindOfRust("src-tauri/src/agent_spec.rs"), "table");
  assert.equal(kindOfRust("src-tauri/src/bare/codex_payload.rs"), "adapter");
  assert.equal(kindOfRust("src-falcon/src/codex/driver/a.rs"), "adapter");
  assert.equal(kindOfRust("src-tauri/src/pty.rs"), "debt");
});
