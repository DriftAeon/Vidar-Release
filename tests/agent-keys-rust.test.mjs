// Lexical agent keys: key-words.mjs vocabulary, rust-keys.mjs scanner, anchored pins
// and the schema-3 CLI paths. Every test feeds a small inline source; nothing here reads the repo's own fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anchor, applyPins, classOf, strictOf, tierOf, useIds, words, DEFAULT_IDS } from "../tools/agents/key-words.mjs";
import { enumsOf, lex, scan } from "../tools/agents/rust-keys.mjs";

useIds(DEFAULT_IDS);
const CLI = fileURLToPath(new URL("../tools/agents/agent-literals.mjs", import.meta.url));
const ENUMS = new Map([["Agent", ["Claude", "Codex"]], ["AgentDriver", ["Claude", "Codex"]]]);

/** Scan one inline source the way gather() does (strictness attached). */
const K = (src, path = "src-tauri/src/x.rs") => scan([{ path, src }], { enums: ENUMS }).map((e) => ({ ...e, strictness: strictOf(e) }));
const row = (e) => `${e.tok}:${e.cls}:${e.strictness}`;
const find = (es, tok, nth = 0) => es.filter((e) => e.tok === tok)[nth];

test("words: camelCase, ACRONYMWord, all-caps id prefix, letter/digit", () => {
  assert.deepEqual(words("RulesPrepared"), ["rules", "prepared"]);
  assert.deepEqual(words("CodexHome"), ["codex", "home"]);
  assert.deepEqual(words("CLAUDECODE"), ["claude", "code"]);
  assert.deepEqual(words("CLAUDE_CODE_ENTRYPOINT"), ["claude", "code", "entrypoint"]);
  assert.deepEqual(words("XMLHttpClaude"), ["xml", "http", "claude"]);
  assert.deepEqual(words("claude3"), ["claude", "3"]);
  assert.deepEqual(words("PIPE"), ["pipe"]);
});

test("classOf: identity, literal, id-file, positional, forced, C", () => {
  assert.equal(classOf("codex", { kind: "ident" }), "S1");
  assert.equal(classOf("codex_home", { kind: "ident" }), "C");
  assert.equal(classOf("codex", { kind: "literal" }), "S2");
  assert.equal(classOf("claude-p", { kind: "literal" }), "S2");
  assert.equal(classOf("x/claude", { kind: "literal" }), "S2");
  assert.equal(classOf("claude.local.md", { kind: "literal" }), "S3");
  assert.equal(classOf("codex.config.template.toml", { kind: "literal" }), "S3");
  assert.equal(classOf(".codex", { kind: "literal" }), "S3");
  assert.equal(classOf("CLAUDE.md", { kind: "literal" }), "S3");
  assert.equal(classOf("Claude Code", { kind: "literal" }), "C");
  assert.equal(classOf("CLAUDECODE", { kind: "literal" }), "C");
  assert.equal(classOf("hello", { kind: "literal" }), "none");
  assert.equal(classOf("-(claude|codex)$", { kind: "regex" }), "S2");
  assert.equal(classOf("AGENT_IDS[0]", { kind: "positional" }), "S4");
  assert.equal(classOf("Codex", { kind: "ident", forcedArm: true }), "F");
  assert.equal(classOf("Codex", { kind: "ident", forcedArm: true, mergesNone: true }), "S1");
});

