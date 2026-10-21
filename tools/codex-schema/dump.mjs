// Dump: the shared Codex schema dump behind refresh.mjs and verify.mjs. Spawns `<codex> app-server
// generate-json-schema --experimental --out <tmp>` and trims it with manifest.mjs `buildManifest`.
// Not a CLI; importing it spawns nothing. Never writes outside a temp folder it removes again.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildManifest } from "./manifest.mjs";

export function findCodex() {
  // Vidar spawns this entrypoint (src-tauri/src/agent.rs:165-177); PATH is only a fallback.
  if (process.env.APPDATA) {
    const vidar = join(process.env.APPDATA, "npm/node_modules/@openai/codex/bin/codex.js");
    if (existsSync(vidar)) return vidar;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const binary = join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    if (existsSync(binary)) return binary;
    if (process.platform === "win32") {
      const entry = join(directory, "node_modules/@openai/codex/bin/codex.js");
      if (existsSync(entry)) return entry;
    }
  }
  throw new Error("Codex not found; supply --codex with its executable or npm JS entrypoint");
}

/** Dumps `executable` (a codex.exe or its codex.js) and returns `{ version, manifest }`. */
export function dumpManifest(executable = null) {
  const target = executable ? resolve(executable) : findCodex();
  const run = (arguments_) => {
    const js = target.endsWith(".js");
    const result = spawnSync(js ? process.execPath : target, js ? [target, ...arguments_] : arguments_,
      { encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024, shell: false });
    if (result.error || result.status !== 0) throw new Error(`Codex failed: ${result.error?.message ?? result.stderr}`);
    if (result.stderr.trim()) process.stderr.write(result.stderr);
    return result.stdout.trim();
  };
  const version = run(["--version"]).match(/^codex-cli (\S+)$/)?.[1];
  if (!version) throw new Error("Unrecognized Codex version output");
  const directory = mkdtempSync(join(tmpdir(), "vidar-codex-schema-"));
  try {
    run(["app-server", "generate-json-schema", "--experimental", "--out", directory]);
    return { version, manifest: buildManifest(directory, version) };
  } finally {
    // The directory is created by this invocation under the OS temporary directory.
    try { rmSync(directory, { recursive: true, force: true }); }
    catch (error) { console.warn(`Could not remove ${directory}: ${error.message}`); }
  }
}
