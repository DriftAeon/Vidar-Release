// Trust boundary: launch values come only from the approved snapshot Rust writes. A
// gateway missing from it, or whose pack changed after it, refuses; snapshot values aiming `claude`
// at a plain-http endpoint, reading an Anthropic key, naming a bad model or setting an env key outside
// the contract's gateway.envAllowlist are refused again here, before the fence is built and before `claude`.
// The rig is tests/lib/vendor-fence-rig.mjs (import it first); the pack is the acme contract fixture.
import { fixturePack, hasPwsh, launchRig, plain, snapshotEntry, writePack, writeSnapshot } from "./lib/vendor-fence-rig.mjs";
import { rel } from "../tools/lib/paths.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const skip = hasPwsh ? false : "needs pwsh on Windows";

function refuses(tag, edit, pattern) {
  const pack = fixturePack();
  edit(pack.module.agent.gateway);
  const rig = launchRig(tag, { ACME_API_KEY: "acme-test", ANTHROPIC_API_KEY: "ant-test" }, { pack });
  try {
    const r = rig.run();
    assert.notEqual(r.status, 0, "a pack breaking the gateway rules must refuse");
    assert.match(plain(r), pattern);
    assert.equal(existsSync(rig.marker), false, "claude was started");
  } finally {
    rmSync(rig.tmp, { recursive: true, force: true });
  }
}

test("vendor-tab.ps1 refuses a gateway keyVar of ANTHROPIC_API_KEY", { skip }, () => {
  refuses("p1", (g) => { g.keyVar = "ANTHROPIC_API_KEY"; }, /keyVar must be ACME_API_KEY/);
});

test("vendor-tab.ps1 refuses a non-https gateway baseUrl", { skip }, () => {
  refuses("p2", (g) => { g.baseUrl = "http://api.acme.example/anthropic"; }, /baseUrl must start https:\/\//);
});

function refusesRig(rig, pattern) {
  try {
    const r = rig.run();
    assert.notEqual(r.status, 0, "launch must refuse");
    assert.match(plain(r), pattern);
    assert.equal(existsSync(rig.marker), false, "claude was started");
  } finally {
    rmSync(rig.tmp, { recursive: true, force: true });
  }
}

test("vendor-tab.ps1 refuses a gateway with no entry in the approved snapshot", { skip }, () => {
  refusesRig(launchRig("p4", { ACME_API_KEY: "acme-test" }, { snapshot: [] }), /gateway 'acme' is not approved by Vidar: restart Vidar to check the pack/);
});

// N4: the snapshot entry must name the pack folder after the gateway id itself; an entry pointing at
// another pack folder (whose hash may well match) is not an approval of this gateway.
test("vendor-tab.ps1 refuses a snapshot entry whose pack is not the gateway id", { skip }, () => {
  const pack = fixturePack();
  const rig = launchRig("p8", { ACME_API_KEY: "acme-test" }, { pack: null });
  const other = { ...pack, id: "other" };
  const sha = writePack(rig.tmp, other);
  writeSnapshot(rig.tmp, [{ ...snapshotEntry(pack, sha), pack: "other" }]);
  refusesRig(rig, /gateway 'acme' is not approved by Vidar: restart Vidar to check the pack/);
});

// N7: .NET's `$` matches before a final newline, so "acme-large\n" passes the model pattern alone.
test("vendor-tab.ps1 refuses a snapshot value carrying a newline", { skip }, () => {
  for (const [tag, edit] of [
    ["p9", (e) => { e.model = "acme-large\n"; }],
    ["p10", (e) => { e.baseUrl += "\r\n"; }],
    ["p11", (e) => { e.keyVar += "\n"; }],
    ["p12", (e) => { e.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "acme-small\n"; }],
  ]) {
    const pack = fixturePack();
    const rig = launchRig(tag, { ACME_API_KEY: "acme-test" }, { pack: null });
    const sha = writePack(rig.tmp, pack);
    const entry = snapshotEntry(pack, sha);
    edit(entry);
    writeSnapshot(rig.tmp, [entry]);
    refusesRig(rig, /gateway 'acme' (baseUrl must start|keyVar must be|model is not a model id|env ANTHROPIC_DEFAULT_HAIKU_MODEL is not a string)/);
  }
});

// S4: the launch values come from the snapshot, not from the pack the hash pins.
test("the fence's models come from the snapshot, not from the pack", { skip }, () => {
  const pack = fixturePack();
  const rig = launchRig("p13", { ACME_API_KEY: "acme-test" }, { pack: null });
  try {
    const sha = writePack(rig.tmp, pack);
    const entry = { ...snapshotEntry(pack, sha), model: "snap-large", env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "snap-small" } };
    assert.notEqual(entry.model, pack.module.agent.gateway.model);
    writeSnapshot(rig.tmp, [entry]);
    const r = rig.run("-PrintFence");
    assert.equal(r.status, 0, plain(r));
    const models = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))).availableModels;
    assert.deepEqual(models, ["opus", "sonnet", "haiku", "snap-large", "snap-small"]);
    assert.equal(models.includes(pack.module.agent.gateway.model), false, "the pack's model reached the fence");
  } finally {
    rmSync(rig.tmp, { recursive: true, force: true });
  }
});

