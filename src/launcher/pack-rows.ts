// Adapt Rust-validated pack launch descriptors into Raw launcher rows.
import type { AgentType } from "../config";
import type { ModuleRow } from "../modules/registry";

function launchArgs(executable: string, args: readonly string[]): { shell?: string; args: string[] } {
  if (/^(?:pwsh|powershell)(?:\.exe)?$/i.test(executable)) {
    const file = args.findIndex((arg) => /^-file$/i.test(arg));
    if (file < 0) return { shell: executable, args: [...args] };
    // -File resolves against the picked workspace. Pack scripts live under Vidar's root.
    const script = args[file + 1];
    const rest = args.slice(file + 2).map((arg) => `'${arg}'`).join(" ");
    return {
      shell: executable,
      args: [...args.slice(0, file), "-Command", `if (-not $env:VIDAR_ROOT) { throw 'VIDAR_ROOT is not set' }; & "$env:VIDAR_ROOT/${script}"${rest ? ` ${rest}` : ""}`],
    };
  }
  const command = args.length ? `& '${executable}' ${args.map((arg) => `'${arg}'`).join(" ")}` : executable;
  return { args: ["-NoExit", "-Command", command] };
}

/** Registry survivors only; a missing or broken pack contributes no row. Dependency availability
 * stays in `requires`, so the normal launcher gate updates after a dependency report. */
export function rawPackRows(modules: readonly ModuleRow[]): AgentType[] {
  return modules.flatMap((m) => {
    if (m.source !== "pack" || m.kind !== "agent" || m.agent?.gateway || !m.agent?.rows?.includes("raw") || !m.agent.launch) return [];
    return [{
      key: m.id,
      id: m.id,
      label: m.label,
      requires: [...(m.when?.deps ?? [])],
      ...launchArgs(m.agent.launch.executable, m.agent.launch.args),
    }];
  });
}
