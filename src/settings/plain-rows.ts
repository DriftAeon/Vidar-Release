// Settings › Agents › Plain Rows: the On/Off switch for the plain (non-Bare) Claude and Codex launcher
// rows (roster.ts PLAIN_KEYS), kept in the "launcher.plainRows" pref. Off by default: the Bare rows lead.
import { loadConfig } from "../config";
import { overlayAgents } from "../config-agents";
import { buildTypeMenu } from "../launcher/menu";
import { builtinAgents } from "../launcher/roster";
import { getPref, setPref } from "../prefs";

export const plainRowsOn = (): boolean => getPref("launcher.plainRows") === true;

/** The switch. The launcher draws its rows once per build, so a change rebuilds it from the same
 *  config the app built it from (launcher-order.ts pattern); `redraw` refreshes the Settings page. */
export function plainRowsControl(redraw: () => void): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ws-btn";
  const paint = () => {
    b.textContent = plainRowsOn() ? "On" : "Off";
    b.setAttribute("aria-pressed", String(plainRowsOn()));
  };
  paint();
  b.addEventListener("click", () => {
    setPref("launcher.plainRows", !plainRowsOn());
    paint();
    redraw();
    void loadConfig().then(({ config: c }) => buildTypeMenu(overlayAgents(builtinAgents(), c.agents), c.locations ?? []));
  });
  return b;
}
