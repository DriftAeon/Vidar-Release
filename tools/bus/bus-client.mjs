#!/usr/bin/env node
// tools\bus\bus-client.mjs — Node client for the bus ops on Falcon's session
// pipe (`Op::Subscribe`, `Op::Publish`; src-falcon\src\protocol.rs, serve.rs
// BusHub).
//
// Frames are 4-byte LE length + JSON, matching src-falcon\src\ipc.rs. Every
// connection negotiates first, exactly like src-tauri\src\falcon\connection.rs's
// `Connection::open`. One connection per client object; a client may both
// subscribe and publish on it because libuv pipes are overlapped (Vidar itself
// uses two connections, but a script here is free to share one).
//
// Library:
//   import { connect } from "./bus-client.mjs";
//   const client = await connect();
//   client.subscribe(["ask.open"], (frame) => { ... });
//   await client.publish("ask.open", { reason: "..." });
//   const reply = await client.request("ask.open", { reason: "..." }, { timeoutMs: 120_000 });
//   client.close();
//
// CLI:
//   node tools\bus\bus-client.mjs request <topic> --json '<payload>' [--timeout ms]
//   node tools\bus\bus-client.mjs respond <topic>   (loopback test responder)
//   node tools\bus\bus-client.mjs ping
//
// Exit codes (CLI only): 0 ok, 2 timeout, 3 registry missing or pipe refused.

import { connect as connectPipe } from "node:net";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "../lib/paths.mjs";

const REGISTRY_PATH = resolvePath("falconRegistry");

/** Registry missing/malformed, or the pipe refused the connection. CLI exit 3. */
export class BusUnavailableError extends Error {}

/**
 * The connection closed or errored after negotiate: every pending `call` and
 * in-flight `request` rejects with this at once instead of running to its
 * timeout (a Vidar exit drops the replier while Falcon keeps the pipe up, and
 * a host exit drops the pipe itself). A `BusUnavailableError`, so CLI exit 3.
 */
export class BusGoneError extends BusUnavailableError {}

/** No reply arrived within the deadline. CLI exit 2. */
export class BusTimeoutError extends Error {}

const MAX_FRAME = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000; // matches the ask gate's 300 s requester deadline (plan v1->v2)

/** Pull the three fields `connect` needs out of a parsed registry object. */
function registryFields(registry, source) {
  const { session_endpoint: sessionEndpoint, attach_secret: secret, protocol_max: protocol } = registry ?? {};
  if (!sessionEndpoint || !secret || !protocol) {
    throw new BusUnavailableError(`registry missing session_endpoint/attach_secret/protocol_max: ${source}`);
  }
  return { sessionEndpoint, secret, protocol };
}

function readRegistry() {
  let raw;
  try {
    raw = readFileSync(REGISTRY_PATH, "utf8");
  } catch (error) {
    throw new BusUnavailableError(`registry missing: ${REGISTRY_PATH}: ${error.message}`);
  }
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (error) {
    throw new BusUnavailableError(`registry malformed: ${REGISTRY_PATH}: ${error.message}`);
  }
  return registryFields(registry, REGISTRY_PATH);
}

/** Length-prefixed JSON write, matching `ipc::write_json_bounded`. */
function writeFrame(socket, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME) {
    throw new Error(`frame of ${body.length} bytes is out of range`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  socket.write(header);
  socket.write(body);
}

/**
 * Reassembles length-prefixed JSON frames out of a byte stream. Returns a
 * function to feed chunks into; calls `onFrame` once per complete frame.
 */
function makeFrameReader(onFrame) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME) {
        throw new Error(`frame length ${length} exceeds 1..=${MAX_FRAME}`);
      }
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      onFrame(JSON.parse(body.toString("utf8")));
    }
  };
}

/**
 * Exact match, or a pattern ending `.*` matching every topic with that
 * prefix followed by a `.` — mirrors `serve.rs`'s `topic_matches` exactly,
 * so a subscriber sees on this side precisely what the host thinks it fanned
 * out to it.
 */
function topicMatches(pattern, topic) {
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return topic.startsWith(prefix) && topic.slice(prefix.length).startsWith(".");
  }
  return pattern === topic;
}

/**
 * Open one connection: negotiate, then expose subscribe/publish/request on
 * it. Fails fast when the registry is missing or the pipe refuses — slice A
 * has no auto-start; Vidar is the normal starter. `registry` (a parsed
 * registry object, same shape as the file) replaces the file read, for tests.
 */
