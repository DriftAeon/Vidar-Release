// Trust boundary (board A3): a vendor tab must never start `claude` without its fence. This runs the
// real tools/vendor/vendor-tab.ps1 from a temp <vidar>/tools/vendor (its $PSScriptRoot root is the
// temp folder), with a fake `claude` first on PATH that records whether it was started. The intact
// base passes the pre-launch checks (control); a base missing a floor deny, or no base at all, must
// exit non-zero before the key read and before `claude`.
// Split from the former vendor-fence.test.mjs; the rig is tests/lib/vendor-fence-rig.mjs (import it first).
import { GATEWAY, VENDOR, VENDOR_FILES, copyPathsLib, hasPwsh, launchRig, plain } from "./lib/vendor-fence-rig.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("vendor-tab.ps1 refuses to start claude on a weakened or missing fence", { skip: hasPwsh ? false : "needs pwsh on Windows" }, () => {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "vidar-fence-")));
  try {
    const dir = join(tmp, "tools", "vendor");
    const bin = join(tmp, "bin");
    mkdirSync(dir, { recursive: true });
    mkdirSync(bin);
    for (const f of VENDOR_FILES) copyFileSync(join(VENDOR, f), join(dir, f));
    copyPathsLib(tmp);
    const marker = join(bin, "launched.txt");
    writeFileSync(join(bin, "claude.cmd"), `@echo launched> "${marker}"\r\n`);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const env = { ...process.env, [pathKey]: `${bin};${process.env[pathKey] ?? ""}`, VIDAR_TAB: "t1", ACME_API_KEY: "" };
    delete env.CLAUDECODE; // vendor-tab refuses inside a Claude Code session before any fence check
    delete env.CLAUDE_CONFIG_DIR;
    const run = (...extra) => spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(dir, "vendor-tab.ps1"), "-Vendor", GATEWAY, ...extra], { encoding: "utf8", env });

    const ok = run("-PrintFence");
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);

    const basePath = join(dir, "vendor-fence.base.json");
    const base = JSON.parse(readFileSync(basePath, "utf8"));
    base.permissions.deny = base.permissions.deny.filter((r) => r !== "Agent(Orion)");
    writeFileSync(basePath, JSON.stringify(base));
    const weak = run();
    assert.notEqual(weak.status, 0, "weakened base must fail");
    assert.match(plain(weak),/Vendor fence check failed.*Agent\(Orion\)/s);

    rmSync(basePath);
    const gone = run();
    assert.notEqual(gone.status, 0, "missing base must fail");

    assert.equal(existsSync(marker), false, "claude was started");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Trust boundary: the project's .claude/settings(.local).json (cwd) loads into the vendor `claude`
// as well; a credential there or disableAllHooks (drops the guard hook) must refuse the launch.
test("vendor-tab.ps1 refuses when project settings re-inject a credential or disable hooks", { skip: hasPwsh ? false : "needs pwsh on Windows" }, () => {
  const rig = launchRig("t4", { ACME_API_KEY: "acme-test" });
  try {
    const proj = join(rig.tmp, "proj");
    mkdirSync(join(proj, ".claude"), { recursive: true });
    writeFileSync(join(proj, ".claude", "settings.local.json"), JSON.stringify({ env: { Other_Api_Key: "project-value-must-not-print" }, disableAllHooks: true }));
    rig.opts.cwd = proj;
    const r = rig.run();
    assert.notEqual(r.status, 0, "project settings must refuse");
    // pwsh wraps its error box at the console width, so a long temp path splits "settings.local.json sets".
    const out = plain(r).replace(/\s*\r?\n[\s|]*/g, " ");
    assert.match(out, /proj.*settings\.local\.json sets.*env\.Other_Api_Key,.*disableAllHooks/s);
    assert.doesNotMatch(out, /must-not-print/);
    assert.equal(existsSync(rig.marker), false, "claude was started");
  } finally {
    rmSync(rig.tmp, { recursive: true, force: true });
  }
});
