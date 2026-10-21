// claude-sidecar-shrink.mjs: caps SDK messages at CAP bytes of JSON per tool input / tool result
// before claude-sidecar.mjs writes them to its stdout protocol (live traffic and resume replay).
// Imported by claude-sidecar.mjs and bundled beside it (Falcon bundle sidecar\, friend zip tools\).
//
// Usage: import { CAP, bytes, summarizeInput, shrink } from "./claude-sidecar-shrink.mjs";
//
// Refuses: no I/O, no top-level side effects; `shrink` never throws (a message it cannot
// shrink goes out as-is rather than being lost).

export const CAP = 256 * 1024; // bytes of JSON per tool input / tool result before truncation

/* ---- shrink: exact byte caps on the parsed object ---- */

export function bytes(v) {
  return Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
}
// One whole sidecar stdout line (a full SDK message) must stay well under the Rust readers'
// LINE_CAP of 8 MiB (src-tauri/src/agent.rs:38 and src-falcon/src/process.rs:68), which drop the
// line whole, taking every pill in the message with it.
export const MESSAGE_CAP = 4 * 1024 * 1024;
const FIELD_CAP = 4 * 1024; // bytes of JSON per summarized input field
const TEXT_WRAPPER = bytes({ type: "text", text: "" }); // an empty text block's JSON bytes, quotes included

export function summarizeInput(name, input) {
  const s = {};
  for (const k of ["file_path", "path", "pattern", "description", "url"]) {
    const v = input?.[k];
    if (typeof v === "string") s[k] = bytes(v) > FIELD_CAP ? shrinkText(v, Buffer.byteLength(v, "utf8"), FIELD_CAP) : v;
  }
  if (typeof input?.command === "string") s.command = input.command.slice(0, 200);
  return s;
}
function shrinkToolUse(block) {
  const n = bytes(block.input);
  if (n <= CAP) return block;
  return { ...block, input: { ...summarizeInput(block.name, block.input), __truncated: n } };
}
// Truncated text whose JSON string form (quotes and escapes included) is at most `budget` bytes.
function shrinkText(text, n, budget = CAP) {
  const marker = `\n… [truncated: ${n} bytes]`;
  const markerJson = bytes(marker) - 2; // "\n" is 2 bytes in JSON; drop the quotes
  const buf = Buffer.from(text, "utf8");
  let len = Math.max(0, Math.min(buf.length, budget - 2 - markerJson));
  for (;;) {
    const s = `${buf.subarray(0, len).toString("utf8")}${marker}`;
    if (len === 0 || bytes(s) <= budget) return s; // len 0 returns the bare marker even if the budget is below it
    // escapes (\n, \", \uXXXX) inflate the JSON form; retry smaller. Strictly decreasing, clamped at 0: terminates.
    len = Math.max(0, Math.min(len - 1, Math.floor(len * 0.9)));
  }
}
function imagePlaceholder(b) {
  return { type: "text", text: `[image omitted: ${bytes(b)} bytes]` };
}
function shrinkToolResult(block, cap = CAP) {
  const n = bytes(block.content);
  if (n <= cap) return block;
  if (typeof block.content === "string") return { ...block, content: shrinkText(block.content, n, cap), __truncated: n };
  // block array: keep blocks that fit, truncate the first oversize text block into the rest, drop other oversize ones
  const kept = [];
  let used = 2; // brackets
  let truncated = false;
  for (const b of block.content) {
    const sep = kept.length ? 1 : 0; // comma
    const bn = bytes(b) + sep;
    if (used + bn <= cap) { kept.push(b); used += bn; continue; }
    if (!truncated && b.type === "text" && typeof b.text === "string") {
      const budget = cap - used - sep - (TEXT_WRAPPER - 2);
      if (budget > 64) {
        const t = { type: "text", text: shrinkText(b.text, Buffer.byteLength(b.text, "utf8"), budget) };
        kept.push(t); used += bytes(t) + sep; truncated = true;
      }
    }
  }
  return { ...block, content: kept, __truncated: n };
}
// Per-message budget: per-block caps alone let many blocks (or an uncapped image) build a line over the Rust cap.
function enforceMessageCap(m) {
  const content = m.message?.content;
  if (bytes(m) <= MESSAGE_CAP) return m;
  if (typeof content === "string") {
    // String user content (a replayed prompt) has no blocks to share the budget: one text cap.
    const room = MESSAGE_CAP - bytes({ ...m, message: { ...m.message, content: "" } }) - 1024;
    return room < 512 ? m : { ...m, message: { ...m.message, content: shrinkText(content, Buffer.byteLength(content, "utf8"), room) } };
  }
  if (!Array.isArray(content)) return m;
  // Images over CAP go first; if the message is still over, every image does (33 images of
  // 250 KB are each within CAP and together past the Rust readers' 8 MiB).
  const swapImages = (limit) => (b) => {
    if (b.type === "image" && bytes(b) > limit) return imagePlaceholder(b);
    if (b.type === "tool_result" && Array.isArray(b.content)) return { ...b, content: b.content.map((c) => (c?.type === "image" && bytes(c) > limit ? imagePlaceholder(c) : c)) };
    return b;
  };
  let next = content.map(swapImages(CAP));
  let out = { ...m, message: { ...m.message, content: next } };
  if (bytes(out) <= MESSAGE_CAP) return out;
  next = next.map(swapImages(0));
  out = { ...m, message: { ...m.message, content: next } };
  if (bytes(out) <= MESSAGE_CAP) return out;
  const share = Math.floor((MESSAGE_CAP - bytes({ ...m, message: { ...m.message, content: [] } })) / next.length) - 1024;
  if (share < 512) return out;
  next = next.map((b) => {
    if (bytes(b) <= share) return b;
    if (b.type === "tool_result") return shrinkToolResult(b, share);
    if (b.type === "text" && typeof b.text === "string") return { ...b, text: shrinkText(b.text, Buffer.byteLength(b.text, "utf8"), share - TEXT_WRAPPER) };
    return b;
  });
  return { ...m, message: { ...m.message, content: next } };
}
export function shrink(msg) {
  try {
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      return enforceMessageCap({ ...msg, message: { ...msg.message, content: msg.message.content.map((b) => (b.type === "tool_use" ? shrinkToolUse(b) : b)) } });
    }
    if (msg.type === "user") {
      let m = msg;
      if (Array.isArray(m.message?.content)) {
        m = { ...m, message: { ...m.message, content: m.message.content.map((b) => (b.type === "tool_result" ? shrinkToolResult(b) : b)) } };
      }
      if (m.tool_use_result !== undefined && bytes(m.tool_use_result) > CAP) {
        m = { ...m, tool_use_result: { __truncated: bytes(m.tool_use_result) } };
      }
      return enforceMessageCap(m);
    }
  } catch { /* fall through: emit as-is rather than lose the message */ }
  return msg;
}
