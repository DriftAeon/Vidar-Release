// Make Variant on a re-adopted tab. The variant is a new vault for new
// sessions only (runeset-model rule 4), so the write sends no session move: the tab's record keeps pointing at the
// vault it loaded, and rune_vault_session_move no longer exists.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const LOOKUP = `export function driveSnapshot() {
    return { tabs: [{ id: "s1-new", falconSession: "fs-3", sessionId: "th-3" }] };
  }`;
const { ipc } = setupDom({ stubs: { "panels/sessions/lookup": LOOKUP } });
const { tabVaultIo } = await import("../src/runes/bare/vault-io.ts");
const { editVault, settleEdit } = await import("../src/runes/bare/vault-edit.ts");
const { tabVaultSession } = await import("../src/panels/sessions/vault-tabs.ts");

test("Make Variant leaves the tab's record on the original vault", async () => {
  const record = { vault: { id: "main-claude", hash: "h1" } };
  ipc.answers.rune_vault_session = () => record;
  ipc.answers.rune_vault_read = () => ({ vault: { id: "main-claude", lockedUtc: "t", runes: [] }, drift: [], runes: [], warnings: [] });
  ipc.answers.rune_vault_edit = (a) => ({ id: "main-claude-variant", name: "Daily Variant", lockedUtc: null, runes: [], mode: a.mode });
  ipc.invoked.length = 0;
  const io = tabVaultIo(async () => null, async () => { throw new Error("a variant never respawns the tab"); });
  const r = await editVault(io, "main-claude", [], "variant");
  await settleEdit(io, r);
  assert.equal(r.vault.name, "Daily Variant");
  assert.ok(ipc.invoked.includes("rune_vault_edit") && !ipc.invoked.includes("rune_vault_session_move"), `no move was sent: ${ipc.invoked}`);
  assert.equal((await tabVaultSession("s1-new")).vault.id, "main-claude", "the record still names the vault the tab loaded");
});

test("the session read sends the same identity", async () => {
  let args = null;
  ipc.answers.rune_vault_session = (a) => { args = a; return null; };
  await tabVaultSession("s1-new");
  assert.deepEqual(args, { tab: "s1-new", falconSession: "fs-3", threadId: "th-3" });
});
