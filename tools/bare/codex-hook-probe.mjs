// Codex hook probe (P1 W0): learns what Codex 0.163's hooks really send and do on Windows, in a scratch CODEX_HOME,
// so the Codex guard shim (P1 W1) and the hooks.json writer (P1 W2) are built on recorded payloads, not docs.
//
// Usage: node tools/bare/codex-hook-probe.mjs setup [--dir <d>]   build the scratch home, pre-trust its hooks
//        node tools/bare/codex-hook-probe.mjs read  [--dir <d>]   print what the recordings show
//        node tools/bare/codex-hook-probe.mjs record <tag>...      the hook handler itself (Codex runs it)
//   --dir  the probe folder; default %TEMP%\vidar-codex-hook-probe. Layout: home\ (CODEX_HOME), work\ (the launch
//          folder, the only sandbox-writable place), rec\ (recordings, outside the workspace), setup.json.
//
// setup: config.toml from profiles/bare/codex.config.template.toml with the two entries that would reach the live
// Vidar left out (`notify`, `[mcp_servers.vidar_drive]`), plus a trusted [projects] table for work\ as home.rs
// writes it. home\hooks.json wires this script as a command hook on all 12 events, `command` and `commandWindows`
// tagged apart, each carrying `%OS%` and `$env:OS` so the recording shows which shell expanded it. Then it starts
// `codex app-server` (no login needed), calls hooks/list, writes `[hooks.state."<key>"] trusted_hash` for each
// hook into config.toml (route a), lists again and records both lists, plus which hash recipes reproduce
// currentHash. Nothing is signed in and no model turn runs. Re-running setup wipes home\ only when it holds no
// auth.json (a sign-in is kept; the file is never read).
//
// record: appends one JSON line (argv, cwd, payload, env names, a write test) to rec\events.jsonl, falling back to
// work\.probe-rec\events.jsonl when rec\ is not writable (that is the "hooks run sandboxed" signal). PreToolUse
// whose tool_input mentions P1W0-BLOCK-EMPTY exits 2 with empty stderr; P1W0-BLOCK-MSG exits 2 with a reason.
//
// read: prints the PreToolUse payload for a shell call and an apply_patch call, the shell tool's name, whether
// exit 2 with empty stderr blocked (no PostToolUse for that call), whether hooks ran sandboxed, which command
// field and shell ran the hook, and where trust sits (config.toml hooks.state, diffed against setup).
//
// Exit codes: 0 done; 1 a step failed (message on stderr); 2 nothing recorded yet (read before the user's run).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(HERE, "..", "..");
const SELF = fileURLToPath(import.meta.url);
const EVENTS = ["PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "UserPromptSubmit",
  "SubagentStart", "SubagentStop", "Stop", "Interrupt", "SessionStart", "SessionEnd"];
const PROMPT = "Hook probe. Do these in order and report each result in one line: " +
  "1) run the shell command: echo P1W0-ALLOW; " +
  "2) run the shell command: echo P1W0-BLOCK-EMPTY; " +
  "3) run the shell command: echo P1W0-BLOCK-MSG; " +
  "4) create probe.txt containing P1W0-PATCH with apply_patch; " +
  "5) edit probe.txt with apply_patch so it reads P1W0-PATCH-2. Do nothing else.";

function argOf(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function paths(dir) {
  return { dir, home: join(dir, "home"), work: join(dir, "work"), rec: join(dir, "rec"),
    setup: join(dir, "setup.json"), config: join(dir, "home", "config.toml"), hooks: join(dir, "home", "hooks.json") };
}

function tomlEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

// home.rs norm_cwd + trusted_project_key: backslashes, lowercase.
function projectKey(p) {
  return p.replace(/\//g, "\\").toLowerCase();
}

/** The Bare template minus `notify` and `[mcp_servers.vidar_drive]` (both reach the live Vidar), placeholders
 *  filled as home.rs fills them, plus the launch folder's trusted [projects] table. */
export function buildConfig(templateText, { root, home, work }) {
  const out = [];
  let skip = false;
  for (const line of templateText.replace(/^﻿/, "").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) skip = /^\s*\[mcp_servers\.vidar_drive\]/.test(line);
    if (skip || /^\s*notify\s*=/.test(line)) continue;
    out.push(line);
  }
  let text = out.join("\n")
    .replaceAll("{{payload}}", tomlEscape("Vidar Codex hook probe (scratch home)."))
    .replaceAll("{{root}}", tomlEscape(root))
    .replaceAll("{{home}}", tomlEscape(home))
    .replaceAll("{{pwsh}}", "pwsh");
  if (/\{\{\w+\}\}/.test(text)) throw new Error("template placeholder left unfilled");
  if (!text.endsWith("\n")) text += "\n";
  return `${text}\n[projects.'${projectKey(work)}']\ntrust_level = "trusted"\n`;
}

/** hooks.json: one group per event, matcher "*", this script as the handler. `node` stays a bare name: a quoted
 *  first token is a parse error under PowerShell, so the hook never ran (probe run 2026-10-19). Codex runs
 *  commandWindows through PowerShell, whose -Command exit is 1 for any native failure: `exit $LASTEXITCODE` keeps
 *  the handler's exit 2 (a block) from reaching Codex as 1 (a non-blocking error). */
export function buildHooks(node, dir) {
  const run = (via) => `${node} "${SELF}" record "dir=${dir}" via=${via} cmd=%OS% ps=$env:OS`;
  const hooks = {};
  for (const ev of EVENTS) {
    const handler = { type: "command", command: run("command"), commandWindows: `${run("commandWindows")}; exit $LASTEXITCODE`, timeout: 30 };
    hooks[ev] = [{ matcher: "*", hooks: [handler] }];
  }
  return { hooks };
}

function codexEntry() {
  if (process.env.CODEX_JS) return process.env.CODEX_JS;
  const js = join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!existsSync(js)) throw new Error(`codex.js not found at ${js}; set CODEX_JS`);
  return js;
}

