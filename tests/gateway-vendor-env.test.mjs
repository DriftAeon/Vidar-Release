// Gate wrapper for tests/gateway-vendor-env.ps1: the pure credential strip/set construction in
// tools/vendor/vendor-env.ps1. No key lookup, child CLI or file write; skips without pwsh like the
// other vendor tests.
import { hasPwsh, plain } from "./lib/vendor-fence-rig.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("vendor-env strips credential names and sets only the selected gateway auth", { skip: hasPwsh ? false : "needs pwsh on Windows" }, () => {
  const script = fileURLToPath(new URL("./gateway-vendor-env.ps1", import.meta.url));
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8" });
  assert.equal(r.status, 0, plain(r));
  assert.match(r.stdout, /PASS: Gateway Environment Strip and Set/);
});
