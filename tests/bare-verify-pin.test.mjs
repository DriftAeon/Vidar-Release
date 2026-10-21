// tools/bare/verify-pin.mjs: the five checks, the no-check-turn prompt and --write, on fixtures under a temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "tools", "bare", "verify-pin.mjs");
const V = "9.8.7";

const PROFILE = `{
  "id": "bare",
  "verifiedVersion": "1.0.0",
  "overlay": { "TEMP": "x", "CLAUDE_CONFIG_DIR": "x" },
  "after": "kept"
}
`;

// opts: env, version, mode, loads, canary, turn ("in" | "out" | "none"), manifestVersion
function fixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "vidar-verify-pin-"));
  const home = join(root, "home");
  const cwd = join(root, "work");
  mkdirSync(join(home, "manifests"), { recursive: true });
  mkdirSync(join(home, "claude-config", "projects", "p"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (opts.canary !== false) writeFileSync(join(cwd, "CLAUDE.md"), "canary\n");
  const profile = join(root, "claude.json");
  writeFileSync(profile, PROFILE);
  const manifest = {
    agent: "claude", createdUtc: "2020-01-01T00:00:00Z",
    binary: { version: opts.manifestVersion === undefined ? V : opts.manifestVersion },
    envNames: opts.env ?? ["Path", "TEMP", "CLAUDE_CONFIG_DIR", "VIDAR_TAB_NAME", "HOMEDRIVE"],
    homes: { home, claudeConfig: join(home, "claude-config") },
  };
  writeFileSync(join(home, "manifests", "2026-01-01T000000000Z-s1-1.json"), JSON.stringify(manifest));
  const lines = [{ type: "user", cwd, version: opts.version ?? V, permissionMode: opts.mode ?? "auto" }];
  for (let i = 0; i < (opts.loads ?? 0); i++) lines.push({ type: "attachment", attachment: { type: "instructions" } });
  const turn = opts.turn ?? "in";
  if (turn !== "none") {
    const out = turn === "in" ? join(home, "user-home", "Temp") + "\\" : "Z:\\elsewhere\\Temp\\";
    lines.push({ type: "user", toolUseResult: { stdout: out + "\r\n", stderr: "", interrupted: false, isImage: false } });
  }
  const transcript = join(home, "claude-config", "projects", "p", "t.jsonl");
  writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { root, home, profile, transcript };
}

function run(f, extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, "--home", f.home, "--profile", f.profile, ...extra], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function with_(opts, fn) {
  const f = fixture(opts);
  try { fn(f); } finally { rmSync(f.root, { recursive: true, force: true }); }
}

test("all five checks pass: exit 0 and the commit subject", () => {
  with_({}, (f) => {
    const r = run(f);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal((r.out.match(/^PASS /gm) ?? []).length, 5);
    assert.match(r.out, /^\[Chore\] Bare - Verify Claude 9\.8\.7$/m);
  });
});

const FAILS = [
  ["env: a dropped name", { env: ["Path", "ANTHROPIC_API_KEY"] }, "1 env"],
  ["env: an unlisted name", { env: ["Path", "SOME_SECRET"] }, "1 env"],
  ["version differs", { version: "9.9.9" }, "2 version"],
  ["instruction loads present", { loads: 2 }, "3 loads"],
  ["permission mode not auto", { mode: "default" }, "4 mode"],
  ["temp path outside the home", { turn: "out" }, "5 temp"],
];
for (const [name, opts, row] of FAILS) {
  test(`fails when ${name}`, () => {
    with_(opts, (f) => {
      const r = run(f);
      assert.equal(r.code, 1, r.out + r.err);
      assert.match(r.out, new RegExp(`^FAIL\\s+${row}`, "m"));
      assert.doesNotMatch(r.out, /\[Chore\]/);
    });
  });
}

test("the default manifest is the newest Raw one, skipping a newer hosted one", () => {
  with_({}, (f) => {
    const hosted = { agent: "claude", createdUtc: "2020-01-01T00:00:00Z", binary: {}, envNames: ["Path", "SOME_SECRET"], homes: { home: f.home } };
    writeFileSync(join(f.home, "manifests", "2027-01-01T000000000Z-s2-1.json"), JSON.stringify(hosted));
    const r = run(f);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /2026-01-01T000000000Z-s1-1\.json/);
  });
});

test("no Raw manifest exits 2 asking for a Raw Bare tab", () => {
  with_({ manifestVersion: null }, (f) => {
    const r = run(f);
    assert.equal(r.code, 2);
    assert.match(r.err, /Raw Bare tab is needed/);
  });
});

test("no canary file is UNKNOWN, not PASS", () => {
  with_({ canary: false }, (f) => {
    const r = run(f);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.out, /^UNKNOWN\s+3 loads/m);
  });
});

test("no check turn prints the prompt and exits 2", () => {
  with_({ turn: "none" }, (f) => {
    const r = run(f);
    assert.equal(r.code, 2);
    assert.ok(r.out.includes('Run pwsh -NoProfile -Command "[IO.Path]::GetTempPath()" and reply with only its output.'));
  });
});

test("--write changes only the verifiedVersion line, and only on all PASS", () => {
  with_({}, (f) => {
    const r = run(f, ["--write"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(readFileSync(f.profile, "utf8"), PROFILE.replace('"1.0.0"', `"${V}"`));
  });
  with_({ mode: "default" }, (f) => {
    run(f, ["--write"]);
    assert.equal(readFileSync(f.profile, "utf8"), PROFILE, "a failing run writes nothing");
  });
});
