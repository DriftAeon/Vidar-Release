// vault-pending.ts: Modify's staged changes. Flips net out, Done's op list is ordered and drops members of a runeset
// pending removal, output styles stay exclusive over the pending state.
import test from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const P = await import("../src/runes/bare/vault-pending.ts");
const SET = { library: "lib", set: "daily" };
const rune = (library, id) => ({ t: "rune", library, id });
const style = (id) => ({ t: "rune", library: "lib", id, kind: "output-style" });
const member = (id) => ({ t: "member", set: SET, rune: { library: "lib", id } });
const view = ({ sets = [SET], runes = [], members = [], off = [] } = {}) => ({
  vault: { runesets: sets.map((source) => ({ source })), runes },
  runes: [...runes.map((r) => ({ ...r, set: null })), ...members.map((id) => ({ library: "lib", id, set: SET }))],
  off: off.map((id) => ({ library: "lib", id, set: SET })),
});

test("flip twice nets to no op", () => {
  const p = new Map();
  P.flip(p, rune("lib", "a"), false);
  assert.equal(p.size, 1);
  assert.equal(P.effectiveOn(p, rune("lib", "a"), false), true);
  assert.equal(P.isPending(p, rune("lib", "a")), true);
  P.flip(p, rune("lib", "a"), false);
  assert.equal(p.size, 0);
  assert.deepEqual(P.pendingOps(p), []);
});

test("pendingOps orders sets, runes, members", () => {
  const p = new Map();
  P.flip(p, member("m"), true);
  P.flip(p, rune("lib", "gone"), true);
  P.flip(p, rune("lib", "new"), false);
  P.flip(p, { t: "set", source: { library: "lib", set: "old" } }, true);
  P.flip(p, { t: "set", source: { library: "lib", set: "fresh" } }, false);
  assert.deepEqual(P.pendingOps(p).map((o) => o.op), ["addRuneset", "removeRuneset", "addRune", "removeRune", "member"]);
});

test("members of a runeset pending removal leave the batch", () => {
  const p = new Map();
  P.flip(p, member("m"), true);
  P.flip(p, { t: "set", source: SET }, true);
  assert.deepEqual(P.pendingOps(p), [{ op: "removeRuneset", ref: SET }]);
});

test("a library tick on a rune held only by a runeset pending removal becomes addRune", () => {
  const v = view({ members: ["m"] });
  const p = new Map();
  assert.deepEqual(P.libraryTargets(v, p, { library: "lib", id: "m" }), [{ target: member("m"), base: true }]);
  P.flip(p, { t: "set", source: SET }, true);
  assert.deepEqual(P.libraryTargets(v, p, { library: "lib", id: "m" }), [{ target: rune("lib", "m"), base: false }]);
});

test("library targets: a held one-off, an off member, a new rune", () => {
  const v = view({ runes: [{ library: "lib", id: "one" }], off: ["offm"] });
  const p = new Map();
  assert.deepEqual(P.libraryTargets(v, p, { library: "lib", id: "one" }), [{ target: rune("lib", "one"), base: true }]);
  assert.deepEqual(P.libraryTargets(v, p, { library: "lib", id: "offm" }), [{ target: member("offm"), base: false }]);
  assert.deepEqual(P.libraryTargets(v, p, { library: "other", id: "x" }), [{ target: rune("other", "x"), base: false }]);
  const ts = P.libraryTargets(v, p, { library: "lib", id: "offm" });
  assert.deepEqual(P.rowState(p, ts), { on: false, pending: false });
  P.setWanted(p, ts[0].target, ts[0].base, true);
  assert.deepEqual(P.rowState(p, ts), { on: true, pending: true });
});

test("output styles stay exclusive over pending state", () => {
  const p = new Map();
  const styles = [{ target: style("a"), base: false }, { target: style("b"), base: false }, { target: style("c"), base: true }];
  // a pending add of A, then B: A's pending add drops, C (saved on) goes pending off
  P.flip(p, style("a"), false, styles);
  assert.equal(P.effectiveOn(p, style("c"), true), false);
  P.flip(p, style("b"), false, styles);
  assert.equal(P.isPending(p, style("a")), false);
  assert.equal(P.effectiveOn(p, style("b"), false), true);
  assert.equal(P.effectiveOn(p, style("c"), true), false);
  // unticking B brings the replaced saved style back: the vault never ends with none
  P.flip(p, style("b"), false, styles);
  assert.equal(P.effectiveOn(p, style("c"), true), true);
  assert.equal(p.size, 0);
});

