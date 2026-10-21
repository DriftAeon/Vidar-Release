// The "Connection Lost" card of a Falcon-hosted Rendered body: the shared card shell with an
// error mark and one body line. The raw read error and the reattach advice ride in the card's
// tooltip. No actions; styled in rendered-cards.css.

import { el } from "./dom";
import { cardShell } from "./card-shell";

// The read error alone cannot tell a host restart (session gone) from a dropped pipe
// (session still hosted), so the advice covers both.
const ADVICE = "Still listed: reattach from the launcher's Falcon row. Host restarted: resume it from the Launcher's Recent list.";

export function connectionLostCard(reason: string): HTMLElement {
  const shell = cardShell({
    root: "div",
    classes: "blk blk-lost",
    parts: ["head", "title", "mark", "body"],
    title: "Connection Lost",
    mark: "error",
  });
  shell.root.title = `${reason}\n${ADVICE}`;
  shell.body!.append(el("div", "lost-line", "Reattach from the Falcon Row"));
  return shell.root;
}
