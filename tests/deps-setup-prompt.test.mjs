// Trust boundary: "Set up with an agent" types `& '<exe>' '<prompt>'` into a pwsh tab.
// Each part is one single-quoted argument. pwsh closes a single-quoted string on ASCII ' AND on the
// curly quotes U+2018-U+201B, so every one of them is doubled; newlines in the prompt are collapsed.
// Anything else (double quotes, backticks, $(...), $env:) must stay inert inside the quotes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSetupPrompt, missingSetupAgentMessage, pickSetupRunner, setupCommand } from "../src/deps/setup-prompt.ts";

const catalog = JSON.parse(readFileSync(new URL("../contracts/dependencies.json", import.meta.url), "utf8"));
// The runtime catalog also holds pack deps; codex's lives in content/packs/codex.
catalog.deps.push(...JSON.parse(readFileSync(new URL("../content/packs/codex/pack.json", import.meta.url), "utf8")).module.deps);

const QUOTES = new Set(["'", "\u2018", "\u2019", "\u201A", "\u201B"]);

/** Reads one pwsh single-quoted string starting at `s[i]`. A doubled quote char is a literal; any
 *  other quote char closes the string. Returns the literal value and the index after the close. */
function readQuoted(s, i) {
  assert.ok(QUOTES.has(s[i]), `expected a quote at ${i}: ${s}`);
  let value = "";
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (!QUOTES.has(c)) { value += c; continue; }
    if (s[j + 1] === c) { value += c; j++; continue; }
    return { value, end: j + 1 };
  }
  assert.fail(`unterminated quoted string: ${s}`);
}

/** Splits `& '<exe>' '<prompt>'` into its two literals; fails unless the whole command is consumed. */
function parseCommand(cmd) {
  assert.ok(cmd.startsWith("& "), `not & '…' '…': ${cmd}`);
  const exe = readQuoted(cmd, 2);
  assert.equal(cmd[exe.end], " ", `no single space after the exe argument: ${cmd}`);
  const prompt = readQuoted(cmd, exe.end + 1);
  assert.equal(prompt.end, cmd.length, `text after the prompt argument ends the quoting early: ${cmd}`);
  return { exe: exe.value, prompt: prompt.value };
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

test("the prompt over every catalog entry is a single line", () => {
  const prompt = buildSetupPrompt(catalog.deps);
  assert.ok(prompt.length > 0);
  assert.doesNotMatch(prompt, /[\r\n]/);
});

test("setupCommand keeps adversarial text inside one single-quoted argument", () => {
  const input = "it's \u2019curly\u2019 \u2018left\u2018 \u201Alow\u201B ''quoted'' \"dq\" `tick` $(x) $env:A\nnext line";
  const exe = "C:\\Users\\o'brien\u2019s\\.local\\bin\\claude.exe";
  const cmd = setupCommand(input, exe);
  assert.doesNotMatch(cmd, /[\r\n]/);
  const parsed = parseCommand(cmd);
  assert.equal(parsed.exe, exe);
  assert.equal(norm(parsed.prompt), norm(input));
});

const AGENTS = [
  { id: "claude", label: "Claude", kind: "agent", agent: { setup: { dep: "claude" } } },
  { id: "codex", label: "Codex", kind: "agent", agent: { setup: { dep: "codex" } } },
];
const rows = (...found) => ({ deps: found.map(([id, ok]) => ({ id, found: ok, location: ok ? `C:\\bin\\${id}.exe` : undefined })) });

test("pickSetupRunner takes claude first, codex when claude is missing, none otherwise", () => {
  assert.equal(pickSetupRunner(AGENTS, rows(["claude", true], ["codex", true])).id, "claude");
  assert.deepEqual(pickSetupRunner(AGENTS, rows(["claude", false], ["codex", true])), { id: "codex", exe: "C:\\bin\\codex.exe" });
  assert.equal(pickSetupRunner(AGENTS, rows(["claude", false], ["codex", false])), null);
  assert.equal(pickSetupRunner(AGENTS, null), null);
  // found without a location cannot be launched
  assert.equal(pickSetupRunner(AGENTS, { deps: [{ id: "claude", found: true }] }), null);
});

test("missing setup agent names the sole active agent's catalogue CLI label", () => {
  const deps = [...catalog.deps, { id: "claude", label: "Claude Code" }];
  assert.equal(missingSetupAgentMessage([AGENTS[1]], deps), "No Setup Agent Found: Install Codex CLI, Then Recheck");
  assert.equal(missingSetupAgentMessage([AGENTS[0]], deps), "No Setup Agent Found: Install Claude Code, Then Recheck");
});

test("missing setup agent names both CLI labels in setup order", () => {
  const deps = [...catalog.deps, { id: "claude", label: "Claude Code" }];
  const modules = [
    { ...AGENTS[1], agent: { setup: { dep: "codex", order: 1 } } },
    { ...AGENTS[0], agent: { setup: { dep: "claude", order: 0 } } },
  ];
  assert.equal(missingSetupAgentMessage(modules, deps), "No Setup Agent Found: Install Claude Code Or Codex CLI, Then Recheck");
});

test("missing setup agent reports no enabled agent with a setup dependency", () => {
  assert.equal(missingSetupAgentMessage([], catalog.deps), "No Agent Module Enabled");
  assert.equal(missingSetupAgentMessage([{ id: "notes", label: "Notes", kind: "content" }], catalog.deps), "No Agent Module Enabled");
  assert.equal(missingSetupAgentMessage([{ id: "agent", label: "Agent", kind: "agent" }], catalog.deps), "No Agent Module Enabled");
});

test("the prompt carries no double quote or percent sign (codex.cmd crosses cmd.exe)", () => {
  const hostile = { id: "x", label: "X \"q\" 100%", required: true, usedBy: [], probe: { kind: "falcon" }, install: { command: "echo \"%PATH%\"" } };
  assert.doesNotMatch(buildSetupPrompt([hostile]), /["%]/);
});

test("a plain exe and prompt give the & '<exe>' '<prompt>' shape", () => {
  assert.equal(setupCommand("install node", "C:\\bin\\claude.exe"), "& 'C:\\bin\\claude.exe' 'install node'");
});
