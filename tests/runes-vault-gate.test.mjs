// Rune Vault acceptance gate, Node half (run 2026-10-25-rune-vault, wave 0). Contract:
// docs/projects/bare/runeset-model.md § Gate and R3 (a vault locks on the session's first message,
// never on hydrate or replay). The lock lives in the Rust send commands (`falcon_send` in
// falcon/session_commands.rs, `agent_send` in agent.rs) so every composer path that delivers a user
// turn (`sendUser`, `sendPrompt`, `flushQueue`) presses it through one door, and only once: the Rust
// lock is idempotent (bare/vault_gate_tests.rs covers that half). Reads source files only; starts nothing.
// Usage: node --test tests/runes-vault-gate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "rune-vault");
const src = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const json = (...p) => JSON.parse(readFileSync(join(FIXTURE, ...p), "utf8"));

/** The body of `fn name(` / `function name(` / `async name(` up to its matching close brace. */
function body(text, re) {
  const m = re.exec(text);
  assert.ok(m, `no match for ${re}`);
  // Signatures here hold no braces, so the first `{` after the match opens the body.
  let i = text.indexOf("{", m.index + m[0].length);
  let depth = 0;
  const start = i;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`unbalanced body for ${re}`);
}

// The Rust hook every user-turn delivery calls before it writes the line (L3a names it here).
const LOCK_CALL = "lock_first_send(";

test("falcon_send and agent_send lock the session's vault before delivering", () => {
  // L3a: lock in `falcon_send` (session_commands.rs) and `agent_send` (agent.rs).
  const falcon = body(src("src-tauri", "src", "falcon", "session_commands.rs"), /pub async fn falcon_send\(/);
  const agent = body(src("src-tauri", "src", "agent.rs"), /pub fn agent_send\(/);
  for (const [name, b] of [["falcon_send", falcon], ["agent_send", agent]]) {
    assert.ok(b.includes(LOCK_CALL), `${name} does not lock the vault on the first send`);
    assert.ok(b.indexOf(LOCK_CALL) < Math.max(b.indexOf("hosted_request"), b.indexOf("write_all")), `${name} delivers before it locks`);
  }
});

test("no other Rust command presses the first-message lock (spawn, adopt and hydrate never lock)", () => {
  // L3a: the lock call sits only in the two send commands and the vault module that defines it.
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (rel.endsWith(".rs") && src(rel).includes(LOCK_CALL)) hits.push(rel);
    }
  };
  walk("src-tauri/src");
  const allowed = new Set(["src-tauri/src/falcon/session_commands.rs", "src-tauri/src/agent.rs"]);
  const bad = hits.filter((f) => !allowed.has(f) && !f.startsWith("src-tauri/src/bare/vault/"));
  assert.deepEqual(bad, []);
});

test("sendUser, sendPrompt and flushQueue all deliver through transport.send, and none locks in TS", () => {
  // L3a: one door. The composer never calls rune_vault_lock itself, so a turn cannot lock twice.
  const composer = src("src", "panels", "rendered", "composer.ts");
  const rendered = src("src", "panels", "rendered.ts");
  assert.ok(body(composer, /function sendUser\(/).includes("sendEncoded("), "sendUser");
  assert.ok(body(composer, /function flushQueue\(/).includes("sendEncoded("), "flushQueue");
  assert.ok(body(rendered, /async sendPrompt\(/).includes("transport.send("), "sendPrompt");
  for (const [name, text] of [["composer.ts", composer], ["rendered.ts", rendered]]) {
    assert.ok(!text.includes("rune_vault_lock"), `${name} locks in TS; the Rust send command owns the first-message lock`);
  }
});

test("hydrate and replay never deliver a turn, so they never lock", () => {
  // L3a: flushQueue stands down while hydrating or replaying; sendPrompt refuses a busy tab.
  const composer = src("src", "panels", "rendered", "composer.ts");
  const flush = body(composer, /function flushQueue\(/);
  assert.match(flush, /S\.hydrating/);
  assert.match(flush, /S\.replaying/);
  const rendered = src("src", "panels", "rendered.ts");
  assert.match(body(rendered, /async sendPrompt\(/), /promptReady\(\)/);
});

test("the Lock button calls rune_vault_lock with lockedBy button from the Runes head only", () => {
  // L3b1: Lock button in the Runes head; L1b owns the IPC entry.
  const ipc = src("src", "ipc.ts");
  assert.ok(ipc.includes("rune_vault_lock"), "no rune_vault_lock IPC entry");
  assert.ok(ipc.includes("rune_vault_session"), "no rune_vault_session IPC entry");
  const panel = src("src", "panels", "runes.ts");
  assert.match(panel, /invoke\("rune_vault_lock", \{ id, by: "button", expectHash \}\)/);
  assert.ok(panel.includes("e.handle.lockButton"), "the Runes head does not seat the Lock button");
  const callers = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (rel.endsWith(".ts") && src(rel).includes('"rune_vault_lock"')) callers.push(rel);
    }
  };
  walk("src");
  // L3a's launcher lock is the one other caller the plan allows; the Runes panel is the only button
  assert.deepEqual(callers.filter((f) => f !== "src/ipc.ts" && !f.startsWith("src/launcher/")), ["src/panels/runes.ts"]);
});

test("fixture vault.json v1 carries every contract field", () => {
  // L1a: the store writes exactly these keys (plan v1 Vault object, v2 D-e pins).
  const keys = ["version", "id", "name", "createdUtc", "from", "runesets", "runes", "lockedUtc", "lockedBy", "hash", "pins"];
  for (const id of ["astra-code", "astra-code-no-skill"]) {
    const v = json("vaults", id, "vault.json");
    assert.deepEqual(Object.keys(v), keys, id);
    assert.equal(v.version, 1);
    for (const s of v.runesets) assert.deepEqual(Object.keys(s), ["file", "source", "copiedUtc", "sourceHash"]);
    for (const r of v.runes) assert.deepEqual(Object.keys(r), ["library", "id"]);
  }
  const locked = json("vaults", "astra-code-no-skill", "vault.json");
  assert.deepEqual(locked.from, { vault: "astra-code", hash: json("vaults", "astra-code", "vault.json").hash });
  assert.equal(locked.lockedBy, "first-message");
  assert.ok(Object.keys(locked.pins).every((k) => /^[a-z0-9-]+\/[a-z0-9-]+$/.test(k)));
});

test("fixture session record carries no launcher row and names its vault by id and hash", () => {
  // L1b: record shape (plan v1 Session record minus rowKey).
  const dir = join(FIXTURE, "vaults", "sessions");
  const [file] = readdirSync(dir);
  assert.match(file, /^\d{4}-\d{2}-\d{2}T\d{9}Z-(claude|codex)-[0-9a-f]{8}\.json$/);
  const r = JSON.parse(readFileSync(join(dir, file), "utf8"));
  assert.deepEqual(Object.keys(r), ["version", "createdUtc", "agent", "body", "tab", "falconSession", "threadId", "vault", "home", "loadoutHash"]);
  assert.deepEqual(Object.keys(r.vault), ["id", "hash"]);
  assert.equal(r.rowKey, undefined, "a session never binds a launcher row (model R2)");
});

test("defaults.json is a per-agent last-used pre-pick, never keyed by a launcher row", () => {
  // L3a launcher pre-pick (Q2): the only reader is src/launcher/.
  const d = json("vaults", "defaults.json");
  assert.deepEqual(Object.keys(d), ["version", "lastUsed"]);
  for (const k of Object.keys(d.lastUsed)) assert.ok(["claude", "codex"].includes(k), k);
});
