// Which window hosts a Rendered body, and the features that only work there. Import-free so
// tests can load it under Node type stripping.

export type RenderedHostId = "vidar-tab" | "falcon-shell";
/** A body behaviour that depends on a host capability. Adding a member makes `HOST_FEATURES`
 *  and `FEATURE_COMMANDS` fail to compile until every host and command list is stated. */
export type RenderedFeature = "installedVersionCheck" | "loginCheck" | "loginRun" | "bangMode";

export const HOST_FEATURES: Record<RenderedHostId, Record<RenderedFeature, boolean>> = {
  "vidar-tab": { installedVersionCheck: true, loginCheck: true, loginRun: true, bangMode: true },
  // `claude_installed_version`, `claude_auth_status` and `claude_login_run` are not registered in the
  // Falcon shell; flip once they are (`tests/rendered-host-profile.test.mjs` fails a true here until then).
  // Without loginCheck the shell still learns "not logged in" from the CLI's own reply.
  "falcon-shell": { installedVersionCheck: false, loginCheck: false, loginRun: false, bangMode: false },
};

/** Tauri commands each feature invokes; checked against `COMMAND_HOSTS` in `src/ipc-hosts.ts`. */
export const FEATURE_COMMANDS: Record<RenderedFeature, readonly string[]> = {
  installedVersionCheck: ["claude_installed_version"],
  loginCheck: ["claude_auth_status", "claude_auth_status_bare"],
  loginRun: ["claude_login_run", "claude_login_cancel"],
  bangMode: ["bang_run"],
};

export function hostHas(host: RenderedHostId, feature: RenderedFeature): boolean {
  return HOST_FEATURES[host][feature];
}