test("tierOf: table, adapter, test, harness, devtool, other", () => {
  assert.equal(tierOf("src-tauri/src/agent_spec.rs"), "table");
  assert.equal(tierOf("tools/lib/FalconRuntimes.ps1"), "table");
  assert.equal(tierOf("src-tauri/src/codex_config.rs"), "adapter:codex");
  assert.equal(tierOf("src-falcon/src/codex/driver/approvals.rs"), "adapter:codex");
  assert.equal(tierOf("src-tauri/src/bare/claude_codex_both.rs"), "other");
  assert.equal(tierOf("src-tauri/src/pty.rs"), "other");
  assert.equal(tierOf("src-tauri/src/pty_tests.rs"), "test");
  assert.equal(tierOf("tests/agent-literals.test.mjs"), "test");
  assert.equal(tierOf("content/x/test_speak.py"), "test");
  assert.equal(tierOf("tools/sandbox/card-sandbox.ps1"), "harness");
  assert.equal(tierOf("tools/sandbox/write-audit.ps1"), "other");
  assert.equal(tierOf("tools/foo/run-smoke.mjs"), "harness");
  assert.equal(tierOf("tools/bare/probe-seed-data.mjs"), "harness");
  assert.equal(tierOf("tools/claude-sidecar-seed.mjs"), "adapter:claude");
  assert.equal(tierOf("tools/bare/sweep.mjs"), "devtool");
  assert.equal(tierOf("tools/bare/codex-hook-probe.mjs"), "devtool");
  assert.equal(tierOf("tools/claude-sidecar.mjs"), "adapter:claude");
  assert.equal(tierOf("tools/release/swap.ps1"), "other");
  assert.equal(tierOf("tools/gate/gate.mjs"), "other");
});

test("rust lexer: raw and byte strings, chars vs lifetimes, comments, attribute strings", () => {
  const vals = (s) => lex(s).filter((t) => t.t === "str").map((t) => t.v);
  assert.deepEqual(vals(`let a = r#"say "claude" now"#; let b = br"codex"; let c = b"pi";`), [`say "claude" now`, "codex", "pi"]);
  assert.deepEqual(vals(`fn f<'a>(x: &'a str) { let q = '"'; let e = '\\''; "Codex" }`), ["Codex"]);
  assert.deepEqual(vals(`/* a /* "claude" */ "codex" */ // "pi"\n/// "claude"\nlet s = "Claude";`), ["Claude"]);
  assert.deepEqual(vals(`let s = "a\\"claude\\"";`), [`a\\"claude\\"`]);
  assert.equal(lex(`a\n\nb "x"`).at(-1).line, 3);
  assert.deepEqual(K(`#[serde(rename = "claude")]\nstruct S;`).map(row), ["claude:S2:strict"]);
  assert.deepEqual(K(`let a = r#"x "claude" y"#; let b = r"claude";`).map(row), ["x \"claude\" y:C:cap", "claude:S2:strict"]);
});

test("cfg: test-positive items are skipped, cfg(not(test)) is product (R5)", () => {
  const toks = (s) => K(s).map((e) => e.tok);
  assert.deepEqual(toks(`#[cfg(test)] mod t { fn f() { "claude"; } }\nfn g() { "codex"; }`), ["codex"]);
  assert.deepEqual(toks(`#[cfg(all(test, feature = "x"))] fn f() { "claude"; }\nfn g() { "codex"; }`), ["codex"]);
  assert.deepEqual(toks(`#[cfg(not(test))] fn f() { "claude"; }`), ["claude"]);
  assert.deepEqual(toks(`#[cfg(any(test, unix))] fn f() { "claude"; }`), ["claude"]);
  assert.deepEqual(toks(`#[test]\n#[ignore]\nfn t() { "claude"; }\nfn g() { "codex"; }`), ["codex"]);
  assert.deepEqual(toks(`#[cfg(test)] use x::{A, B}; let s = "claude";`), ["claude"]);
});

test("forms: let-else, map_or, if/else variant, Self::, path segment, exact-id field", () => {
  let es = K(`fn f(a: Option<Agent>) { let Agent::Claude = a else { return }; }`);
  assert.deepEqual(es.map(row), ["Claude:S1:strict"]);
  es = K(`fn f(o: Option<u8>) { let a = o.map_or(Agent::Claude, |x| other(x)); }`);
  assert.equal(es[0].cls, "S1");
  assert.equal(es[0].ctx.fallbackArm, true);
  es = K(`fn f(c: bool) -> Agent { if c { Agent::Claude } else { Agent::Codex } }`);
  assert.deepEqual(es.map(row), ["Claude:S1:strict", "Codex:S1:strict"]);
  assert.equal(find(es, "Codex").ctx.fallbackArm, true);
  es = K(`impl Agent { fn k(self) -> u8 { match self { Self::Claude => 1, Self::Codex => 2 } } }`);
  assert.deepEqual(es.map(row), ["Claude:F:free", "Codex:F:free"]);
  assert.match(es[0].anchor, /^Agent::k: /);
  es = K(`fn f() { let a = super::claude::agent(); }`);
  assert.deepEqual(es.map(row), ["claude:S1:strict"]);
  es = K(`fn f() -> RulesPrepared { RulesPrepared { codex } }`);
  assert.deepEqual(es.map(row), ["codex:S1:strict"]);
  es = K(`fn f() { let a = AGENT_IDS[0]; let b = Agent::ALL[1]; }`);
  assert.deepEqual(es.map(row), ["AGENT_IDS[0]:S4:strict", "Agent::ALL[1]:S4:strict"]);
});

