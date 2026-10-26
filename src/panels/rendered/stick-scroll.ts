// Scrolling: stick to the bottom unless the user scrolled up.
// Within STICK_MARGIN_PX of the bottom re-sticks; further away un-sticks only when the scroll
// was not follow's own glide (user input cancels the glide first, see follow.ts).

import type { Follow } from "./follow";
import type { LatestPill } from "./latest-pill";
import type { RenderedState } from "./state";

const STICK_MARGIN_PX = 60;

export function bindStickScroll(transcript: HTMLElement, S: Pick<RenderedState, "stick">, follow: Follow, latest: LatestPill): void {
  let lastTop = 0;
  let lastScrollH = 0;
  transcript.addEventListener("scroll", () => {
    const up = transcript.scrollTop < lastTop; // an upward move inside the margin stays un-stuck
    // a clamp, not the user: content shrank (a pill or group folding shut) or the viewport grew
    // (Agents bar Clear, composer shrinking), and the browser pulled scrollTop up to the new
    // maximum. A user scroll-up never lands exactly on the bottom, so the stick stays.
    const shrank = transcript.scrollHeight < lastScrollH;
    const atMax = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 1;
    lastTop = transcript.scrollTop;
    lastScrollH = transcript.scrollHeight;
    if (up && S.stick && (shrank || atMax)) { follow.toBottom(); latest.update(); return; }
    if (!latest.settling()) {
      if (!up && transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - STICK_MARGIN_PX) S.stick = true;
      else if (up && !follow.programmatic()) S.stick = false; // a downward move never leaves the bottom
    }
    latest.update();
  });
}
