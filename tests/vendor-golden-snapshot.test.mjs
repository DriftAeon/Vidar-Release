// Cross-language contract: the snapshot Rust renders (src-tauri modules::tests::
// modules_snapshot_matches_the_golden_file pins it byte for byte) is the one the real
// vendor-prepare.ps1 accepts, for the same fixture pack (a pack.json with a UTF-8 BOM).
// Regenerate both golden files with VIDAR_REGEN_GOLDEN=1 cargo test modules_snapshot_matches.
import { hasPwsh, launchRig, plain } from "./lib/vendor-fence-rig.mjs";
import { rel } from "../tools/lib/paths.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skip = hasPwsh ? false : "needs pwsh on Windows";
const golden = (f) => fileURLToPath(new URL(`./fixtures/modules-golden/${f}`, import.meta.url));

test("vendor-prepare.ps1 accepts Rust's golden snapshot with the golden BOM pack", { skip }, () => {
  const rig = launchRig("g1", { ACME_API_KEY: "acme-test" }, { pack: null });
  try {
    const pack = join(rig.tmp, rel("packs"), "acme", "pack.json");
    const snap = join(rig.tmp, rel("gatewaySnapshot"));
    mkdirSync(dirname(pack), { recursive: true });
    mkdirSync(dirname(snap), { recursive: true });
    copyFileSync(golden("acme/pack.json"), pack);
    copyFileSync(golden("gateways.json"), snap);
    const r = rig.run("-PrintFence");
    assert.equal(r.status, 0, plain(r));
    // Not just exit 0: the printed fence carries the golden snapshot's model and env model ids.
    const g = JSON.parse(readFileSync(golden("gateways.json"), "utf8")).gateways[0];
    const models = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))).availableModels;
    const want = ["opus", "sonnet", "haiku", ...new Set([g.model, ...Object.entries(g.env).filter(([k]) => k.endsWith("_MODEL")).map(([, v]) => v)])];
    assert.deepEqual(models, want);
  } finally {
    rmSync(rig.tmp, { recursive: true, force: true });
  }
});
