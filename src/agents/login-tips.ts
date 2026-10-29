// src\agents\login-tips.ts — the logged-out wording per agent, held apart from the Login Card
// modules (panels/rendered/claude-login.ts, api-key-card.ts) so src/agents never imports a panel.
// Both card modules re-export these names. The LoginReach import is type-only (erased).

import type { LoginReach } from "../panels/rendered/login";

/** A Codex tab logs in through its own app-server (agents/codex.ts encodeLogin): the pill opens the choice. */
export const CODEX_LOGIN_TIP = "Codex is not logged in. Click Not Logged In in the status bar to log in with ChatGPT or an API key.";

/** `/login` is a terminal-UI command a headless session cannot run; the pill opens the Login Card
 *  (claude-login.ts), which runs `claude auth login` against the tab's own home (a Bare tab's, else
 *  the default) and respawns the session once the status check says logged in. */
export const LOGIN_TIP = "Claude Code is not logged in. Click Not Logged In in the status bar to log in through the browser.";
/** Where the card is unavailable (the Falcon shell, a host without the command) the pill offers
 *  nothing; the login happens outside Vidar, and naming no command keeps a Bare tab off the default home. */
export const LOGIN_TIP_NO_CARD = "Claude Code is not logged in. Log in to this tab's Claude home outside Vidar, then type /clear here to restart the session.";
/** A tab whose respawn is refused: /clear would fail there too, so the way back is a new tab. */
export const LOGIN_TIP_REFUSED = "Claude Code is not logged in. Log in to this tab's Claude home outside Vidar, then open a new tab.";
/** A known gateway holds the identity: the CLI's not-logged-in reply means the gateway's key. */
export const LOGIN_TIP_GATEWAY = "This gateway reports Claude Code is not logged in. Check the gateway's API key.";

/** How a logged-out Claude tab gets back in (the shared `LoginReach`). */
export type ClaudeReach = LoginReach;
/** A gateway wins over a refused respawn: no home login helps a gateway tab. */
export function claudeReach(hostCan: boolean, transport: { gateway?: unknown; respawnRefused?: boolean }): ClaudeReach {
  if (transport.gateway) return "gateway";
  if (transport.respawnRefused) return "refused";
  return hostCan ? "card" : "outside";
}
const CLAUDE_TIPS: Record<ClaudeReach, string> = { card: LOGIN_TIP, gateway: LOGIN_TIP_GATEWAY, refused: LOGIN_TIP_REFUSED, outside: LOGIN_TIP_NO_CARD };
/** The Claude profile's `loginTip`. `reach`: the tab's way back in. */
export const claudeLoginTip = (reach: ClaudeReach = "card"): string => CLAUDE_TIPS[reach];
