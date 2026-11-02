// Blank the sandbox's voice hotkey so its voice_register never fights the live app for the global chord.
// launch.ps1 runs this last (after the app copy and every seed), so no seed overwrites it.
// Usage: node tools/sandbox/blank-voice-hotkey.mjs --to <base> [--dry-run]
// Sets voice.hotkey to "" in <base>\app\vidar.json, keeping every other key and the rest of `voice`;
// creates the file with just that key when absent. UTF-8 without BOM. An unreadable vidar.json is refused (exit 2).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "../lib/paths.mjs";

export function blankVoiceHotkey({ base, dryRun = false }) {
  const file = resolve("config", { root: join(base, "app") });
  let cfg = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    } catch (e) {
      return { code: 2, file, msg: `REFUSED: ${file} is not valid JSON (${e.message}).` };
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { code: 2, file, msg: `REFUSED: ${file} is not a JSON object.` };
  }
  const voice = cfg.voice && typeof cfg.voice === "object" && !Array.isArray(cfg.voice) ? cfg.voice : {};
  cfg.voice = { ...voice, hotkey: "" };
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }
  return { code: 0, file, msg: `voice hotkey: blanked in ${file}${dryRun ? " (dry run, nothing written)" : ""}` };
}

if (process.argv[1] && pathResolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--to");
  if (i < 0 || !args[i + 1]) {
    console.error("REFUSED: usage: node tools/sandbox/blank-voice-hotkey.mjs --to <base> [--dry-run]");
    process.exit(2);
  }
  const r = blankVoiceHotkey({ base: pathResolve(args[i + 1]), dryRun: args.includes("--dry-run") });
  (r.code ? console.error : console.log)(r.msg);
  process.exit(r.code);
}
