import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { describeCheck, describeStamp, describeThrown, renderLaunchSwitch, renderRelease } from "../src/settings/release-view.ts";

const head = "abcdef0" + "1".repeat(33);
const stamp = (over = {}) => ({ head, dirty: false, builtUtc: "2026-10-11T00:00:00Z", local: true, ...over });
const doc = () => new JSDOM("<!doctype html><body></body>").window.document;

test("a stamp shows the short commit, with the full hash and build time in the tooltip", () => {
  const { label, tip } = describeStamp(stamp());
  assert.equal(label, head.slice(0, 7));
  assert.ok(tip.includes(head));
  assert.ok(tip.includes("2026-10-11T00:00:00Z"));
});

test("dirty shows Local Changes only for a local build, never for a release zip", () => {
  assert.match(describeStamp(stamp({ dirty: true })).label, /Local Changes/);
  assert.doesNotMatch(describeStamp(stamp({ dirty: true, local: false })).label, /Local Changes/);
  assert.doesNotMatch(describeStamp(stamp({ dirty: false })).label, /Local Changes/);
});

test("a missing stamp shows Dev Build with no commit", () => {
  const root = renderRelease(doc(), null, async () => {});
  const text = root.textContent ?? "";
  assert.ok(text.includes("Dev Build"));
  assert.doesNotMatch(text, /[0-9a-f]{7}/);
});

test("the row has one action that opens releases and reports a failure to open", async () => {
  let opened = 0;
  const failing = renderRelease(doc(), stamp(), async () => { opened++; throw new Error("no"); });
  const buttons = failing.querySelectorAll("button");
  assert.equal(buttons.length, 1);
  buttons[0].click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(opened, 1);
  assert.ok(failing.querySelector("[role=status]").textContent.length > 0);
});

const okReply = (core) => ({ status: "ok", core, packs: [], blocked: [], seen: {} });
const newer = { installed: "0.1.0", version: "0.2.0", page: "https://x/tag", asset: null };

test("check status strings: up to date, Update Available, or could not check with the reason as tooltip", () => {
  assert.deepEqual(describeCheck(okReply(null)), { text: "Vidar Is Up to Date", tip: "" });
  assert.deepEqual(describeCheck(okReply(newer)), { text: "Update Available", tip: "" });
  // A pack offer alone is an update too.
  const packOffer = { id: "gemini", label: "Gemini", installed: null, release: "1.1.0", page: "https://p/g" };
  assert.deepEqual(describeCheck({ ...okReply(null), packs: [packOffer] }), { text: "Update Available", tip: "" });
  assert.deepEqual(describeCheck({ status: "notPublished", reason: "No release index is published yet." }),
    { text: "No Release Published Yet", tip: "No release index is published yet." });
  assert.deepEqual(describeCheck({ status: "offline", reason: "Vidar could not reach GitHub." }),
    { text: "Could Not Reach GitHub", tip: "Vidar could not reach GitHub." });
  const err = (reason) => describeCheck({ status: "error", reason });
  assert.deepEqual(err("GitHub answered with status 503."), { text: "GitHub Returned Status 503", tip: "GitHub answered with status 503." });
  assert.equal(err("The release index is too large.").text, "Release Index Too Large");
  assert.equal(err("The release index is not text.").text, "Release Index Unreadable");
  assert.equal(err("The release index could not be read.").text, "Release Index Unreadable");
  assert.equal(err("The request failed: broken pipe.").text, "Request Failed");
  assert.deepEqual(err("Something new."), { text: "Could Not Check for Updates", tip: "Something new." });
});

test("a thrown check keeps the generic line, with a short cause appended and the full text as tooltip", () => {
  assert.deepEqual(describeThrown(new Error("command failed")),
    { text: "Could Not Check for Updates: command failed", tip: "Error: command failed" });
  const long = "x".repeat(60);
  assert.equal(describeThrown(long).text, "Could Not Check for Updates");
  assert.equal(describeThrown(long).tip, long);
  assert.equal(describeThrown(undefined).text, "Could Not Check for Updates");
});

test("Check Now shows Update Available, and a failed command as could not check", async () => {
  const d = doc();
  const root = renderRelease(d, stamp(), async () => {}, async () => okReply(newer));
  const check = [...root.querySelectorAll("button")].find((b) => b.textContent === "Check Now");
  check.click();
  await new Promise((r) => setTimeout(r, 0));
  const status = root.querySelector("[role=status]");
  assert.equal(status.textContent, "Update Available");
  const failing = renderRelease(d, stamp(), async () => {}, async () => { throw new Error("command failed"); });
  [...failing.querySelectorAll("button")].find((b) => b.textContent === "Check Now").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(failing.querySelector("[role=status]").textContent, "Could Not Check for Updates: command failed");
  assert.match(failing.querySelector("[role=status]").title, /command failed/);
});

test("the launch switch defaults on, reads state and saves the flip", async () => {
  const saved = [];
  const sw = renderLaunchSwitch(doc(), Promise.resolve(false), async (on) => { saved.push(on); }, () => {});
  assert.equal(sw.getAttribute("aria-label"), "Check for Updates at Launch");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sw.getAttribute("aria-checked"), "false");
  sw.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(saved, [true]);
  assert.equal(sw.getAttribute("aria-checked"), "true");
});
