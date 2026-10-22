// Every askGate() call names a registered kind (src/panels/askgate-kinds.ts) so its title comes from
// the one table, and no permission ask hand-rolls a `title:` of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom();
const { ASK_KINDS } = await import("../src/panels/askgate-kinds.ts");
const ctl = await import("../src/relay/source-ctl-asks.ts");
const store = await import("../src/relay/store.ts");

const root = join(fileURLToPath(import.meta.url), "..", "..");
const src = join(root, "src");

// Calls allowed to pass an unregistered kind and an inline title: none. Questions live in Relay, not the modal.
const ALLOW = new Set([]);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(e.name)) yield p;
  }
}

/** `askGate(` call sites: args text up to the matching paren (strings and comments skipped). */
function calls() {
  const out = [];
  for (const file of walk(src)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(root, file).replaceAll("\\", "/");
    for (const m of text.matchAll(/(?<![\w.])askGate\(/g)) {
      const before = text.slice(0, m.index);
      if (/function\s+$/.test(before) || /(^|\n)\s*(\/\/|\*|\/\*)[^\n]*$/.test(before)) continue; // the definition, or a comment line
      let depth = 1, i = m.index + m[0].length, args = "";
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (c === '"' || c === "'" || c === "`") {
          const q = c;
          let s = c;
          for (i++; i < text.length && text[i] !== q; i++) { s += text[i]; if (text[i] === "\\") s += text[++i]; }
          args += s + q; i++; continue;
        }
        if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
        if (c === "(") depth++;
        if (c === ")") depth--;
        if (depth > 0) args += c;
        i++;
      }
      const kind = /,\s*"([^"]+)"\s*$/.exec(args)?.[1] ?? null;
      out.push({ rel, args, kind });
    }
  }
  return out;
}

test("the scan finds the known askGate callers", () => {
  assert.ok(calls().length >= 5, "five call sites today");
});

test("every askGate call passes a kind registered in ASK_KINDS, bar the allowlist", () => {
  for (const c of calls()) {
    if (ALLOW.has(`${c.rel}|${c.kind}`)) continue;
    assert.ok(c.kind, `${c.rel}: askGate call without a literal kind`);
    assert.ok(ASK_KINDS[c.kind], `${c.rel}: kind "${c.kind}" is not in ASK_KINDS`);
  }
});

test("no permission ask passes an inline title", () => {
  for (const c of calls()) {
    if (!/\bpermission\s*:\s*true\b/.test(c.args)) continue;
    assert.ok(!/\btitle\s*:/.test(c.args), `${c.rel}: permission ask (${c.kind}) passes an inline title; add it to ASK_KINDS`);
  }
});

// The trust boundary: questions never reach the modal, approvals still do.
test("no askGate call passes choices or placeholder, and a question only for astra", () => {
  for (const c of calls()) {
    assert.ok(!/(^|[\s,{])(choices|choiceDetails|placeholder)\s*[:,}]/.test(c.args), `${c.rel}: askGate (${c.kind}) passes choices or a placeholder`);
    const q = /\bquestion\s*:\s*("(?:[^"\\]|\\.)*"|[^,\n]+)/.exec(c.args)?.[1]?.trim();
    if (q === undefined || q === '""') continue;
    assert.equal(c.kind, "astra", `${c.rel}: askGate (${c.kind}) passes a non-empty question`);
  }
});

const ASKER = "tab-1";
const ctlAsk = (cardId, over = {}) => ({ cardId, askerTab: ASKER, question: "Which db?", choices: ["sqlite", "postgres"], claimedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, ...over });
const itemOf = (id) => store.items().find((i) => i.id === id);

test("ctl-ask: an answer and the expiry race, and the caller hears exactly once", async () => {
  const lines = [];
  const done = (ok, line) => lines.push([ok, line]);
  // answer wins: expiry is due now, but the answer lands first in the same tick
  assert.equal(ctl.publishCtlAsk(ctlAsk("c1", { expiresAtMs: Date.now() }), done), null);
  const item = itemOf("c1");
  assert.equal(item.kind, "question");
  assert.equal(item.askerTab, ASKER);
  await item.resolve({ verdict: "approve", comment: "", reply: { answers: { "0:Which db?": "postgres" }, notes: "" } });
  await dom.flush();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(lines, [[true, 'answered choice=postgres comment=""']]);
  assert.equal(itemOf("c1"), undefined, "the item leaves once answered");
  // expiry wins: a late answer is refused and writes nothing
  lines.length = 0;
  ctl.publishCtlAsk(ctlAsk("c2", { expiresAtMs: Date.now() + 10 }), done);
  const late = itemOf("c2");
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(lines, [[false, "err expired"]]);
  await assert.rejects(late.resolve({ verdict: "approve", comment: "", reply: { answers: {}, notes: "" } }), /Already Answered/);
  assert.equal(lines.length, 1);
});

test("ctl-ask: a dismiss keeps the denied line; a cancel removes the item silently", async () => {
  const lines = [];
  const done = (ok, line) => lines.push([ok, line]);
  ctl.publishCtlAsk(ctlAsk("c3"), done);
  await itemOf("c3").resolve({ verdict: "deny", comment: "not now" });
  assert.deepEqual(lines, [[false, "denied not now"]]);
  ctl.publishCtlAsk(ctlAsk("c4"), done);
  dom.ipc.listeners["ctl-card-cancel"]({ payload: { cardId: "c4" } });
  assert.equal(itemOf("c4"), undefined);
  assert.equal(lines.length, 1, "a cancel replies nothing: Rust already answered");
});

test("ctl-ask: one in flight per asker, so silent asks cannot fill the card cap", async () => {
  const done = () => {};
  assert.equal(ctl.publishCtlAsk(ctlAsk("c5"), done), null);
  assert.equal(ctl.publishCtlAsk(ctlAsk("c6"), done), ctl.CTL_ASK_BUSY);
  assert.equal(itemOf("c6"), undefined);
  assert.equal(ctl.publishCtlAsk(ctlAsk("c7", { askerTab: "tab-2" }), done), null, "another asker is not blocked");
  await itemOf("c5").resolve({ verdict: "deny", comment: "" });
  assert.equal(ctl.publishCtlAsk(ctlAsk("c8"), done), null, "the slot frees once answered");
  for (const id of ["c7", "c8"]) await itemOf(id).resolve({ verdict: "deny", comment: "" });
});

test("hard steer: a plain ask from a hosted Claude Rendered tab is refused", () => {
  const tabs = [
    { id: "h", body: "rendered", agent: "claude", hosted: true },
    { id: "u", body: "rendered", agent: "claude", hosted: false },
    { id: "x", body: "rendered", agent: "codex", hosted: true },
    { id: "p", body: "pty", agent: "claude" },
  ];
  assert.equal(ctl.hostedClaudeAsker(tabs, "h"), true);
  for (const t of ["u", "x", "p", "none", null]) assert.equal(ctl.hostedClaudeAsker(tabs, t), false, String(t));
  assert.equal(ctl.CTL_ASK_STEER, "err use --pending or AskUserQuestion");
  const listen = readFileSync(join(src, "control", "listen.ts"), "utf8");
  const ask = listen.slice(listen.indexOf('verb === "ask"'));
  assert.ok(ask.indexOf("hostedClaudeAsker(") > 0 && ask.indexOf("hostedClaudeAsker(") < ask.indexOf("publishCtlAsk("), "the steer runs before the ask is published");
  assert.ok(!/askGate\(/.test(ask), "the ask branch never opens the modal");
});