/** One app-server session over stdio: initialize, initialized, then each request in turn. */
export function appServer(codexHome, requests, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [codexEntry(), "app-server"], {
      env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const results = {};
    let buf = "", err = "", next = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`app-server timed out; stderr: ${err.slice(-800)}`)); }, timeoutMs);
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    const sendNext = () => {
      if (next >= requests.length) { clearTimeout(timer); child.stdin.end(); child.kill(); resolve(results); return; }
      const r = requests[next];
      send({ id: 100 + next, method: r.method, params: r.params ?? {} });
    };
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1 && (m.result || m.error)) {
          if (m.error) { clearTimeout(timer); child.kill(); reject(new Error(`initialize: ${JSON.stringify(m.error)}`)); return; }
          send({ method: "initialized", params: {} });
          sendNext();
        } else if (typeof m.id === "number" && m.id >= 100 && (m.result || m.error)) {
          results[requests[m.id - 100].name ?? requests[m.id - 100].method] = m.error ? { error: m.error } : m.result;
          next += 1;
          sendNext();
        } else if (m.method) {
          (results.notifications ??= []).push(m.method);
          if (/warning/i.test(m.method)) (results.warnings ??= []).push(m.params);
        }
      }
    });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "vidar-hook-probe", title: "Vidar Hook Probe", version: "0" },
      capabilities: { experimentalApi: true } } });
  });
}

function vidarHooks(list, hooksPath) {
  const out = [];
  for (const entry of list?.data ?? []) for (const h of entry.hooks ?? []) {
    if (String(h.sourcePath).toLowerCase() === hooksPath.toLowerCase()) out.push(h);
  }
  return out;
}

/** Candidate recipes for currentHash; the report names the one that matches (none is a finding too). */
export function hashRecipes(hook, hooksJsonText, handler) {
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const c = {
    "sha256(hooks.json bytes)": sha(hooksJsonText),
    "sha256(command)": sha(handler.command),
    "sha256(commandWindows)": sha(handler.commandWindows),
    "sha256(handler JSON)": sha(JSON.stringify(handler)),
    "sha256(group JSON)": sha(JSON.stringify({ matcher: "*", hooks: [handler] })),
    "sha256(key)": sha(hook.key),
  };
  const want = String(hook.currentHash).replace(/^sha256:/, "").toLowerCase();
  return { currentHash: hook.currentHash, matched: Object.entries(c).filter(([, v]) => v === want).map(([k]) => k) };
}

function trustTables(hooks) {
  return hooks.map((h) => `\n[hooks.state."${tomlEscape(h.key)}"]\ntrusted_hash = "${tomlEscape(h.currentHash)}"\n`).join("");
}

