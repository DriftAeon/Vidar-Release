// The agent drawer (rendered/agents-drawer.ts) opens at its newest call, or at the call awaiting the
// user, and stays pinned to the newest call while open when the reader was already there: a ~100-call
// subagent no longer opens at its first call with the one that needs an answer 98 rows down.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createAgentsDrawer } = await import("../src/panels/rendered/agents-drawer.ts");

function pill(tools, id, name, host) {
  const details = document.createElement("details");
  details.className = "blk-tool tool";
  details.dataset.tool = name;
  const summary = document.createElement("summary");
  summary.append(Object.assign(document.createElement("span"), { className: "tool-summary", textContent: id }));
  details.appendChild(summary);
  host.appendChild(details);
  const rec = { details, out: null, children: null, name, group: null, card: null };
  tools.set(id, rec);
  return rec;
}

function drawerFixture(n, awaitAt = -1) {
  const tools = new Map();
  const agent = pill(tools, "ag", "Agent", document.body);
  agent.children = document.createElement("div");
  agent.children.className = "tool-children";
  agent.details.appendChild(agent.children);
  for (let i = 0; i < n; i++) {
    const p = pill(tools, `c${i}`, "Bash", agent.children);
    if (i === awaitAt) p.details.classList.add("awaiting");
  }
  const drawer = createAgentsDrawer({ tools });
  document.body.appendChild(drawer.el);
  const body = drawer.el.querySelector(".agent-drawer-body");
  // jsdom has no layout: the scroller's height follows the lines the drawer has drawn, not the source pills
  Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => drawer.el.querySelectorAll(".agent-call").length * 24 });
  Object.defineProperty(body, "clientHeight", { configurable: true, get: () => 160 });
  const w = { title: "Fix", done: false, toolUseId: "ag" };
  return { drawer, body, w, tools, agent };
}

test("the drawer opens scrolled to its newest call", () => {
  const { drawer, body, w } = drawerFixture(98);
  body.scrollTop = 0;
  drawer.open("t1", w);
  assert.equal(body.scrollTop, 98 * 24);
});

test("the drawer opens at an awaiting call rather than the newest one", () => {
  const { drawer, body, w } = drawerFixture(98, 10);
  const lines = () => [...drawer.el.querySelectorAll(".agent-call")];
  // rects for the body and its lines that follow scrollTop
  body.getBoundingClientRect = () => ({ top: 0, bottom: 160 });
  const proto = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const i = lines().indexOf(this);
    return i >= 0 ? { top: i * 24 - body.scrollTop, bottom: i * 24 + 24 - body.scrollTop } : proto.call(this);
  };
  try {
    drawer.open("t1", w);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = proto;
  }
  assert.equal(body.scrollTop, 10 * 24, "the awaiting call is not at the top of the view");
});

test("while open, a reader at the bottom stays pinned as calls arrive; a reader scrolled up is left alone", () => {
  const f = drawerFixture(20);
  let n = 20;
  f.drawer.open("t1", f.w);
  assert.equal(f.body.scrollTop, 20 * 24);
  const add = () => {
    pill(f.tools, `c${n}`, "Bash", f.agent.children);
    n++;
    f.drawer.refresh();
  };
  f.body.scrollTop = n * 24 - 160; // at the bottom of the scroller
  add();
  assert.equal(f.body.scrollTop, n * 24, "a pinned reader was left behind");
  f.body.scrollTop = 0; // scrolled up to read
  add();
  assert.equal(f.body.scrollTop, 0, "a reader scrolled up was moved");
});
