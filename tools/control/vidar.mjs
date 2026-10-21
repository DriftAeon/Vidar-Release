#!/usr/bin/env node
// tools\control\vidar.mjs — CLI front end for the `ctl.*` bus surface
// (skill `vidar:vidar-control`, plugins\vidar-app\skills\vidar-control).
//
//   node tools\control\vidar.mjs state [--json]
//   node tools\control\vidar.mjs read [--bytes n]
//   node tools\control\vidar.mjs show <path> [--focus]
//   node tools\control\vidar.mjs focus <tab>|workbench
//   node tools\control\vidar.mjs prompt <tab> [--notify] [--report p] <text...>
//   node tools\control\vidar.mjs spawn <agent> --model m [--effort level] [--cwd p] (--brief path | --text t) [--title t] [--notify] [--report p]
//   node tools\control\vidar.mjs ask <question> [--choice a,b,c [--detail text]...] [--placeholder text]
//   node tools\control\vidar.mjs unpend [id]
//   node tools\control\vidar.mjs wait <tab> [--report path] [--timeout s]
//   node tools\control\vidar.mjs flow start --template id (--input text | --input-file path) [--cwd path]
//   node tools\control\vidar.mjs flow start --graph json-path [--cwd path]
//   node tools\control\vidar.mjs flow save --graph json-path [--cwd path]
//   node tools\control\vidar.mjs flow status <run-id>
//   node tools\control\vidar.mjs flow wait <run-id> [--timeout s]
//
// <tab> is a tab id or a tab name (the state verb lists both; a name has a space, so quote it: "Amber Raptor").
// A name matches case-insensitively and exactly; an unknown or ambiguous one fails like an unknown id.
// A tab's own agent finds its name in $env:VIDAR_TAB_NAME (set at spawn; a later rename is not reflected).
//
// Exit codes: 0 ok, 1 err <reason>, 2 timeout (incl. `wait`'s `err timeout`), 3 bus unavailable, 4 no token
// in env (not a Vidar tab).
//
// This file parses argv and owns the usage strings; checks and payloads live in `verbs.mjs`.
// Flag ↔ build() field: `--timeout` (seconds) ↔ `timeoutS`, `--bytes` ↔ `bytes`, `--choice a,b` ↔ `choices`, repeated `--detail` ↔ `details`.

import { request, EXIT } from "./client.mjs";
import { printReply } from "./format.mjs";
import { build, UsageError } from "./verbs.mjs";

const USAGE = {
  state: "state [--json]",
  read: "read [--bytes n]",
  show: "show <path> [--focus]",
  focus: "focus <tab>|workbench",
  prompt: "prompt <tab> [--notify] [--report p] <text...>",
  spawn: "spawn <agent> --model m [--effort level] [--cwd p] (--brief path | --text t) [--title t] [--notify] [--report p]",
  ask: "ask <question> [--choice a,b,c [--detail text]...] [--placeholder text | --pending [--context line]]",
  unpend: "unpend [id]",
  wait: "wait <tab> [--report path] [--timeout s]",
  flow: "flow start --template id (--input text | --input-file path) [--cwd path] | flow start --graph json-path [--cwd path] | flow save --graph json-path [--cwd path] | flow status <run-id> | flow wait <run-id> [--timeout s]",
};

/** Raised by argv parsing itself (unknown flag, flag without value). */
const usage = (detail) => { throw new UsageError(detail); };

