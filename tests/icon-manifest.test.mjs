// contracts/icons.json is the only list of colour icons: files, tool/backend maps and the
// generated PROVENANCE.md must agree with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderProvenance } from "../tools/icons/slot.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(repo, "contracts", "icons.json"), "utf8"));
const colorDir = join(repo, "public", "icons", "color");
const ext = (s) => s.slice(s.lastIndexOf(".")).toLowerCase();

test("every manifest icon has its file, with a registered set", () => {
  for (const [name, icon] of Object.entries(manifest.icons)) {
    assert.ok(existsSync(join(colorDir, name + ext(icon.source))), `missing file for ${name}`);
    assert.ok(manifest.sets[icon.source.split("/")[0]], `${name}: set not in sets`);
  }
});

test("every file in public/icons/color is in the manifest", () => {
  const expected = new Set(Object.entries(manifest.icons).map(([n, i]) => n + ext(i.source)));
  for (const f of readdirSync(colorDir)) {
    if (f === "PROVENANCE.md") continue;
    assert.ok(expected.has(f), `${f} is not in contracts/icons.json`);
  }
});

test("tools and backends point at manifest icons", () => {
  for (const kind of ["tools", "backends"]) {
    // a backend may list several icons (vidar-drive: app mark then steer); a tool names one
    for (const [k, vs] of Object.entries(manifest[kind])) for (const v of [vs].flat()) assert.ok(manifest.icons[v], `${kind}.${k} -> unknown icon ${v}`);
  }
});

test("PROVENANCE.md equals the regenerated output", () => {
  const onDisk = readFileSync(join(colorDir, "PROVENANCE.md"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(onDisk, renderProvenance(manifest), "run tools/icons/slot.mjs or regenerate; do not hand-edit PROVENANCE.md");
});
