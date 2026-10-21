// The Astra arm check (src/panels/sessions/astra-sandbox.ts): arming is consent to type into a Codex
// that can write files, so it is an allowlist over the launch args, the shell wrapper and the tab cwd.
import test from "node:test";
import assert from "node:assert/strict";
import { sandboxBlocker, codexCommandOk, normalizeWinPath, REFUSE_COMMAND, REFUSE_SHELL, REFUSE_CWD } from "../src/panels/sessions/astra-sandbox.ts";

const ROOT = "C:\\app\\Vidar";
const DISPLAY = `${ROOT}\\runtime\\bridge\\display`;
const REPORTS = `${ROOT}\\runtime\\bridge\\astra-reports`;
const wrap = (cmd) => ["-NoExit", "-Command", cmd];
const facts = (over = {}) => ({
  launchArgs: wrap("codex -a never -s workspace-write -m gpt-6-astra -c model_reasoning_effort=low -c model_verbosity=low"),
  shell: undefined,
  cwd: DISPLAY,
  allowedCwds: [DISPLAY, REPORTS],
  ...over,
});

test("the built-in Astra row and its read-only, model and verbosity variants arm", () => {
  assert.equal(sandboxBlocker(facts()), null);
  for (const cmd of [
    "codex -a never -s read-only",
    "codex -a never -s workspace-write",
    "codex -a never -s read-only -m gpt-5.5",
    "codex -a never -s read-only -c model_verbosity=low -m gpt-5.5",
    "codex -a never -s workspace-write -m o3_mini-2 -c model_verbosity=high",
  ]) assert.equal(sandboxBlocker(facts({ launchArgs: wrap(cmd) })), null, cmd);
  // the bare argv form
  assert.equal(sandboxBlocker(facts({ launchArgs: ["codex", "-a", "never", "-s", "read-only", "-m", "gpt-5.5"] })), null);
});

test("reasoning effort arms with the other optional flags in any order", () => {
  for (const effort of ["low", "medium", "high", "xhigh"]) {
    for (const flags of [
      `-m gpt-6-astra -c model_reasoning_effort=${effort} -c model_verbosity=low`,
      `-c model_reasoning_effort=${effort} -c model_verbosity=low -m gpt-6-astra`,
      `-c model_verbosity=low -m gpt-6-astra -c model_reasoning_effort=${effort}`,
    ]) {
      const cmd = `codex -a never -s workspace-write ${flags}`;
      assert.equal(sandboxBlocker(facts({ launchArgs: wrap(cmd) })), null, cmd);
    }
  }
  assert.equal(codexCommandOk(["codex", "-a", "never", "-s", "read-only", "-c", "model_reasoning_effort=low"]), true);
});

test("malformed or repeated reasoning effort refuses", () => {
  for (const flags of [
    "-c model_reasoning_effort=invalid",
    "-c model_reasoning_effort=",
    "-c model_reasoning_effort=low;calc",
    "-c model_reasoning_effort=low -c model_reasoning_effort=high",
    "-c model_reasoning_effort=low -m gpt-6-astra -c model_reasoning_effort=low",
  ]) {
    const cmd = `codex -a never -s workspace-write ${flags}`;
    assert.equal(sandboxBlocker(facts({ launchArgs: wrap(cmd) })), REFUSE_COMMAND, cmd);
  }
});

test("any other codex token refuses with the command message", () => {
  for (const cmd of [
    "codex -a never",
    "codex -s workspace-write -a never",
    "codex -a never -s danger-full-access",
    "codex -a never -s workspace-write --add-dir C:\\",
    "codex -a never -s workspace-write -C C:\\",
    "codex -a never -s workspace-write --cd C:\\",
    "codex -a never -s workspace-write -p full",
    "codex -a never -s workspace-write --dangerously-bypass-approvals-and-sandbox",
    "codex -a never -s workspace-write --config sandbox_workspace_write.network_access=true",
    "codex -a never -s workspace-write -c sandbox_mode=danger-full-access",
    "codex -a never -s workspace-write -c model_verbosity=low -c model_verbosity=high",
    "codex -a never -s workspace-write -m a -m b",
    "codex -a never -s workspace-write -m",
    "codex -a never -s workspace-write -m $(x)",
    "codex -a never -s workspace-write -m a;b",
    "codex -a never -s workspace-write -m \"a\"",
    "codex -a never -s workspace-write; calc",
    "codex -a never -s workspace-write && calc",
    "codex -a never -s workspace-write --worktree x",
    "codex -a never -s workspace-write -c model_verbosity=$(x)",
    "codex resume -a never -s workspace-write",
    "echo codex -a never -s workspace-write",
    "",
  ]) assert.equal(sandboxBlocker(facts({ launchArgs: wrap(cmd) })), REFUSE_COMMAND, cmd);
});

test("a launch that is not exactly -NoExit -Command <cmd> or the bare codex argv refuses", () => {
  const cmd = "codex -a never -s read-only";
  for (const args of [
    undefined,
    [],
    ["-Command", cmd],
    ["-NoExit", "-Command", cmd, "extra"],
    ["-NoProfile", "-NoExit", "-Command", cmd],
    ["-NoExit", "-File", cmd],
    ["pwsh", "-Command", cmd],
    ["codex", "-a", "never", "-s", "read-only", "--add-dir", "C:\\"],
    ["codex", "-a", "never", "-s", "read-only", "-m", "$(x)"],
  ]) assert.equal(sandboxBlocker(facts({ launchArgs: args })), REFUSE_COMMAND, JSON.stringify(args));
});

test("a shell wrapper refuses, before the command is read", () => {
  assert.equal(sandboxBlocker(facts({ shell: "bash" })), REFUSE_SHELL);
  assert.equal(sandboxBlocker(facts({ shell: "bash", launchArgs: undefined })), REFUSE_SHELL);
});

test("the tab cwd must resolve exactly to display or astra-reports", () => {
  for (const cwd of [DISPLAY, REPORTS, DISPLAY.toLowerCase(), DISPLAY.replaceAll("\\", "/"), `${DISPLAY}\\`, `${ROOT}\\runtime\\bridge\\astra-reports\\..\\display`, `${ROOT}\\.\\runtime\\bridge\\display`])
    assert.equal(sandboxBlocker(facts({ cwd })), null, cwd);
  for (const cwd of [
    "",
    ROOT,
    `${ROOT}\\runtime\\bridge`,
    `${ROOT}\\runtime\\bridge\\decisions`,
    `${ROOT}\\runtime\\bridge\\review`,
    `${DISPLAY}\\reviews`,
    `${DISPLAY}\\..`,
    `${REPORTS}-evil`,
    "display",
    "\\\\server\\share\\display",
    "C:\\..\\..\\display",
  ]) assert.equal(sandboxBlocker(facts({ cwd })), REFUSE_CWD, cwd);
});

test("an unknown Vidar root refuses the cwd rather than guessing", () => {
  assert.equal(sandboxBlocker(facts({ allowedCwds: null })), REFUSE_CWD);
});

test("helpers: command parse and path normalisation", () => {
  assert.equal(codexCommandOk(undefined), false);
  assert.equal(normalizeWinPath("C:/A/b/../C/"), "c:\\a\\c");
  assert.equal(normalizeWinPath("relative\\x"), null);
  assert.equal(normalizeWinPath("C:\\.."), null);
});
