// Startup re-adopt: only a live, unattached Claude session last driven by Vidar
// comes back as a tab; a Jettisoned (shell-held), attached, exited or pre-field session stays put.
import test from "node:test";
import assert from "node:assert/strict";
import { heldElsewhere, readoptHostedSessions, shouldReadopt, shouldReadoptHeld } from "../src/launcher/readopt.ts";

const base = {
  session: "abc-1", generation: 1, agent: "claude", cwd: "C:\\x", conversation: null, pid: 1,
  model: null, permission_mode: "default", attached: 0, exited: null,
  queued_prompts: [], pending_permissions: [], last_holder: "vidar",
};

test("re-adopts only live, unattached Claude sessions Vidar held last", () => {
  assert.equal(shouldReadopt(base), true);
  const { last_holder: _, ...oldHost } = base;
  for (const skip of [
    { ...base, last_holder: "falcon-shell" },
    { ...base, last_holder: null },
    { ...base, attached: 1 },
    { ...base, exited: 0 },
    { ...base, agent: "codex" },
    oldHost,
  ]) assert.equal(shouldReadopt(skip), false, JSON.stringify(skip));
});

test("heldElsewhere: live, attached, last held by a non-Vidar client", () => {
  const held = { ...base, attached: 1, last_holder: "falcon-shell" };
  assert.equal(heldElsewhere(held), true);
  const { last_holder: _, ...oldHost } = held;
  for (const no of [
    base,
    { ...held, last_holder: "vidar" },
    { ...held, last_holder: null },
    { ...held, attached: 0 },
    { ...held, exited: 0 },
    oldHost,
  ]) assert.equal(heldElsewhere(no), false, JSON.stringify(no));
});

// Background adopts never select; with no tab selected the first adopted one is, and a
// selection that already exists is never replaced.
test("re-adopt selects the first tab only when none is selected", async () => {
  const run = async (initial) => {
    let active = initial;
    const selected = [];
    await readoptHostedSessions({
      available: async () => true,
      list: async () => ({ sessions: [{ ...base, session: "a" }, { ...base, session: "b" }] }),
      openIds: async () => [],
      held: async () => [],
      detach: async () => {},
      relaunch: true,
      adopt: async (s) => `tab-${s.session}`,
      activeId: () => active,
      select: (t) => { selected.push(t); active = t; },
    });
    return selected;
  };
  assert.deepEqual(await run(null), ["tab-a"]);
  assert.deepEqual(await run("user-tab"), []);
});

// Reload ghosts (falcon-idle-reap.md §Decision 1): the held predicate ignores last_holder and
// attached, since both describe this process's own view.
test("held views re-adopt whatever last_holder says", () => {
  const held = new Set(["abc-1"]);
  for (const last_holder of ["vidar", "falcon-shell", null]) {
    assert.equal(shouldReadoptHeld({ ...base, attached: 1, last_holder }, held), true, String(last_holder));
  }
  assert.equal(shouldReadoptHeld({ ...base, exited: 0 }, held), false);
  assert.equal(shouldReadoptHeld(base, new Set()), false);
});

// After a reload the boot adopts held views even in a dev build (relaunch false), then detaches
// every held view by its old tab: a no-op for a moved one, a release for the rest.
test("boot adopts held views, then detaches the held set", async () => {
  const adopted = [];
  const detached = [];
  await readoptHostedSessions({
    available: async () => true,
    list: async () => ({ sessions: [
      { ...base, session: "a", attached: 1 },
      { ...base, session: "b", attached: 1, exited: 0 },
      { ...base, session: "c" },
    ] }),
    openIds: async () => [],
    held: async () => [{ tab: "s1-old", session: "a", gen: 4 }, { tab: "s2-old", session: "b", gen: 5 }],
    detach: async (tab, gen) => { detached.push(`${tab}:${gen}`); },
    relaunch: false,
    adopt: async (s) => { adopted.push(s.session); return `tab-${s.session}`; },
    activeId: () => "user-tab",
    select: () => {},
  });
  assert.deepEqual(adopted, ["a"]);
  assert.deepEqual(detached, ["s1-old:4", "s2-old:5"]);
});
