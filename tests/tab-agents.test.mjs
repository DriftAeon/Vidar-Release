// Cross-panel contract: subtabs follow the Rendered agents block's published summary, route
// selection back to its drawer through openAgentRow, and disappear with the owning body/tab.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
after(() => window.close());
const { initTabAgents, moveTabFamily } = await import("../src/panels/sessions/tab-agents.ts");
const { createAgentsBlock } = await import("../src/panels/rendered/agents-block.ts");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture() {
  const strip = document.createElement("div");
  const container = document.createElement("div");
  const button = document.createElement("button");
  button.className = "session-btn";
  button.dataset.id = "parent";
  button.title = "parent";
  button.innerHTML = '<span class="tab-title">Parent</span><span class="tab-sub"><span class="tab-model">Verified Model</span></span><span class="tab-rc"></span>';
  strip.append(button);
  document.body.append(strip, container);
  const session = { id: "parent", agent: "claude", container, button };
  const sessions = new Map([["parent", session]]);
  const tools = new Map();
  const newBlock = () => createAgentsBlock({ sessionId: "agent-session", replaying: false }, { tools, noticeBlock() {}, refreshState() {} });
  const f = { strip, container, button, session, sessions, tools, agents: newBlock(), focused: [] };
  container.appendChild(f.agents.el);
  const dispose = initTabAgents(strip, sessions, (id) => { f.focused.push(id); button.classList.add("active"); });
  f.add = (id, label) => {
    const details = document.createElement("details");
    const children = document.createElement("div");
    details.appendChild(children);
    tools.set(id, { details, children, subagentType: label, subagentDesc: "Review the change" });
    f.agents.addWaiting(id, id);
    return children;
  };
  f.replaceBody = () => { // detachRenderedBody: the old body is disposed and cleared, a new one mounts
    f.agents.dispose();
    f.agents.el.remove();
    f.agents = newBlock();
    container.appendChild(f.agents.el);
  };
  f.cleanup = () => { dispose(); f.agents.dispose(); strip.remove(); container.remove(); };
  return f;
}
const dots = (f) => [...f.button.querySelectorAll(".tab-agent-dot")];

test("Rendered child lifecycle paints subtabs and dots; selection opens the original drawer", async () => {
  const f = fixture();
  try {
    const calls = f.add("child", "source reviewer");
    await flush();
    const row = f.strip.querySelector(".agent-subtab");
    assert.equal(row.querySelector(".tab-title").textContent, "Source Reviewer");
    assert.equal(row.querySelector(".tab-sub").textContent, "Running");
    assert.deepEqual(dots(f).map((d) => [d.dataset.state, d.title]), [["running", "Source Reviewer: running"]]);
    assert.ok(f.button.querySelector(".tab-rc > .tab-agent-dots"), "dots sit in the right column");
    assert.equal(f.button.textContent.includes("Agent"), false, "no count text on the parent row");
    assert.equal(row.querySelector(".tab-model"), null, "no child model is inferred from the parent");
    row.click();
    await flush();
    assert.deepEqual(f.focused, ["parent"]);
    assert.equal(f.agents.waiting.get("child").row.getAttribute("aria-expanded"), "true");
    assert.equal(row.getAttribute("aria-pressed"), "true");
    assert.equal(f.container.querySelector(".agent-drawer").hidden, false);
    row.click(); // a second click keeps it open: subtabs select, they never toggle shut
    await flush();
    assert.equal(row.getAttribute("aria-pressed"), "true");

    const awaiting = document.createElement("div");
    awaiting.className = "blk-tool awaiting";
    calls.appendChild(awaiting);
    f.agents.resumeWaiting("child", "child");
    await flush();
    assert.equal(row.dataset.phase, "needs");
    assert.equal(row.querySelector(".tab-sub").textContent, "Needs You");
    assert.equal(dots(f)[0].title, "Source Reviewer: needs you");
    f.agents.removeWaiting("child", "failed");
    await flush();
    assert.equal(row.dataset.phase, "lost");
    assert.equal(row.querySelector(".tab-sub").textContent, "Failed");
    assert.equal(dots(f)[0].dataset.state, "failed");
    awaiting.remove();
    f.agents.resumeWaiting("child", "child");
    f.agents.removeWaiting("child", "completed");
    await flush();
    assert.equal(row.querySelector(".tab-sub").textContent, "Done");
    assert.equal(dots(f)[0].dataset.state, "done");
    assert.equal(f.strip.querySelector(".agent-subtab"), row, "lifecycle redraw keeps the focused DOM node");
    f.agents.clearWaiting();
    await flush();
    assert.equal(f.strip.querySelector(".agent-subtab"), null);
    assert.equal(f.button.querySelector(".tab-agent-dots").hidden, true);
    assert.equal(f.button.querySelector(".tab-model").textContent, "Verified Model");
  } finally { f.cleanup(); }
});

