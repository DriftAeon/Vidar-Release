// A Codex Rendered tab refused for Vidar's folder (bare/mod.rs refuse_vidar_cwd): the failed-spawn pane
// draws the Open in Worktree card instead of the plain notice and Retry; without the seam it keeps both.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createLifecycle, VIDAR_CWD_REFUSED } = await import("../src/panels/rendered/lifecycle.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));
const labels = (n) => [...n.querySelectorAll("button")].map((b) => b.textContent);

test("lifecycle VIDAR_CWD_REFUSED equals the string in bare/mod.rs", () => {
  const rs = readFileSync(new URL("../src-tauri/src/bare/mod.rs", import.meta.url), "utf8");
  const m = rs.match(/pub const VIDAR_CWD_REFUSED: &str = "([^"]*)";/);
  assert.ok(m, "constant not found in bare/mod.rs");
  assert.equal(VIDAR_CWD_REFUSED, m[1]);
});

function failedSpawn(onOpenWorktree, error = `Failed: ${VIDAR_CWD_REFUSED}`) {
  const root = document.createElement("div");
  const notices = [];
  const S = { disposed: false, spawning: null, hydrating: false, replaying: false, mode: "default", sessionId: null, switchPending: false };
  const life = createLifecycle(S, {
    opts: { agent: "claude", tabId: "t1", cwd: "C:\\work\\Checkout", onOpenWorktree, onSelectWorkspace: null, onDead() {}, onAdopted() {} },
    transport: { spawn: () => Promise.reject(error) },
    root, sl: {}, queued: [], tools: new Map(), newAdapter: () => ({}), handle() {}, hostPayload() {},
    cancelApprovals() {}, resetCache() {}, stopCacheTimer() {}, drawCache() {}, redrawStatus() {}, resetTranscript() {},
    setInTurn() {}, refreshState() {}, append: (n) => root.appendChild(n), noticeBlock: (t) => notices.push(t),
    stats: { end() {} }, openHydratedCards() {}, checkLogin() {},
  });
  return { root, notices, spawn: life.spawn };
}

test("the refusal draws the card with Open in Worktree and Dismiss, no notice and no Retry", async () => {
  const f = failedSpawn(() => Promise.resolve());
  await f.spawn();
  assert.deepEqual(f.notices, []);
  const card = f.root.querySelector(".blk-notice-card");
  assert.equal(card.querySelector(".blk-notice").textContent, "Codex can't run in Vidar's own folder: its sandbox could write Vidar's launch files.");
  assert.deepEqual(labels(f.root), ["Open in Worktree", "Dismiss"]);
  const b = card.querySelector("button");
  assert.ok(b.classList.contains("wb-card-btn-primary") && b.classList.contains("notice-trust"));
  assert.equal(b.title, "Makes a git worktree of Vidar at HEAD under runtime\\worktrees and opens Codex there; uncommitted changes stay here.");
  assert.equal(f.root.querySelector(".rendered-retry"), null);
  card.querySelectorAll("button")[1].click();
  assert.equal(f.root.querySelector(".blk-notice-card"), null);
});

test("the button calls onOpenWorktree, shows Opening, then the failure line on a reject", async () => {
  let reject;
  let calls = 0;
  const f = failedSpawn(() => { calls++; return new Promise((_, rej) => { reject = rej; }); });
  await f.spawn();
  const b = f.root.querySelector("button");
  b.click();
  assert.equal(calls, 1);
  assert.equal(b.getAttribute("aria-busy"), "true");
  assert.equal(b.textContent, "Opening");
  reject(new Error("fatal: not a git repository"));
  await tick();
  assert.equal(b.textContent, "Open in Worktree");
  const line = f.root.querySelector(".notice-err");
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, "Couldn't open a worktree: fatal: not a git repository");
});

test("without onOpenWorktree the refusal keeps the plain notice and Retry", async () => {
  const f = failedSpawn(null);
  await f.spawn();
  assert.deepEqual(f.notices, [`Failed to Start: Failed: ${VIDAR_CWD_REFUSED}`]);
  assert.equal(f.root.querySelector(".blk-notice-card"), null);
  assert.deepEqual(labels(f.root), ["Retry"]);
});

test("another spawn error keeps the notice and Retry even with the seam", async () => {
  const f = failedSpawn(() => Promise.resolve(), "boom");
  await f.spawn();
  assert.deepEqual(f.notices, ["Failed to Start: boom"]);
  assert.deepEqual(labels(f.root), ["Retry"]);
});
