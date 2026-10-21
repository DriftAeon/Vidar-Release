// Project-settings trust gate for the non-Bare sidecar (security fix D1). A cloned repo's
// .claude/settings.json can carry hooks, so the "project" settings source loads only when Claude
// itself has trusted that exact folder (hasTrustDialogAccepted in .claude.json). Parents do not
// count: a parent folder being trusted says nothing about a repo cloned beneath it. Imported by
// claude-sidecar.mjs (bundled beside it, root).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// One spelling for every form: forward slashes, lower case, no trailing separator.
function norm(p) {
  return String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// True only when the projects entry for cwd (any spelling, exact folder) is trust-accepted.
export function projectTrusted(claudeJson, cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return false;
  const projects = claudeJson?.projects;
  if (!projects || typeof projects !== "object") return false;
  const want = norm(cwd);
  let trusted = false;
  for (const [key, entry] of Object.entries(projects)) {
    if (norm(key) !== want) continue;
    if (entry?.hasTrustDialogAccepted === true) trusted = true;
  }
  return trusted;
}

// .claude.json sits in CLAUDE_CONFIG_DIR when set, else the home directory (src-tauri/src/mcp.rs).
// A missing or unparsable file is untrusted; the contents are never printed.
export function loadClaudeJson(env = process.env, home = homedir()) {
  try {
    const dir = env.CLAUDE_CONFIG_DIR || home;
    return JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

// The settingSources for a run in cwd, with one stderr line naming the folder.
export function settingSourcesFor(cwd, claudeJson = loadClaudeJson()) {
  const trusted = projectTrusted(claudeJson, cwd);
  process.stderr.write(`[sidecar] project settings ${trusted ? "loaded" : "skipped (folder not trusted)"}: ${cwd}\n`);
  return trusted ? ["user", "project"] : ["user"];
}
