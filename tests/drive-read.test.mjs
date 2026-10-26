import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { read, readLines } from "../tools/drive/verbs/read.mjs";

// Classes mirror sessions.ts, rendered.ts, user-block.ts, text-stream.ts,
// groups.ts and tool-pills.ts. The inactive pane must never be read.
function fixture() {
  return new JSDOM(`<!doctype html><body>
    <button class="session-btn" data-id="s1"></button>
    <button class="session-btn focused" data-id="s2"></button>
    <div class="term-container rendered-host"><div class="rendered-transcript"><div class="blk blk-user">Wrong tab</div></div></div>
    <div class="term-container focused rendered-host"><div class="rendered"><div class="rendered-transcript">
      <div class="blk blk-agent-pill">Codex</div>
      <div class="blk blk-user">First line\nSecond line</div>
      <details class="blk blk-activity"><summary>1 Op</summary>
        <details class="blk blk-tool"><summary>Command ran</summary><pre class="tool-output">hidden output</pre></details>
      </details>
      <div class="blk blk-text"><p>Done</p></div>
    </div></div></div>
  </body>`, { runScripts: "outside-only" });
}

test("read: parses active Rendered transcript markup and role prefixes", async () => {
  const dom = fixture();
  const ctx = { evalJs: async (source) => JSON.parse(JSON.stringify(dom.window.eval(source))) };
  assert.deepEqual(await read(ctx), { tab: "s2", lines: ["user: First line", "Second line", "tool: Command ran", "assistant: Done"], truncated: false });
  assert.deepEqual(readLines(dom.window.document, 2), { tab: "s2", lines: ["tool: Command ran", "assistant: Done"], truncated: true });
});

test("read: no active Rendered tab exits 2", async () => {
  const dom = fixture();
  dom.window.document.querySelector(".term-container.focused").classList.remove("focused");
  await assert.rejects(read({ evalJs: async (source) => dom.window.eval(source) }), (e) => e.exitCode === 2);
});

test("read: --lines accepts 1..200", async () => {
  const dom = fixture();
  const ctx = { a1: "--lines", a2: "1", evalJs: async (source) => JSON.parse(JSON.stringify(dom.window.eval(source))) };
  assert.deepEqual((await read(ctx)).lines, ["assistant: Done"]);
  await assert.rejects(read({ ...ctx, a2: "201" }), /usage: read/);
});
