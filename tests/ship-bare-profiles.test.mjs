// The bare launch profiles and the gate plugin ship (tools/release/ship-list.txt) and no
// .gitattributes export-ignore drops them: export.ps1 archives the ship list with export-ignore
// applied on top, so either gap would leave a release whose Bare row refuses to spawn.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIPPED = ["profiles", "plugins/gate"];

// Release tooling and git metadata are absent from a source export or zip: skip, naming the path.
const skipShip = existsSync(new URL("../tools/release/ship-list.txt", import.meta.url)) ? false : "tools/release/ship-list.txt is not in this tree (not shipped)";
const skipGit = skipShip || (existsSync(new URL("../.git", import.meta.url)) ? false : ".git is not in this tree (export or zip)");

test("ship-list names the bare profiles and the gate plugin", { skip: skipShip }, () => {
  const lines = readFileSync(new URL("../tools/release/ship-list.txt", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const p of SHIPPED) assert.ok(lines.includes(p), `${p} missing from ship-list.txt`);
});

test("no export-ignore drops a tracked file under them", { skip: skipGit }, () => {
  const files = spawnSync("git", ["ls-files", "-z", "--", ...SHIPPED], { cwd: ROOT, encoding: "utf8" });
  assert.equal(files.status, 0, files.stderr);
  const list = files.stdout.split("\0").filter(Boolean);
  assert.ok(list.some((f) => f.startsWith("profiles/bare/")), "profiles/bare is not tracked");
  assert.ok(list.some((f) => f.startsWith("plugins/gate/")), "plugins/gate is not tracked");
  const attr = spawnSync("git", ["check-attr", "-z", "export-ignore", "--", ...list], { cwd: ROOT, encoding: "utf8" });
  assert.equal(attr.status, 0, attr.stderr);
  const parts = attr.stdout.split("\0");
  const ignored = [];
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === "set") ignored.push(parts[i]);
  assert.deepEqual(ignored, [], "export-ignore would drop these from the release");
});
