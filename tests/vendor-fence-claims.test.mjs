// Gateway keyVar rules the PowerShell fence re-checks from the hash-verified pack, as Rust does
// (manifest.rs check_gateway "No Dep Probes keyVar", scan.rs "keyVar ... Is Claimed By"): a dep of the
// pack probes the keyVar, and neither the dependency catalog, a core module nor another pack probes it.
// The rig is tests/lib/vendor-fence-rig.mjs (import it first); the pack is the acme contract fixture.
import { fixturePack, hasPwsh, launchRig, plain, writePack } from "./lib/vendor-fence-rig.mjs";
import { rel } from "../tools/lib/paths.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const skip = hasPwsh ? false : "needs pwsh on Windows";

function run(tag, prepare, pattern) {
  const rig = launchRig(tag, { ACME_API_KEY: "acme-test" });
  try {
    prepare(rig.tmp);
    const r = rig.run();
    if (pattern) {
      assert.notEqual(r.status, 0, "launch must refuse");
      assert.match(plain(r), pattern);
      assert.equal(existsSync(rig.marker), false, "claude was started");
    } else {
      assert.equal(r.status, 0, plain(r));
      assert.equal(existsSync(rig.marker), true, "claude stub did not run");
    }
  } finally {
    rmSync(rig.tmp, { recursive: true, force: true });
  }
}

// A different module whose dep probes ACME_API_KEY.
const claimer = (id) => ({ id, version: 1, module: { id, label: id, level: "optional", kind: "content", deps: [{ id: `${id}-key`, label: "K", probe: { kind: "env", name: "ACME_API_KEY" } }] } });

test("vendor-tab.ps1 refuses a gateway whose pack has no dep probing the keyVar", { skip }, () => {
  run("c1", (tmp) => {
    const pack = fixturePack();
    pack.module.deps[0].probe.name = "OTHER_API_KEY";
    // The snapshot pins the edited bytes, so only the new rule can refuse.
    const file = join(tmp, rel("gatewaySnapshot"));
    const snap = JSON.parse(readFileSync(file, "utf8"));
    snap.gateways[0].packSha256 = writePack(tmp, pack);
    writeFileSync(file, JSON.stringify(snap));
  }, /gateway 'acme' has no dependency probing ACME_API_KEY/);
});

test("vendor-tab.ps1 refuses a keyVar another pack's dep probes", { skip }, () => {
  run("c2", (tmp) => { writePack(tmp, claimer("other")); }, /gateway 'acme' keyVar ACME_API_KEY is claimed by module other/);
});

test("vendor-tab.ps1 refuses a keyVar the dependency catalog probes", { skip }, () => {
  run("c3", (tmp) => {
    const file = join(tmp, "contracts", "dependencies.json");
    const cat = JSON.parse(readFileSync(file, "utf8"));
    cat.deps.push({ id: "taken", label: "Taken", required: false, probe: { kind: "env", name: "ACME_API_KEY" } });
    writeFileSync(file, JSON.stringify(cat));
  }, /gateway 'acme' keyVar ACME_API_KEY is claimed by the dependency catalog/);
});

test("vendor-tab.ps1 refuses a keyVar a core module's dep probes", { skip }, () => {
  run("c4", (tmp) => {
    const file = join(tmp, "contracts", "modules.json");
    const c = JSON.parse(readFileSync(file, "utf8"));
    c.core[0].deps = [{ id: "core-key", label: "K", probe: { kind: "env", name: "ACME_API_KEY" } }];
    writeFileSync(file, JSON.stringify(c));
  }, /gateway 'acme' keyVar ACME_API_KEY is claimed by module /);
});

// The child's CLAUDE_CODE_MAX_CONTEXT_TOKENS follows the pack's flowModels entry for the model.
test("the child's context follows the pack's maxContext, else 1000000", { skip }, () => {
  for (const [tag, edit, want] of [
    ["m1", () => {}, "200000"],
    ["m2", (p) => { p.module.flowModels = []; }, "1000000"],
    ["m3", (p) => { p.module.flowModels[0].id = "other-model"; }, "1000000"],
  ]) {
    const pack = fixturePack();
    edit(pack);
    const rig = launchRig(tag, { ACME_API_KEY: "acme-test" }, { pack });
    try {
      const r = rig.run();
      assert.equal(r.status, 0, plain(r));
      assert.equal(JSON.parse(readFileSync(rig.marker, "utf8")).maxContext, want, tag);
    } finally {
      rmSync(rig.tmp, { recursive: true, force: true });
    }
  }
});

test("vendor-tab.ps1 launches when only the gateway's own dep probes the keyVar", { skip }, () => {
  run("c5", (tmp) => { writePack(tmp, { ...claimer("quiet"), module: { ...claimer("quiet").module, deps: [] } }); });
});
