// One JSON read and one atomic write for the tools folder.
// Usage: import { readJson, writeJsonAtomic, writeTextAtomic } from "../lib/json.mjs";
//   readJson(path)            parsed file, a leading BOM stripped; throws on a missing or invalid file.
//   readJson(path, fallback)  the same, but any read or parse failure returns `fallback` (null included).
//   writeJsonAtomic(path, value, { compact })  pretty JSON plus a newline (compact: JSON.stringify alone).
//   writeTextAtomic(path, text)                a sibling temp file, then a rename that waits out a scanner hold.
// Refuses: nothing itself; the parent folder must exist (callers mkdir), and a failed rename leaves the temp file.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { renameWithRetry } from "./rename-retry.mjs";

export function readJson(path, ...fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    if (fallback.length === 0) throw err;
    return fallback[0];
  }
}

export function writeTextAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameWithRetry(tmp, path);
}

export function writeJsonAtomic(path, value, { compact = false } = {}) {
  writeTextAtomic(path, compact ? JSON.stringify(value) : JSON.stringify(value, null, 2) + "\n");
}
