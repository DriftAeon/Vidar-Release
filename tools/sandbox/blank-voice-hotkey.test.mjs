// tools/sandbox/blank-voice-hotkey.mjs: voice.hotkey becomes "" with every other key and voice field kept, an absent
// file is created with just that key, a dry run writes nothing, bad JSON is refused, no BOM; launch.ps1 calls it after the seeds.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "../lib/paths.mjs";
import { blankVoiceHotkey } from "./blank-voice-hotkey.mjs";

const fresh = () => realpathSync.native(mkdtempSync(join(tmpdir(), "blank-hotkey-")));
const config = (base) => resolve("config", { root: join(base, "app") });

test("keeps other keys and voice fields, blanks the hotkey", () => {
  const base = fresh();
  try {
    mkdirSync(dirname(config(base)), { recursive: true });
    writeFileSync(config(base), '{"theme":"dark","voice":{"hotkey":"Ctrl+Shift+G","model":"base"}}');
    assert.equal(blankVoiceHotkey({ base }).code, 0);
    const buf = readFileSync(config(base));
    assert.notEqual(buf[0], 0xef);
    assert.deepEqual(JSON.parse(buf.toString("utf8")), { theme: "dark", voice: { hotkey: "", model: "base" } });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("creates the file with just the key when absent", () => {
  const base = fresh();
  try {
    assert.equal(blankVoiceHotkey({ base }).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(config(base), "utf8")), { voice: { hotkey: "" } });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("dry run writes nothing and bad JSON is refused untouched", () => {
  const base = fresh();
  try {
    assert.equal(blankVoiceHotkey({ base, dryRun: true }).code, 0);
    assert.equal(existsSync(config(base)), false);
    mkdirSync(dirname(config(base)), { recursive: true });
    writeFileSync(config(base), "{nope");
    assert.equal(blankVoiceHotkey({ base }).code, 2);
    assert.equal(readFileSync(config(base), "utf8"), "{nope");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("launch.ps1 calls the helper after the seeds and before the start", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "launch.ps1"), "utf8");
  const seed = src.indexOf("if ($Seed) { Invoke-Seed $prof }");
  const blank = src.indexOf("blank-voice-hotkey.mjs", seed);
  const start = src.indexOf("Start-CleanProcess -FilePath $exe");
  assert.ok(seed > 0 && blank > seed && start > blank);
});
