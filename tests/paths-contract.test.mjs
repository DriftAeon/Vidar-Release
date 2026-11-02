// Layout contract (contracts/paths.json): hard-coded layout paths may only fall in number.
// The scan matches whole quoted literals only (see tools/lib/paths-scan.mjs); lower the allowlist
// with `node tools/gate/paths-allow.mjs --write`.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ids, resolve as resolveNode } from "../tools/lib/paths.mjs";
import { scanRepo, scanText } from "../tools/lib/paths-scan.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("layout literals do not rise above the allowlist", () => {
  const allow = JSON.parse(readFileSync(new URL("./paths-contract.allow.json", import.meta.url), "utf8"));
  const bad = [];
  for (const [id, n] of scanRepo(ROOT)) {
    const cap = allow[id]?.count;
    if (cap === undefined) bad.push(`${id}: ${n} (not in allowlist)`);
    else if (n > cap) bad.push(`${id}: ${n} > ${cap}`);
  }
  assert.deepEqual(bad, [], "route these through the paths contract instead of a literal");
});

test("the scan detects a seeded literal, either separator", () => {
  const counts = scanText(
    [
      `const a = join(root, "runtime\\\\bridge\\\\display");`,
      `const b = 'runtime/bridge/review';`,
      `$c = 'runtime\\bridge\\clips'`,
      `const d = "./runtime/window-state.json";`,
    ].join("\n"),
  );
  assert.deepEqual(
    [...counts].sort(),
    [["clips", 1], ["display", 1], ["review", 1], ["windowState", 1]],
  );
});

test("a stale multi-segment tail or a full chain inside a longer literal counts", () => {
  // The layout before bridge moved under runtime: the tail without its topmost ancestor.
  assert.equal(scanText(`$b = Join-Path $vidar "bridge\\falcon\\bundles"`).get("falconBundles"), 1);
  assert.equal(scanText(`const p = "bridge/falcon/bundles/b1/falcon.exe";`).get("falconBundles"), 1);
  // The full chain inside a longer literal.
  assert.equal(scanText(`const p = "{vidar}\\\\runtime\\\\bridge\\\\display";`).get("display"), 1);
  assert.equal(scanText(`const p = \`\${root}/runtime/bridge/falcon/bundles/x\`;`).get("falconBundles"), 1);
  // One count per literal; a single-segment tail and a mid-word match do not count.
  assert.equal(scanText(`"runtime/bridge/falcon/bundles"`).size, 1);
  assert.equal(scanText(`const a = "falcon/bundlesx"; const b = "xbridge/falcon/bundles";`).size, 0);
});

test("the old release-zip bundle literal is flagged, HEAD's script is clean", () => {
  const old = execFileSync("git", ["show", "58843bef^:tools/release/release-zip.ps1"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(scanText(old).get("falconBundles"), 1);
  const now = readFileSync(join(ROOT, "tools", "release", "release-zip.ps1"), "utf8");
  assert.equal(scanText(now).size, 0);
});

test("module specifiers do not count, a plain literal still does", () => {
  assert.equal(scanText(`import { S } from "./runtime/state";`).size, 0);
  assert.equal(scanText(`const s = "./runtime/state";`).get("state"), 1);
  assert.equal(scanText(`let p = PathBuf::from("./runtime/state");`).get("state"), 1);
});

test("TypeScript type literals are skipped while values and Rust literals count", () => {
  const types = [
    `export type Kind = "content"`,
    `  | "state";`,
    `const annotated: "content" | "state" = "content";`,
    `interface Entry {`,
    `  kind: "content" | "state";`,
    `  path: "content";`,
    `}`,
    `type Shape = { kind: "content" };`,
  ].join("\n");
  assert.deepEqual([...scanText(types)], [["content", 1]]);
  assert.equal(scanText(`const k: Kind = "content";`).get("content"), 1);
  assert.equal(scanText(`const entry = { kind: "content" };`).get("content"), 1);
  assert.equal(scanText(`let k: &str = "content";`).get("content"), 1);
});

test("resolve is the contract rel under the root, whatever exists on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "paths-"));
  try {
    mkdirSync(join(dir, "tools"), { recursive: true });
    mkdirSync(join(dir, "contracts"), { recursive: true });
    copyFileSync(join(ROOT, "contracts", "paths.json"), join(dir, "contracts", "paths.json"));
    const leaf = resolveNode("reviewDispatch", { root: dir });
    assert.ok(leaf.startsWith(join(dir, "runtime", "bridge")), "nothing exists: runtime layout");
    mkdirSync(join(dir, "bridge"));
    assert.equal(resolveNode("reviewDispatch", { root: dir }), leaf, "a root-level bridge dir is ignored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runeImports is runtime/runes, apart from the root runes library", () => {
  assert.deepEqual(ids().runeImports, { under: "runtime", rel: "runes" });
  const dir = mkdtempSync(join(tmpdir(), "paths-"));
  try {
    mkdirSync(join(dir, "contracts"), { recursive: true });
    copyFileSync(join(ROOT, "contracts", "paths.json"), join(dir, "contracts", "paths.json"));
    assert.equal(resolveNode("runeImports", { root: dir }), join(dir, "runtime", "runes"));
    assert.equal(resolveNode("runes", { root: dir }), join(dir, "runes"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runeSkills is runtime/rune-skills", () => {
  assert.deepEqual(ids().runeSkills, { under: "runtime", rel: "rune-skills" });
  const dir = mkdtempSync(join(tmpdir(), "paths-"));
  try {
    mkdirSync(join(dir, "contracts"), { recursive: true });
    copyFileSync(join(ROOT, "contracts", "paths.json"), join(dir, "contracts", "paths.json"));
    assert.equal(resolveNode("runeSkills", { root: dir }), join(dir, "runtime", "rune-skills"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Node and PowerShell readers agree on every id", { skip: !process.env.VIDAR_FULL_GATE }, () => {
  const list = Object.keys(ids()).map((id) => `'${id}'`).join(",");
  const cmd = `. '${ROOT}/tools/lib/Paths.ps1'; $o = [ordered]@{}; ` +
    `foreach ($id in @(${list})) { $o[$id] = Resolve-VidarPath -Id $id }; ` +
    `$o | ConvertTo-Json -Compress`;
  const fromPs = JSON.parse(execFileSync("pwsh", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }));
  const norm = (p) => p.replace(/\\/g, "/");
  for (const id of Object.keys(ids())) assert.equal(norm(fromPs[id]), norm(resolveNode(id)), id);
});
