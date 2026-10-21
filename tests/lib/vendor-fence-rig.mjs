// Shared rig for tests/vendor-fence-*.test.mjs. Every split file imports this module first: the GIT_*
// scrub below is an import-time side effect that must run in each test process.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rel } from "../../tools/lib/paths.mjs";

// A pre-commit hook exports GIT_DIR/GIT_INDEX_FILE; left in, the temp repos below resolve to this one.
for (const k of Object.keys(process.env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR)$/i.test(k)) delete process.env[k];

export const VENDOR = fileURLToPath(new URL("../../tools/vendor/", import.meta.url));
// Everything vendor-tab.ps1 needs beside it: the wrapper delegates to the shared preparation.
export const VENDOR_FILES = ["vendor-tab.ps1", "vendor-prepare.ps1", "vendor-env.ps1", "guard-vendor-write.mjs", "vendor-fence.base.json"];
// The gateway the launches use: the contract fixture pack (id acme, keyVar ACME_API_KEY).
export const GATEWAY = "acme";
export const fixturePack = () => JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/modules/ok-gateway/acme/pack.json", import.meta.url)), "utf8"));
// Writes <tmp>/<packs>/<pack.id>/pack.json, where vendor-prepare.ps1 resolves it through paths.json.
// Returns the SHA-256 (lowercase hex) of the bytes written, which is what the snapshot pins.
export function writePack(tmp, pack) {
  const dir = join(tmp, rel("packs"), pack.id);
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(pack), "utf8");
  writeFileSync(join(dir, "pack.json"), bytes);
  return createHash("sha256").update(bytes).digest("hex");
}
// One approved-snapshot entry, in the format Rust writes (contracts/paths.json id gatewaySnapshot).
export function snapshotEntry(pack, packSha256) {
  const g = pack.module.agent.gateway;
  return { id: pack.id, pack: pack.id, packSha256, baseUrl: g.baseUrl, keyVar: g.keyVar, model: g.model, env: { ...(g.env ?? {}) } };
}
// Writes <tmp>/<bridge>/gateways.json: `{ version: 1, gateways }`.
export function writeSnapshot(tmp, gateways) {
  const file = join(tmp, rel("gatewaySnapshot"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, gateways }));
  return file;
}
export const hasPwsh = process.platform === "win32" && !spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).error;
// pwsh colours its error output unless the parent shell says otherwise (agent shells do not), and the
// codes land mid-sentence; match on plain text.
export const plain = (r) => (r.stderr + r.stdout).replace(/\x1b\[[0-9;]*m/g, "");

// vendor-tab.ps1 dot-sources tools/lib, resolves paths through contracts/paths.json (also the root
// marker) and reads the approved gateway snapshot, checked against contracts/modules.json (its
// gateway.envAllowlist is the env key allowlist; core modules and contracts/dependencies.json are read
// only for the keyVar-claim rule).
// The fixture pack and its matching snapshot go in too; pass `pack: null` to leave both out, or a
// pack object to write that one instead.
// The snapshot Rust would write follows the pack as written; `snapshot: [...]` writes those entries
// instead (an empty list = a scan that approved nothing).
export function copyPathsLib(tmp, { pack = fixturePack(), snapshot } = {}) {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  mkdirSync(join(tmp, "tools", "lib"), { recursive: true });
  mkdirSync(join(tmp, "contracts"), { recursive: true });
  for (const f of ["Paths.ps1", "BridgeIo.ps1"]) copyFileSync(join(repo, "tools", "lib", f), join(tmp, "tools", "lib", f));
  for (const f of ["paths.json", "modules.json", "dependencies.json"]) copyFileSync(join(repo, "contracts", f), join(tmp, "contracts", f));
  const sha = pack ? writePack(tmp, pack) : null;
  if (snapshot) writeSnapshot(tmp, snapshot);
  else if (pack) writeSnapshot(tmp, [snapshotEntry(pack, sha)]);
}

// Shared rig for the launch tests: a temp <vidar>/tools/vendor, USERPROFILE at the temp folder (so
// the plugin dir and the user settings the script reads are the temp ones, never the real
// ~/.claude), and a fake `claude` that records only credential-shaped NAMES plus whether
// ANTHROPIC_AUTH_TOKEN is non-empty (never values: with a real User-scope key present, AUTH_TOKEN
// holds it). The shape rule mirrors vendor-tab.ps1's Test-CredentialName.
export function launchRig(tabTag, fixtures, packOpts) {
  const tmp = mkdtempSync(join(tmpdir(), "vidar-fence-"));
  const dir = join(tmp, "tools", "vendor");
  const bin = join(tmp, "bin");
  mkdirSync(dir, { recursive: true });
  mkdirSync(bin);
  for (const f of VENDOR_FILES) copyFileSync(join(VENDOR, f), join(dir, f));
  copyPathsLib(tmp, packOpts);
  const marker = join(bin, "env.json");
  writeFileSync(join(bin, "dump.mjs"), `import { writeFileSync } from "node:fs";
const shaped = (k) => { const u = k.toUpperCase(); return u.startsWith("ANTHROPIC_") || u.endsWith("_API_KEY") || u.endsWith("_TOKEN") || u.endsWith("_SECRET")
  || u.endsWith("_KEY") || u.endsWith("_PASSWORD") || u.endsWith("_PAT") || u.endsWith("_CREDENTIALS")
  || ["AWS_ACCESS_KEY_ID", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"].includes(u); };
// sentinel (launchRig option): the key value under test. Only the NAMES of env vars holding it are
// recorded, never a value. (The stub gets no argv: claude.cmd does not forward %*.)
const sentinel = ${JSON.stringify(packOpts?.sentinel ?? "")};
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  names: Object.keys(process.env).filter(shaped).map((k) => k.toUpperCase()).sort(),
  authSet: (process.env.ANTHROPIC_AUTH_TOKEN ?? "").length > 0,
  maxContext: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? null,
  carriers: sentinel ? Object.keys(process.env).filter((k) => process.env[k].includes(sentinel)).sort() : [],
}));
`);
  writeFileSync(join(bin, "claude.cmd"), `@node "${join(bin, "dump.mjs")}"\r\n`);
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const env = { ...process.env, [pathKey]: `${bin};${process.env[pathKey] ?? ""}`, USERPROFILE: tmp, VIDAR_TAB: tabTag, ...fixtures };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CONFIG_DIR;
  const script = join(dir, "vendor-tab.ps1");
  const opts = { encoding: "utf8", env };
  const run = (...extra) => spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Vendor", GATEWAY, ...extra], opts);
  const settings = (obj) => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "settings.json"), JSON.stringify(obj));
  };
  return { tmp, env, script, marker, run, settings, opts };
}
