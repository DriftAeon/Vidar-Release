// Hermetic: no Codex spawn. sameSurface ignores only the version; mergeAccepted keeps other keys.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sameSurface } from "../tools/codex-schema/manifest.mjs";
import { mergeAccepted } from "../tools/codex-schema/verify.mjs";

const manifest = JSON.parse(readFileSync(new URL("../tools/codex-schema/manifest.json", import.meta.url), "utf8"));

test("sameSurface ignores the version and sees one changed method", () => {
  assert.equal(sameSurface(manifest, { ...manifest, codexVersion: "9.9.9" }), true);
  const changed = structuredClone(manifest);
  changed.clientRequests[0].paramsSha256 = "0".repeat(64);
  assert.equal(sameSurface(manifest, changed), false);
  const removed = structuredClone(manifest);
  removed.notifications.pop();
  assert.equal(sameSurface(manifest, removed), false);
});

test("mergeAccepted creates the file, keeps other keys and leaves no tmp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vidar-codex-accepted-"));
  try {
    const file = join(dir, "sub", "codex-accepted.json");
    mergeAccepted(file, "0.163.0", { pinned: "0.162.1", same: true, atMs: 1 });
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), "0.160.0": { pinned: "0.159.0", same: false, atMs: 0 } }));
    const merged = mergeAccepted(file, "0.164.0", { pinned: "0.162.1", same: false, atMs: 2 });
    assert.deepEqual(Object.keys(merged).sort(), ["0.160.0", "0.163.0", "0.164.0"]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), merged);
    assert.deepEqual(readdirSync(join(dir, "sub")), ["codex-accepted.json"]);
    writeFileSync(file, "not json");
    assert.deepEqual(Object.keys(mergeAccepted(file, "0.165.0", { pinned: "x", same: true, atMs: 3 })), ["0.165.0"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
