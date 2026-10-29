// The staged Falcon frontend manifest contract, as written by
// tools/release/falcon-frontend-stage.ps1. The fixture is shared with the Rust side
// (src-falcon/src/frontend.rs #[test] reads tests/fixtures/falcon-frontend-manifest.json).
// Digest choice, frozen: SHA-256 of "<path>|<sha256>" lines joined with "\n", NO trailing newline.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/falcon-frontend-manifest.json", import.meta.url), "utf8"));
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const digestOf = (files) => sha(files.map((f) => `${f.path}|${f.sha256}`).join("\n"));

test("manifest shape", () => {
  assert.equal(fixture.schema, 1);
  assert.deepEqual(Object.keys(fixture), ["schema", "digest", "shell_key", "files"]);
  assert.match(fixture.digest, /^[0-9a-f]{64}$/);
  assert.match(fixture.shell_key, /^[0-9a-f]{64}$/);
  for (const f of fixture.files) {
    assert.deepEqual(Object.keys(f), ["path", "sha256", "bytes"]);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(f.bytes) && f.bytes >= 0);
    assert.ok(!f.path.includes("\\") && !f.path.startsWith("/"), f.path);
  }
});

test("paths are sorted ordinally", () => {
  const paths = fixture.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

test("digest recomputes: lines joined with \\n, no trailing newline", () => {
  assert.equal(digestOf(fixture.files), fixture.digest);
  const withTrailing = sha(fixture.files.map((f) => `${f.path}|${f.sha256}`).join("\n") + "\n");
  assert.notEqual(withTrailing, fixture.digest);
});