test("match: forced arms, guard split, wild and binding catch-all, None merge", () => {
  let es = K(`fn f(a: Agent) { match a { Agent::Claude => 1, Agent::Codex => 2 } }`);
  assert.deepEqual(es.map(row), ["Claude:F:free", "Codex:F:free"]);
  es = K(`fn f(a: Agent) { match a { Agent::Codex if x() => 1, Agent::Codex => 2, Agent::Claude => 3 } }`);
  assert.deepEqual(es.map(row), ["Codex:S1:strict", "Codex:F:free", "Claude:F:free"]);
  es = K(`fn f(a: Agent) { match a { Agent::Claude => 1, _ => 2 } }`);
  assert.deepEqual(es.map(row), ["Claude:S1:strict"]);
  es = K(`fn f(a: Agent) { match a { Agent::Claude | Agent::Codex => 1, other => g(other) } }`);
  assert.deepEqual(es.map(row), ["Claude:S1:strict", "Codex:S1:strict"]);
  es = K(`fn f(a: Option<Agent>) { match a { Some(Agent::Codex) | None => 1, Some(Agent::Claude) => 2 } }`);
  assert.ok(es.every((e) => e.cls === "S1"));
  es = K(`fn f(a: Agent) { match a { Agent::Codex(x) => 1, Agent::Claude { .. } => 2 } }`);
  assert.deepEqual(es.map(row), ["Codex:F:free", "Claude:F:free"]);
});

test("adapter tier: own-id free, strict on _ arm (R1), None merge (R3), foreign id", () => {
  const A = "src-tauri/src/codex_models.rs";
  assert.deepEqual(K(`fn f() { let a = Agent::Codex; }`, A).map(row), ["Codex:S1:free"]);
  assert.deepEqual(K(`fn f() { let a = Agent::Claude; }`, A).map(row), ["Claude:S1:strict"]);
  assert.deepEqual(K(`fn f(a: Agent) { match a { Agent::Codex => 1, _ => 2 } }`, A).map(row), ["Codex:S1:strict"]);
  assert.deepEqual(K(`fn f(a: Option<Agent>) { match a { Some(Agent::Codex) | None => 1, _ => 2 } }`, A).map(row), ["Codex:S1:strict"]);
  assert.equal(K(`fn f(a: Option<Agent>) { match a { Some(Agent::Codex) | None => 1, Some(Agent::Claude) => 2 } }`, A)[0].ctx.mergesNone, true);
  assert.deepEqual(K(`fn f(a: Agent) -> bool { a != Agent::Codex }`, A).map(row), ["Codex:S1:strict"]);
  assert.deepEqual(K(`fn f(a: Agent) { let b = a.unwrap_or(Agent::Codex); }`, A).map(row), ["Codex:S1:strict"]);
  assert.deepEqual(K(`fn f(a: Agent) { match a { Agent::Codex => 1, Agent::Claude => 2 } }`, A).map(row), ["Codex:F:free", "Claude:F:free"]);
});

test("C keys: condition position is strict (R2), compounds are capped", () => {
  assert.deepEqual(K(`fn f(s: S) { if s.codex_home.is_some() { g(); } }`).map(row), ["codex_home:C:strict"]);
  assert.deepEqual(K(`fn f(s: S) -> bool { s.ok && s.codex_home.is_none() }`).map(row), ["codex_home:C:strict"]);
  assert.deepEqual(K(`fn f(s: S) -> bool { matches!(s.is_codex, true) }`).map(row), ["is_codex:C:strict"]);
  assert.deepEqual(K(`fn f(s: S) { let h = s.codex_home; }`).map(row), ["codex_home:C:cap"]);
  assert.deepEqual(K(`fn f(s: S) { let h = s.codex_home; }`, "tools/x/y.rs").map(row), ["codex_home:C:cap"]);
  assert.deepEqual(K(`const E: &str = "CLAUDECODE";`).map(row), ["CLAUDECODE:C:cap"]);
  assert.deepEqual(K(`const E: &str = "claude.local.md";`).map(row), ["claude.local.md:S3:strict"]);
});

