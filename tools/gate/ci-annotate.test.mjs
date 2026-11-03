// ci-annotate.ps1: one ::error annotation per failing test from a cargo or node:test TAP log.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./ci-annotate.ps1", import.meta.url));

function annotate(kind, log, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "ci-annotate-"));
  try {
    const file = join(dir, "log.txt");
    writeFileSync(file, log);
    const r = spawnSync("pwsh", ["-NoProfile", "-File", SCRIPT, "-Kind", kind, "-Log", file, "-Title", "Vidar test", ...extra], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split(/\r?\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CARGO = `running 3 tests
test a::ok ... ok
test a::bad ... FAILED
test b::quiet ... FAILED

failures:

---- a::bad stdout ----

thread 'a::bad' (20400) panicked at src\\a.rs:10:5:
assertion \`left == right\` failed: home, dir
  left: 1
 right: 2
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    a::bad
    b::quiet

test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out
`;

test("cargo: one annotation per failing test, first panic line, escaped", () => {
  assert.deepEqual(annotate("cargo", CARGO), [
    "::error title=Vidar test::a::bad: assertion `left == right` failed: home, dir (src\\a.rs:10:5)",
    "::error title=Vidar test::b::quiet",
  ]);
});

test("cargo: a crashed test binary and the cap", () => {
  const log = "error: test failed, to rerun pass `--lib`\n\nCaused by:\n  process didn't exit successfully: `D:\\t\\debug\\deps\\vidar_lib-0123456789abcdef.exe` (exit code: 0xc00000fd, STATUS_STACK_OVERFLOW)\n";
  const [line] = annotate("cargo", log);
  assert.match(line, /^::error title=Vidar test::vidar_lib \(crashed\): `D/);
  assert.deepEqual(annotate("cargo", CARGO, ["-Max", "1", "-Plain"]), [
    "FAIL a::bad: assertion `left == right` failed: home, dir (src\\a.rs:10:5)",
    "FAIL 1 more failing tests not shown",
  ]);
});

test("cargo: nothing parsed still annotates", () => {
  assert.match(annotate("cargo", "error[E0425]: cannot find value `x`\n")[0], /compile error 1: error\[E0425\]/);
  assert.match(annotate("cargo", "nothing here\n")[0], /\(unparsed\)/);
});

const TAP = `TAP version 13
# Subtest: suite
    # Subtest: inner fails
    not ok 1 - inner fails
      ---
      duration_ms: 1
      type: 'test'
      location: 'file:///D:/r/tests/x.test.mjs:5:3'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        1 !== 2
      code: 'ERR_ASSERTION'
      ...
    1..1
not ok 1 - suite
  ---
  duration_ms: 2
  type: 'suite'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
# Subtest: top
not ok 2 - top
  ---
  duration_ms: 1
  type: 'test'
  location: 'D:\\\\r\\\\tools\\\\y.test.mjs:9:1'
  failureType: 'testCodeFailure'
  error: "it's missing"
  code: 'ERR_TEST_FAILURE'
  stack: |-
    TestContext.<anonymous> (file:///D:/r/tools/y.test.mjs:9:27)
  ...
# Subtest: quoted
not ok 3 - quoted
  ---
  duration_ms: 1
  type: 'test'
  failureType: 'testCodeFailure'
  error: 'it''s single'
  ...
ok 4 - fine
`;

test("node: leaf failures only, with file and line", () => {
  assert.deepEqual(annotate("node", TAP), [
    "::error title=Vidar test::inner fails [x.test.mjs:5]: Expected values to be strictly equal: 1 !== 2",
    "::error title=Vidar test::top [y.test.mjs:9]: it's missing",
    "::error title=Vidar test::quoted: it's single",
  ]);
});
