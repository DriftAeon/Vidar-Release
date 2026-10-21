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
//                                   setPlugins: ["<home>\\layer\\plugins\\<set>-<hash12>"] /* --set-plugin, repeated */,
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
// exactly the `rendered.plugins` set from <root>\plugins\<name> then the row's rune-set plugins
// (`--set-plugin`, from <home>\layer\plugins; a bad one is dropped, not refused), and `mcp__plugin_vidar_drive`
// allowed. The SDK `env` option is never set: it replaces the child env, and Falcon already built it.
//
// Refuses (throws, the sidecar reports and exits): an unknown profile id, a relative --root or
// --home, a profile that is not the Claude one or has no rendered block, a plugin name that is not
// plain or whose folder is missing, a missing payload, a junctioned <home>\layer, a `--payload`
// outside the real <home>\layer, not named payload-<hash12>.md or whose SHA-256 prefix does not match that name. Never reads vidar.json (pluginDirs and
// statuslineMirror are the default tab's settings, not a bare tab's).

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, lstatSync } from "node:fs";
import { basename, dirname, join, isAbsolute } from "node:path";
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

/* A Flow Claude stage's SDK options from its argv (flow/claude_mcp.rs; never with --profile):
   `--flow-payload <profile> --root <abs root>` → systemPrompt, `--mcp-servers <json>` → mcpServers (omitted when
   empty). Neither given (every other caller, Falcon's tabs among them): {}, so no option changes. A bad arg goes
   to `fail(message)` (the sidecar's: error line, exit 1); {} if it returns. */
export function flowOptions({ profile, payload, servers, root }, fail) {
  const out = {};
  try {
    if ((payload !== undefined || servers !== undefined) && profile !== undefined) throw new Error("a launch profile carries no flow arguments");
    if (payload !== undefined) out.systemPrompt = flowPayload({ profile: payload, root });
    if (servers !== undefined) {
      const s = flowMcpServers(servers);
      if (Object.keys(s).length) out.mcpServers = s;
    }
  } catch (e) { fail(`flow stage: ${e?.message ?? e}`); return {}; }
  return out;
}

/* A row's rune-set plugin folders (`--set-plugin`, repeated; Falcon admitted each under the home's
   layer\plugins\). Checked again here like the payload: the real folder must sit directly in the
   real <home>\layer\plugins (itself the real home's own, not a junction), be named
   <[A-Za-z0-9._-]+>-<12 hex>, and hold a regular .claude-plugin\plugin.json. One that fails is
   dropped with a note to `warn`, never thrown: the tab runs without that set. */
function admitSetPlugins(raws, home, warn) {
  const out = [];
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

export function bareOptions({ profile, root, home, payload: rowPayload, setPlugins = [], warn = stderrWarn }) {
  if (!BARE_PROFILES.includes(profile)) throw new Error(`unknown launch profile ${JSON.stringify(profile)}`);
  if (!root || !isAbsolute(root)) throw new Error("--root must be an absolute Vidar root");
  if (!home || !isAbsolute(home)) throw new Error("--home must be an absolute agent home");
  const { path, doc } = readProfile(profile, root);
  const rendered = doc.rendered;
  if (!rendered || !Array.isArray(rendered.plugins)) throw new Error(`${path} has no rendered block`);
  const plugins = rendered.plugins.map((name) => {
    if (typeof name !== "string" || !/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`bad plugin name ${JSON.stringify(name)}`);
    const dir = join(root, "plugins", name);
    if (!existsSync(dir)) throw new Error(`plugin ${name} not found at ${dir}`);
    return { type: "local", path: dir };
  });
  plugins.push(...admitSetPlugins(setPlugins, home, warn));
  let bytes;
  if (rowPayload !== undefined) bytes = admitRowPayload(rowPayload, home);
  else bytes = staticPayload(doc, root);
  const fill = (s) => String(s).replaceAll("{{root}}", root).replaceAll("{{home}}", home);
  const configDir = doc.overlay?.CLAUDE_CONFIG_DIR ? fill(doc.overlay.CLAUDE_CONFIG_DIR) : join(home, "claude-config");
  return {
    profile,
    root,
    home,
    configDir,
    settingSources: ["user"],
    systemPrompt: { type: "preset", preset: "claude_code", append: bytes.toString("utf8") },
    extraArgs: {},
    plugins,
    allowedTools: [...BARE_ALLOWED_TOOLS],
  };
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
