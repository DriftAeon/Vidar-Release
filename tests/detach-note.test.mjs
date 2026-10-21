// A Jettison-adopted session's first prompt carries the detached note once; a plain adopt never does.
import test from "node:test";
import assert from "node:assert/strict";

const { withDetachNote, DETACH_NOTE } = await import("../src/panels/rendered/detach-note.ts");

function fake() {
  const sent = [];
  return { sent, send: async (_t, _g, line) => { sent.push(line); } };
}
const user = (content) => JSON.stringify({ type: "user", content });

test("jettison adopt: first prompt is prefixed, the second is not", async () => {
  const base = fake();
  const t = withDetachNote(base, true);
  await t.send("tab", 1, JSON.stringify({ type: "interrupt" }));
  await t.send("tab", 1, user("hello"));
  await t.send("tab", 1, user("again"));
  assert.equal(base.sent[0], JSON.stringify({ type: "interrupt" }));
  assert.equal(JSON.parse(base.sent[1]).content, `${DETACH_NOTE}\nhello`);
  assert.equal(base.sent[2], user("again"));
});

test("a failed first send keeps the note for the retry", async () => {
  const base = fake();
  let fail = true;
  base.send = async (_t, _g, line) => { if (fail) { fail = false; throw new Error("x"); } base.sent.push(line); };
  const t = withDetachNote(base, true);
  await assert.rejects(t.send("tab", 1, user("one")));
  await t.send("tab", 1, user("one"));
  assert.equal(JSON.parse(base.sent[0]).content, `${DETACH_NOTE}\none`);
});

test("plain adopt: never prefixed", async () => {
  const base = fake();
  const t = withDetachNote(base, false);
  await t.send("tab", 1, user("hello"));
  assert.equal(base.sent[0], user("hello"));
});
