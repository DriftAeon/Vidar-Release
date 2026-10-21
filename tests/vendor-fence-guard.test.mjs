// Split from the former vendor-fence.test.mjs; the rig is tests/lib/vendor-fence-rig.mjs (import it first).
import { VENDOR, hasPwsh, launchRig, plain } from "./lib/vendor-fence-rig.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Permission deny globs are case-sensitive; the guard blocks a mixed-case registry read itself,
// and only the User environment: near-miss commands pass.
test("guard-vendor-write blocks a mixed-case reg query and allows near misses", () => {
  const run = (tool_name, command) => spawnSync("node", [join(VENDOR, "guard-vendor-write.mjs")], {
    env: { ...process.env, VIDAR_FENCE_PROBE: "1" }, encoding: "utf8", input: JSON.stringify({ tool_name, tool_input: { command } }),
  });
  assert.equal(run("Bash", "rEg qUeRy hkcu\\environment /v KEY").status, 2);
  assert.equal(run("PowerShell", "[Environment]::getenvironmentvariable('K','User')").status, 2);
  assert.equal(run("PowerShell", "Get-ItemProperty Registry::HKEY_CURRENT_USER\\Environment").status, 2);
  assert.equal(run("PowerShell", "Get-ItemProperty HKCU:\\Environment").status, 2);
  assert.equal(run("Bash", "reg query \"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\"").status, 2);
  assert.equal(run("PowerShell", "[Environment]::GetEnvironmentVariable('K', [EnvironmentVariableTarget]::User)").status, 2);
  assert.equal(run("Bash", "echo x > runtime/bridge/vendor/f.settings.json").status, 2);
  assert.equal(run("Bash", "echo registry").status, 0);
  assert.equal(run("Bash", "echo progress query").status, 0);
  assert.equal(run("Bash", "reg query HKCU\\Console").status, 0);
  assert.equal(run("PowerShell", "Get-ItemProperty HKCU:\\Software\\Microsoft").status, 0);
  assert.equal(run("PowerShell", "[Environment]::GetEnvironmentVariable('PATH')").status, 0);
});

// Trust boundary: from a subfolder the git top level's settings.json loads too, and a string
// "false" for disableAllHooks is not `false`. The project .claude of both dirs is fenced from
// Edit and from the Bash guard, and a relocated CLAUDE_CONFIG_DIR refuses.
test("vendor-tab.ps1 covers the git top level and refuses a relocated config dir", { skip: hasPwsh ? false : "needs pwsh on Windows" }, () => {
  const rig = launchRig("t5", { ACME_API_KEY: "acme-test" });
  try {
    const top = join(rig.tmp, "gitproj");
    const sub = join(top, "sub");
    mkdirSync(join(top, ".claude"), { recursive: true });
    mkdirSync(sub);
    const init = spawnSync("git", ["init", "-q"], { cwd: top });
    if (init.error || init.status !== 0) return; // no git: nothing to resolve
    rig.opts.cwd = sub;

    const fence = rig.run("-PrintFence");
    assert.equal(fence.status, 0, fence.stderr || fence.stdout);
    const deny = JSON.parse(fence.stdout.slice(fence.stdout.indexOf("{"))).permissions.deny;
    assert.ok(deny.some((r) => /^Edit\(.*\/gitproj\/\.claude\/\*\*\)$/.test(r)), "git top .claude not denied");
    assert.ok(deny.some((r) => /^Edit\(.*\/gitproj\/sub\/\.claude\/\*\*\)$/.test(r)), "cwd .claude not denied");

    const guard = spawnSync("node", [join(rig.tmp, "tools", "vendor", "guard-vendor-write.mjs")], {
      cwd: sub, env: { ...rig.env, VIDAR_FENCE_PROBE: "1" }, encoding: "utf8",
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `echo x > "${top.replace(/\\/g, "/")}/.claude/settings.json"` } }),
    });
    assert.equal(guard.status, 2, "guard let a Bash write into the git top .claude through");

    writeFileSync(join(top, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: "false" }));
    const r = rig.run();
    assert.notEqual(r.status, 0, "string-false disableAllHooks must refuse");
    assert.match(plain(r), /gitproj.*settings\.json sets[\s|]+disableAllHooks/s);

    rig.env.CLAUDE_CONFIG_DIR = join(rig.tmp, "elsewhere");
    const moved = rig.run("-PrintFence");
    assert.notEqual(moved.status, 0, "CLAUDE_CONFIG_DIR must refuse");
    assert.match(plain(moved),/CLAUDE_CONFIG_DIR/);
    assert.equal(existsSync(rig.marker), false, "claude was started");
  } finally {
    rmSync(rig.tmp, { recursive: true, force: true });
  }
});
