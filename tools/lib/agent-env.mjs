// Vidar agent homes, the JS side: where a bare launch's homes live and how the Vidar-layer scripts
// (tools/agent-layer/) take their paths. Twin of src-tauri/src/bare/home.rs::resolve (bare-mode
// plan, Design 3): every consumer resolves the home through one function. D2b put it under
// %LOCALAPPDATA%\Vidar\homes\<install-root-key>; keep both sides byte-identical (tests/agent-home-parity.test.mjs).
//
// The scripts never read USERPROFILE, HOME, os.homedir() or `~`: Claude's subprocess scrub strips
// CLAUDE_CONFIG_DIR from their env, and a redirected profile would point them at the wrong place.
// Every path arrives as an absolute `--root` / `--home` argument.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Folders under %LOCALAPPDATA% that hold the per-install homes (D2b; Rust `home::HOMES_REL`). */
export const AGENT_HOMES_REL = ["Vidar", "homes"];

/** Twin of `falcon/host_names.rs::root_suffix`: FNV-1a 64 over the normalised root, 16 hex digits.
 *  Normalised = canonical path when the folder exists (else as given), no `\\?\` prefix, `\`
 *  separators, no trailing separator, lowercased. */
export function installRootKey(root) {
  let resolved = root;
  try {
    resolved = realpathSync.native(root);
  } catch {
    // missing folder: the path as given, same as Rust's canonicalize fallback
  }
  let text = resolved.replaceAll("/", "\\");
  if (text.startsWith("\\\\?\\UNC\\")) text = `\\\\${text.slice(8)}`;
  else if (text.startsWith("\\\\?\\")) text = text.slice(4);
  text = text.replace(/\\+$/, "").toLowerCase();
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** The Vidar agent home for an install root: `<localAppData>\Vidar\homes\<install-root-key>`.
 *  `localAppData` defaults to the env's LOCALAPPDATA (a sandbox passes its fake profile's). */
export function resolveHome(root, localAppData = process.env.LOCALAPPDATA) {
  if (!isAbsoluteWin(localAppData)) throw new Error("LOCALAPPDATA is unset or not absolute; the bare home cannot be placed");
  return join(localAppData, ...AGENT_HOMES_REL, installRootKey(root));
}

/** Drive-letter or UNC absolute; `\x` (current drive) and `C:x` (drive-relative) do not count. */
export function isAbsoluteWin(p) {
  return typeof p === "string" && /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(p);
}

/** `--name value` pairs from argv; each named one must be present and absolute.
 *  Returns `{ values }` or `{ error }` (one line, for stderr). */
export function absoluteArgs(argv, names) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(.+)$/.exec(argv[i]);
    if (m && names.includes(m[1]) && i + 1 < argv.length) values[m[1]] = argv[++i];
  }
  for (const n of names) {
    if (values[n] === undefined) return { error: `missing --${n} <absolute path>` };
    if (!isAbsoluteWin(values[n])) return { error: `--${n} must be an absolute path, got "${values[n]}"` };
  }
  return { values };
}

// ---- The bare spawn env, JS twin of src-tauri/src/bare/env.rs + mod.rs::prepare_with (Design 2) ----
// Built from the contract's allowlist plus the `=X:` drive entries plus the profile overlay, never a
// parent env minus a list. Names match case-insensitively; the first spelling seen is kept, and an
// overlay value replaces an allowlisted one under the earlier spelling. Read-only: the contract and the
// profile are read, never written. tests/fixtures/agent-env-parity.json holds both builders to one result.

/** contracts/agent-env.json of an install root (or repo). */
export function readEnvContract(root) {
  return JSON.parse(readFileSync(join(root, "contracts", "agent-env.json"), "utf8"));
}

/** `=C:`-style per-drive cwd entry. */
export function isDriveEntry(name) {
  return /^=[A-Za-z]:$/.test(name);
}

/** Does the contract's drop list name `name` (a trailing `*` is a prefix)? */
export function inDropList(name, contract) {
  const n = name.toLowerCase();
  return (contract.drop ?? []).some((d) => {
    const l = d.toLowerCase();
    return l.endsWith("*") ? n.startsWith(l.slice(0, -1)) : n === l;
  });
}

/** Case-insensitive env map: set() keeps the first spelling, replaces the value. */
function envMap() {
  const m = new Map();
  return {
    has: (k) => m.has(k.toLowerCase()),
    set(k, v) {
      const key = k.toLowerCase();
      const prev = m.get(key);
      m.set(key, [prev ? prev[0] : k, v]);
    },
    object: () => Object.fromEntries([...m.values()]),
  };
}

/** The allowlisted part of `parent` (a name -> value object, e.g. process.env). */
export function allowlisted(parent, contract) {
  const allow = new Set((contract.allow ?? []).map((n) => n.toLowerCase()));
  const env = envMap();
  for (const [name, value] of Object.entries(parent)) {
    const keep = allow.has(name.toLowerCase()) || (contract.driveEntries && isDriveEntry(name));
    if (keep && !env.has(name)) env.set(name, value);
  }
  return env;
}

/** `X:\a\b` -> ["X:", "\a\b"]; anything else null. */
export function splitHome(path) {
  return /^[A-Za-z]:[\\/]/.test(path ?? "") ? [path.slice(0, 2), path.slice(2).replaceAll("/", "\\")] : null;
}

/** The bare env for `profile` (parsed profiles/bare/claude.json): allowlist, then the overlay with
 *  {{root}} and {{home}} filled, then HOMEDRIVE/HOMEPATH from the overlay's USERPROFILE.
 *  The tab variables pty.rs adds on top (TERM, VIDAR_TAB, VIDAR_ROOT, VIDAR_CTL_TOKEN) are not here. */
export function buildBareEnv({ parent, profile, root, home, contract }) {
  // {{localappdata}} = the parent's own LOCALAPPDATA (Bare Codex runs on the real one; env.rs refuses unset,
  // relative or inside the home).
  const lad = Object.entries(parent).find(([k]) => k.toLowerCase() === "localappdata")?.[1];
  const fill = (s) => {
    s = s.replaceAll("{{root}}", root).replaceAll("{{home}}", home);
    if (!s.includes("{{localappdata}}")) return s;
    if (!/^[A-Za-z]:[\\/]/.test(lad ?? "")) throw new Error("LOCALAPPDATA is unset or not absolute; spawn refused");
    return s.replaceAll("{{localappdata}}", lad);
  };
  const env = allowlisted(parent, contract);
  for (const [k, v] of Object.entries(profile.overlay ?? {})) env.set(k, fill(v));
  const split = splitHome(fill(profile.overlay?.USERPROFILE ?? ""));
  if (split) {
    env.set("HOMEDRIVE", split[0]);
    env.set("HOMEPATH", split[1]);
  }
  return env.object();
}

/** VIDAR_TAB shape `s<n>-<boot>` (sessions.ts createSession; same regex as the global statusline). */
export function vidarTab(env = process.env) {
  const tab = env.VIDAR_TAB ?? "";
  return /^s\d+(-[0-9a-z]+)?$/.test(tab) ? tab : null;
}
