// Read-BuildInfo (tools/release/build-info.ps1) finds the embedded build marker in exe bytes (audit H8),
// and swap-release.ps1 -DryRun judges a staged exe by its stamp. Drives pwsh against synthetic files in %TEMP%.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hasPwsh = process.platform === "win32" && spawnSync("pwsh", ["-NoProfile", "-Command", "1"]).status === 0;
const lib = resolve("tools/release/build-info.ps1");
const swap = resolve("tools/release/swap-release.ps1");
// Release tooling does not ship: skip with the missing path named when the script is absent.
const skipFor = (file, rel) => !hasPwsh ? "needs pwsh on Windows" : !existsSync(file) ? `${rel} is not in this tree (not shipped)` : false;
const skip = skipFor(lib, "tools/release/build-info.ps1");
const skipSwap = skipFor(swap, "tools/release/swap-release.ps1");
const MARK = '{"customProtocol":true,"optLevel":"1","debugAssertions":false,"profile":"release"}';

function readInfo(file) {
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", `. '${lib}'; $r = Read-BuildInfo '${file}'; if ($null -eq $r) { 'NULL' } else { $r | ConvertTo-Json -Compress }`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function tmp() { return mkdtempSync(join(tmpdir(), "vidar-bi-")); }
function junk(n, fill = 0x41) { return Buffer.alloc(n, fill); }

test("Read-BuildInfo finds the marker in a synthetic byte file", { skip }, () => {
  const d = tmp();
  try {
    const f = join(d, "a.exe");
    writeFileSync(f, Buffer.concat([junk(5000), Buffer.from(`VIDAR-BUILD-INFO ${MARK}\n`), junk(5000, 0)]));
    assert.deepEqual(JSON.parse(readInfo(f)), JSON.parse(MARK));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("Read-BuildInfo finds a marker that straddles an 8 MB chunk boundary", { skip }, () => {
  const d = tmp();
  try {
    const f = join(d, "big.exe");
    const at = 8 * 1024 * 1024 - 20;
    writeFileSync(f, Buffer.concat([junk(at, 0), Buffer.from(`VIDAR-BUILD-INFO ${MARK}\n`), junk(3000, 0)]));
    assert.equal(JSON.parse(readInfo(f)).optLevel, "1");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("Read-BuildInfo returns null when the marker is absent", { skip }, () => {
  const d = tmp();
  try {
    const f = join(d, "b.exe");
    writeFileSync(f, junk(10000));
    assert.equal(readInfo(f), "NULL");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("Read-BuildInfo returns null for malformed JSON, and skips it for a later good marker", { skip }, () => {
  const d = tmp();
  try {
    const bad = join(d, "c.exe");
    writeFileSync(bad, Buffer.concat([junk(100), Buffer.from('VIDAR-BUILD-INFO {"customProtocol":tru\n'), junk(100)]));
    assert.equal(readInfo(bad), "NULL");
    const unterminated = join(d, "e.exe");
    writeFileSync(unterminated, Buffer.concat([junk(100), Buffer.from(`VIDAR-BUILD-INFO ${MARK}`)]));
    assert.equal(readInfo(unterminated), "NULL");
    const both = join(d, "d.exe");
    writeFileSync(both, Buffer.concat([Buffer.from("VIDAR-BUILD-INFO {oops\n"), junk(50), Buffer.from(`VIDAR-BUILD-INFO ${MARK}\n`)]));
    assert.equal(JSON.parse(readInfo(both)).customProtocol, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

function dry(staged, live) {
  return spawnSync("pwsh", ["-NoProfile", "-File", swap, "-DryRun", "-Staged", staged, "-Live", live], { encoding: "utf8", env: { ...process.env, VIDAR_TAB: "" } });
}
function stage(d, name, body, stamp) {
  const exe = join(d, name);
  writeFileSync(exe, body);
  if (stamp) writeFileSync(`${exe}.head`, JSON.stringify({ head: "abcdef0123", dirty: false, exe_sha256: createHash("sha256").update(body).digest("hex"), ...stamp }));
  return exe;
}

test("swap-release -DryRun accepts a stamped custom-protocol exe and refuses the rest", { skip: skipSwap },() => {
  const d = tmp();
  try {
    const live = join(d, "live.exe");
    const body = Buffer.concat([junk(300), Buffer.from(`VIDAR-BUILD-INFO ${MARK}\n`)]);
    const ok = dry(stage(d, "ok.exe", body, { build_info: JSON.parse(MARK) }), live);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /staged exe verified/);
    assert.match(ok.stdout, /would swap/);

    const none = dry(stage(d, "none.exe", body, null), live);
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /build-staged\.ps1/);

    const wrong = dry(stage(d, "wrong.exe", body, { exe_sha256: "00" }), live);
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /differs from its stamp/);

    const dev = dry(stage(d, "dev.exe", body, { build_info: { ...JSON.parse(MARK), customProtocol: false } }), live);
    assert.notEqual(dev.status, 0);
    assert.match(dev.stderr, /customProtocol is not true/);

    const nomark = dry(stage(d, "nomark.exe", body, { build_info: null }), live);
    assert.notEqual(nomark.status, 0);
    assert.match(nomark.stderr, /no build_info/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
