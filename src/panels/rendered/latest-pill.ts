// "Latest" pill of a Rendered tab: floats above the bottom stack when the user has scrolled up
// more than one viewport from the end; a click scrolls to the bottom and re-arms stick-to-bottom.
// It reads the transcript's own scroll position; the stick listener in rendered.ts calls
// update(), so there is one scroll listener and one at-bottom computation, not two.

import { iconImg } from "../../icon-img";
import { el } from "./dom";

/** True when the view sits more than one viewport height above the bottom of the scroller. */
function isFarFromBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight - (scrollTop + clientHeight) > clientHeight;
}

const SETTLE_MS = 400; // smooth scroll to the bottom takes well under this

export interface LatestPill {
  el: HTMLButtonElement;
  /** recompute visibility (rAF-throttled); call on scroll and when content grows */
  update(): void;
  /** true while the smooth scroll to the bottom runs: the stick flag must not be recomputed from it */
  settling(): boolean;
}

export function createLatestPill(scroller: HTMLElement, onJump: () => void): LatestPill {
  const b = el("button", "rendered-latest");
  b.type = "button";
  b.setAttribute("aria-label", "Scroll To Latest");
  b.title = "Scroll To Latest";
  b.append(iconImg("arrow-down-square"), el("span", undefined, "Latest"));

  let frame = 0;
  let settleUntil = 0;
  const apply = (): void => {
    frame = 0;
    const far = isFarFromBottom(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight);
    b.classList.toggle("is-shown", far);
  };
  b.addEventListener("click", () => {
    settleUntil = performance.now() + SETTLE_MS;
    onJump();
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    scroller.focus({ preventScroll: true });
  });
  return {
    el: b,
    update() {
      if (!frame) frame = requestAnimationFrame(apply);
    },
    settling: () => performance.now() < settleUntil,
  };
}
