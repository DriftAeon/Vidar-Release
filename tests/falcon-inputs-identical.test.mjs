// K1: falcon-inputs.ps1 reads its runtimes from tools/lib/FalconRuntimes.ps1; the lines a bundle id hashes and the
// shell key stay what they were before that table (a changed key would stale every staged frontend and host).
// Golden: tests/fixtures/falcon-inputs-golden.json, recorded at the base commit for {claude,codex}, {claude}, {codex}.
import baseTest from "node:test";
import { missingInputs, guard } from "./helpers/optional-input.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Falcon release tooling does not ship; the tests skip when its scripts are absent.
const test = guard(baseTest, missingInputs(import.meta.url, "../tools/release/falcon-inputs.ps1", "../tools/lib/FalconRuntimes.ps1"));
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const inputs = join(root, "tools", "release", "falcon-inputs.ps1");
const golden = JSON.parse(readFileSync(join(root, "tests", "fixtures", "falcon-inputs-golden.json"), "utf8")).sets;
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function pwsh(body) {
  const script = `$ErrorActionPreference='Stop'; . '${inputs}'; ${body}`;
  return execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", cwd: root }).trim();
}

// The input lines for one runtime set with fixed fake identities; rustc and the MSVC toolset are real inputs.
function inputLines(set) {
  const ids = set.split(",");
  const identities = [
    ids.includes("claude") ? `$id['claude'] = ('a' * 64)` : "",
    ids.includes("codex") ? `$id['codex'] = @([pscustomobject]@{ path = 'a.exe'; sha256 = ('b' * 64) }, [pscustomobject]@{ path = 'z/x.dll'; sha256 = ('c' * 64) })` : "",
  ].join("; ");
  return pwsh(
    `$id = @{}; ${identities}; ` +
    `(Get-FalconInputLines -RepoRoot '${root}' -FrontendLines ([string[]]@('frontend/f|' + ('d' * 64))) -EncodedFlags 'flags' ` +
    `-Identities $id -Runtimes ${ids.join(",")} | ForEach-Object { $_ }) -join "\`n"`,
  ).split("\n");
}

const toolchain = spawnSync("rustc", ["-vV"], { encoding: "utf8" }).status === 0;

for (const set of Object.keys(golden)) {
  test(`${set}: the runtime/ and build/ input lines match the golden recorded before the table`, (t) => {
    if (!toolchain) return t.skip("rustc is not on PATH");
    const got = inputLines(set)
      .filter((l) => /^(runtime|build)\//.test(l))
      .map((l) => {
        const name = l.slice(0, l.lastIndexOf("|"));
        return /^(build\/|runtime\/claude\.exe$|runtime\/codex\/)/.test(name) ? l : name;
      });
    assert.deepEqual(got, golden[set]);
  });

  test(`${set}: the shell key is the hash of the scheme and the shell input lines`, () => {
    const lines = pwsh(`(Get-FalconShellInputLines -RepoRoot '${root}' -Runtimes ${set} | ForEach-Object { $_ }) -join "\`n"`);
    const key = pwsh(`Get-FalconShellKey -RepoRoot '${root}' -Runtimes ${set}`);
    assert.equal(key, sha(`falcon-shell-key/3\n${lines}\n`));
  });
}
