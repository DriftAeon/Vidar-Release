// A replay arrives as one `agent-event` carrying `batch: [...]` (falcon/events.rs ReplayBatch);
// the router must hand its items, in order, to the same handlers a run of single payloads reaches.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom();
const { ensureListeners, registerRoute, releaseRoute } = await import("../src/panels/rendered/host-router.ts");

function route(log) {
  return {
    gen: -1, floor: 0,
    adapter: { feed: (line) => [line] },
    handle: (ev) => log.push(["line", ev]),
    dropped: (n) => log.push(["dropped", n]),
    exit: () => {},
    host: (p) => log.push(["host", p.hydration ?? p.hostRecord?.record ?? null, p.id, p.gen]),
  };
}

test("host router: a batched payload delivers its items in order, like singles", async () => {
  await ensureListeners();
  const fire = dom.ipc.listeners["agent-event"];
  const singles = [];
  registerRoute("hb-1", route(singles));
  const items = [
    { hostRecord: { record: "prompt-queued" } },
    { line: "a", replay: true },
    { dropped: 7, replay: true },
    { line: "b", replay: true },
  ];
  for (const item of items) fire({ payload: { id: "hb-1", gen: 4, ...item } });

  const batched = [];
  registerRoute("hb-2", route(batched));
  fire({ payload: { id: "hb-2", gen: 4, batch: items } });

  assert.equal(batched.length, 4);
  assert.deepEqual(
    batched.map((r) => r.slice(0, 2)),
    [["host", "prompt-queued"], ["line", "a"], ["dropped", 7], ["line", "b"]],
  );
  assert.deepEqual(batched[0].slice(2), ["hb-2", 4], "host payload lost id/gen");
  assert.deepEqual(batched.map((r) => r.slice(0, 2)), singles.map((r) => r.slice(0, 2)));
  releaseRoute("hb-1");
  releaseRoute("hb-2");
});
