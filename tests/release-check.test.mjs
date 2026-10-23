import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { DAY_MS, checkInput, launchCheckDue, releaseRows, statePatch } from "../src/startup-updates/release.ts";
import { renderStartupUpdateRows } from "../src/settings/dependencies-view.ts";

const doc = () => new JSDOM("<!doctype html><body></body>").window.document;
const ok = (over = {}) => ({ status: "ok", core: null, packs: [], blocked: [], seen: {}, ...over });
const core = { installed: "0.1.0", version: "0.2.0", page: "https://github.com/o/r/releases/tag/vidar-v0.2.0", asset: null };

test("launch check runs at most once per 24 h and never when the toggle is off", () => {
  const now = 10 * DAY_MS;
  assert.equal(launchCheckDue({}, now), true);
  assert.equal(launchCheckDue({ "vidarUpdate.lastCheck": now - DAY_MS + 1 }, now), false);
  assert.equal(launchCheckDue({ "vidarUpdate.lastCheck": now - DAY_MS }, now), true);
  assert.equal(launchCheckDue({ "vidarUpdate.lastCheck": "x" }, now), true);
  // A clock that went backwards does not lock the check out.
  assert.equal(launchCheckDue({ "vidarUpdate.lastCheck": now + DAY_MS }, now), true);
  assert.equal(launchCheckDue({ "vidarUpdate.atLaunch": false }, now), false);
  assert.equal(launchCheckDue({ "vidarUpdate.atLaunch": true }, now), true);
});

test("the call reads skip and seen from state; the reply writes lastCheck and seen back", () => {
  const state = { "vidarUpdate.skip": "0.2.0", "packUpdates.seen.gemini": "1.1.0", "packUpdates.seen.pi": 3, other: "x" };
  assert.deepEqual(checkInput(state), { skip: "0.2.0", seen: { gemini: "1.1.0" } });
  assert.deepEqual(checkInput({}), { skip: null, seen: {} });
  assert.deepEqual(statePatch(ok({ seen: { gemini: "1.1.0" } }), 5),
    { "vidarUpdate.lastCheck": 5, "packUpdates.seen.gemini": "1.1.0" });
  assert.deepEqual(statePatch({ status: "notPublished", reason: "r" }, 5), { "vidarUpdate.lastCheck": 5 });
  assert.deepEqual(statePatch({ status: "offline", reason: "r" }, 5), {});
  assert.deepEqual(statePatch({ status: "error", reason: "r" }, 5), {});
});

test("rows: Vidar first, then packs; a skipped pack release is left out; failures show nothing", () => {
  const reply = ok({
    core,
    packs: [{ id: "gemini", label: "Gemini", installed: null, release: "1.1.0", page: "https://p/g" }],
    blocked: [{ id: "voice-stock", label: "voice-stock", installed: "1.0.0", release: "1.0.1", reason: "Pack Needs Update: Needs Vidar Update" }],
  });
  const rows = releaseRows(reply, {});
  assert.deepEqual(rows.map((r) => [r.label, r.installed, r.latest, r.blocked]), [
    ["Vidar 0.2.0", "0.1.0", "0.2.0", null],
    ["Gemini 1.1.0", "—", "1.1.0", null],
    ["voice-stock 1.0.1", "1.0.0", "1.0.1", "Pack Needs Update: Needs Vidar Update"],
  ]);
  assert.equal(rows[0].skipKey, "vidarUpdate.skip");
  assert.equal(rows[1].skipKey, "packUpdates.skip.gemini");
  assert.equal(releaseRows(reply, { "packUpdates.skip.gemini": "1.1.0" }).length, 2);
  assert.equal(releaseRows(reply, { "packUpdates.skip.gemini": "1.0.0" }).length, 3);
  assert.deepEqual(releaseRows({ status: "offline", reason: "r" }, {}), []);
});

const cli = [{ id: "gemini", label: "Gemini", installed: "1.0.0", latest: "1.1.0" }];
const noop = { update() {}, skip() {} };

test("CLI rows render byte-identically with default and explicit CLI labels", () => {
  const a = doc().createElement("div");
  const b = doc().createElement("div");
  renderStartupUpdateRows(a, cli, null, null, noop);
  renderStartupUpdateRows(b, cli, null, null, noop, { heading: "CLI Updates", main: "Update" });
  assert.equal(a.innerHTML, b.innerHTML);
  assert.equal(a.querySelector(".swap-confirm-head").textContent, "CLI Updates");
  assert.equal(a.querySelector(".deps-update").textContent, "Update");
});

test("release rows: Update Available head, Open Release opens the page, a blocked pack shows its reason", () => {
  const root = doc().createElement("div");
  const rows = releaseRows(ok({ core, blocked: [{ id: "pi", label: "Pi", installed: null, release: "2.0.0", reason: "Pack Needs Update: Needs Vidar Update" }] }), {});
  const opened = [];
  renderStartupUpdateRows(root, rows, null, null, {
    update: (u) => opened.push(rows.find((r) => r.id === u.id).page),
    skip() {},
    blocked: (u) => rows.find((r) => r.id === u.id).blocked,
  }, { heading: "Update Available", main: "Open Release" });
  assert.equal(root.querySelector(".swap-confirm-head").textContent, "Update Available");
  const labels = [...root.querySelectorAll(".deps-label")].map((e) => e.textContent);
  assert.deepEqual(labels, ["Vidar 0.2.0", "Pi 2.0.0"]);
  const mains = [...root.querySelectorAll(".deps-update")];
  assert.deepEqual(mains.map((b) => b.textContent), ["Open Release", "Open Release"]);
  assert.deepEqual([...root.querySelectorAll(".deps-skip")].map((b) => b.textContent), ["Skip", "Skip"]);
  mains[0].click();
  assert.deepEqual(opened, [core.page]);
  assert.equal(mains[1].disabled, true);
  assert.equal(root.querySelector(".deps-note").textContent, "Pack Needs Update: Needs Vidar Update");
});

test("a pack offer with an empty page (pinned out by Rust) keeps its row; the card disables Open Release", () => {
  const rows = releaseRows(ok({ packs: [{ id: "pi", label: "Pi", installed: null, release: "1.0.0", page: "" }] }), {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].page, "");
  assert.equal(rows[0].blocked, null);
});
