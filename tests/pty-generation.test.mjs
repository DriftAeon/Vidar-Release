import test from "node:test";
import assert from "node:assert/strict";
import { matchesPtyGeneration } from "../src/panels/sessions/pty-generation.ts";

test("exit and output accept only the terminal attachment's own tag", () => {
  for (const event of ["pty-exit", "pty-output"]) {
    const applied = [];
    // attachTerminalBody tags the attachment before invoking spawn_pty; no reply has arrived yet.
    const session = { body: "terminal", term: {}, ptyGen: 2 };
    const apply = (gen) => {
      if (matchesPtyGeneration(session, gen)) applied.push(gen);
    };
    apply(2); // own tag before the reply (ConPTY's ESC[6n, an immediate exit): applied
    apply(1); // stale tag from the attachment this one replaced: dropped
    assert.deepEqual(applied, [2], event);
  }
  const session = { body: "terminal", term: {}, ptyGen: 2 };
  assert.equal(matchesPtyGeneration(undefined, 2), false);
  assert.equal(matchesPtyGeneration({ ...session, ptyGen: undefined }, 2), false);
  assert.equal(matchesPtyGeneration({ ...session, term: undefined }, 2), false);
  assert.equal(matchesPtyGeneration({ ...session, body: "rendered" }, 2), false);
});