test("table span: protocol.rs enum Agent and impl Agent only", () => {
  const src = `pub enum Agent { Claude, Codex }\nimpl Agent { fn s(self) -> &'static str { match self { Self::Claude => "claude", Self::Codex => "codex" } } }\nfn other() { let a = "claude"; }`;
  const tiers = K(src, "src-falcon/src/protocol.rs").map((e) => `${e.tok}:${e.tier}`);
  assert.deepEqual(tiers, ["Claude:table", "Codex:table", "Claude:table", "claude:table", "Codex:table", "codex:table", "claude:other"]);
});

test("enumsOf lists enums with an id-named variant", () => {
  const m = enumsOf([{ path: "a.rs", src: `enum A { Claude, Codex(u8), Other }\nenum B { X, Y }\n#[cfg(test)] enum T { Claude }\nenum C { #[doc = "x"] ClaudeCode, Z }` }]);
  assert.deepEqual([...m.keys()], ["A"]);
  assert.deepEqual(m.get("A"), ["Claude", "Codex", "Other"]);
});

const SRC = `fn pick(a: u8) {\n    let x = Agent::Claude;\n}\n`;
const pinOf = (e) => ({ file: e.file, anchor: e.anchor, n: e.n, why: "dev-probe" });

test("pins: anchor survives a line shift and a reindent, fails on a swapped site", () => {
  const e0 = K(SRC)[0];
  const pins = [pinOf(e0)];
  const shifted = K(`// moved\n\n\nfn pick(a: u8) {\n\t\tlet x   =   Agent::Claude ;\n}\n`);
  assert.equal(shifted[0].line, 5);
  assert.deepEqual(applyPins(shifted, pins, ["rs"]), { unpinned: [], problems: [] });
  const swapped = applyPins(K(`fn pick(a: u8) {\n    let x = Agent::Codex;\n}\n`), pins, ["rs"]);
  assert.equal(swapped.unpinned.length, 1);
  assert.match(swapped.problems[0], /^dead pin/);
  assert.match(anchor(["a", "b", "c", "d", "e", "f", "g", "h"], 4, "fn"), /^fn: b c d e f g h$/);
});

test("pins: dead pin and n mismatch fail; blank-is-claude without a test is refused", () => {
  const body = (k) => `fn p() { ${"a(Agent::Claude); ".repeat(k)}b(); }`;
  const two = K(body(3));
  assert.equal(two[0].n, 2);
  const pin = pinOf(two[0]);
  assert.deepEqual(applyPins(two, [pin], ["rs"]).problems, []);
  assert.match(applyPins(K(body(4)), [pin], ["rs"]).problems[0], /n is 3, pinned 2/);
  assert.match(applyPins(K(`fn q() {}`), [pin], ["rs"]).problems[0], /^dead pin/);
  assert.match(applyPins(two, [{ ...pin, why: "blank-is-claude" }], ["rs"]).problems[0], /needs --test/);
  assert.match(applyPins(two, [{ ...pin, why: "seed-data" }], ["rs"]).problems[0], /why must be one of/);
  assert.deepEqual(applyPins(two, [{ ...pin, why: "history-data", test: "history_roundtrip" }], ["rs"]).problems, []);
});

// ---- CLI ----

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "agent-keys-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  git("init", "-q");
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  git("add", "-A");
  git("commit", "-qm", "base");
  return { dir, git };
}
const cli = (dir, ...flags) => spawnSync(process.execPath, [CLI, ...flags], { encoding: "utf8", env: { ...process.env, AGENT_LITERALS_ROOT: dir, AGENT_LITERALS_FIXTURE: join(dir, "fx.json") } });
const FX3 = { $schema: 3, $ids: ["claude", "codex", "gemini", "pi"], $enums: [], $adapters: [], $strict: {} };
const withTree = (files, fn) => { const t = tree(files); try { fn(t); } finally { rmSync(t.dir, { recursive: true, force: true }); } };

