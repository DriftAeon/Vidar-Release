// Review-fix E3/E4/E-outside: codex-grants.ps1 with exactly one granted root, and traced-run.ps1's cleanup.
// Nothing here starts a trace or touches an ACL: codex-grants only prints, traced-run is read as text.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingInputs } from "../../tests/helpers/optional-input.mjs";

const here = import.meta.dirname;
// traced-run.ps1 is not in the claude-codex source set: its two text checks skip with the path named.
const skipTraced = missingInputs(import.meta.url, "./traced-run.ps1") ?? false;
const tmp = [];
after(() => { for (const p of tmp) rmSync(p, { recursive: true, force: true }); });

function pwsh(args, env = {}) {
  return spawnSync("pwsh", ["-NoProfile", ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("E4: one granted root with a SID still emits a two-element target", () => {
  const home = mkdtempSync(join(tmpdir(), "grants-"));
  tmp.push(home);
  mkdirSync(join(home, ".codex", ".sandbox"), { recursive: true });
  writeFileSync(join(home, ".codex", ".sandbox", "sandbox.2026-10-10.log"), "granting write ACE to C:\\Fixture\\It's for sandbox x\n");
  writeFileSync(join(home, ".codex", "cap_sid"), JSON.stringify({ writable_root_by_path: { "c:/fixture/it's": "S-1-5-21-1-2-3-4" } }));
  const out = pwsh(["-File", join(here, "codex-grants.ps1")], { USERPROFILE: home });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.split(/\r?\n/).filter((l) => l.startsWith("$targets"));
  assert.equal(lines.length, 2, out.stdout);
  const probe = pwsh(["-Command", `${lines.join("\n")}\n"$($targets.Count)|$($targets[0].Count)|$($targets[0][0])|$($targets[0][1])"`]);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), "1|2|C:\\Fixture\\It's|S-1-5-21-1-2-3-4");
});

test("E4: the emitted purge parses the SID inside the try", () => {
  const src = readFileSync(join(here, "codex-grants.ps1"), "utf8");
  const tryAt = src.indexOf("  try {\r\n    $cap = [System.Security.Principal.SecurityIdentifier]::new($t[1])");
  assert.ok(tryAt > 0 || src.includes("  try {\n    $cap = [System.Security.Principal.SecurityIdentifier]::new($t[1])"));
});

test("E3: traced-run cancels a trace it started when it ends without a clean stop", { skip: skipTraced }, () => {
  const src = readFileSync(join(here, "traced-run.ps1"), "utf8").replace(/\r\n/g, "\n");
  const startAt = src.indexOf("& wpr.exe -start");
  const tryAt = src.indexOf("  try {\n    [void](Read-Host", startAt);
  assert.ok(startAt > 0 && tryAt > startAt, "Read-Host and wpr -stop sit in a try after wpr -start");
  assert.match(src, /\$traceOpen = \$true\n/);
  assert.match(src, /finally \{\n\s+if \(\$traceOpen\) \{ & wpr\.exe -cancel \*> \$null \}/);
  const stopAt = src.indexOf("& wpr.exe -stop");
  const openFalse = src.indexOf("$traceOpen = $false");
  assert.ok(stopAt > tryAt && openFalse > stopAt, "traceOpen clears only after wpr -stop succeeded");
});

test("E-outside: a localized wpr -status no longer decides 'not running'", { skip: skipTraced }, () => {
  const src = readFileSync(join(here, "traced-run.ps1"), "utf8");
  assert.doesNotMatch(src, /if \(\$status -notmatch 'not recording'\)/);
  assert.match(src, /\$status -match 'recording' -and \$status -notmatch 'not recording'/);
});
