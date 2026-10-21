// tools\bus\bus-client.mjs: an in-flight `request` fails fast with
// BusGoneError when the pipe drops, instead of running to its timeout.
// Self-contained: a fake named-pipe server stands in for Falcon.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { connect, BusGoneError } from "../tools/bus/bus-client.mjs";

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

test("an in-flight request rejects BusGoneError within 1 s of the socket closing", async (t) => {
  const pipe = `\\\\.\\pipe\\vidar-bus-gone-test-${randomUUID()}`;
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        const payload = request.op === "publish" ? { delivered: 1 } : {};
        socket.write(frame({ t: "response", request: request.id, outcome: "applied", payload }));
        // The replier "exits" right after accepting the publish.
        if (request.op === "publish") setTimeout(() => socket.destroy(), 20);
      }
    });
  });
  await new Promise((resolve) => server.listen(pipe, resolve));
  t.after(() => server.close());

  const client = await connect("bus-gone-test", {
    registry: { session_endpoint: pipe, attach_secret: "s", protocol_max: 1 },
  });
  t.after(() => client.close());

  const started = Date.now();
  await assert.rejects(client.request("ctl.wait", {}, { timeoutMs: 30_000 }), BusGoneError);
  assert.ok(Date.now() - started < 1000, `rejected after ${Date.now() - started} ms`);
});
