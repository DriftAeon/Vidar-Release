// A scripted stand-in for `codex app-server --listen stdio://`, for Falcon's
// journey tests (src-falcon/src/serve/journeys/tests.rs). The test copies it
// into a scratch cwd as `app-server` and spawns node there, so the host's own
// argv (`app-server --listen stdio://`) runs it unchanged.
//
// Files in its cwd:
// - scenario.json (read once at start): `{ "rules": [ ... ] }`. Each inbound
//   line uses the first rule that matches and has uses left: `method` matches a
//   request or notification by method, `response` matches a client answer (no
//   method) by its id; `times` bounds the uses (default unlimited). `send` is
//   written in order; the string "$id" anywhere in it becomes the inbound id.
//   A line no rule matches gets no reply.
// - stdin.jsonl: every inbound line, appended before any reply goes out. A
//   line over 4 KiB is logged as `{ method, id, bytes }`.
// - inject.jsonl: polled; each new line is written to stdout, except the
//   control `{"$exit": code}`, which ends the fake with that code.
//
// Deterministic: no network, no clock in any reply, one poll timer (20 ms).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const here = process.cwd();
const scenario = JSON.parse(fs.readFileSync(path.join(here, "scenario.json"), "utf8"));
const rules = (scenario.rules || []).map((rule) => ({ ...rule, used: 0 }));
const logPath = path.join(here, "stdin.jsonl");
const injectPath = path.join(here, "inject.jsonl");
let injected = 0;

const emit = (message) => process.stdout.write(JSON.stringify(message) + "\n");

const fill = (value, id) => {
  if (value === "$id") return id;
  if (Array.isArray(value)) return value.map((item) => fill(item, id));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, id)]));
  }
  return value;
};

const matches = (rule, message) => {
  if (rule.times !== undefined && rule.used >= rule.times) return false;
  if (rule.method !== undefined) return message.method === rule.method;
  if (rule.response !== undefined) return message.method === undefined && message.id === rule.response;
  return false;
};

const onLine = (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fs.appendFileSync(logPath, JSON.stringify({ malformed: line.slice(0, 200) }) + "\n");
    return;
  }
  const logged = line.length > 4096
    ? JSON.stringify({ method: message.method, id: message.id, bytes: line.length })
    : line;
  fs.appendFileSync(logPath, logged + "\n");
  const rule = rules.find((candidate) => matches(candidate, message));
  if (!rule) return;
  rule.used += 1;
  for (const reply of rule.send || []) emit(fill(reply, message.id));
};

const finish = (code) => {
  clearInterval(poll);
  process.exitCode = code;
  process.stdin.destroy();
};

const poll = setInterval(() => {
  if (!fs.existsSync(injectPath)) return;
  // Only whole lines: the test may be mid-append.
  const text = fs.readFileSync(injectPath, "utf8");
  const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter((line) => line.trim());
  for (; injected < lines.length; injected += 1) {
    const message = JSON.parse(lines[injected]);
    if (message.$exit !== undefined) {
      finish(message.$exit);
      return;
    }
    emit(message);
  }
}, 20);

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", onLine);
input.on("close", () => finish(0));
