// Rule injection, the pure half: what a launch carries (`RulesLaunch`), which agent rows may take
// rules (`rulesPlan`), and the rewrite of a Raw tab's `-Command` string (`injectRules`). No IPC:
// src/rules/prepare.ts calls `rules_prepare`, terminal-body.ts applies the rewrite once at spawn.

/** `rules_prepare`'s `codex` field (src-tauri/src/rules/mod.rs `CodexRules`): `value` is a TOML basic string, quotes included. */
type CodexRules = { mode: "c"; value: string } | { mode: "profile"; name: string } | null;

/** One tab's rules, prepared once per fresh launch and kept on the session; Resume, Retry and
 *  Raw/Rendered switches reuse it. `file` is the built file under runtime\rules\built. */
export interface RulesLaunch {
  file: string | null;
  codex: CodexRules;
  warnings: string[];
}

export type RulesClient = "claude" | "codex";

/** The slice of an agent row the plan reads (AgentType, config.ts). */
interface RulesRow { id: string; key?: string; label?: string; rules?: string[] }

/** Whether a row's `rules` can be applied: `null` when it has none, a `warning` when it must be
 *  refused (the tab launches without rules), else what `rules_prepare` needs. */
export function rulesPlan(row: RulesRow): { key: string; ids: string[]; client: RulesClient } | { warning: string } | null {
  const who = row.label ?? row.id;
  if (row.rules === undefined || row.rules === null) return null;
  if (!Array.isArray(row.rules)) {
    return { warning: `Rules not applied: "rules" in the "${who}" entry of vidar.json is not a list. Make it a list of rule ids and open a new tab.` };
  }
  const ids = row.rules.filter((r) => typeof r === "string" && r.trim() !== "");
  if (!ids.length) return null;
  if (typeof row.key !== "string" || !row.key.trim()) {
    return { warning: `Rules not applied: the "${who}" entry in vidar.json has no key, so its last-good rules cannot be tracked. Add a "key" to that entry and open a new tab.` };
  }
  if (row.id !== "claude" && row.id !== "codex") {
    return { warning: `Rules not applied: "${who}" is not a Claude or Codex row. Remove "rules" from its entry in vidar.json.` };
  }
  return { key: row.key, ids, client: row.id };
}

/** pwsh single-quoted literal: `'` and the curly single quotes U+2018-U+201B (pwsh treats them as quotes) doubled. */
const psq = (s: string) => `'${s.replace(/['‘-‛]/g, (c) => c + c)}'`;

const UNKNOWN_SHAPE = 'Rules not applied to this terminal launch: the command is not a plain claude or codex command. Remove "args" from its entry in vidar.json, or remove "rules".';

/** Rewrite a Raw tab's args (`["-NoExit", "-Command", "<cmd>"]`) so `<cmd>` carries the rules:
 *  Claude gets `--append-system-prompt-file '<file>'`, Codex `-c 'developer_instructions=<toml>'`
 *  (or `--profile` when `rules_prepare` said so), both right after the leading agent token so
 *  `claude --resume <id>` and `codex resume <id>` keep their subcommand. Any other shape comes
 *  back unchanged with a warning. No rules, or nothing to inject for that agent: unchanged, silent. */
export function injectRules(args: string[] | undefined, rules: RulesLaunch | null | undefined): { args: string[] | undefined; warning?: string } {
  if (!rules || (rules.file === null && rules.codex === null)) return { args };
  const at = args?.findIndex((a) => a.toLowerCase() === "-command") ?? -1;
  const cmd = args && at >= 0 && at === args.length - 2 ? args[at + 1] : null;
  const m = cmd === null ? null : /^(claude|codex)(?=\s|$)/.exec(cmd);
  if (!args || cmd === null || !m) return { args, warning: UNKNOWN_SHAPE };
  let flag: string | null = null;
  if (m[1] === "claude" && rules.file !== null) {
    flag = `--append-system-prompt-file ${psq(rules.file)}`;
  } else if (m[1] === "codex" && rules.codex) {
    flag = rules.codex.mode === "c"
      ? `-c ${psq(`developer_instructions=${rules.codex.value}`)}`
      : `--profile ${psq(rules.codex.name)}`;
  }
  if (flag === null) return { args };
  const out = [...args];
  out[at + 1] = `${m[1]} ${flag}${cmd.slice(m[1].length)}`;
  return { args: out };
}