// Every add path keeps one output style: a runeset head, a runeset holding two styles, a one-off over a staged runeset,
// two runesets in one batch. The view builds its targets through setTarget and styleTargets.
const NEW = { library: "lib", set: "fresh" }, ALT = { library: "lib", set: "alt" };
const LIBSETS = [
  { library: "lib", set: "fresh", members: [{ library: "lib", id: "x" }, { library: "lib", id: "s1" }], fixed: false },
  { library: "lib", set: "pair", members: [{ library: "lib", id: "s1" }, { library: "lib", id: "x" }, { library: "lib", id: "s2" }], fixed: false },
  { library: "lib", set: "alt", members: [{ library: "lib", id: "s3" }], fixed: false },
];
const LIB = [
  { library: "lib", id: "x", kind: "skill" }, { library: "lib", id: "c", kind: "output-style" },
  { library: "lib", id: "s1", kind: "output-style" }, { library: "lib", id: "s2", kind: "output-style" },
  { library: "lib", id: "s3", kind: "output-style" }, { library: "lib", id: "d", kind: "output-style" },
];
// a vault holding one-off style C on, no runesets
const styled = () => ({ vault: { runesets: [], runes: [{ library: "lib", id: "c" }] }, runes: [{ library: "lib", id: "c", kind: "output-style", set: null }] });
const head = (p, v, source) => P.setWanted(p, P.setTarget(source, LIBSETS, LIB), false, true, P.styleTargets(v, p, LIB));

test("a runeset head adding a style switches the vault's saved style off", () => {
  const p = new Map(), v = styled();
  head(p, v, NEW);
  assert.deepEqual(P.pendingOps(p), [
    { op: "addRuneset", ref: NEW },
    { op: "removeRune", ref: { library: "lib", id: "c" } },
  ]);
  // unticking the runeset brings C back and leaves nothing staged
  P.flip(p, P.setTarget(NEW, LIBSETS, LIB), false, P.styleTargets(v, p, LIB));
  assert.equal(p.size, 0);
});

test("a runeset holding two styles keeps its first on and switches the rest off in the vault's copy", () => {
  const p = new Map(), v = { vault: { runesets: [], runes: [] }, runes: [] };
  const pair = { library: "lib", set: "pair" };
  head(p, v, pair);
  assert.deepEqual(P.pendingOps(p), [
    { op: "addRuneset", ref: pair },
    P.memberOp(pair, { library: "lib", id: "s2" }, false),
  ]);
});

test("a one-off style over a staged runeset switches the runeset's style off; unstaging the runeset leaves no member op", () => {
  const p = new Map(), v = { vault: { runesets: [], runes: [] }, runes: [] };
  head(p, v, NEW);
  P.flip(p, style("d"), false, P.styleTargets(v, p, LIB));
  assert.deepEqual(P.pendingOps(p), [
    { op: "addRuneset", ref: NEW },
    { op: "addRune", ref: { library: "lib", id: "d" } },
    P.memberOp(NEW, { library: "lib", id: "s1" }, false),
  ]);
  P.flip(p, P.setTarget(NEW, LIBSETS, LIB), false, P.styleTargets(v, p, LIB));
  assert.deepEqual(P.pendingOps(p), [{ op: "addRune", ref: { library: "lib", id: "d" } }]);
});

test("two runesets with a style in one batch: the later one's style wins", () => {
  const p = new Map(), v = styled();
  head(p, v, NEW);
  head(p, v, ALT);
  assert.deepEqual(P.pendingOps(p), [
    { op: "addRuneset", ref: NEW },
    { op: "addRuneset", ref: ALT },
    { op: "removeRune", ref: { library: "lib", id: "c" } },
    P.memberOp(NEW, { library: "lib", id: "s1" }, false),
  ]);
  // unticking the later runeset brings the earlier one's style back
  P.flip(p, P.setTarget(ALT, LIBSETS, LIB), false, P.styleTargets(v, p, LIB));
  assert.deepEqual(P.pendingOps(p), [{ op: "addRuneset", ref: NEW }, { op: "removeRune", ref: { library: "lib", id: "c" } }]);
});

// A Rune Library row inside a runeset card that is not placed: the pick stages the runeset with only that member on,
// so Done writes the runeset the vault view shows, never a loose copy of its rune.
const pick = (p, v, id, card) => {
  const ts = P.libraryTargets(v, p, LIB.find((r) => r.id === id), LIBSETS, card);
  const on = !P.rowState(p, ts).on;
  const styles = P.styleTargets(v, p, LIB);
  for (const b of ts) P.setWanted(p, b.target, b.base, on, styles);
};
const empty = () => ({ vault: { runesets: [], runes: [] }, runes: [] });

