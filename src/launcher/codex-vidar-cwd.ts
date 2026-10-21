// src\launcher\codex-vidar-cwd.ts — one concern: the TS mirror of Rust's `refuse_vidar_cwd`
// (src-tauri\src\bare\mod.rs). Codex Bare refuses a folder that is Vidar's root, an ancestor of it,
// or inside `<root>\runtime` except `runtime\worktrees\<name>`; the launcher dims the Bare rows on it
// instead of refusing after the click. Text comparison only (the Rust side also compares canonical
// paths, so a junction still gets refused at launch). No imports (the node test harness loads this file directly): the caller passes the runtime
// folder's name, which the paths contract gives (`rel("bridge")` sits directly under it).

/** A folder as lowercase components: `/` and `\` alike, `\\?\` dropped, `.` dropped, `..` applied. */
function parts(p: string): string[] {
  const s = p.trim().replace(/\//g, "\\").replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").toLowerCase();
  const out: string[] = [];
  for (const part of s.split("\\")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

/** True when Codex Bare would refuse `cwd` for the Vidar folder `root`. Empty input passes. */
export function codexBareRefusesCwd(cwd: string, root: string, runtime: string): boolean {
  const c = parts(cwd);
  const r = parts(root);
  const RUNTIME = runtime.toLowerCase();
  if (!cwd.trim() || !r.length) return false;
  if (c.length <= r.length) return c.every((seg, i) => seg === r[i]);
  if (!r.every((seg, i) => seg === c[i]) || c[r.length] !== RUNTIME) return false;
  return !(c.length > r.length + 2 && c[r.length + 1] === "worktrees");
}
