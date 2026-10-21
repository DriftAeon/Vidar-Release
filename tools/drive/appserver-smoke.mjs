// Smoke test for `codex app-server` over piped stdio (JSON-RPC 2.0, JSONL):
// initialize → initialized → thread/start → turn/start → wait for turn/completed.
// Prints every notification method and the first agent message. Spends one
// short Codex turn. Run from the repo root: node tools\drive\appserver-smoke.mjs
// Exit 0 = turn completed; 2 = timeout; 1 = error.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve as resolveId } from "../lib/paths.mjs";

const cwd = resolveId("display");
const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: true });
const t0 = Date.now();
const log = (s) => console.log(`${String(Date.now() - t0).padStart(6)}ms ${s}`);
let nextId = 1;
const pending = new Map();
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject, method });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const timer = setTimeout(() => { log("TIMEOUT"); child.kill(); process.exit(2); }, 180_000);
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${String(d).slice(0, 300)}`));
child.on("exit", (code) => { log(`app-server exit ${code}`); clearTimeout(timer); });

let threadId = null, turnId = null, agentText = "";
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { log(`non-JSON: ${line.slice(0, 120)}`); return; }
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (!p) { log(`response for unknown id ${m.id}`); return; }
    if (m.error) { log(`${p.method} ERROR ${JSON.stringify(m.error).slice(0, 300)}`); p.reject(m.error); } else { log(`${p.method} ok ${JSON.stringify(m.result).slice(0, 200)}`); p.resolve(m.result); }
    return;
  }
  if (m.id !== undefined && m.method) { // server → client request
    log(`SERVER REQUEST ${m.method} ${JSON.stringify(m.params).slice(0, 200)}`);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { decision: "decline" } }) + "\n");
    return;
  }
  const method = m.method ?? "?";
  if (method === "item/agentMessage/delta") { agentText += m.params?.delta ?? ""; return; }
  log(`notify ${method}${method === "item/started" || method === "item/completed" ? ` ${m.params?.item?.type}` : ""}${method === "thread/tokenUsage/updated" ? ` ctx=${m.params?.tokenUsage?.modelContextWindow} last=${JSON.stringify(m.params?.tokenUsage?.last)}` : ""}${method === "account/rateLimits/updated" ? ` ${JSON.stringify(m.params).slice(0, 300)}` : ""}`);
  if (method === "turn/completed") {
    log(`turn status=${m.params?.turn?.status} error=${JSON.stringify(m.params?.turn?.error)}`);
    log(`agent text: ${agentText.slice(0, 200)}`);
    child.stdin.end();
    setTimeout(() => process.exit(m.params?.turn?.status === "completed" ? 0 : 1), 2000);
  }
});

(async () => {
  try {
    await request("initialize", { clientInfo: { name: "vidar-smoke", title: "Vidar smoke", version: "0.1.0" } });
    notify("initialized", {});
    const t = await request("thread/start", { cwd, approvalPolicy: "on-request", sandbox: "workspace-write" });
    threadId = t.thread?.id;
    log(`thread ${threadId} model=${t.model} sandbox=${JSON.stringify(t.sandbox)} approval=${JSON.stringify(t.approvalPolicy)}`);
    const turn = await request("turn/start", { threadId, input: [{ type: "text", text: "Reply with exactly the single word PONG and nothing else." }] });
    turnId = turn.turn?.id;
    log(`turn ${turnId} started`);
  } catch (e) { log(`failed: ${JSON.stringify(e).slice(0, 300)}`); process.exit(1); }
})();
