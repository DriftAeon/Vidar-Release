// Launcher root order (Settings › Agents › Launcher Order): the saved order wins, roots
// it does not name follow in default order, and a saved id with no root is dropped silently.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { overlayAgents } from "../src/config-agents.ts";
import { rawPackRows } from "../src/launcher/pack-rows.ts";
import { orderRoots, shownRootsOf } from "../src/launcher/roster-shown.ts";
import { missingInputs } from "./helpers/optional-input.mjs";

const pack = (id) => ({ ...JSON.parse(readFileSync(new URL(`../content/packs/${id}/pack.json`, import.meta.url))).module, source: "pack" });

test("saved order first, new roots after it in default order, removed ids ignored", () => {
  const claude = { key: "claude", id: "claude" };
  const codex = { key: "codex", id: "codex" };
  const gemini = { key: "gemini", id: "gemini" };
  const local = { id: "local", label: "Local" }; // key-less, as in a hand-written vidar.json
  const terminal = { key: "terminal", id: "shell" };
  const custom = { id: "claude", label: "Mine" };
  const roots = [terminal, custom, local, gemini, codex, claude];

  assert.deepEqual(orderRoots(roots, undefined), [claude, custom, codex, gemini, local, terminal]);
  assert.deepEqual(
    orderRoots(roots, ["terminal", "gone", "gemini"]),
    [terminal, gemini, claude, custom, codex, local],
  );
});

test("Raw rows follow present packs, retain launcher order and accept keyed overlays", { skip: missingInputs(import.meta.url, "../content/packs/gemini/pack.json") ?? false }, () => {
  const modules = [pack("gemini"), pack("local"), pack("pi")];
  const rows = rawPackRows(modules);
  assert.deepEqual(rows.map((r) => r.key), ["gemini", "local", "pi"]);
  assert.deepEqual(rows.map((r) => r.requires), [["gemini"], ["pwsh", "node"], ["pi"]]);
  assert.deepEqual(rows[0].args, ["-NoExit", "-Command", "gemini"]);
  assert.deepEqual(rows[2].args, ["-NoExit", "-Command", "pi"]);
  assert.equal(rows[1].shell, "pwsh");
  assert.match(rows[1].args.at(-1), /\$env:VIDAR_ROOT\/tools\/local\/local-tab\.ps1/);

  const terminal = { key: "terminal", id: "shell" };
  assert.deepEqual(orderRoots([...rows, terminal], undefined).map((r) => r.key), ["pi", "gemini", "local", "terminal"]);
  assert.deepEqual(shownRootsOf(rows, (id) => id !== "gemini").map((r) => r.key), ["pi", "local"]);
  const overlaid = overlayAgents(rows, [{ key: "pi", label: "My Pi", args: ["-NoExit", "-Command", "pi --mode json"] }]);
  assert.equal(overlaid.find((r) => r.key === "pi").label, "My Pi");
  assert.deepEqual(overlaid.find((r) => r.key === "pi").args, ["-NoExit", "-Command", "pi --mode json"]);

  assert.deepEqual(rawPackRows([modules[0], modules[2]]).map((r) => r.key), ["gemini", "pi"]);
  assert.deepEqual(rawPackRows([]), []);
  assert.deepEqual(rawPackRows([{ ...modules[0], source: "core" }]), []);
});
