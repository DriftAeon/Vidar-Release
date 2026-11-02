import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareSites, forcedOutside, initFixture, parseRustErrors, parseTsErrors, validateFixture } from "../tools/agents/third-agent-check.mjs";

test("TypeScript errors map to the Record literal and never-closing switch", () => {
  const file = "src/example.ts";
  const src = [
    "type AgentId = 'claude' | 'codex' | 'grok';",
    "declare function unknownAgent(a: never): never;",
    "const rows: Record<AgentId, number> = {",
    "  claude: 1, codex: 2,",
    "};",
    "function label(a: AgentId) {",
    "  switch (a) {",
    "    case 'claude': return 'Claude';",
    "    case 'codex': return 'Codex';",
    "    default: return unknownAgent(a);",
    "  }",
    "}",
  ].join("\n");
  const output = `${file}(3,39): error TS2741: Property 'grok' is missing in type.\n${file}(10,34): error TS2345: Argument of type 'grok' is not assignable to parameter of type 'never'.`;
  const got = parseTsErrors(output, () => src);
  assert.deepEqual(got.other, []);
  assert.deepEqual(got.sites, [
    { file, anchor: "3:39", lines: [3, 5], kind: "ts-record" },
    { file, anchor: "7:3", lines: [7, 11], kind: "ts-switch" },
  ]);
  assert.deepEqual(compareSites(got.sites.slice(0, 1), got.sites), { missing: [], extra: got.sites.slice(1) });
});

test("TS2741 at a Record declaration name maps to the object literal", () => {
  const file = "src/example.ts";
  const src = [
    "export const ROWS: Readonly<Record<AgentId, () => void>> = {",
    "  claude: () => {},",
    "};",
    "const other: Map<string, number> = { a: 1 };",
    "const MAPPED: { [A in AgentId]: (n: number) => void } = {",
    "  claude: () => {},",
    "};",
    "const SAT = {",
    "  claude: 1,",
    "} satisfies Record<AgentId, number>;",
  ].join("\n");
  const at = (r, c) => `${file}(${r},${c}): error TS2741: Property 'grok' is missing.`;
  const got = parseTsErrors([at(1, 14), at(4, 7), at(5, 7), at(10, 3)].join("\n"), () => src);
  assert.deepEqual(got.sites, [
    { file, anchor: "1:60", lines: [1, 3], kind: "ts-record" },
    { file, anchor: "5:57", lines: [5, 7], kind: "ts-record" },
    { file, anchor: "8:13", lines: [8, 10], kind: "ts-record" },
  ]);
  assert.equal(got.other.length, 1);
});

test("a regex literal with a quote does not unbalance the block scan", () => {
  const file = "src/example.ts";
  const src = ["const re = /['\"]?x/;", "const T: Record<AgentId, { a: boolean; b: boolean }> = {", "  claude: 1,", "};", "const S = {", "  claude: 1,", "} satisfies Record<AgentId, number>;"].join("\n");
  const at = (r, c) => `${file}(${r},${c}): error TS2741: Property 'grok' is missing.`;
  const got = parseTsErrors([at(2, 7), at(7, 3)].join("\n"), () => src);
  assert.deepEqual(got.other, []);
  assert.deepEqual(got.sites.map((s) => s.lines), [[2, 4], [5, 7]]);
});

test("rustc E0004 maps to the match and other errors are reported", () => {
  const file = "src-tauri/src/example.rs";
  const src = "fn label(a: Agent) {\n    match a {\n        Agent::Claude => (),\n        Agent::Codex => (),\n    }\n}";
  const diagnostic = (code, message) => JSON.stringify({ reason: "compiler-message", message: { level: "error", code: { code }, message, spans: [{ file_name: "src/example.rs", line_start: 2, is_primary: true }] } });
  const got = parseRustErrors(`${diagnostic("E0004", "non-exhaustive patterns")}\n${diagnostic("E0308", "mismatched types")}`, (f) => { assert.equal(f, file); return src; }, "src-tauri");
  assert.deepEqual(got.sites, [{ file, lines: [2, 5], kind: "rust-match" }]);
  assert.deepEqual(got.other, ["E0308: mismatched types"]);
});

test("forced scanner key outside every compiler error site fails subset check", () => {
  const entries = [{ file: "src/a.ts", line: 4, lang: "ts", forced: true }, { file: "src/a.ts", line: 9, lang: "ts", forced: true }];
  const sites = [{ file: "src/a.ts", anchor: "3:20", lines: [3, 5], kind: "ts-record" }];
  assert.deepEqual(forcedOutside(entries, sites), [entries[1]]);
});

test("init without yes prints a diff and leaves the fixture untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "third-agent-test-"));
  try {
    const path = join(dir, "fixture.json"), old = { files: ["src/a.ts"] };
    writeFileSync(path, `${JSON.stringify(old)}\n`);
    const diff = initFixture(path, old, [{ file: "src/a.ts", anchor: "1:1", lines: [1, 2], kind: "ts-record" }]);
    assert.match(diff, /\+  "sites"/);
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(old)}\n`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dry validates the current fixture and available scanner imports", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/third-agent-tables.json", import.meta.url), "utf8"));
  assert.ok(validateFixture(fixture, true));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../tools/agents/third-agent-check.mjs", import.meta.url)), "--dry"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /third-agent dry: ok/);
});
