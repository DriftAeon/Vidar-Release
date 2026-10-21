// g2: the shell input lines and shell key follow the bundle's runtimes; a codex-only list names no sidecar.
import baseTest from "node:test";
import { missingInputs, guard } from "./helpers/optional-input.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Falcon release tooling does not ship; the tests skip when its scripts are absent.
const test = guard(baseTest, missingInputs(import.meta.url, "../tools/release/falcon-inputs.ps1", "../tools/release/falcon-build.ps1", "../tools/release/pending.ps1", "../tools/release/falcon-frontend-stage.ps1"));
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const inputs = join(root, "tools", "release", "falcon-inputs.ps1");
const read = (rel) => readFileSync(join(root, rel), "utf8");

function pwsh(body) {
  const script = `$ErrorActionPreference='Stop'; . '${inputs}'; ${body}`;
  return execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", cwd: root }).trim();
}

const lines = (runtimes) =>
  pwsh(`(Get-FalconShellInputLines -RepoRoot '${root}' ${runtimes} | ForEach-Object { $_ }) -join "\`n"`).split("\n");

test("the default shell input list is the two-runtime list and carries the sidecar line", () => {
  const both = lines("-Runtimes claude,codex");
  assert.deepEqual(lines(""), both);
  assert.equal(both.filter((l) => l.startsWith("runtime/claude-sidecar.mjs|")).length, 1);
});

test("a codex-only list has no claude-sidecar line and is otherwise the same lines", () => {
  const both = lines("");
  const codex = lines("-Runtimes codex");
  assert.ok(!codex.some((l) => l.includes("claude-sidecar")));
  assert.deepEqual(codex, both.filter((l) => !l.startsWith("runtime/claude-sidecar.mjs|")));
});

test("the shell key defaults to both runtimes and differs for codex-only", () => {
  const key = (args) => pwsh(`Get-FalconShellKey -RepoRoot '${root}' ${args}`);
  const both = key("");
  assert.match(both, /^[0-9a-f]{64}$/);
  assert.equal(key("-Runtimes claude,codex"), both);
  assert.notEqual(key("-Runtimes codex"), both);
});

test("Get-FalconManifestRuntimes: absent or no manifest means both", () => {
  const rt = (m) => pwsh(`(Get-FalconManifestRuntimes ${m}) -join ','`);
  assert.equal(rt("$null"), "claude,codex");
  assert.equal(rt("([pscustomobject]@{ schema = 3 })"), "claude,codex");
  assert.equal(rt("([pscustomobject]@{ runtimes = @('codex') })"), "codex");
});

test("every caller passes the runtimes of the bundle it builds or reads", () => {
  const build = read("tools/release/falcon-build.ps1");
  assert.ok(build.includes("-CodexFiles $codexFiles -Runtimes $runtimeList"));
  assert.ok(build.includes("Get-FalconShellKey -RepoRoot $repoRoot -Runtimes $runtimeList"));
  assert.ok(build.includes("$runtimeList = Resolve-FalconRuntimes $Runtimes"), "-Runtimes codex resolves to the codex list");
  assert.ok(read("tools/release/pending.ps1").includes("Get-FalconShellInputLines -RepoRoot $root -Runtimes (Get-FalconManifestRuntimes $pBundle)"));
  assert.ok(read("tools/release/falcon-frontend-stage.ps1").includes("Get-FalconShellKey -RepoRoot $repoRoot -Runtimes (Get-FalconManifestRuntimes $currentBundle)"));
});
