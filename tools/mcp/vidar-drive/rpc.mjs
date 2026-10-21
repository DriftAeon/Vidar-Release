// tools\mcp\vidar-drive\rpc.mjs — newline-delimited JSON-RPC 2.0 over a pair of streams
// (stdin/stdout for the server). The only writer to `output`; diagnostics go to stderr.
// Requests dispatch concurrently: each handler starts at once and writes its own reply
// when it settles, so a long `wait` never blocks a later `state`.

import { createInterface } from "node:readline";

export class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

/** Serves `handlers` (method → async (params) => result) until `input` ends and every
 *  in-flight reply is written. Messages without an `id` are notifications: ignored. */
export function serve({ input, output, handlers, log = (m) => process.stderr.write(`vidar-drive: ${m}\n`) }) {
  const send = (msg) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const inflight = new Set();

  async function handle(msg) {
    const { id, method, params } = msg;
    try {
      const fn = typeof method === "string" && Object.hasOwn(handlers, method) ? handlers[method] : undefined;
      if (!fn) throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
      send({ id, result: await fn(params ?? {}) });
    } catch (error) {
      if (!(error instanceof RpcError)) log(`${method} failed: ${error.stack ?? error}`);
      send({ id, error: { code: error instanceof RpcError ? error.code : -32603, message: error.message } });
    }
  }

  // readline decodes UTF-8 across chunk boundaries, so a split multibyte character survives.
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      send({ id: null, error: { code: -32600, message: "invalid request" } });
      return;
    }
    if (msg.id === undefined || msg.id === null) return; // notification
    const job = handle(msg);
    inflight.add(job);
    job.finally(() => inflight.delete(job));
  });

  return new Promise((resolve) => {
    lines.on("close", async () => {
      while (inflight.size) await Promise.allSettled([...inflight]);
      resolve();
    });
  });
}