test("cli: --lang loads present scanners and names the missing ones", () => {
  withTree({ "src-tauri/src/a.rs": `fn f() { let a = Agent::Claude; }\n` }, ({ dir }) => {
    const r = cli(dir, "--report", "--lang", "rs,ts,ps,py");
    assert.equal(r.status, 0);
    for (const l of ["ts", "ps", "py"]) {
      const missing = new RegExp(`missing scanner: ${l}`);
      if (existsSync(join(dirname(CLI), `${l}-keys.mjs`))) assert.doesNotMatch(r.stdout, missing);
      else assert.match(r.stdout, missing);
    }
    assert.match(r.stdout, /rs: 1 files, 1 keys, 1 unpinned strict/);
    assert.match(cli(dir, "--report", "--tiers", "--lang", "rs").stdout, /other\s+files\s+1 keys\s+1/);
    assert.match(cli(dir, "--report", "--files", "src-tauri/src/a.rs", "--lang", "rs").stdout, /a\.rs:1\tS1\tstrict\tClaude/);
  });
});

test("cli: mutation, a planted matches!(d, AgentDriver::Codex(..)) is an unpinned strict key; --pin clears it", () => {
  withTree({ "src-tauri/src/y.rs": `fn f(d: D) -> bool { matches!(d, AgentDriver::Codex(..)) }\n` }, ({ dir }) => {
    let r = cli(dir, "--strict-dry", "--lang", "rs");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /y\.rs:1 S1 Codex/);
    assert.equal(cli(dir, "--pin", "src-tauri/src/y.rs:1", "--why", "blank-is-claude", "--lang", "rs").status, 2);
    assert.equal(cli(dir, "--pin", "src-tauri/src/y.rs:1", "--why", "bogus", "--lang", "rs").status, 2);
    assert.equal(cli(dir, "--pin", "src-tauri/src/y.rs:1", "--why", "dev-probe", "--lang", "rs").status, 0);
    const pins = JSON.parse(readFileSync(join(dir, "agent-pins.json"), "utf8")).pins;
    assert.equal(pins.length, 1);
    assert.equal(pins[0].n, 1);
    r = cli(dir, "--strict-dry", "--lang", "rs");
    assert.equal(r.status, 0);
  });
});

test("cli: --owns needs each strict-hit file owned by exactly one lane", () => {
  withTree({ "src-tauri/src/a.rs": `fn f() { Agent::Claude; }\n`, "src-tauri/src/b.rs": `fn f() { Agent::Codex; }\n` }, ({ dir }) => {
    writeFileSync(join(dir, "owns.json"), JSON.stringify({ e1: ["src-tauri/src/a.rs"], e2: ["src-tauri/src/*.rs"] }));
    const r = cli(dir, "--owns", join(dir, "owns.json"), "--lang", "rs");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /a\.rs: owned by e1, e2/);
    writeFileSync(join(dir, "owns.json"), JSON.stringify({ e1: ["src-tauri/src/a.rs"], e2: ["src-tauri/src/b.rs"] }));
    assert.equal(cli(dir, "--owns", join(dir, "owns.json"), "--lang", "rs").status, 0);
  });
});

test("cli: $ keys are skipped by readers and kept by --write (old fixture)", () => {
  withTree({ "src/a.ts": `export const a = 1;\n` }, ({ dir }) => {
    const fx = { $note: { x: 1 }, "src/a.ts": { kind: "debt", literals: { claude: 2 } } };
    writeFileSync(join(dir, "fx.json"), JSON.stringify(fx));
    assert.equal(cli(dir).status, 0);
    assert.equal(cli(dir, "--write").status, 0);
    const after = JSON.parse(readFileSync(join(dir, "fx.json"), "utf8"));
    assert.deepEqual(after.$note, { x: 1 });
    assert.equal(after["src/a.ts"], undefined);
  });
});

