// One git runner for tools that build throwaway repos.
// Usage: import { git } from "../lib/git.mjs"; git(cwd, ["init", "-q"]); git(cwd, args, MyError) to throw that class.
// Runs `git <args>` in `cwd` with every GIT_* variable dropped from the environment (a hook's GIT_DIR must not
// steer a repo built elsewhere). Refuses: throws `new ErrorClass("git <args> failed in <cwd>: <stderr>")` on a
// non-zero exit or a spawn error; returns nothing on success.
import { spawnSync } from "node:child_process";

export function git(cwd, args, ErrorClass = Error) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new ErrorClass(`git ${args.join(" ")} failed in ${cwd}: ${(r.stderr || r.error?.message || "").trim()}`);
}
