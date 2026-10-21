// Probe-pin: verifies and bumps the Bare Claude pin with no manual Bare tab. Run by /swap when pending.ps1's `pin` line
// says stale=yes.
//
// Usage: node tools/bare/probe-pin.mjs
//
// Reads the installed `claude --version` and profiles/bare/claude.json `verifiedVersion`.
//   equal  -> prints "pin current", exits 0.
//   newer  -> runs the ignored cargo test `probe_pin_runs_one_real_raw_bare_turn` (src-tauri/src/bare/tests.rs): the
//             real `bare::prepare` env and args, one `claude -p` turn of verify-pin's PROMPT in a temp cwd holding a
//             canary CLAUDE.md, the launch manifest written with the final env names (a test, never vidar.exe). It
//             writes a manifest and a transcript into the real Bare home. Then runs
//             `node tools/bare/verify-pin.mjs --write` and passes its exit code and output through (0 all PASS and the
//             pin rewritten; 1 a FAIL; 2 nothing to check; 3 an UNKNOWN).
// Never commits: the caller commits profiles/bare/claude.json with the subject and body verify-pin printed.
// Refuses: claude or the profile unreadable, or the probe test failing (exit 2, cargo output shown).
// Never launches Vidar. The Codex pin is out of scope.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT } from "./verify-pin.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (msg) => { console.error(msg); process.exit(2); };

const pin = JSON.parse(readFileSync(join(REPO, "profiles", "bare", "claude.json"), "utf8").replace(/^﻿/, "")).verifiedVersion;
const ver = spawnSync("claude", ["--version"], { encoding: "utf8", shell: true });
const installed = /(\d+\.\d+\.\d+\S*)/.exec(ver.stdout ?? "")?.[1];
if (!installed || !pin) fail(`Cannot read versions (installed ${installed ?? "unreadable"}, pin ${pin ?? "unreadable"}).`);
if (installed === pin) {
  console.log(`pin current (claude ${installed})`);
  process.exit(0);
}
console.log(`claude ${installed} installed, pin ${pin}: probing`);

const probe = spawnSync(
  "cargo",
  ["test", "--manifest-path", join(REPO, "src-tauri", "Cargo.toml"), "probe_pin_runs_one_real_raw_bare_turn", "--", "--ignored", "--nocapture", "--test-threads=1"],
  { cwd: REPO, encoding: "utf8", env: { ...process.env, VIDAR_PROBE_PROMPT: PROMPT }, timeout: 900000 },
);
if (probe.status !== 0) {
  console.error(`${probe.stdout ?? ""}${probe.stderr ?? ""}`.split("\n").slice(-30).join("\n"));
  fail("The probe test failed; pin left as is.");
}

const v = spawnSync(process.execPath, [fileURLToPath(new URL("./verify-pin.mjs", import.meta.url)), "--write"], { cwd: REPO, encoding: "utf8" });
process.stdout.write(v.stdout ?? "");
process.stderr.write(v.stderr ?? "");
process.exit(v.status ?? 2);