test("vendor-tab.ps1 refuses a pack edited after the snapshot was written", { skip }, () => {
  const rig = launchRig("p5", { ACME_API_KEY: "acme-test" });
  const pack = fixturePack();
  pack.module.agent.gateway.baseUrl = "https://elsewhere.example/anthropic";
  writePack(rig.tmp, pack);
  refusesRig(rig, /pack 'acme' changed since Vidar checked it: Trust Current in Dependencies accepts it/);
});

test("vendor-tab.ps1 refuses a gateway model that fails the contract's modelPattern", { skip }, () => {
  refuses("p6", (g) => { g.model = "acme large"; }, /gateway 'acme' model is not a model id/);
});

// S3: a full launch (past the key read, through the claude stub). The key is meant to reach the child
// only as ANTHROPIC_AUTH_TOKEN (the keyVar name itself is stripped); nowhere else.
test("a full launch hands the key only to the child's ANTHROPIC_AUTH_TOKEN", { skip }, () => {
  const sentinel = "sentinel-key-value-7f3a";
  const rig = launchRig("p7", { ACME_API_KEY: sentinel }, { sentinel });
  try {
    const r = rig.run();
    assert.equal(r.status, 0, plain(r));
    assert.equal(existsSync(rig.marker), true, "claude stub did not run, so the key read was not reached");
    const raw = readFileSync(rig.marker, "utf8");
    assert.equal(raw.includes(sentinel), false, "stub marker file holds the key");
    assert.deepEqual(JSON.parse(raw).carriers, ["ANTHROPIC_AUTH_TOKEN"], "env names carrying the key in the child");
    assert.equal(readFileSync(join(rig.tmp, rel("gatewaySnapshot")), "utf8").includes(sentinel), false, "snapshot holds the key");
    assert.equal((r.stdout + r.stderr).includes(sentinel), false, "output holds the key");
  } finally {
    rmSync(rig.tmp, { recursive: true, force: true });
  }
});

test("vendor-tab.ps1 refuses a gateway env key outside the contract's gateway.envAllowlist", { skip }, () => {
  refuses("p3", (g) => { g.env.ANTHROPIC_BASE_URL = "https://elsewhere.example"; }, /env key ANTHROPIC_BASE_URL is not in gateway\.envAllowlist/);
});

// The allowlist is the contract's gateway.envAllowlist, not a core module's field: with Claude in its
// own pack, every allowlisted key still passes (the fixture sets three; this adds the fourth).
test("vendor-tab.ps1 accepts every key in the contract's gateway.envAllowlist", { skip }, () => {
  const { gateway } = JSON.parse(readFileSync(new URL("../contracts/modules.json", import.meta.url), "utf8"));
  assert.ok(gateway.envAllowlist.length > 0, "gateway.envAllowlist is empty");
  const pack = fixturePack();
  for (const k of gateway.envAllowlist) pack.module.agent.gateway.env[k] ??= k.endsWith("_MODEL") ? "acme-small" : "60000";
  const rig = launchRig("p-allow", { ACME_API_KEY: "acme-test" }, { pack });
  try {
    const r = rig.run();
    assert.equal(r.status, 0, plain(r));
    assert.ok(existsSync(rig.marker), `the child did not run: ${plain(r)}`);
  } finally {
    rmSync(rig.tmp, { recursive: true, force: true });
  }
});
