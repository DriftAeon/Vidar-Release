// Codex PreToolUse payload fixtures for tests/bare/codex-shim.test.mjs.
// REAL_* are the three payloads captured in a signed-in live probe run (2026-10-19),
// verbatim except the user folder name (tests/no-machine-paths.test.mjs forbids the real one). Keys: cwd hook_event_name model
// permission_mode session_id tool_input tool_name tool_use_id transcript_path turn_id. The shell tool is `Bash`;
// apply_patch carries its patch text in tool_input.command. Builders below reuse that shape with another cwd/text.

const PROBE = "C:\\Users\\tester\\AppData\\Local\\Temp\\vidar-codex-hook-probe";
const SESSION = "01a153ad-3033-74d0-b867-df1fa6327652";
const TURN = "01a153ad-308c-7990-93c4-dce97fea1c19";
const TRANSCRIPT = `${PROBE}\\home\\sessions\\2026\\10\\19\\rollout-2026-10-19T21-20-21-${SESSION}.jsonl`;

const realCommon = {
  session_id: SESSION,
  turn_id: TURN,
  transcript_path: TRANSCRIPT,
  cwd: `${PROBE}\\work`,
  hook_event_name: "PreToolUse",
  model: "gpt-6.1-sol",
  permission_mode: "default",
};

export const REAL_SHELL = {
  ...realCommon,
  tool_name: "Bash",
  tool_input: { command: "echo P1W0-ALLOW" },
  tool_use_id: "exec-d61e2a82-2a7f-4de0-bb95-9dde5509a36b",
};

export const REAL_PATCH_ADD = {
  ...realCommon,
  tool_name: "apply_patch",
  tool_input: {
    command: `*** Begin Patch\n*** Add File: ${PROBE}\\work\\probe.txt\n+P1W0-PATCH\n*** End Patch`,
  },
  tool_use_id: "exec-9c498a9f-6912-45f8-8fd3-e2a5a55b0448",
};

export const REAL_PATCH_UPDATE = {
  ...realCommon,
  tool_name: "apply_patch",
  tool_input: {
    command: `*** Begin Patch\n*** Update File: ${PROBE}\\work\\probe.txt\n@@\n-P1W0-PATCH\n+P1W0-PATCH-2\n*** End Patch`,
  },
  tool_use_id: "exec-d42588b5-9885-45a0-a770-dc733f9ee863",
};

export function common(cwd) {
  return { ...realCommon, cwd, tool_use_id: "exec-fixture-1" };
}

export const shell = (cwd, command, extra = {}) => ({ ...common(cwd), tool_name: "Bash", tool_input: { command }, ...extra });

export const patch = (cwd, text, extra = {}) => ({ ...common(cwd), tool_name: "apply_patch", tool_input: { command: text }, ...extra });

export const TWO_FILE_PATCH = [
  "*** Begin Patch",
  "*** Add File: src/new-thing.ts",
  "+export const a = 1;",
  "+export const b = 2;",
  "*** Update File: src/old-thing.ts",
  "@@",
  " keep",
  "-before",
  "+after",
  "*** End Patch",
  "",
].join("\n");
