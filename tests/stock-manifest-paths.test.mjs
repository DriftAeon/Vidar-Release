// Layout contract (contracts/paths.json): every {vidar}/... path in a stock pack manifest must sit
// under a path the contract names, so a folder move that leaves a manifest on the old layout
// (e.g. {vidar}/vendor/whisper after vendor moved under content/) fails here, not as a missing file.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ids, rel } from "../tools/lib/paths.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKS = join(ROOT, "content", "packs");

const jsonFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? jsonFiles(join(dir, e.name)) : e.name.endsWith(".json") ? [join(dir, e.name)] : [],
  );

// Every string in the parsed JSON that contains a {vidar}/ path (also inside a longer sentence).
const strings = (v) =>
  typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

test("every {vidar}/ path in a stock manifest is under a contract path", () => {
  const roots = Object.keys(ids()).map(rel);
  let seen = 0;
  for (const file of jsonFiles(PACKS)) {
    for (const s of strings(JSON.parse(readFileSync(file, "utf8")))) {
      for (const m of s.matchAll(/\{vidar\}\/([^\s,"']+)/g)) {
        const p = m[1].replace(/[.:]+$/, "");
        seen++;
        assert.ok(
          roots.some((r) => p === r || p.startsWith(`${r}/`)),
          `${file}: {vidar}/${p} is not under any contracts/paths.json path`,
        );
      }
    }
  }
  assert.ok(seen > 0, "no {vidar}/ paths found in content/packs");
});

// Same rule for contracts/dependencies.json: a `kind: vidar` probe is root-relative and compiled
// into deps.rs, so a stale one hides a capability after a move (Speak, 2026-09-29).
test("every kind:vidar dependency probe file is under a contract path", () => {
  const roots = Object.keys(ids()).map(rel);
  const { deps } = JSON.parse(readFileSync(join(ROOT, "contracts", "dependencies.json"), "utf8"));
  const files = [];
  for (const d of deps.filter((d) => d.probe?.kind === "vidar")) {
    for (const f of d.probe.files) files.push(f.replaceAll("\\", "/"));
  }
  assert.ok(files.length > 0, "no kind:vidar probes found in contracts/dependencies.json");
  for (const p of files) {
    assert.ok(
      roots.some((r) => p === r || p.startsWith(`${r}/`)),
      `dependencies.json: ${p} is not under any contracts/paths.json path`,
    );
  }
});
