import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { globalRunesDir } from "./paths.mjs";

const HOME = join("C:", "home", "u");
const claude = join(HOME, ".claude");

test("Claude home present: its runes folder", () => {
  const got = globalRunesDir({ USERPROFILE: HOME, CODEX_HOME: join("D:", "cx") }, (p) => p === claude);
  assert.equal(got, join(claude, "runes"));
});

test("Claude home absent, CODEX_HOME set: its runes folder", () => {
  const cx = join("D:", "cx");
  assert.equal(globalRunesDir({ USERPROFILE: HOME, CODEX_HOME: cx }, () => false), join(cx, "runes"));
});

test("Claude home absent, CODEX_HOME empty: ~/.codex/runes", () => {
  assert.equal(
    globalRunesDir({ USERPROFILE: HOME, CODEX_HOME: "" }, () => false),
    join(HOME, ".codex", "runes"),
  );
});