/** argv words → build() opts, per verb. */
const PARSE = {
  flow: (rest) => {
    const [action, ...args] = rest;
    if (action === "status") { if (args.length !== 1) usage("status takes one run id"); return { action, run_id: args[0] }; }
    if (action === "wait") {
      const [run_id, ...flags] = args;
      const opts = { action, run_id };
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === "--timeout") { opts.timeoutS = Number(flags[++i]); continue; }
        usage(`"${flags[i]}" is not a recognized flag`);
      }
      return opts;
    }
    if (action !== "start" && action !== "save") usage("flow action must be start, save, status or wait");
    const opts = { action };
    const named = { "--template": "template_id", "--input": "input", "--input-file": "input_file", "--graph": "graph_path", "--cwd": "cwd" };
    for (let i = 0; i < args.length; i++) {
      const key = named[args[i]];
      if (!key) usage(`"${args[i]}" is not a recognized flag`);
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) usage(`${args[i - 1]} takes a value`);
      if (opts[key] !== undefined) usage(`${args[i - 1]} was repeated`);
      opts[key] = value;
    }
    return opts;
  },
  state: (rest) => ({ json: rest.includes("--json") }),

  read: (rest) => {
    const idx = rest.indexOf("--bytes");
    return idx === -1 ? {} : { bytes: Number(rest[idx + 1]) };
  },

  show: (rest) => ({ path: rest[0], focus: rest.includes("--focus") }),

  focus: (rest) => ({ target: rest[0] }),

  prompt: (rest) => {
    const [tab, ...args] = rest;
    // Flags only between <tab> and the first text word; from there on every word is text, verbatim.
    let notify = false, report;
    let i = 0;
    for (; i < args.length; i++) {
      if (args[i] === "--notify") { notify = true; continue; }
      if (args[i] === "--report") { report = args[++i] ?? ""; continue; }
      break;
    }
    const text = args.slice(i).join(" ");
    return { tab, text: text || undefined, notify, report };
  },

  spawn: (rest) => {
    const [agent, ...flags] = rest;
    const opts = { agent, notify: false };
    const value = (i) => {
      const v = flags[i];
      if (v === undefined || v.startsWith("--")) usage(`${flags[i - 1]} takes a value`);
      return v;
    };
    const named = { "--model": "model", "--effort": "effort", "--cwd": "cwd", "--brief": "brief", "--text": "text", "--title": "title" };
    for (let i = 0; i < flags.length; i++) {
      if (Object.hasOwn(named, flags[i])) { opts[named[flags[i]]] = value(++i); continue; }
      if (flags[i] === "--notify") { opts.notify = true; continue; }
      if (flags[i] === "--report") { opts.report = flags[++i] ?? ""; continue; }
      usage(`"${flags[i]}" is not a recognized flag`);
    }
    return opts;
  },

  ask: (rest) => {
    const [question, ...flags] = rest;
    const opts = { question };
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--choice") { opts.choices = (flags[++i] ?? "").split(","); continue; }
      if (flags[i] === "--detail") { (opts.details ??= []).push(flags[++i] ?? ""); continue; }
      if (flags[i] === "--placeholder") { opts.placeholder = flags[++i]; continue; }
      if (flags[i] === "--context") { opts.context = flags[++i]; continue; }
      if (flags[i] === "--pending") { opts.pending = true; continue; }
      usage(`"${flags[i]}" is not a recognized flag`);
    }
    return opts;
  },

  unpend: (rest) => (rest[0] === undefined ? {} : { id: rest[0] }),

  wait: (rest) => {
    const [tab, ...flags] = rest;
    const opts = { tab };
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--report") { opts.report = flags[++i] ?? ""; continue; }
      if (flags[i] === "--timeout") { opts.timeoutS = Number(flags[++i]); continue; }
      usage(`"${flags[i]}" is not a recognized flag`);
    }
    return opts;
  },
};

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(PARSE, verb ?? "")) {
    process.stderr.write(`vidar: usage: vidar.mjs ${Object.values(USAGE).join(" | ")}\n`);
    process.exit(EXIT.ERR);
  }

  let built;
  try {
    built = build(verb, PARSE[verb](rest));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`vidar: usage: vidar.mjs ${USAGE[verb]} — ${error.message}\n`);
    process.exit(EXIT.ERR);
  }

  const { payload, timeoutMs } = built;
  const reply = await request(built.verb ?? verb, payload, timeoutMs ? { timeoutMs } : undefined);
  const code = printReply(reply);
  // `err bus gone`: Vidar drained its pending replies on exit (control\mod.rs
  // `drain_pending`); same exit as losing the bus outright, for any verb.
  if (reply.line === "err bus gone") process.exit(EXIT.BUS_UNAVAILABLE);
  process.exit((verb === "wait" || verb === "flow") && reply.line === "err timeout" ? EXIT.TIMEOUT : code);
}

main().catch((error) => {
  process.stderr.write(`vidar: ${error.message}\n`);
  process.exit(error.exitCode ?? 1);
});
