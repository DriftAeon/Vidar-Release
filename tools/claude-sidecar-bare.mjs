// claude-sidecar-bare.mjs: the launch-profile (`--profile bare`) mapping for claude-sidecar.mjs, the
// Falcon-hosted Rendered Bare tab (plan P5). Imported by claude-sidecar.mjs and bundled beside it
// (tools/release/falcon-inputs.ps1 $FalconSidecarModules).
//
// Also, for a Flow Claude stage (Vidar's flow/claude.rs, not Falcon): flowOptions maps
// `--flow-payload bare --root <abs root>` to the profile's static payload as `systemPrompt.append` (its text,
// never the path) and `--mcp-servers <json>` to `mcpServers`; nothing else of the profile (settingSources,
// plugins, allowedTools) applies, so Flow keeps its own permission mode, allowlist and setting sources.
//
// Usage: import { bareOptions, flowOptions, writeInitOnce } from "./claude-sidecar-bare.mjs";
//        const flow = flowOptions({ profile, payload: "bare", servers: "<json>", root }, fail); // {} with neither
//        const bare = bareOptions({ profile: "bare", root: "<abs Vidar root>", home: "<abs agent home>",
//                                   payload: "<home>\\layer\\payload-<hash12>.md" /* optional, --payload */,
//                                   setPlugins: ["<root>\\plugins\\<name>", "<home>\\layer\\plugins\\<set>-<hash12>"] /* --set-plugin, repeated */,
//                                   warn: (msg) => {} /* a dropped set plugin; default: stderr */ });
//        setPluginArgs(argv) // every --set-plugin value, in order
//        // bare.settingSources / extraArgs / plugins / allowedTools go onto the SDK options;
//        // bare.configDir is the tab's CLAUDE_CONFIG_DIR (statusline mirror, seeds, settings model)
//        writeInitOnce(bare, process.env.FALCON_SESSION, initMessage);
//
// The profile is <root>\profiles\<id>\claude.json, the same file Vidar (src-tauri/src/bare/) and
// Falcon (src-falcon/src/claude.rs bare_spawn) read. Mapping: settingSources ["user"] (the tab's own
// config dir, which Falcon's env names), the profile's payload as `systemPrompt.append` (or a
// row's built `--payload` from <home>\layer in its place; the checked bytes' text, never the path),
// plugins only from `--set-plugin`: the vault's plugin runes (<root>\plugins\<name>, which Falcon
// admitted from `plugin_names`; a bad one is refused) and any rune-set plugins (<home>\layer\plugins;
// a bad one is dropped, not refused), and `mcp__plugin_vidar_drive` allowed only when the launch's
// settings.json allow list holds it (the vault's `drive-allow` rune). The SDK `env` option is never
// set: it replaces the child env, and Falcon already built it.
//
// Refuses (throws, the sidecar reports and exits): an unknown profile id, a relative --root or
// --home, a profile that is not the Claude one, has no rendered block or lists rendered plugins, a
// vault plugin rune whose name is not plain, whose folder is a junction, missing or outside the real
// <root>\plugins, or lacks .claude-plugin\plugin.json, a missing payload, a junctioned <home>\layer, a `--payload`
// outside the real <home>\layer, not named payload-<hash12>.md or whose SHA-256 prefix does not match that name. The optional --mcp-file is checked under the same layer and supplies strict MCP servers. Never reads vidar.json (pluginDirs and
// statuslineMirror are the default tab's settings, not a bare tab's).

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, lstatSync } from "node:fs";
import { basename, dirname, join, isAbsolute, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

export const BARE_PROFILES = ["bare"];
export const BARE_ALLOWED_TOOLS = ["mcp__plugin_vidar_drive"];

const under = (base, rel) => join(base, ...String(rel).split(/[\\/]+/).filter(Boolean));

/* A row's built payload (`--payload`, which Falcon admitted under the home's layer\): checked again
   here, since the pipe that carries a spawn is open to same-user processes. The real file must sit
   directly in the real <home>\layer (case-insensitive), which must itself be the real home's own
   `layer` (a junctioned or linked layer\ is refused, as Falcon refuses it), be named
   payload-<12 hex>.md, and its bytes' SHA-256 must start with that name's hash. That hash is an
   integrity check (the bytes match the name), not provenance: a same-user process can still write a
   well-named file. Returns the checked bytes (read once; the caller sends that text, not the path). */
function admitRowPayload(raw, home) {
  if (typeof raw !== "string" || !isAbsolute(raw)) throw new Error("--payload must be an absolute path");
  let file, layer, realHome;
  try { file = realpathSync.native(raw); } catch (e) { throw new Error(`payload unavailable: ${e?.message ?? e}`); }
  try { realHome = realpathSync.native(home); } catch (e) { throw new Error(`home unavailable: ${e?.message ?? e}`); }
  try { layer = realpathSync.native(join(home, "layer")); } catch (e) { throw new Error(`home layer unavailable: ${e?.message ?? e}`); }
  const ownLayer = join(realHome, "layer");
  if (layer.toLowerCase() !== ownLayer.toLowerCase()) throw new Error(`home layer ${ownLayer} resolves to ${layer}, not itself`);
  if (dirname(file).toLowerCase() !== layer.toLowerCase()) throw new Error(`payload ${file} is outside ${layer}`);
  const m = /^payload-([0-9a-f]{12})\.md$/.exec(basename(file));
  if (!m) throw new Error(`payload ${file} is not named payload-<hash12>.md`);
  if (!statSync(file).isFile()) throw new Error(`payload ${file} is not a file`);
  const bytes = readFileSync(file);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  if (hash !== m[1]) throw new Error(`payload ${file} does not match its hash`);
  return bytes;
}

/* <root>\profiles\<profile>\claude.json, checked to be that Claude profile. */
function readProfile(profile, root) {
  if (!BARE_PROFILES.includes(profile)) throw new Error(`unknown launch profile ${JSON.stringify(profile)}`);
  if (!root || !isAbsolute(root)) throw new Error("--root must be an absolute Vidar root");
  const path = join(root, "profiles", profile, "claude.json");
  const doc = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  if (doc?.id !== profile || doc?.agent !== "claude") throw new Error(`${path} is not the Claude ${profile} profile`);
  return { path, doc };
}

/* The profile's static `payload` file's bytes (read once). */
function staticPayload(doc, root) {
  const payload = under(root, doc.payload ?? "");
  if (!doc.payload || !existsSync(payload)) throw new Error(`payload not found at ${payload}`);
  return readFileSync(payload);
}

/* A Flow Claude stage (`--flow-payload bare --root <abs root>`, flow/claude.rs): only the profile's
   static payload, as the `systemPrompt.append` a Bare tab gets (its text, never the path). Nothing
   else of the profile (settingSources, plugins, allowedTools) applies: Flow keeps its own. */
export function flowPayload({ profile, root }) {
  const { doc } = readProfile(profile, root);
  return { type: "preset", preset: "claude_code", append: staticPayload(doc, root).toString("utf8") };
}

/* A Flow Claude stage's carried MCP servers (`--mcp-servers <json>`, flow/claude_mcp.rs): a JSON object
   of name → { type: "http"|"sse", url }, rebuilt with exactly those two fields for the SDK's
   `mcpServers` option. Throws on anything else (Rust filters first; this is the backstop): a name
   that is not plain or starts with `plugin_` (the SDK's plugin-server namespace), another type, or a
   url that is not http(s). */
export function flowMcpServers(raw) {
  let doc;
  try { doc = JSON.parse(raw); } catch { throw new Error("--mcp-servers is not JSON"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("--mcp-servers must be a JSON object");
  const out = {};
  for (const [name, s] of Object.entries(doc)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || name.startsWith("plugin_")) throw new Error(`bad MCP server name ${JSON.stringify(name)}`);
    if (s?.type !== "http" && s?.type !== "sse") throw new Error(`MCP server ${name} is not http or sse`);
    if (typeof s.url !== "string" || !/^https?:\/\//i.test(s.url)) throw new Error(`MCP server ${name} has no http(s) url`);
    out[name] = { type: s.type, url: s.url };
  }
  return out;
}

/* Falcon passes --mcp-file only for a Bare profile. The file must be a regular
   direct child of the real home's own layer, with the generated file name. */
function readBareMcpFile(raw, home) {
  if (typeof raw !== "string" || !isAbsolute(raw)) throw new Error("--mcp-file must be an absolute path");
  if (!home || !isAbsolute(home)) throw new Error("--home must be an absolute agent home");
  if (!/^mcp-[0-9a-f]{12}\.json$/.test(basename(raw))) throw new Error("MCP file is not named mcp-<hash12>.json");
  const realHome = realpathSync.native(home);
  const layer = realpathSync.native(join(home, "layer"));
  if (layer.toLowerCase() !== join(realHome, "layer").toLowerCase()) throw new Error("home layer resolves outside itself");
  if (!lstatSync(raw).isFile()) throw new Error("MCP file is not a regular file");
  const file = realpathSync.native(raw);
  if (dirname(file).toLowerCase() !== layer.toLowerCase() || basename(file) !== basename(raw)) throw new Error("MCP file is outside the home layer");
  const doc = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  const servers = doc?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("MCP file has no mcpServers object");
  for (const name of Object.keys(servers)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || (name.startsWith("plugin_") && name !== "plugin_vidar_drive")) {
      throw new Error(`bad MCP server name ${JSON.stringify(name)}`);
    }
  }
  return servers;
}

/* A Flow Claude stage's SDK options from its argv (flow/claude_mcp.rs; never with --profile),
   plus a Bare profile's --mcp-file. The main sidecar spreads this return into SDK options:
   `--flow-payload <profile> --root <abs root>` → systemPrompt, `--mcp-servers <json>` → mcpServers (omitted when
   empty). A Flow stage's --mcp-file (Flow's own drive-only file, fold W2 L2a) needs --flow-payload and
   --home; its servers and the user's URL-only ones form one strict set. With no Flow args or MCP file:
   {}, so no option changes. A bad arg goes to `fail(message)` (the sidecar's: error line, exit 1); {}
   if it returns. */
export function flowOptions({ profile, payload, servers, root }, fail, argv = process.argv.slice(2)) {
  const out = {};
  try {
    const at = argv.indexOf("--mcp-file");
    if (at !== -1) {
      const launch = profile !== undefined && payload === undefined && servers === undefined;
      const flowStage = profile === undefined && payload !== undefined;
      if (!launch && !flowStage) throw new Error("an MCP file needs a launch profile or a Flow payload");
      const raw = argv[at + 1];
      const homeAt = argv.indexOf("--home");
      out.mcpServers = readBareMcpFile(raw, homeAt === -1 ? undefined : argv[homeAt + 1]);
      out.strictMcpConfig = true;
    }
    if ((payload !== undefined || servers !== undefined) && profile !== undefined) throw new Error("a launch profile carries no flow arguments");
    if (payload !== undefined) out.systemPrompt = flowPayload({ profile: payload, root });
    if (servers !== undefined) {
      const s = flowMcpServers(servers);
      if (Object.keys(s).length) out.mcpServers = { ...s, ...(out.mcpServers ?? {}) };
    }
  } catch (e) { fail(`flow stage: ${e?.message ?? e}`); return {}; }
  return out;
}

const PLUGIN_RUNE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const sameDir = (a, b) => resolve(a).replace(/[\\/]+$/, "").toLowerCase() === resolve(b).replace(/[\\/]+$/, "").toLowerCase();

/* A vault plugin rune (`--set-plugin <root>\plugins\<name>`; Falcon admitted it from SpawnParams
   `plugin_names`, run 2026-10-25-rune-vault L2b). Checked again here: the name is Falcon's
   (`^[a-z0-9][a-z0-9-]{0,63}$`), <root>\plugins is the real root's own (not a junction), the folder
   is no reparse point and sits directly in it, and holds a regular .claude-plugin\plugin.json. One
   that fails throws: Falcon refuses the spawn on the same checks, so a miss here is tampering. */
function admitRootPlugin(raw, root) {
  const name = basename(raw);
  if (!PLUGIN_RUNE_NAME.test(name)) throw new Error(`plugin rune name ${JSON.stringify(name)} is not plain`);
  let plugins;
  try { plugins = realpathSync.native(join(root, "plugins")); } catch (e) { throw new Error(`plugins folder unavailable: ${e?.message ?? e}`); }
  const own = join(realpathSync.native(root), "plugins");
  if (plugins.toLowerCase() !== own.toLowerCase()) throw new Error(`${own} resolves to ${plugins}, not itself`);
  let st;
  try { st = lstatSync(raw); } catch (e) { throw new Error(`plugin rune ${name} not found: ${e?.message ?? e}`); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`plugin rune ${name} is not a plain folder`);
  const dir = realpathSync.native(raw);
  if (dirname(dir).toLowerCase() !== plugins.toLowerCase() || basename(dir).toLowerCase() !== name) throw new Error(`plugin rune ${name} is outside ${plugins}`);
  const meta = join(dir, ".claude-plugin");
  const manifest = join(meta, "plugin.json");
  let ok = false;
  try { ok = lstatSync(meta).isDirectory() && lstatSync(manifest).isFile(); } catch { /* missing */ }
  if (!ok) throw new Error(`plugin rune ${name} has no regular .claude-plugin\\plugin.json`);
  return { type: "local", path: dir };
}

/* Every `--set-plugin` folder: one directly under <root>\plugins is a vault plugin rune
   (`admitRootPlugin`, which throws); any other is a row's rune-set plugin folder (Falcon admitted each
   under the home's layer\plugins\). The latter is checked again here like the payload: the real
   folder must sit directly in the real <home>\layer\plugins (itself the real home's own, not a
   junction), be named <[A-Za-z0-9._-]+>-<12 hex>, and hold a regular .claude-plugin\plugin.json. One
   that fails is dropped with a note to `warn`, never thrown: the tab runs without that set. */
function admitSetPlugins(raws, home, warn, root) {
  const out = [];
  const layerRaws = [];
  // Falcon sends the canonical folder; --root may be a non-canonical spelling of the same root.
  let realPlugins = null;
  try { if (root) realPlugins = realpathSync.native(join(root, "plugins")); } catch { /* none */ }
  const rootPlugin = (raw) => typeof raw === "string" && isAbsolute(raw) && root
    && (sameDir(dirname(raw), join(root, "plugins")) || (realPlugins !== null && sameDir(dirname(raw), realPlugins)));
  for (const raw of raws) {
    if (rootPlugin(raw)) out.push(admitRootPlugin(raw, root));
    else layerRaws.push(raw);
  }
  raws = layerRaws;
  if (!raws.length) return out;
  let plugins;
  try {
    const own = join(realpathSync.native(home), "layer", "plugins");
    plugins = realpathSync.native(join(home, "layer", "plugins"));
    if (plugins.toLowerCase() !== own.toLowerCase()) throw new Error(`${own} resolves to ${plugins}, not itself`);
  } catch (e) { warn(`set plugins dropped: ${e?.message ?? e}`); return out; }
  for (const raw of raws) {
    try {
      if (typeof raw !== "string" || !isAbsolute(raw)) throw new Error("not an absolute path");
      if (!/^[A-Za-z0-9._-]+-[0-9a-f]{12}$/.test(basename(raw))) throw new Error("not named <set>-<hash12>");
      const dir = realpathSync.native(raw);
      if (dirname(dir).toLowerCase() !== plugins.toLowerCase() || basename(dir).toLowerCase() !== basename(raw).toLowerCase()) throw new Error(`outside ${plugins}`);
      const manifest = join(dir, ".claude-plugin", "plugin.json");
      if (!lstatSync(join(dir, ".claude-plugin")).isDirectory() || !lstatSync(manifest).isFile()) throw new Error("no regular .claude-plugin\\plugin.json");
      out.push({ type: "local", path: dir });
    } catch (e) { warn(`set plugin ${raw} dropped: ${e?.message ?? e}`); }
  }
  return out;
}

/* Every `--set-plugin <dir>` in argv, in order (the flag repeats, so the sidecar's first-match `arg` cannot read it). */
export function setPluginArgs(argv) {
  return argv.flatMap((a, i) => (a === "--set-plugin" && i + 1 < argv.length ? [argv[i + 1]] : []));
}

const stderrWarn = (m) => process.stderr.write(`claude-sidecar: ${m}\n`);

/* The launch's Claude config dir: CLAUDE_CONFIG_DIR as Falcon set it in this process's env (the row's
   set-combination home, or the profile's own; Falcon admits it under the home before spawning), when
   it is absolute and sits under `home`; else the profile overlay's, as before (fold W2 L2a). */
function launchConfigDir(env, home, overlayDir) {
  const dir = env?.CLAUDE_CONFIG_DIR;
  if (typeof dir === "string" && isAbsolute(dir)) {
    const norm = (p) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
    if (norm(dir).startsWith(norm(home) + sep)) return dir;
  }
  return overlayDir;
}

export function bareOptions({ profile, root, home, payload: rowPayload, setPlugins = [], warn = stderrWarn, env = process.env }) {
  if (!BARE_PROFILES.includes(profile)) throw new Error(`unknown launch profile ${JSON.stringify(profile)}`);
  if (!root || !isAbsolute(root)) throw new Error("--root must be an absolute Vidar root");
  if (!home || !isAbsolute(home)) throw new Error("--home must be an absolute agent home");
  const { path, doc } = readProfile(profile, root);
  const rendered = doc.rendered;
  if (!rendered || !Array.isArray(rendered.plugins)) throw new Error(`${path} has no rendered block`);
  if (rendered.plugins.length) throw new Error(`${path} lists rendered plugins; plugins come from the vault's plugin runes`);
  const plugins = admitSetPlugins(setPlugins, home, warn, root);
  let bytes;
  if (rowPayload !== undefined) bytes = admitRowPayload(rowPayload, home);
  else bytes = staticPayload(doc, root);
  const fill = (s) => String(s).replaceAll("{{root}}", root).replaceAll("{{home}}", home);
  const overlayDir = doc.overlay?.CLAUDE_CONFIG_DIR ? fill(doc.overlay.CLAUDE_CONFIG_DIR) : join(home, "claude-config");
  const configDir = launchConfigDir(env, home, overlayDir);
  return {
    profile,
    root,
    home,
    configDir,
    settingSources: ["user"],
    systemPrompt: { type: "preset", preset: "claude_code", append: bytes.toString("utf8") },
    extraArgs: {},
    plugins,
    allowedTools: vaultAllowedTools(configDir),
  };
}

/* The BARE_ALLOWED_TOOLS entries the launch's own settings.json `permissions.allow` holds: Vidar writes
   that list only from the vault's permission runes (`drive-allow`), so a vault without the rune gets
   none (run 2026-10-25-rune-vault L2b). Unreadable settings: none. */
function vaultAllowedTools(configDir) {
  let allow = [];
  try {
    const doc = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8").replace(/^﻿/, ""));
    if (Array.isArray(doc?.permissions?.allow)) allow = doc.permissions.allow;
  } catch { /* absent or unparsable */ }
  return BARE_ALLOWED_TOOLS.filter((t) => allow.includes(t));
}

/* The model a bare tab expects before its first turn: ANTHROPIC_MODEL, then its own config dir's
   settings.json (settingSources is ["user"], so no project layer applies). Read-only. */
export function bareSettingsModel(configDir) {
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  try {
    const m = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8").replace(/^﻿/, "")).model;
    if (typeof m === "string" && m.trim()) return m.trim();
  } catch { /* absent or unparsable */ }
  return null;
}

/* The first system/init of a session, as received, to <home>\manifests\falcon-<session>.init.json
   (create-new: an existing file is never rewritten). It is the record of what the CLI actually
   loaded (plugins, slash commands, MCP servers, permission mode). Best effort, never throws;
   returns the path written or null. */
export function writeInitOnce(bare, session, msg) {
  try {
    if (!bare || typeof session !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(session)) return null;
    const dir = join(bare.home, "manifests");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `falcon-${session}.init.json`);
    writeFileSync(path, JSON.stringify(msg, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    return path;
  } catch { return null; }
}
