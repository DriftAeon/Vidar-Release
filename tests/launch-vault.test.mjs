// ctl.spawn's Rune Vault resolver (control/launch-vault.ts): an explicit vault, the user's Last Vault when unset
// (refused when there is none), and the refusals that happen before the Approve card.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveLaunchVault } from "../src/control/launch-vault.ts";

const base = { asked: undefined, last: "team-daily", listed: ["team-daily", "other"], bare: true };
const run = (over) => resolveLaunchVault({ ...base, ...over });

test("unset vault loads the user's Last Vault", () => {
  assert.deepEqual(run({}), { vault: "team-daily" });
  assert.deepEqual(run({ asked: "last" }), { vault: "team-daily" });
});

test("ctl.spawn with no vault and no Last Used refuses", () => {
  assert.match(run({ last: undefined }).refuse, /no Last Vault/);
  assert.match(run({ last: undefined, asked: "last" }).refuse, /no Last Vault/);
  assert.match(run({ last: "" }).refuse, /no Last Vault/);
});

test("a Last Vault that no longer exists is refused, never replaced", () => {
  assert.match(run({ last: "gone" }).refuse, /unknown vault "gone"/);
});

test("a keyword is no vault: it is an unknown vault like any other id", () => {
  assert.match(run({ asked: "base" }).refuse, /unknown vault "base"/);
});

test("an explicit id must be listed", () => {
  assert.deepEqual(run({ asked: "other" }), { vault: "other" });
  assert.match(run({ asked: "nope" }).refuse, /unknown vault "nope"/);
  assert.deepEqual(run({ asked: "other", listed: null }), { vault: "other" }, "an unreadable list skips the membership check");
});

test("a row without a launch profile ignores unset and refuses an explicit vault", () => {
  assert.deepEqual(run({ bare: false }), { vault: undefined });
  assert.deepEqual(run({ bare: false, last: undefined }), { vault: undefined });
  assert.match(run({ bare: false, asked: "team-daily" }).refuse, /Bare row/);
});
