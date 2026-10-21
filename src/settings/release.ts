// General's build row: the stamp beside the running exe and the releases page. No network request.
import { loadBuildStamp, RELEASES_URL } from "../build-stamp/stamp";
import { invoke } from "../ipc";
import { addSettingRow } from "./registry";
import { renderRelease } from "./release-view";
import "./release.css";

export function registerReleaseRow(category: string): void {
  const stamp = loadBuildStamp();
  addSettingRow({
    name: "Vidar Build",
    category,
    wide: true,
    tip: "The commit this build was made from. Hover it for the full hash and build time.",
    keywords: () => "version release commit build stamp",
    control: () => {
      const host = document.createElement("div");
      void stamp.then((s) => host.replaceChildren(renderRelease(document, s, () => invoke("open_url", { url: RELEASES_URL }))));
      return host;
    },
  });
}
