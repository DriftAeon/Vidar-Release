// check-zip.ps1 resolves the set a zip was built with: set.json beside the zip first (the wrapper's
// ad-hoc <base>-custom sets live only there), then tools/release/sets/<id>.json, else it refuses.
// Runs the real script against a small temp zip (Vidar/ top folder, base paths, release-manifest.json).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "tools", "sandbox", "check-zip.ps1");
const hasPwsh = process.platform === "win32" && !spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).error;
const setsDir = join(root, "tools", "release", "sets");
const skip = !hasPwsh ? "needs pwsh on Windows"
  : !existsSync(join(setsDir, "codex.json")) ? "tools/release/sets/codex.json is not in this tree (release sets are not shipped)" : false;

// The pre-commit gate exports GIT_DIR and friends, which would point the script's repo lookup elsewhere.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

function pwsh(...args) {
  return spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { encoding: "utf8", env });
}

// Temp dir holding `src/Vidar/...` (zipped to out/x.zip). Returns the paths.
function makeZip(setId) {
  const tmp = mkdtempSync(join(tmpdir(), "check-zip-set-"));
  const top = join(tmp, "src", "Vidar");
  for (const d of ["contracts", join("plugins", "vidar-app"), join("tools", "sandbox")]) mkdirSync(join(top, d), { recursive: true });
  for (const f of ["vidar.exe", join("contracts", "a.json"), join("plugins", "vidar-app", "a.txt"), join("tools", "sandbox", "launch.ps1")]) {
    writeFileSync(join(top, f), "x");
  }
  writeFileSync(join(top, "release-manifest.json"), JSON.stringify({ set: { id: setId } }));
  const out = join(tmp, "out");
  mkdirSync(out);
  const zip = join(out, "x.zip");
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CZ_SRC, $env:CZ_ZIP, 'Optimal', $true)"], {
    encoding: "utf8",
    env: { ...process.env, CZ_SRC: top, CZ_ZIP: zip },
  });
  assert.equal(r.status, 0, r.stderr);
  return { tmp, out, zip };
}

const check = (zip) => pwsh("-File", script, "-Zip", zip);

test("check-zip reads a custom set.json beside the zip", { skip }, () => {
  const z = makeZip("codex-custom");
  try {
    const set = JSON.parse(readFileSync(join(root, "tools", "release", "sets", "codex.json"), "utf8"));
    writeFileSync(join(z.out, "set.json"), JSON.stringify({ ...set, id: "codex-custom" }));
    const r = check(z.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /set source: .*set\.json \(beside the zip\)/);
  } finally {
    rmSync(z.tmp, { recursive: true, force: true });
  }
});

test("check-zip refuses a custom id with no set.json and no named set", { skip }, () => {
  const z = makeZip("codex-custom");
  try {
    const r = check(z.zip);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL: set codex-custom: no set\.json beside the zip and no tools\/release\/sets\/codex-custom\.json/);
  } finally {
    rmSync(z.tmp, { recursive: true, force: true });
  }
});

test("check-zip still resolves a named set by id", { skip }, () => {
  const z = makeZip("codex");
  try {
    const r = check(z.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /set source: .*codex\.json \(by name\)/);
  } finally {
    rmSync(z.tmp, { recursive: true, force: true });
  }
});
