// Recurrence control for "proxy" shown instead of "Proxy": lint-copy sees only static strings, so runtime ids
// (module names, loaded file names) are drawn from lowercase fixtures and every visible label must start uppercase.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({ stubs: { "panels/sessions/lookup": `
  export const getFocusedSession = () => null;
  export const renderedSessionId = () => null;
  export const renderedBody = () => null;
  export const sessionLaunchInfo = () => null;` } });
const { moduleTicks } = await import("../src/runes/bare/module-ticks.ts");
const { outsideRow, vaultWarningLine } = await import("../src/panels/runes.ts");

const bundles = { bundles: {
  proxy: { mcp: [{ name: "proxy", hasUrl: true }, { name: "jira-atlassian", hasCommand: true }],
    skills: ["modules/vidar-drive"], agents: ["agents/code-reviewer.md"], guards: [{ event: "Stop", run: ["hooks/guard-install.mjs"] }] },
  "vidar-drive": { mcp: [{ name: "vidar-drive" }], skills: [], agents: [], guards: [] },
} };
const ctx = { io: {}, set: { library: "kit", set: "kit" }, runes: [], sources: null, bundles, codex: false, busy: false,
  edit: async () => {}, act: () => {}, trackOpen: () => {} };
const startsUpper = (s) => /^[A-Z]/.test(s);

test("Module heads and rows show Title Case from lowercase ids", () => {
  const nodes = moduleTicks(ctx);
  const labels = [];
  for (const n of nodes) {
    if (n.classList.contains("runes-div")) { labels.push(n.textContent); continue; }
    labels.push(n.querySelector("summary")?.textContent ?? "");
    for (const r of n.querySelectorAll(".runes-module-item .runes-rname")) labels.push(r.textContent);
  }
  assert.ok(labels.length > 8, `drew ${labels.length} labels`);
  for (const l of labels) assert.ok(startsUpper(l), `label "${l}" must start uppercase`);
  assert.ok(labels.includes("Jira Atlassian") && labels.includes("Vidar Drive") && labels.includes("Guard Install"));
});

test("Outside file rows show a Title Case name, the raw path in the tooltip", () => {
  const row = outsideRow("C:/notes/project-notes.md", () => {});
  const name = row.querySelector(".runes-rname").textContent;
  assert.ok(startsUpper(name), name);
  assert.equal(name, "Project Notes");
  assert.equal(row.title, "C:/notes/project-notes.md");
  assert.match(row.querySelector("img").src, /\/doc\.svg$/);
});

test("A Codex vault row draws its kind icon, not the doc icon", () => {
  assert.match(outsideRow("kit/ctx", () => {}, "skill").querySelector("img").src, /\/skill\.png$/);
  assert.match(outsideRow("kit/jira-atlassian", () => {}, "mcp").querySelector("img").src, /\/proxy\.svg$/);
  assert.match(outsideRow("D:/repo/AGENTS.md", () => {}, "agents.md").querySelector("img").src, /\/doc\.svg$/);
});

test("Codex MCP resource tool rows get pretty names and the MCP icon", () => {
  const a = outsideRow("codex.list_mcp_resources", () => {}, "skill", false);
  assert.equal(a.querySelector(".runes-rname").textContent, "List MCP Resources");
  assert.match(a.querySelector("img").src, /\/proxy\.svg$/);
  const b = outsideRow("codex.list_mcp_resource_templates", () => {}, undefined, false);
  assert.equal(b.querySelector(".runes-rname").textContent, "List MCP Resource Templates");
  assert.match(b.querySelector("img").src, /\/proxy\.svg$/);
});

test("A Not Carried warning renders the kind icon and mono id", () => {
  const line = vaultWarningLine("skill drive-allow Not Carried by Codex: no per-tool list", "tabNC");
  assert.equal(line.querySelector(".nm-mono").textContent, "drive-allow");
  assert.ok(line.querySelector(".runes-warn-text img, .runes-warn-text svg"));
});