test("cli: --write refuses a C cap rise without --reason, records it with one", () => {
  const src = `fn f(s: S) { let a = s.codex_home; let b = s.codex_home; }\n`;
  withTree({ "src-tauri/src/a.rs": src }, ({ dir }) => {
    const fx = { ...FX3, "src-tauri/src/a.rs": { tier: "other", caps: { codex: 1 } } };
    writeFileSync(join(dir, "fx.json"), JSON.stringify(fx));
    assert.equal(cli(dir, "--lang", "rs").status, 1, "default run fails on the rise");
    const refused = cli(dir, "--write", "--lang", "rs");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /cap rise .* codex: 2 > 1 needs --reason/);
    assert.equal(JSON.parse(readFileSync(join(dir, "fx.json"), "utf8"))["src-tauri/src/a.rs"].caps.codex, 1);
    assert.equal(cli(dir, "--write", "--lang", "rs", "--reason", "second site is the mirror read").status, 0);
    const e = JSON.parse(readFileSync(join(dir, "fx.json"), "utf8"))["src-tauri/src/a.rs"];
    assert.equal(e.caps.codex, 2);
    assert.equal(e.reasons.codex, "second site is the mirror read");
    assert.equal(cli(dir, "--lang", "rs").status, 0);
    writeFileSync(join(dir, "src-tauri/src/a.rs"), `fn f(s: S) { let a = s.codex_home; }\n`);
    assert.equal(cli(dir, "--write", "--lang", "rs").status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "fx.json"), "utf8"))["src-tauri/src/a.rs"].caps.codex, 1, "a cap falls without a reason");
  });
});

test("cli: schema 3 default run checks $enums, new adapters and strict growth", () => {
  withTree({ "src-tauri/src/a.rs": `enum E { Claude }\nfn f() { let x = Agent::Claude; }\n`, "src-tauri/src/codex_x.rs": `fn g() {}\n` }, ({ dir }) => {
    const fx = { ...FX3, $enums: ["E"], $adapters: ["src-tauri/src/codex_x.rs"], $strict: { "src-tauri/src/a.rs": 2 } };
    writeFileSync(join(dir, "fx.json"), JSON.stringify(fx));
    assert.equal(cli(dir, "--lang", "rs").status, 0);
    assert.equal(cli(dir, "--lang", "rs", "--strict").status, 1);
    writeFileSync(join(dir, "fx.json"), JSON.stringify({ ...fx, $enums: [] }));
    assert.match(cli(dir, "--lang", "rs").stderr, /\$enums drift/);
    writeFileSync(join(dir, "fx.json"), JSON.stringify({ ...fx, $adapters: [] }));
    assert.match(cli(dir, "--lang", "rs").stderr, /new adapter path src-tauri\/src\/codex_x\.rs/);
    writeFileSync(join(dir, "fx.json"), JSON.stringify({ ...fx, $strict: { "src-tauri/src/a.rs": 1 } }));
    assert.match(cli(dir, "--lang", "rs").stderr, /strict rise/);
  });
});

test("cli: --rekey is a dry run, refuses on a $schema 3 marker, and --yes needs every scanner and a clean tree", () => {
  withTree({ "src-tauri/src/a.rs": `fn f() { let x = Agent::Claude; }\n`, "fx.json": `{}\n` }, ({ dir }) => {
    const dry = cli(dir, "--rekey", "--lang", "rs");
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /dry run/);
    assert.equal(readFileSync(join(dir, "fx.json"), "utf8"), "{}\n");
    const clean = cli(dir, "--rekey", "--yes", "--lang", "rs");
    assert.equal(clean.status, 2);
    assert.match(clean.stderr, /needs every scanner \(missing: ts, ps, py\)/);
    writeFileSync(join(dir, "src-tauri/src/a.rs"), `fn f() { let x = Agent::Codex; }\n`);
    const dirty = cli(dir, "--rekey", "--yes", "--lang", "rs");
    assert.equal(dirty.status, 2);
    assert.match(dirty.stderr, /clean tree[\s\S]*src-tauri\/src\/a\.rs/);
    assert.equal(readFileSync(join(dir, "fx.json"), "utf8"), "{}\n");
  });
  withTree({ "src-tauri/src/a.rs": `fn f() {}\n`, "fx.json": JSON.stringify(FX3) }, ({ dir }) => {
    const r = cli(dir, "--rekey", "--lang", "rs");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /already \$schema 3/);
  });
});