test("a collapsed agents list expands before the row opens; the subtab menu is suppressed", async () => {
  const f = fixture();
  try {
    f.add("child", "Worker");
    await flush();
    const toggle = f.container.querySelector(".agents-toggle");
    toggle.click();
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    const row = f.strip.querySelector(".agent-subtab");
    row.click();
    await flush();
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(f.agents.waiting.get("child").row.getAttribute("aria-expanded"), "true");
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    row.dispatchEvent(menu);
    assert.equal(menu.defaultPrevented, true);
  } finally { f.cleanup(); }
});

test("dots cap at eight; the group label follows a rename", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10; i++) f.add(`a${i}`, `Worker ${i}`);
    await flush();
    assert.equal(f.strip.querySelectorAll(".agent-subtab").length, 10);
    assert.equal(dots(f).length, 8);
    assert.equal(/\d+\s*$/.test(f.button.querySelector(".tab-rc").textContent), false, "no +N figure");
    assert.equal(f.strip.querySelector(".tab-agents").getAttribute("aria-label"), "Parent Agents");
    f.button.title = "renamed tab";
    await flush();
    assert.equal(f.strip.querySelector(".tab-agents").getAttribute("aria-label"), "Renamed Tab Agents");
  } finally { f.cleanup(); }
});

test("body replacement and tab removal retire stale child selection", async () => {
  const f = fixture();
  try {
    f.add("child", "Worker");
    await flush();
    const retired = f.strip.querySelector(".agent-subtab");
    f.replaceBody(); // switching to Raw (or a resume) disposes the old Rendered body
    await flush();
    retired.click();
    assert.deepEqual(f.focused, []);
    assert.equal(f.strip.querySelector(".agent-subtab"), null);
    f.add("child", "Worker"); // the new body's replay provides rows again
    await flush();
    assert.equal(f.strip.querySelectorAll(".agent-subtab").length, 1);
    f.sessions.delete("parent");
    f.button.remove();
    await flush();
    assert.equal(f.strip.querySelector(".tab-agents"), null);
    f.agents.removeWaiting("child", "completed");
    await flush();
    assert.equal(f.strip.children.length, 0);
  } finally { f.cleanup(); }
});

test("parent drag preserves family adjacency without adding children to tab order", async () => {
  const f = fixture();
  try {
    f.add("first", "Reviewer");
    f.add("second", "Worker");
    await flush();
    const other = document.createElement("button");
    other.className = "session-btn";
    other.dataset.id = "other";
    f.strip.appendChild(other);
    moveTabFamily(f.button, null);
    await flush();
    assert.equal(f.strip.firstElementChild, other);
    assert.equal(f.button.nextElementSibling.dataset.parentTab, "parent");
    assert.deepEqual([...f.strip.querySelectorAll(".session-btn")].map((b) => b.dataset.id), ["other", "parent"]);
    assert.equal(dots(f).length, 2);
    moveTabFamily(f.button, other);
    await flush();
    assert.equal(f.strip.firstElementChild, f.button);
    assert.equal(f.button.nextElementSibling.nextElementSibling, other);
  } finally { f.cleanup(); }
});
