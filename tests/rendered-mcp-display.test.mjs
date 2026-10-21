// MCP tool names in the Rendered chain and pills: a plugin server (`plugin_<plugin>_<server>`) resolves to
// its backend icons, and the label drops to the tool word.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { shortLabel, toolIcons } = await import("../src/panels/rendered/chain.ts");
const srcs = (name) => toolIcons(name).map((img) => img.getAttribute("src").replace(/^\/icons\/color\/|\.(svg|png)$/g, ""));

test("plugin vidar-drive ask: label Ask, the steering wheel alone", () => {
  const name = "mcp__plugin_vidar_drive__ask";
  assert.equal(shortLabel(name), "Ask");
  assert.deepEqual(srcs(name), ["steer"]);
});

test("Atlassian tools: short labels, camelCase split for the rest", () => {
  assert.equal(shortLabel("mcp__atlassian__executeRead"), "Read");
  assert.equal(shortLabel("mcp__atlassian__executeDestructive"), "Delete");
  assert.equal(shortLabel("mcp__atlassian__getAccessibleAtlassianResources"), "List Sites");
  assert.equal(shortLabel("mcp__atlassian__getJiraIssue"), "Get Issue");
  assert.equal(shortLabel("mcp__atlassian__createJiraIssue"), "Create Jira Issue");
});

test("non-plugin names are unchanged", () => {
  assert.equal(shortLabel("mcp__unreal__call_tool"), "Call Tool");
  assert.equal(srcs("mcp__unreal__call_tool").length, 1);
  assert.equal(shortLabel("mcp__playwright__browser_click"), "Playwright: Browser Click");
  assert.deepEqual(srcs("mcp__playwright__browser_click"), []);
});

test("Codex proxy Unreal tools use Vidar then Unreal icons", () => {
  assert.equal(shortLabel("proxy.unreal_list_toolsets"), "List Toolsets");
  assert.deepEqual(srcs("proxy.unreal_list_toolsets"), ["vidar", "unreal"]);
});

test("Codex OpenAI Docs tools use the OpenAI mark", () => {
  assert.equal(shortLabel("openai_developer_docs.search_openai_docs"), "Search OpenAI Docs");
  assert.deepEqual(srcs("openai_developer_docs.search_openai_docs"), ["openai"]);
  assert.equal(shortLabel("openai_developer_docs.fetch_openai_doc"), "Fetch OpenAI Doc");
  assert.deepEqual(srcs("openai_developer_docs.fetch_openai_doc"), ["openai"]);
});

test("OpenAI Developer Docs catalog spelling keeps the OpenAI mark", () => {
  assert.equal(shortLabel("openai Developer Docs:search_openai_docs"), "Search OpenAI Docs");
  assert.deepEqual(srcs("openai Developer Docs:search_openai_docs"), ["openai"]);
});

test("generic Codex Command tool gets the terminal glyph", () => {
  assert.equal(shortLabel("Command"), "Command");
  assert.equal(toolIcons("Command")[0]?.querySelector("title")?.textContent, "Command");
  assert.match(toolIcons("Command")[0]?.querySelector("path")?.getAttribute("d") ?? "", /^m7 11/);
});
