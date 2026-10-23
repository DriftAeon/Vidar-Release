// General's build row: the stamp beside the running exe, the releases page and Check Now (the release
// index check, src/startup-updates/release.ts), plus the Check for Updates at Launch switch.
import { loadBuildStamp, RELEASES_URL } from "../build-stamp/stamp";
import { invoke } from "../ipc";
import { addSettingRow } from "./registry";
import { renderLaunchSwitch, renderRelease } from "./release-view";
import "./release.css";

const AT_LAUNCH = "vidarUpdate.atLaunch";

export function registerReleaseRow(category: string): void {
  const stamp = loadBuildStamp();
  // Lazy: the startup-updates card pulls sessions and toasts, needed only when a check runs.
  const checkNow = () => import("../startup-updates").then((m) => m.checkReleaseNow());
  addSettingRow({
    name: "Vidar Build",
    category,
    wide: true,
    tip: "The commit this build was made from. Hover it for the full hash and build time.",
    keywords: () => "version release commit build stamp update check",
    control: () => {
      const host = document.createElement("div");
      void stamp.then((s) => host.replaceChildren(renderRelease(document, s, () => invoke("open_url", { url: RELEASES_URL }), checkNow)));
      return host;
    },
  });
  addSettingRow({
    name: "Check for Updates at Launch",
    category,
    keywords: () => "version release update check launch",
    control: (setError) => renderLaunchSwitch(
      document,
      invoke("read_state").then((s) => s[AT_LAUNCH] !== false, () => true),
      (on) => invoke("patch_state", { entries: { [AT_LAUNCH]: on } }),
      setError,
    ),
  });
}
