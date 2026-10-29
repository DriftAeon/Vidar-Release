// Pins the Not Carried parser (src/runes/not-carried.ts) against the Rust format strings that produce the warnings.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { parseNotCarried, notCarriedLine } = await import("../src/runes/not-carried.ts");
const { KINDS, KIND_NAME } = await import("../src/runes/kind-icons.ts");

const { AGENTS } = await import("../src/agents/descriptor.ts");
const { AGENT_IDS } = await import("../src/agents/id.ts");

test("set_loadout.rs holds the one Not Carried format; both launches call it", () => {
  const src = readFileSync(new URL("../src-tauri/src/bare/set_loadout.rs", import.meta.url), "utf8");
  assert.match(src, /format!\("\{\} \{\} Not Carried by \{\}: \{\}", u\.kind, u\.item, agent_label\(agent\), u\.reason\)/, "format string shape changed; update the parser and this test together");
  for (const file of ["claude_launch.rs", "codex_hosted.rs"]) {
    const launch = readFileSync(new URL(`../src-tauri/src/bare/${file}`, import.meta.url), "utf8");
    assert.match(launch, /set_loadout::not_carried\(/, file);
    assert.doesNotMatch(launch, /Not Carried by/, `${file} must not copy the format`);
  }
});

for (const id of AGENT_IDS) {
  const agent = AGENTS[id].name;
  test(`${agent} line parses`, () => {
    const p = parseNotCarried(`output-style kit-brief Not Carried by ${agent}: ${agent} has no output style`);
    assert.deepEqual(p, { kind: "output-style", id: "kit-brief", agent, reason: `${agent} has no output style` });
  });
}

test("set_loadout.rs names an uncarried output style by its rune kind and id", () => {
  const src = readFileSync(new URL("../src-tauri/src/bare/set_loadout.rs", import.meta.url), "utf8");
  assert.match(src, /push_unsupported\(&mut out\.unsupported, "output-style", &style\.id, why\.into\(\)\)/);
  assert.match(readFileSync(new URL("../src-tauri/src/agent_spec.rs", import.meta.url), "utf8"), /output_style: Some\("Codex has no output style"\)/);
  assert.doesNotMatch(src, /push_unsupported\([^)]*"outputStyle"/, "the legacy spelling renders as prose only");
  const p = parseNotCarried("output-style brief Not Carried by Codex: Codex has no output style");
  assert.deepEqual(p, { kind: "output-style", id: "brief", agent: "Codex", reason: "Codex has no output style" });
});

test("a rune line renders icon, mono id, prose", () => {
  const nodes = notCarriedLine("permission drive-allow Not Carried by Codex: Codex has no per-tool list");
  const host = document.createElement("div");
  host.append(...nodes);
  assert.equal(host.querySelector("img.icn")?.title, "Permission");
  assert.equal(host.querySelector(".nm-mono")?.textContent, "drive-allow");
  assert.equal(host.textContent, " drive-allow Not Carried by Codex: Codex has no per-tool list");
});

test("non-rune kinds and tool names stay plain prose", () => {
  for (const w of [
    "guard Stop Not Carried by Codex: Codex has no Stop hook event",
    "permission mcp__plugin_vidar_drive Not Carried by Codex: Codex has no per-tool list",
    "permission acceptEdits Not Carried by Codex: Codex has no permission mode",
    "outputStyle Explanatory Not Carried by Codex: Codex has no output style",
    "Resumed thread note",
  ]) {
    assert.equal(parseNotCarried(w), null, w);
    const host = document.createElement("div");
    host.append(...notCarriedLine(w));
    assert.equal(host.textContent, w);
    assert.equal(host.querySelector("img"), null);
  }
});

test("all eleven kinds have an icon and a Title Case name", () => {
  assert.deepEqual(Object.keys(KINDS).sort(), ["agent", "fact", "hook", "mcp", "model", "output-style", "permission", "plugin", "procedure", "rule", "skill"]);
  assert.equal(KIND_NAME["mcp"], "MCP Server");
  assert.equal(KINDS.permission.icon, "shield");
  assert.equal(KINDS.rule.icon, "scales");
  assert.equal(KINDS.plugin.icon, "toolbox");
  assert.equal(KINDS["output-style"].icon, "content-view");
});