test("a member pick of an unjoined runeset: Done adds the runeset and switches its other members off, no addRune", () => {
  const p = new Map(), v = empty();
  pick(p, v, "x", NEW);
  assert.deepEqual(P.pendingOps(p), [{ op: "addRuneset", ref: NEW }, P.memberOp(NEW, { library: "lib", id: "s1" }, false)]);
  // the same rune from the Satchel (no runeset card) stays a one-off
  const q = new Map();
  pick(q, v, "x");
  assert.deepEqual(P.pendingOps(q), [{ op: "addRune", ref: { library: "lib", id: "x" } }]);
});

test("a second pick in the joining runeset switches its member back on; unticking the runeset leaves nothing", () => {
  const p = new Map(), v = empty();
  pick(p, v, "x", NEW);
  pick(p, v, "s1", NEW);
  assert.deepEqual(P.pendingOps(p), [{ op: "addRuneset", ref: NEW }]);
  pick(p, v, "x", NEW);
  assert.deepEqual(P.pendingOps(p), [{ op: "addRuneset", ref: NEW }, P.memberOp(NEW, { library: "lib", id: "x" }, false)]);
  P.flip(p, P.setTarget(NEW, LIBSETS, LIB), false, P.styleTargets(v, p, LIB));
  assert.equal(p.size, 0);
});

test("a row of a runeset joined by its head is that runeset's member, on: unticking it writes a member op", () => {
  const p = new Map(), v = empty();
  head(p, v, NEW);
  const ts = P.libraryTargets(v, p, LIB[0], LIBSETS, NEW);
  assert.deepEqual(ts, [{ target: { t: "member", set: NEW, rune: { library: "lib", id: "x" }, kind: "skill" }, base: true }]);
  assert.deepEqual(P.rowState(p, ts), { on: true, pending: false });
  pick(p, v, "x", NEW);
  assert.deepEqual(P.pendingOps(p), [{ op: "addRuneset", ref: NEW }, P.memberOp(NEW, { library: "lib", id: "x" }, false)]);
});

test("picking a style member of an unjoined runeset keeps one style: the vault's style goes off", () => {
  const p = new Map(), v = styled();
  pick(p, v, "s1", NEW);
  assert.deepEqual(P.pendingOps(p), [
    { op: "addRuneset", ref: NEW },
    { op: "removeRune", ref: { library: "lib", id: "c" } },
    P.memberOp(NEW, { library: "lib", id: "x" }, false),
  ]);
  // a non-style pick of a runeset holding two styles keeps every style off
  const q = new Map();
  pick(q, v, "x", { library: "lib", set: "pair" });
  const PAIR = { library: "lib", set: "pair" };
  assert.deepEqual(P.pendingOps(q), [{ op: "addRuneset", ref: PAIR },
    P.memberOp(PAIR, { library: "lib", id: "s1" }, false), P.memberOp(PAIR, { library: "lib", id: "s2" }, false)]);
});

test("prune drops satisfied and vanished targets", () => {
  const p = new Map();
  P.flip(p, rune("lib", "a"), false);
  P.flip(p, rune("lib", "b"), false);
  P.flip(p, member("m"), true);
  P.flip(p, { t: "member", set: { library: "lib", set: "other" }, rune: { library: "lib", id: "x" } }, true);
  // fresh read: a landed elsewhere, m's runeset copy no longer lists m, "other" is not placed
  P.prune(p, view({ runes: [{ library: "lib", id: "a" }] }));
  assert.deepEqual([...p.keys()], ["rune:lib/b"]);
});

test("prune keeps members of a runeset pending add", () => {
  const p = new Map();
  const NEW = { library: "lib", set: "new" };
  P.flip(p, { t: "set", source: NEW }, false);
  P.flip(p, { t: "member", set: NEW, rune: { library: "lib", id: "x" } }, true);
  P.prune(p, view());
  assert.equal(p.size, 2);
});

test("forget drops a deleted rune's entries", () => {
  const p = new Map();
  P.flip(p, rune("lib", "a"), false);
  P.flip(p, member("a"), true);
  P.flip(p, rune("lib", "b"), false);
  P.forget(p, "lib", "a");
  assert.deepEqual([...p.keys()], ["rune:lib/b"]);
});
