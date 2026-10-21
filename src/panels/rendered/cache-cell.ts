// Prompt-cache cell of a Rendered body's status bar: the Warm / countdown / Cold slot, its
// one-second timer, and the reset a new session or model switch needs.

import { el } from "./dom";
import type { RenderedState } from "./state";

export function createCacheCell(S: RenderedState) {
  // Its own slot, not a part of `slParts`: the countdown redraws once a second and
  // redrawStatus() must not run that often.
  const cacheSlot = el("span", "sl-cache");
  /** Ticks only while the slot is on screen: a hidden tab's body is display:none and has no one to read it.
   *  Without IntersectionObserver the slot counts as shown. */
  let shown = typeof IntersectionObserver !== "function";
  /** write only on change, so the once-a-second tick is a no-op while the text holds */
  function put(cls: string, text: string) {
    if (cacheSlot.className !== cls) cacheSlot.className = cls;
    if (cacheSlot.textContent !== text) cacheSlot.textContent = text;
  }
  /* -- prompt-cache countdown --
     The statusline script gets `prompt_cache.expires_at` from its hook input; the SDK emits
     no such field, so the stamp is ours: the last turn that read or wrote cache. The TTL is
     assumed 1h until a PostModelSwitch hook tells us otherwise (it is 5m under usage overage).
     Unlike the statusline's one-shot render this one ticks, which is the whole point — the
     number matters while idle, and idle is exactly when a re-render never comes. */
  /** the cache cell alone — `redrawStatus` never touches it, and it never touches the rest */
  function drawCache() {
    if (!S.isAlive || !S.cacheStamp) { put("sl-cache", ""); return; }
    // Two words and a number, nothing else: Warm while there is nothing to do about it, the
    // minutes once there is, Cold when the prefix is gone. No "Hot" — a third word for the
    // healthy case read as a distinct state when it was just more of Warm.
    if (S.inTurn) {
      // calls are landing right now, so a countdown answers a question nobody is asking
      put("sl-cache sl-ok", "Warm");
      return;
    }
    const left = (S.cacheStamp + S.cacheTtlMs - Date.now()) / 1000;
    if (left <= 0) {
      put("sl-cache sl-dim", "Cold");
      stopCacheTimer(); // there is nothing left to count
      return;
    }
    if (left > 600) {
      put("sl-cache sl-ok", "Warm");
      return;
    }
    // under 10m: the colour carries the urgency, the number is bare
    put(`sl-cache ${left <= 30 ? "sl-bad" : "sl-warn"}`, left <= 30 ? `${Math.ceil(left)}s` : `${Math.ceil(left / 60)}m`);
  }
  function startCacheTimer() {
    if (shown && S.cacheTimer === undefined) S.cacheTimer = window.setInterval(drawCache, 1000);
  }
  function markCacheWarm() {
    if (S.hydrating || S.replaying) return;
    S.cacheStamp = Date.now();
    startCacheTimer();
    drawCache();
  }
  function stopCacheTimer() {
    if (S.cacheTimer !== undefined) { clearInterval(S.cacheTimer); S.cacheTimer = undefined; }
  }
  /** a new session or a model switch: the old prefix is gone, so the clock is meaningless */
  function resetCache() {
    S.cacheStamp = 0;
    stopCacheTimer();
    drawCache();
  }
  if (typeof IntersectionObserver === "function") {
    const io = new IntersectionObserver((entries) => {
      if (S.disposed) { io.disconnect(); stopCacheTimer(); return; }
      shown = entries[entries.length - 1].isIntersecting;
      if (!shown) { stopCacheTimer(); return; }
      drawCache();
      if (S.isAlive && S.cacheStamp && S.cacheStamp + S.cacheTtlMs > Date.now()) startCacheTimer();
    });
    io.observe(cacheSlot);
  }
  return { el: cacheSlot, drawCache, markCacheWarm, stopCacheTimer, resetCache };
}
