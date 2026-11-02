// start-vault (src/launcher/start-vault.ts): a fresh launch on a copy or legacy Custom source starts a copy;
// a named vault or a recorded id (resume) passes through. IPC is a stub that records every create and read.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const gone = new Set();
const created = [];
const reads = [];
setupDom({ answers: {
  rune_vault_read: (args) => { reads.push(args); return gone.has(args.id) ? Promise.reject(new Error("no vault")) : { vault: { id: args.id, hash: `h-${args.id}` }, drift: [] }; },
  rune_vault_create: (args) => { created.push(args); return { id: `copy-${created.length}` }; },
} });

const { startVault, vaultRows } = await import("../src/launcher/start-vault.ts");

test("decision table: fresh copy and custom start a copy; named and recorded pass through", async () => {
  const table = [
    // [vault, recorded, loads, source of the copy]
    ["copy-261031-101010-ab12", false, "copy-1", "copy-261031-101010-ab12"],
    ["custom-a1b2c3", false, "copy-2", "custom-a1b2c3"],
    ["team-main", false, "team-main", null],
    ["copy-261031-101010-ab12", true, "copy-261031-101010-ab12", null],
    ["custom-a1b2c3", true, "custom-a1b2c3", null],
  ];
  for (const [vault, recorded, loads, source] of table) {
    const before = created.length;
    assert.equal(await startVault("claude", vault, recorded), loads, `${vault} recorded=${recorded}`);
    if (source === null) assert.equal(created.length, before, `${vault} makes no copy`);
    else {
      assert.equal(created.length, before + 1);
      assert.deepEqual(created.at(-1), { name: null, from: { vault: source, hash: `h-${source}` }, runesets: [], runes: [], agent: "claude" });
    }
  }
});

test("the source is read for the launching agent; one that cannot be read is the launch error", async () => {
  await startVault("codex", "copy-9");
  assert.deepEqual(reads.at(-1), { id: "copy-9", agent: "codex" });
  gone.add("copy-gone");
  const before = created.length;
  await assert.rejects(startVault("codex", "copy-gone"), /no vault/);
  assert.equal(created.length, before, "no copy is made from a missing source");
  gone.clear();
});

const LISTED = [
  { id: "team-main", name: "Team Main", template: false, hash: "h1", lockedUtc: null },
  { id: "daily", name: "Daily Work", template: false, hash: "h2", lockedUtc: null },
  { id: "daily", name: "Daily Work", template: true, hash: "", lockedUtc: null },
];

test("vault rows: saved vaults by name, once each", () => {
  assert.deepEqual(vaultRows(LISTED).map((v) => v.id), ["daily", "team-main"]);
});

test("vault rows: copy and legacy custom vaults are no cards", () => {
  const hidden = ["copy-261031-101010-ab12", "custom-a1b2c3"].map((id) => ({ id, name: "Hidden", template: false, hash: "h", lockedUtc: null }));
  assert.deepEqual(vaultRows([...LISTED, ...hidden]).map((v) => v.id), ["daily", "team-main"]);
});

test("pending: roster hands start-vault nothing, so no copy is made", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/launcher/roster.ts", import.meta.url), "utf8");
  assert.match(src, /source && !bare\?\.pending \? await startVault\(kind, source, recorded !== null\) : source/);
});