export function connect(clientName = "bus-client", { registry } = {}) {
  const { sessionEndpoint, secret, protocol } = registry
    ? registryFields(registry, "injected registry")
    : readRegistry();

  return new Promise((resolve, reject) => {
    const socket = connectPipe(sessionEndpoint);
    let settled = false;
    const failConnect = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new BusUnavailableError(`connect ${sessionEndpoint}: ${error.message}`));
    };
    socket.once("error", failConnect);

    socket.once("connect", () => {
      let nextRequestId = 1n;
      const pending = new Map(); // request id (bigint) -> {resolve, reject}
      // Each entry: {pattern, onFrame}. Re-sent as one Subscribe covering
      // every pattern's set whenever it changes, because Subscribe REPLACES
      // the connection's patterns server-side (protocol.rs) — it does not
      // add to them.
      const subs = [];
      // Reject functions of every `request` still waiting on its reply.
      const inflight = new Set();
      let gone = null; // the BusGoneError once the socket closed or errored

      function call(op) {
        return new Promise((resolveCall, rejectCall) => {
          if (gone) {
            rejectCall(gone);
            return;
          }
          const id = nextRequestId;
          nextRequestId += 1n;
          pending.set(id.toString(), { resolve: resolveCall, reject: rejectCall });
          try {
            writeFrame(socket, { id: Number(id), ...op });
          } catch (error) {
            pending.delete(id.toString());
            rejectCall(error);
          }
        });
      }

      const feed = makeFrameReader((frame) => {
        if (frame.t === "response") {
          const waiter = pending.get(String(frame.request));
          if (!waiter) return;
          pending.delete(String(frame.request));
          if (frame.outcome === "applied") waiter.resolve(frame.payload ?? null);
          else waiter.reject(new Error(frame.error ?? `request failed: ${frame.outcome}`));
          return;
        }
        if (frame.t === "bus") {
          for (const sub of subs) {
            if (topicMatches(sub.pattern, frame.topic)) sub.onFrame(frame);
          }
        }
        // Other frame types (session events) are not this client's concern;
        // a bus-only connection never attaches, so none should arrive.
      });
      socket.on("data", feed);
      socket.off("error", failConnect);
      // Close or error: fail every pending call and in-flight request now.
      // During negotiate this rejects that call, which `.catch` below turns
      // into the connect rejection (a BusGoneError is a BusUnavailableError).
      const lose = (reason) => {
        if (gone) return;
        gone = new BusGoneError(`bus gone: ${reason}`);
        for (const waiter of pending.values()) waiter.reject(gone);
        pending.clear();
        for (const rejectRequest of inflight) rejectRequest(gone);
        inflight.clear();
      };
      socket.on("error", (error) => lose(error.message));
      socket.on("close", () => lose("connection closed"));

      call({ op: "negotiate", protocol, client: clientName, secret })
        .then(() => {
          if (settled) return;
          settled = true;

          async function subscribe(topics, onFrame) {
            for (const pattern of topics) subs.push({ pattern, onFrame });
            const patterns = [...new Set(subs.map((sub) => sub.pattern))];
            await call({ op: "subscribe", topics: patterns });
          }

          async function publish(topic, payload, { id, replyTo } = {}) {
            const messageId = id ?? randomUUID();
            // Wire key is `msg_id`, not `id`: `Request` flattens `Op` beside
            // its own numeric `id`, and a second `"id"` key on the same
            // object is a deserialize error on the Rust side
            // (src-falcon\src\protocol.rs `Op::Publish`). `frame.id` on a
            // received bus/response frame is unaffected — only this
            // outgoing op key differs.
            const applied = await call({
              op: "publish",
              topic,
              msg_id: messageId,
              payload,
              ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
            });
            return { id: messageId, delivered: applied?.delivered ?? 0 };
          }

          async function request(topic, payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
            const id = randomUUID();
            const replyTopic = `${topic}.reply.${id}`;
            let rejectReply;
            const reply = new Promise((resolveReply, rejectWith) => {
              rejectReply = rejectWith;
              subscribe([replyTopic], (frame) => {
                if (frame.id === id) resolveReply(frame.payload);
              }).catch(() => {}); // a failed subscribe surfaces via the timeout or `lose` below
            });
            // A loss before the race starts must not surface as an unhandled rejection.
            reply.catch(() => {});
            if (gone) throw gone;
            inflight.add(rejectReply);
            let delivered;
            try {
              ({ delivered } = await publish(topic, payload, { id, replyTo: replyTopic }));
            } catch (error) {
              inflight.delete(rejectReply);
              throw error;
            }
            if (delivered === 0) {
              inflight.delete(rejectReply);
              throw new BusUnavailableError(`no subscriber for ${topic}`);
            }
            // The timer must be cleared on the `reply`-wins path: an
            // uncleared `setTimeout` keeps the event loop alive for the
            // rest of `timeoutMs` even after `Promise.race` has already
            // settled, so a one-shot CLI call that got its answer in
            // milliseconds would still not exit for up to
            // DEFAULT_TIMEOUT_MS (300s) — found via tools\bus\_repro.mjs.
            let timer;
            const timeout = new Promise((_, rejectTimeout) => {
              timer = setTimeout(
                () => rejectTimeout(new BusTimeoutError(`no reply on ${replyTopic} within ${timeoutMs}ms`)),
                timeoutMs,
              );
            });
            try {
              return await Promise.race([reply, timeout]);
            } finally {
              clearTimeout(timer);
              inflight.delete(rejectReply);
            }
          }

          function close() {
            // `end()` half-closes and waits for the peer's FIN before the
            // handle fully releases — on this pipe that wait never resolves
            // promptly, so a one-shot CLI invocation (request/ping) hung
            // past its own successful reply until something else killed it
            // (found via tools\bus\_repro.mjs during this brief; the same
            // call round-tripped in under 50ms but the process did not
            // exit for 15s). `destroy()` tears the handle down immediately;
            // the host's own teardown treats an abrupt disconnect the same
            // as a clean one for a connection with no attach and no lease.
            socket.destroy();
          }

          resolve({ subscribe, publish, request, close, socket });
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          reject(error instanceof BusUnavailableError ? error : new BusUnavailableError(error.message));
        });
    });
  });
}

