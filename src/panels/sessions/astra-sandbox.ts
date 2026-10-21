// src\panels\sessions\astra-sandbox.ts — one concern: may this Codex tab be armed as Astra?
// Pure (no imports, so node tests load it as is): astra-bridge.ts hands in the tab's launch facts and
// the two folders an Astra tab may sit in. Arming is consent to type text into a tab whose Codex can
// write files, so the check is an allowlist: the launch must be exactly the shape the Astra rows use,
// and the tab's cwd one of the two report folders. Limit: this reads the launch args, not the live
// process, and a `config.toml` `writable_roots` entry is invisible to it.

export interface SandboxFacts {
  launchArgs: readonly string[] | undefined;
  /** the launcher row's shell wrapper, if any (LaunchOpts.shell) */
  shell: string | undefined;
  /** the tab's cwd as the session recorded it */
  cwd: string;
  /** absolute display and astra-reports folders; null when the Vidar root is unknown */
  allowedCwds: readonly string[] | null;
}

const VALUE = /^[A-Za-z0-9._-]+$/;
const SANDBOXES = new Set(["read-only", "workspace-write"]);

export const REFUSE_COMMAND = "Codex Command Must Be codex -a never -s read-only|workspace-write";
export const REFUSE_SHELL = "Astra Tab Must Not Use A Shell Wrapper";
export const REFUSE_CWD = "Astra Tab Cwd Must Be display Or astra-reports";

/** Tokens of the codex command from the two accepted launch forms, or null. */
function commandTokens(args: readonly string[] | undefined): string[] | null {
  if (!args) return null;
  if (args.length === 3 && args[0] === "-NoExit" && args[1] === "-Command") {
    const cmd = args[2].trim();
    return cmd ? cmd.split(/\s+/) : null;
  }
  return args[0] === "codex" ? [...args] : null; // the bare argv form
}

/** `codex -a never -s <sandbox>` then, in any order and at most once each, `-m <v>`,
 * `-c model_verbosity=<v>` and `-c model_reasoning_effort=<low|medium|high|xhigh>`. */
export function codexCommandOk(args: readonly string[] | undefined): boolean {
  const t = commandTokens(args);
  if (!t || t.length < 5) return false;
  if (t[0] !== "codex" || t[1] !== "-a" || t[2] !== "never" || t[3] !== "-s" || !SANDBOXES.has(t[4])) return false;
  let sawModel = false;
  let sawVerbosity = false;
  let sawEffort = false;
  for (let i = 5; i < t.length; i += 2) {
    const flag = t[i];
    const val = t[i + 1];
    if (val === undefined) return false;
    if (flag === "-m" && !sawModel && VALUE.test(val)) sawModel = true;
    else if (flag === "-c" && !sawVerbosity && val.startsWith("model_verbosity=") && VALUE.test(val.slice("model_verbosity=".length))) sawVerbosity = true;
    else if (flag === "-c" && !sawEffort && /^model_reasoning_effort=(low|medium|high|xhigh)$/.test(val)) sawEffort = true;
    else return false;
  }
  return true;
}

/** Absolute drive path, separators unified, `.` and `..` resolved, lower-cased; null when not a drive path. */
export function normalizeWinPath(p: string): string | null {
  const unified = p.replace(/\//g, "\\");
  if (!/^[A-Za-z]:\\/.test(unified)) return null;
  const out: string[] = [];
  for (const part of unified.slice(3).split("\\")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (out.length === 0) return null; out.pop(); continue; }
    out.push(part);
  }
  return `${unified.slice(0, 2)}\\${out.join("\\")}`.replace(/\\$/, "").toLowerCase();
}

/** Why this tab's launch is outside the Astra sandbox shape, or null. */
export function sandboxBlocker(f: SandboxFacts): string | null {
  if (f.shell) return REFUSE_SHELL;
  if (!codexCommandOk(f.launchArgs)) return REFUSE_COMMAND;
  const cwd = f.cwd ? normalizeWinPath(f.cwd) : null;
  const allowed = (f.allowedCwds ?? []).map(normalizeWinPath);
  if (!cwd || !allowed.includes(cwd)) return REFUSE_CWD;
  return null;
}
