// Shared rig for tests/falcon-prune-*.test.mjs: temp Vidar root + temp LOCALAPPDATA, and a runner for the real script.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../tools/release/falcon-prune.ps1", import.meta.url));
const hasPwsh = process.platform === "win32" && !spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).error;
// falcon-prune.ps1 ships in the public tree (.gitattributes un-ignores it); the absence guard stays for trimmed trees.
export const skip = !hasPwsh ? "needs pwsh on Windows"
  : !existsSync(SCRIPT) ? "tools/release/falcon-prune.ps1 is not in this tree (not shipped)" : false;
export const id = (c) => `0.1.0-${c.repeat(16)}`;

// a registry, b previous, c current, d old (deleted), e no manifest, f newer than current (in flight).
export function makeTree() {
  const tmp = mkdtempSync(join(tmpdir(), "vidar-prune-"));
  const root = join(tmp, "vidar");
  const lad = join(tmp, "lad");
  const falcon = join(root, "runtime", "bridge", "falcon");
  mkdirSync(join(root, "src-falcon"), { recursive: true });
  writeFileSync(join(root, "src-falcon", "tauri.conf.json"), JSON.stringify({ identifier: "test.falcon" }));
  for (const [c, day] of [["a", 1], ["b", 2], ["c", 3], ["d", 0], ["f", 5]]) {
    mkdirSync(join(falcon, "bundles", id(c)), { recursive: true });
    writeFileSync(join(falcon, "bundles", id(c), "runtime-manifest.json"), JSON.stringify({ bundle_id: id(c), created_utc: `2026-09-0${day + 1}T00:00:00.0000000Z` }));
  }
  mkdirSync(join(falcon, "bundles", id("e")));
  writeFileSync(join(falcon, "current.json"), JSON.stringify({ bundle_id: id("c"), executable: "x", previous_bundle_id: id("b") }));
  mkdirSync(join(falcon, "runtime"));
  writeFileSync(join(falcon, "runtime", "registry.json"), JSON.stringify({ bundle_id: id("a"), pid: 0 }));
  for (const name of [id("a"), id("d"), "0.1.0-99999999", "EBWebView", "notes"]) mkdirSync(join(lad, "test.falcon", name), { recursive: true });
  mkdirSync(join(falcon, "prune-trash", "leftover"), { recursive: true });
  return { tmp, root, lad, falcon };
}

export function run(t, ...extra) {
  const r = spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Json", "-Root", t.root, "-LocalAppData", t.lad, ...extra], { encoding: "utf8" });
  const line = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
  return { status: r.status, stderr: r.stderr, out: JSON.parse(line) };
}
