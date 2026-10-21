// The Vidar app layer on a Raw Claude tab: the pure rewrite of a launch's `-Command` string so
// `claude` loads <root>\plugins\vidar-app and auto-allows its drive tools. Same args shape as
// inject.ts (`["-NoExit", "-Command", "<cmd>"]`). `$env:VIDAR_ROOT` is set on Raw children
// (src-tauri/src/pty.rs) and pwsh expands it inside the double quotes; a missing plugin dir is
// not fatal to the CLI. Any other shape (codex, vendor rows, custom args): unchanged, silent.
//
// Conflict rules (the row's own flags win; repeat/merge semantics of the CLI flags are unverified):
// 1. The command already names `plugins\vidar-app` (any case, either slash): no second `--plugin-dir`.
// 2. The command already has `--allowedTools` or `--allowed-tools`: ours is not added; the row's own
//    list governs (drive tools, then prompt).
// 3. The command has `--strict-mcp-config`: `--plugin-dir` is still added (context and skills load) but
//    `--allowedTools` is not, because plugin MCP servers are excluded under strict config
//    (sdk.d.ts:2128-2135). Limit: such a row gets no drive tools; nothing is reported in the UI.

const PLUGIN_DIR = '--plugin-dir "$env:VIDAR_ROOT\\plugins\\vidar-app"';
const ALLOWED = "--allowedTools mcp__plugin_vidar_drive";

const NAMES_PLUGIN = /plugins[\\/]+vidar-app/i;
const HAS_ALLOWED = /(^|\s)--allowed-?tools(?=[\s=]|$)/i;
const HAS_STRICT = /(^|\s)--strict-mcp-config(?=[\s=]|$)/i;

export function injectAppLayer(args: string[] | undefined): string[] | undefined {
  const at = args?.findIndex((a) => a.toLowerCase() === "-command") ?? -1;
  const cmd = args && at >= 0 && at === args.length - 2 ? args[at + 1] : null;
  if (!args || cmd === null || !/^claude(?=\s|$)/.test(cmd)) return args;
  const flags = [
    NAMES_PLUGIN.test(cmd) ? null : PLUGIN_DIR,
    HAS_ALLOWED.test(cmd) || HAS_STRICT.test(cmd) ? null : ALLOWED,
  ].filter((f): f is string => f !== null);
  if (flags.length === 0) return args;
  const out = [...args];
  out[at + 1] = `claude ${flags.join(" ")}${cmd.slice("claude".length)}`;
  return out;
}
