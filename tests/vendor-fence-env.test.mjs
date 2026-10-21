// Trust boundary (security pass item 2): a vendor tab's `claude` inherits no other credential, its
// fence denies the Claude login and the other vendors' logins, and the env it ran with is gone from
// the parent pwsh once it exits (a later bare `claude` in the -NoExit tab is not a vendor session).
// Split from the former vendor-fence.test.mjs; the rig is tests/lib/vendor-fence-rig.mjs (import it first).
import { GATEWAY, hasPwsh, launchRig, plain } from "./lib/vendor-fence-rig.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

test("vendor-tab.ps1 strips other credentials, fences login files and restores the env after claude", { skip: hasPwsh ? false : "needs pwsh on Windows" }, () => {
  const fixtures = {
    ACME_API_KEY: "acme-test", OTHER_API_KEY: "other-test", TYPESAFE_API_KEY: "ts-test", ANTHROPIC_API_KEY: "ant-test",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-test", VIDAR_CTL_TOKEN: "ctl-test", Some_Secret: "s-test",
    Some_Key: "k-test", DB_PASSWORD: "pw-test", GITHUB_PAT: "pat-test", GOOGLE_CREDENTIALS: "gc-test",
    AWS_ACCESS_KEY_ID: "aws-test", CLAUDE_CODE_USE_BEDROCK: "1", claude_code_use_vertex: "1",
  };
  const rig = launchRig("t2", fixtures);
  // Names vendor-tab sets for `claude`; absent before so "absent after" proves the restore.
  const vendorSet = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"];
  for (const k of Object.keys(rig.env)) if (vendorSet.includes(k.toUpperCase()) || k.toUpperCase() === "CLAUDE_CODE_MAX_CONTEXT_TOKENS") delete rig.env[k];
  try {
    // Benign user settings (this machine's shape: non-secret CLAUDE_CODE_* names) must not refuse.
    rig.settings({ env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1", CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1" } });

    const fence = rig.run("-PrintFence");
    assert.equal(fence.status, 0, fence.stderr || fence.stdout);
    const deny = JSON.parse(fence.stdout.slice(fence.stdout.indexOf("{"))).permissions.deny;
    for (const rule of [
      "Read(~/.claude/.credentials.json)", "Read(~/.codex/auth.json)", "Read(~/.pi/agent/auth.json)", "Read(~/.gemini/**)",
      "Bash(*.credentials*)", "Bash(*auth.json*)", "Bash(*.gemini*)", "Bash(*HKCU*Environment*)", "Bash(*HKEY_CURRENT_USER*Environment*)",
      "Bash(*GetEnvironmentVariable*User*)",
      "PowerShell(*auth.json*)", "PowerShell(*.gemini*)", "PowerShell(*GetEnvironmentVariable*User*)", "PowerShell(*HKCU*Environment*)",
    ]) assert.ok(deny.includes(rule), `fence lacks ${rule}`);
    for (const broad of ["Bash(*HKCU*)", "Bash(*reg*query*)", "Bash(*reg.exe*)", "PowerShell(*HKCU*)", "PowerShell(*GetEnvironmentVariable*)"]) {
      assert.ok(!deny.includes(broad), `fence still has broad ${broad}`);
    }

    // The User-environment read stays denied under other spacing/casing and via .NET.
    // Matcher: Claude Code's `*` wildcard over the whole command text (inferred, not its code).
    const bashDenied = (cmd) => deny.some((r) => {
      const m = /^Bash\((.*)\)$/.exec(r);
      return m && new RegExp(`^${m[1].split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s").test(cmd);
    });
    for (const cmd of [
      "reg query HKCU\\Environment /v ACME_API_KEY", "reg  query hkcu\\environment", "REG QUERY \"HKEY_CURRENT_USER\\Environment\"",
      "reg.exe query HKCU\\Environment", "pwsh -c \"[Environment]::GetEnvironmentVariable('ACME_API_KEY','User')\"",
    ]) assert.ok(bashDenied(cmd), `not denied: ${cmd}`);

    // Run inside one pwsh so the parent env can be inspected after `claude` exits. The check
    // prints only names that differ, never values.
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const same = Object.entries(fixtures).map(([k, v]) => `if ((Get-Item -LiteralPath ${q(`Env:${k}`)} -ErrorAction SilentlyContinue).Value -cne ${q(v)}) { $bad += ${q(k)} }`);
    const gone = vendorSet.map((k) => `if (Test-Path -LiteralPath ${q(`Env:${k}`)}) { $bad += ${q(k)} }`);
    const cmd = [`$bad = @()`, `& ${q(rig.script)} -Vendor ${GATEWAY}`, ...same, ...gone, `'RESTORE:' + ($bad -join ',')`].join("\n");
    const launched = spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], { encoding: "utf8", env: rig.env });
    assert.equal(launched.status, 0, launched.stderr || launched.stdout);
    const seen = JSON.parse(readFileSync(rig.marker, "utf8"));
    assert.deepEqual(seen.names, vendorSet);
    assert.equal(seen.authSet, true, "ANTHROPIC_AUTH_TOKEN empty in claude's env");
    assert.match(launched.stdout, /^RESTORE:$/m, "parent env not restored after claude exited");
  } finally {
    rmSync(rig.tmp, { recursive: true, force: true });
  }
});

// Trust boundary: ~/.claude/settings.json is loaded by the vendor `claude` too, so a credential in
// its `env` (or an apiKeyHelper) would come back after the strip. The launch must refuse, naming
// the entries without their values, before `claude` starts.
test("vendor-tab.ps1 refuses when user settings re-inject a credential", { skip: hasPwsh ? false : "needs pwsh on Windows" }, () => {
  const rig = launchRig("t3", { ACME_API_KEY: "acme-test" });
  try {
    rig.settings({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", Github_Pat: "settings-value-must-not-print" }, apiKeyHelper: "helper-must-not-print" });
    const r = rig.run();
    assert.notEqual(r.status, 0, "credential in user settings must refuse");
    const out = plain(r);
    assert.match(out, /re-inject a credential.*env\.Github_Pat.*apiKeyHelper/s);
    assert.doesNotMatch(out, /must-not-print|CLAUDE_CODE_SUBAGENT_MODEL/);
    assert.equal(existsSync(rig.marker), false, "claude was started");
  } finally {
    rmSync(rig.tmp, { recursive: true, force: true });
  }
});