// ---- CLI -------------------------------------------------------------

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    process.stderr.write("usage: bus-client.mjs request|respond|ping ...\n");
    process.exit(3);
  }

  let client;
  try {
    client = await connect();
  } catch (error) {
    process.stderr.write(`bus-client: ${error.message}\n`);
    process.exit(3);
    return;
  }

  try {
    if (command === "ping") {
      process.stdout.write("ok\n");
      client.close();
      return;
    }

    if (command === "request") {
      const topic = rest[0];
      let payload = {};
      let timeoutMs = DEFAULT_TIMEOUT_MS;
      for (let i = 1; i < rest.length; i += 1) {
        if (rest[i] === "--json") payload = JSON.parse(rest[++i]);
        else if (rest[i] === "--timeout") timeoutMs = Number(rest[++i]);
      }
      if (!topic) {
        process.stderr.write("usage: bus-client.mjs request <topic> --json '<payload>' [--timeout ms]\n");
        client.close();
        process.exit(3);
        return;
      }
      try {
        const reply = await client.request(topic, payload, { timeoutMs });
        process.stdout.write(`${JSON.stringify(reply)}\n`);
        client.close();
        return;
      } catch (error) {
        client.close();
        if (error instanceof BusTimeoutError) {
          process.stderr.write(`bus-client: ${error.message}\n`);
          process.exit(2);
          return;
        }
        process.stderr.write(`bus-client: ${error.message}\n`);
        process.exit(3);
        return;
      }
    }

    if (command === "respond") {
      const topic = rest[0];
      const noReply = rest.includes("--no-reply");
      if (!topic) {
        process.stderr.write("usage: bus-client.mjs respond <topic> [--no-reply]\n");
        client.close();
        process.exit(3);
        return;
      }
      await client.subscribe([topic], async (frame) => {
        if (!frame.reply_to || noReply) return;
        await client.publish(frame.reply_to, { ok: true, echo: frame.payload }, { id: frame.id });
      });
      // Printed once the Subscribe response lands, so a test harness spawning
      // this as a child can wait for it instead of racing the request.
      process.stdout.write("ready\n");
      // Runs until killed: a responder is a standing process for the
      // loopback test, not a one-shot.
      return;
    }

    process.stderr.write(`bus-client: unknown command ${command}\n`);
    client.close();
    process.exit(3);
  } catch (error) {
    process.stderr.write(`bus-client: ${error.message}\n`);
    client.close();
    process.exit(3);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
