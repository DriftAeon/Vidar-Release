// Quiet hydrate (cards.ts): a card attached while the view restores leaves its pill and group
// closed and never scrolls; openHydratedCards (host-payload hydration end) opens only the ones still
// awaiting an answer, and a settle then folds the pill again via dataset.cardOpened.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createCards } = await import("../src/panels/rendered/cards.ts");

function harness() {
  const S = { hydrating: true, stick: false, pendingApproval: null, adapter: { encodePermission: () => "line" } };
  const scrolls = [];
  const deps = {
    transport: { durable: false },
    textarea: document.createElement("textarea"),
    follow: { toBottom: () => scrolls.push(1), jump() {}, programmatic: () => false, dispose() {} },
    tools: new Map(),
    approvals: new Map(),
    approvalQueue: [],
    awaiting: new Map(),
    sendEncoded: async () => true,
    append: (n) => document.body.appendChild(n),
    sealGroup: () => {},
    groupRefresh: () => {},
    stalePill: () => {},
    refreshState: () => {},
    noticeBlock: () => {},
    agent: "claude",
  };
  return { S, deps, scrolls, cards: createCards(S, deps) };
}

function pill(deps, id) {
  const group = { details: document.createElement("details"), userToggled: false };
  const details = document.createElement("details");
  details.className = "tool running";
  details.appendChild(document.createElement("summary"));
  deps.tools.set(id, { details, out: null, children: null, name: "Bash", group, card: null });
  return { details, group };
}

test("hydrate: cards attach closed and silent; only a still-pending one opens at the end", () => {
  const h = harness();
  const pending = pill(h.deps, "t1");
  const settled = pill(h.deps, "t2");
  h.cards.approvalCard("r1", "t1", "Bash", { command: "ls" }, 2, []);
  h.cards.approvalCard("r2", "t2", "Bash", { command: "pwd" }, 3, []);
  h.deps.approvals.get("r2").hostSettle("settled"); // the host's later record settles r2 during the replay

  for (const p of [pending, settled]) {
    assert.equal(p.details.open, false, "a pill opened during hydrate");
    assert.equal(p.group.details.open, false, "a group opened during hydrate");
  }
  assert.equal(h.scrolls.length, 0, "a card scrolled during hydrate");

  h.S.hydrating = false;
  h.cards.openHydratedCards();
  assert.equal(pending.details.open, true, "the pending card's pill stayed closed");
  assert.equal(pending.group.details.open, true, "the pending card's group stayed closed");
  assert.equal(settled.details.open, false, "a settled card's pill opened");
  assert.equal(settled.group.details.open, false, "a settled card's group opened");

  // the opened pill folds again once answered
  pending.details.querySelector("." + "approval-actions button").click();
  assert.equal(pending.details.open, false, "an answered card left its pill open");
});

test("hydrate: a group the user toggled stays as it is; live attach still opens at once", () => {
  const h = harness();
  const p = pill(h.deps, "t3");
  p.group.userToggled = true;
  h.cards.approvalCard("r3", "t3", "Bash", { command: "ls" }, 2, []);
  h.S.hydrating = false;
  h.cards.openHydratedCards();
  assert.equal(p.details.open, true);
  assert.equal(p.group.details.open, false, "a user-toggled group was opened");

  const live = pill(h.deps, "t4");
  h.cards.approvalCard("r4", "t4", "Bash", { command: "ls" }, 2, []);
  assert.equal(live.details.open, true, "live attach no longer opens the pill");
  assert.equal(live.group.details.open, true, "live attach no longer opens the group");
  assert.equal(h.scrolls.length, 1);
});
