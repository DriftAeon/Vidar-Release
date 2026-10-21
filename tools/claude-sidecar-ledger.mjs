// claude-sidecar-ledger.mjs: the usage-ledger line a Falcon-hosted Claude session appends for each SDK `result`
// message. Imported by claude-sidecar.mjs and bundled beside it (Falcon bundle sidecar\, friend zip tools\).
// Twin of src-tauri/src/usage_ledger.rs (same line shape); the Rust side writes the rune-gen and flow lines.
//
// Usage: import { startLedger } from "./claude-sidecar-ledger.mjs";
//        const observeLedger = startLedger({ enabled: falcon }); // then observeLedger(msg) per message
//
// Line: {"ts","source":"falcon","sid","model","in","out","cacheRead","cacheWrite","costUsd","transcript":true}
// Path: contracts/paths.json id `usageLedger`, resolved here from the Vidar root's own copy of the contract
// (tools/lib/paths.mjs is not bundled): the contract rel under the root.
//
// Refuses: no top-level side effects; one appendFileSync per line; never throws (a failed write goes to
// stderr, which the host already logs, and the session carries on).

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { readVidarConfig } from "./claude-sidecar-statusline.mjs";

const ID = "usageLedger";

// Absolute path of `id` under `root` from the parsed contract `ids`, or null when the id is unknown.
export function resolveLedgerPath(root, ids, id = ID) {
  const tail = [];
  let cur = id;
  for (let i = 0; i < 16; i++) {
    const n = ids?.[cur];
    if (!n) return null;
    if (n.under === "root") return join(root, n.rel, ...tail);
    tail.unshift(n.rel);
    cur = n.under;
  }
  return null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// The model with the largest costUSD in a result's modelUsage, else null.
function dominantModel(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  let best = null;
  let bestCost = -1;
  for (const [name, u] of Object.entries(modelUsage)) {
    const cost = num(u?.costUSD);
    if (cost > bestCost) { best = name; bestCost = cost; }
  }
  return best;
}

// The ledger line (object) for an SDK `result` message, or null for any other message.
export function ledgerEntry(msg, ts = new Date().toISOString()) {
  if (msg?.type !== "result") return null;
  const u = msg.usage ?? {};
  return {
    ts,
    source: "falcon",
    sid: typeof msg.session_id === "string" ? msg.session_id : null,
    model: dominantModel(msg.modelUsage),
    in: num(u.input_tokens),
    out: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
    transcript: true,
  };
}

// observe(msg): appends a line per `result` when enabled. `path` overrides the resolved ledger file (tests).
export function startLedger({ enabled = true, path = null } = {}) {
  if (!enabled) return () => {};
  let file = path;
  const resolveFile = () => {
    if (file) return file;
    const cfg = readVidarConfig();
    if (!cfg) return null;
    const contract = JSON.parse(readFileSync(join(cfg.root, "contracts", "paths.json"), "utf8").replace(/^﻿/, ""));
    file = resolveLedgerPath(cfg.root, contract.ids);
    return file;
  };
  return (msg) => {
    try {
      const entry = ledgerEntry(msg);
      if (!entry) return;
      const target = resolveFile();
      if (!target) return;
      mkdirSync(dirname(target), { recursive: true });
      appendFileSync(target, JSON.stringify(entry) + "\n");
    } catch (e) {
      try { process.stderr.write(`usage ledger: ${e?.message ?? e}\n`); } catch {}
    }
  };
}
