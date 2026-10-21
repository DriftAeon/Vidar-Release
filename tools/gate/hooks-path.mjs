// `node tools/gate/hooks-path.mjs` - the package.json `prepare` step (retired rune git-hooks-path).
// Sets core.hooksPath to .githooks when the folder is a git work tree; does nothing otherwise
// (Vidar-Release may not be a clone). Never throws, always exits 0.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

try {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const inside = git("rev-parse", "--is-inside-work-tree");
  const top = git("rev-parse", "--show-toplevel");
  // Only when this folder is itself the repo root, not a subfolder of some outer repo.
  if (inside.status === 0 && inside.stdout.trim() === "true" && resolve(top.stdout.trim()) === root) {
    git("config", "core.hooksPath", ".githooks");
  }
} catch {
  // best effort
}
process.exit(0);
