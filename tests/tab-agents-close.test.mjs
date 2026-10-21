// Closing a child view must preserve live lifecycle tracking and reject retired-body controls.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const values = new Map();
globalThis.__agentClosePrefs = values;
const getPref = (key) => values.get(key);
setupDom({ stubs: { prefs: `
  const values = globalThis.__agentClosePrefs;
  export function getPref(key) { return values.get(key); }
  export function setPref(key, value) { values.set(key, value); }
` } });
after(() => window.close());
const { initTabAgents } = await import("../src/panels/sessions/tab-agents.ts");
const { createAgentsBlock } = await import("../src/panels/rendered/agents-block.ts");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture() {
  values.clear();
  const strip = document.createElement("div"), container = document.createElement("div");
  const button = document.createElement("button");
  button.className = "session-btn";
  button.innerHTML = '<span class="tab-rc"></span>';
  strip.append(button);
  document.body.append(strip, container);
  const session = { agent: "claude", container, button };
  const sessions = new Map([["parent", session]]);
  const tools = new Map();
  let focused = 0;
  const make = (replaying = false) => createAgentsBlock({ sessionId: "close-test", replaying }, {
    tools, noticeBlock() {}, refreshState() {},
  });
  const f = { strip, container, tools, sessions, agents: make(), focused: () => focused };
  container.append(f.agents.el);
  const dispose = initTabAgents(strip, sessions, () => { focused++; });
  f.add = (id) => f.agents.addWaiting(id, undefined, id);
  f.replace = (replaying = false) => {
    f.agents.dispose();
    f.agents.el.remove();
    f.agents = make(replaying);
    container.append(f.agents.el);
  };
  f.cleanup = () => { dispose(); f.agents.dispose(); strip.remove(); container.remove(); };
  return f;
}

test("live subtab X closes its view and drawer while preserving child tracking", async () => {
  const f = fixture();
  try {
    f.add("live"); f.add("sibling");
    await flush();
    const row = f.strip.querySelector(".agent-subtab");
    row.click();
    const focused = f.focused();
    row.querySelector(".session-close").click();
    await flush();
    assert.equal(f.focused(), focused, "close does not select the parent");
    assert.equal(f.strip.querySelectorAll(".agent-subtab").length, 1);
    assert.equal(f.agents.waiting.get("live").row.getAttribute("aria-expanded"), "false");
    assert.equal(f.container.querySelector(".agent-drawer").hidden, true);
    assert.equal(f.agents.runningCount(), 2, "both children remain running");
    assert.equal(getPref("rendered.dismissedAgents"), undefined, "live close is view-only");
    f.agents.removeWaiting("live", "completed", undefined, "Child report");
    await flush();
    assert.equal(f.agents.waiting.get("live").report, "Child report");
    assert.equal(f.strip.querySelectorAll(".agent-subtab").length, 1, "completion keeps the view closed");
    f.agents.resumeWaiting("live", undefined);
    await flush();
    assert.equal(f.strip.querySelectorAll(".agent-subtab").length, 2, "new live work reopens its view");
  } finally { f.cleanup(); }
});

test("finished subtab keyboard close persists dismissal through transcript replay", async () => {
  const f = fixture();
  try {
    f.add("done");
    f.agents.removeWaiting("done", "completed");
    await flush();
    const close = f.strip.querySelector(".session-close");
    assert.equal(close.getAttribute("aria-label"), "Close Tab");
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();
    assert.equal(f.focused(), 0);
    assert.equal(f.agents.waiting.size, 0);
    assert.equal(f.strip.querySelector(".agent-subtab"), null);
    assert.deepEqual(getPref("rendered.dismissedAgents")["close-test"].ids, ["done"]);
    f.replace(true);
    f.add("done");
    f.agents.removeWaiting("done", "completed");
    await flush();
    assert.equal(f.strip.querySelector(".agent-subtab"), null);
  } finally { f.cleanup(); }
});

test("a closed live child keeps its parent square and paints later state", async () => {
  const f = fixture();
  try {
    const details = document.createElement("details"), children = document.createElement("div");
    details.appendChild(children);
    f.tools.set("kid", { details, children });
    f.agents.addWaiting("kid", "kid", "kid");
    await flush();
    f.strip.querySelector(".session-close").click();
    await flush();
    const dots = () => [...f.strip.querySelectorAll(".tab-agent-dot")];
    assert.equal(f.strip.querySelectorAll(".agent-subtab").length, 0);
    assert.deepEqual(dots().map((d) => d.dataset.state), ["running"]);
    const awaiting = document.createElement("div");
    awaiting.className = "blk-tool awaiting";
    children.appendChild(awaiting);
    f.agents.resumeWaiting("kid", "kid");
    await flush();
    assert.equal(f.strip.querySelectorAll(".agent-subtab").length, 1, "resume reopens the view");
    f.strip.querySelector(".session-close").click();
    await flush();
    assert.equal(f.strip.querySelectorAll(".agent-subtab").length, 0);
    assert.deepEqual(dots().map((d) => d.dataset.state), ["needs"]);
  } finally { f.cleanup(); }
});

for (const [name, key] of [["Enter", "Enter"], ["Space", " "]]) {
  test(`keyboard ${name} close moves focus to next, then previous, then parent`, async () => {
    const f = fixture();
    try {
      f.add("a"); f.add("b"); f.add("c");
      await flush();
      const closeOf = (i) => f.strip.querySelectorAll(".agent-subtab")[i].querySelector(".session-close");
      const press = (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      const rows = () => [...f.strip.querySelectorAll(".agent-subtab")];
      const [, b, c] = rows();
      press(closeOf(0));
      await flush();
      assert.equal(document.activeElement, b, "next subtab");
      press(closeOf(1)); // c, the last row
      await flush();
      assert.equal(document.activeElement, b.isConnected ? b : null, "previous subtab");
      assert.equal(c.isConnected, false);
      press(closeOf(0));
      await flush();
      assert.equal(document.activeElement, f.sessions.get("parent").button, "parent button");
    } finally { f.cleanup(); }
  });
}

test("retired close controls cannot dismiss a replacement body's reused child id", async () => {
  const f = fixture();
  try {
    f.add("same");
    await flush();
    const retired = f.strip.querySelector(".session-close");
    f.replace();
    f.add("same");
    await flush();
    retired.click();
    await flush();
    assert.equal(f.strip.querySelectorAll(".agent-subtab").length, 1);
    assert.equal(f.agents.runningCount(), 1);
    f.sessions.delete("parent");
    const current = f.strip.querySelector(".session-close");
    current.click();
    assert.equal(f.agents.waiting.size, 1, "removed parent cannot route a close");
  } finally { f.cleanup(); }
});
