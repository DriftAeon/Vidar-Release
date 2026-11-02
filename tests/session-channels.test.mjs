// Session-channels contract (contracts/session-channels.json): every channel Vidar writes into an
// agent session names its carrier (a rune kind or plumbing) and the code that writes it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const rows = JSON.parse(read("contracts/session-channels.json")).channels;

const rune = read("src-tauri/src/rules/rune.rs");
const itemKinds = [...rune.match(/pub const ITEM_KINDS: \[&str; \d+\] = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const kindsBody = rune.match(/pub const KINDS: \[\(&str, &str\); \d+\] = \[([\s\S]*?)\n\];/)[1];
const kinds = [...kindsBody.matchAll(/\("[^"]+",\s*"([^"]+)"\)/g)].map((m) => m[1]);
const KEYS = ["env", "built-in", "ctl"];
const AGENTS = ["claude", "codex"];

test("the Rust kind consts parse", () => {
  assert.ok(itemKinds.length > 0 && kinds.length > 0);
  for (const k of itemKinds) assert.ok(kinds.includes(k), `${k} is an item kind but not in KINDS`);
});

test("every carrier is plumbing or a Rust rune kind", () => {
  const known = new Set(["plumbing", ...kinds, ...itemKinds]);
  assert.deepEqual(rows.filter((r) => !known.has(r.carrier)).map((r) => `${r.id}: ${r.carrier}`), []);
});

test("every key is a header key", () => {
  const header = read("tools/runes/header.mjs");
  for (const k of KEYS) assert.ok(header.includes(`"${k}"`) || header.includes(`${k}:`), `${k} not in header.mjs`);
  assert.deepEqual(rows.filter((r) => "key" in r && !KEYS.includes(r.key)).map((r) => `${r.id}: ${r.key}`), []);
});

test("only plumbing rows carry a reason, and each carries one", () => {
  const bad = rows.filter((r) =>
    r.carrier === "plumbing" ? typeof r.reason !== "string" || r.reason.trim() === "" : "reason" in r,
  );
  assert.deepEqual(bad.map((r) => r.id), []);
});

test("every writer exists and is tracked", () => {
  const tracked = new Set(execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").map((s) => s.trim()));
  const bad = [];
  for (const r of rows) {
    if (!Array.isArray(r.writer) || r.writer.length === 0) bad.push(`${r.id}: no writer`);
    for (const w of r.writer ?? []) if (!tracked.has(w)) bad.push(`${r.id}: ${w}`);
  }
  assert.deepEqual(bad, []);
});

test("ids are kebab-case and unique, agents are known", () => {
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  assert.deepEqual(ids.filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)), []);
  assert.deepEqual(rows.filter((r) => !r.agents?.length || r.agents.some((a) => !AGENTS.includes(a))).map((r) => r.id), []);
});