async function setup(argv) {
  const p = paths(pathResolve(argOf(argv, "--dir", join(tmpdir(), "vidar-codex-hook-probe"))));
  if (existsSync(join(p.home, "auth.json"))) {
    console.log(`kept ${p.home}: it holds a sign-in; config.toml and hooks.json are rewritten`);
  } else {
    rmSync(p.home, { recursive: true, force: true });
  }
  rmSync(p.rec, { recursive: true, force: true });
  rmSync(join(p.work, ".probe-rec"), { recursive: true, force: true });
  for (const d of [p.home, p.work, p.rec]) mkdirSync(d, { recursive: true });
  writeFileSync(join(p.work, "README.txt"), "Scratch launch folder for the Vidar Codex hook probe.\n");

  const template = readFileSync(join(REPO, "profiles", "bare", "codex.config.template.toml"), "utf8");
  const base = buildConfig(template, { root: REPO, home: p.dir, work: p.work });
  writeFileSync(p.config, base);
  const hooksDoc = buildHooks("node", p.dir);
  const hooksText = JSON.stringify(hooksDoc, null, 2) + "\n";
  writeFileSync(p.hooks, hooksText);

  const listReq = { method: "hooks/list", params: { cwds: [p.work] } };
  const before = await appServer(p.home, [listReq]);
  const ours = vidarHooks(before["hooks/list"], p.hooks);
  if (!ours.length) throw new Error(`hooks/list shows none of ${p.hooks}: ${JSON.stringify(before["hooks/list"]).slice(0, 1500)}`);
  const recipes = ours.map((h) => ({ key: h.key, ...hashRecipes(h, hooksText, hooksDoc.hooks[EVENTS.find((e) => e.toLowerCase() === String(h.eventName).toLowerCase())]?.[0]?.hooks?.[0] ?? {}) }));
  writeFileSync(p.config, base + trustTables(ours));
  const after = await appServer(p.home, [listReq]);
  const oursAfter = vidarHooks(after["hooks/list"], p.hooks);
  const configAfter = readFileSync(p.config, "utf8");
  writeFileSync(p.setup, JSON.stringify({ when: new Date().toISOString(), dir: p.dir, before: before["hooks/list"],
    after: after["hooks/list"], recipes, config: configAfter }, null, 2) + "\n");

  const st = (hs) => [...new Set(hs.map((h) => h.trustStatus))].join(",");
  console.log(`scratch home  ${p.home}`);
  console.log(`hooks         ${ours.length} found; trust before ${st(ours)}, after writing hooks.state ${st(oursAfter)}`);
  console.log(`key sample    ${ours[0].key}`);
  console.log(`hash sample   ${ours[0].currentHash}  (recipe match: ${recipes[0].matched.join(", ") || "none"})`);
  const errs = (after["hooks/list"]?.data ?? []).flatMap((e) => [...e.errors.map((x) => x.message), ...e.warnings]);
  if (errs.length) console.log(`list errors   ${errs.join(" | ")}`);
  if (oursAfter.some((h) => h.trustStatus !== "trusted")) {
    console.error("not every probe hook is trusted after the hooks.state write; the run would skip them");
    process.exitCode = 1;
  }
  console.log("\nNext, in a normal terminal (pwsh), not a ! line:");
  console.log(`  $env:CODEX_HOME = '${p.home}'`);
  console.log("  codex login");
  console.log(`  codex -C '${p.work}' "${PROMPT}"`);
  console.log("  (no hook-review prompt is expected; approve anything else it asks, wait for the answer, then /quit)");
  console.log(`Then read the recordings: node tools/bare/codex-hook-probe.mjs read${argv.includes("--dir") ? ` --dir "${p.dir}"` : ""}`);
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function readStep(argv) {
  const p = paths(pathResolve(argOf(argv, "--dir", join(tmpdir(), "vidar-codex-hook-probe"))));
  const outside = readJsonl(join(p.rec, "events.jsonl"));
  const inside = readJsonl(join(p.work, ".probe-rec", "events.jsonl"));
  const all = [...outside, ...inside].sort((a, b) => String(a.time).localeCompare(String(b.time)));
  if (!all.length) { console.error(`no recordings under ${p.rec} or ${join(p.work, ".probe-rec")}; run the session first`); process.exit(2); }
  const pre = all.filter((r) => r.payload?.hook_event_name === "PreToolUse");
  const post = all.filter((r) => r.payload?.hook_event_name === "PostToolUse");
  const text = (r) => JSON.stringify(r.payload?.tool_input ?? "");
  const isPatch = (r) => /apply_patch|\*\*\* Begin Patch/.test(`${r.payload?.tool_name} ${text(r)}`);
  const shell = pre.filter((r) => !isPatch(r) && !String(r.payload?.tool_name).startsWith("mcp__"));
  const patch = pre.filter(isPatch);
  const show = (label, r) => console.log(`\n== ${label}\n${r ? JSON.stringify(r.payload, null, 2) : "(none recorded)"}`);

  console.log(`recordings    ${all.length} (${outside.length} in rec\\, ${inside.length} in work\\.probe-rec\\)`);
  console.log(`events seen   ${[...new Set(all.map((r) => r.payload?.hook_event_name))].join(", ")}`);
  console.log(`tool names    ${[...new Set(pre.map((r) => r.payload?.tool_name))].join(", ") || "(no PreToolUse)"}`);
  console.log(`shell tool    ${[...new Set(shell.map((r) => r.payload?.tool_name))].join(", ") || "(none)"}`);
  console.log(`patch tool    ${[...new Set(patch.map((r) => r.payload?.tool_name))].join(", ") || "(none)"}`);
  const via = [...new Set(all.map((r) => r.via))].join(", ");
  const shells = [...new Set(all.map((r) => r.shell))].join(", ");
  console.log(`command field ${via}   shell that ran it: ${shells}`);
  const ran = (marker) => post.some((r) => JSON.stringify(r.payload).includes(marker));
  const asked = (marker) => pre.some((r) => text(r).includes(marker));
  for (const m of ["P1W0-ALLOW", "P1W0-BLOCK-EMPTY", "P1W0-BLOCK-MSG"]) {
    const verdict = !asked(m) ? "not attempted" : ran(m) ? "RAN (PostToolUse seen)" : "blocked (no PostToolUse)";
    console.log(`${m.padEnd(17)} ${verdict}`);
  }
  const probeTxt = join(p.work, "probe.txt");
  console.log(`probe.txt     ${existsSync(probeTxt) ? JSON.stringify(readFileSync(probeTxt, "utf8").trim()) : "(absent)"}`);
  const sandboxed = all.filter((r) => r.write && r.write.outside === false).length;
  console.log(`sandboxed     ${sandboxed ? `yes: ${sandboxed} of ${all.length} hook runs could not write rec\\ (${all.find((r) => r.write?.outside === false)?.write?.error})` : "no: every hook run wrote rec\\ (outside the workspace)"}`);
  const envNames = [...new Set(all.flatMap((r) => r.env ?? []))].sort();
  console.log(`hook env      ${envNames.join(" ")}`);
  const payloadKeys = [...new Set(pre.flatMap((r) => Object.keys(r.payload ?? {})))].sort();
  console.log(`PreToolUse keys ${payloadKeys.join(" ")}`);
  show("PreToolUse, shell call", shell.find((r) => text(r).includes("P1W0-ALLOW")) ?? shell[0]);
  show("PreToolUse, apply_patch call (add)", patch[0]);
  show("PreToolUse, apply_patch call (update)", patch[1]);

  const setupDoc = existsSync(p.setup) ? JSON.parse(readFileSync(p.setup, "utf8")) : null;
  const cfg = existsSync(p.config) ? readFileSync(p.config, "utf8") : "";
  const stateNow = cfg.match(/\[hooks\.state\.[^\]]+\][^[]*/g) ?? [];
  const stateThen = setupDoc?.config?.match(/\[hooks\.state\.[^\]]+\][^[]*/g) ?? [];
  console.log(`\ntrust         config.toml holds ${stateNow.length} hooks.state tables (setup wrote ${stateThen.length}); ` +
    (cfg === setupDoc?.config ? "config.toml unchanged since setup" : "config.toml CHANGED since setup (diff it against setup.json .config)"));
}

function record(argv) {
  const tags = Object.fromEntries(argv.filter((a) => a.includes("=")).map((a) => a.split(/=(.*)/s).slice(0, 2)));
  const p = paths(tags.dir || (process.env.CODEX_HOME ? dirname(process.env.CODEX_HOME) : join(tmpdir(), "vidar-codex-hook-probe")));
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { unparsed: raw.slice(0, 4000) }; }
  const shell = tags.cmd === "Windows_NT" ? "cmd" : tags.ps === "Windows_NT" ? "pwsh/powershell" : "none (direct exec)";
  const rec = { time: new Date().toISOString(), via: tags.via, shell, argv, cwd: process.cwd(), pid: process.pid, ppid: process.ppid,
    env: Object.keys(process.env).filter((k) => /^(CODEX|CLAUDE|VIDAR|FALCON)_/i.test(k) || /^(USERPROFILE|HOME|TEMP|PSModulePath)$/i.test(k)),
    payload };
  const line = (r) => JSON.stringify(r) + "\n";
  try {
    mkdirSync(p.rec, { recursive: true });
    appendFileSync(join(p.rec, "events.jsonl"), line({ ...rec, write: { outside: true } }));
  } catch (e) {
    const alt = join(p.work, ".probe-rec");
    try { mkdirSync(alt, { recursive: true }); appendFileSync(join(alt, "events.jsonl"), line({ ...rec, write: { outside: false, error: e.code || String(e) } })); } catch { /* nowhere to write */ }
  }
  if (payload?.hook_event_name === "PreToolUse") {
    const t = JSON.stringify(payload.tool_input ?? "");
    if (t.includes("P1W0-BLOCK-EMPTY")) process.exit(2);
    if (t.includes("P1W0-BLOCK-MSG")) { process.stderr.write("P1W0 probe hook blocked this call.\n"); process.exit(2); }
  }
  process.exit(0);
}

if (process.argv[1] && pathResolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = { setup, read: readStep, record }[cmd];
  if (!run) {
    console.error("usage: node tools/bare/codex-hook-probe.mjs setup|read [--dir <d>]");
    process.exit(1);
  }
  try {
    await run(rest);
  } catch (e) {
    console.error(e.message || String(e));
    process.exit(1);
  }
}
