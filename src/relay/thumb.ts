// Relay card thumbnail fit: an HTML display renders in a sandboxed frame (preview.ts mountFrame,
// sandbox="") whose content size the parent cannot read, so the card shows a fixed-size capture
// scaled down to the card width: never a horizontal scroll, never above 100%. Taller pages crop at
// the capture's bottom edge (the dashed edge in relay.css says so). PNG and SVG are plain images
// and fit by CSS alone (relay.css .relay-thumb img).

/** capture width: mock A2's thumbnail slot is 955 px, so a frame this wide shows near 1:1 there */
export const FRAME_W = 960;
/** capture height: the sandbox hides the content height; a fixed 960 x 600 crop (2026-10-11) */
export const FRAME_H = 600;

export interface ThumbFit {
  /** re-measures after a paint (a frame swapped in) or a resize */
  fit(): void;
  dispose(): void;
}

export function fitThumb(host: HTMLElement): ThumbFit {
  function fit(): void {
    const frame = host.querySelector<HTMLIFrameElement>("iframe.display-render:not(.display-staging)");
    host.classList.toggle("relay-thumb-frame", frame !== null);
    if (!frame) { host.style.height = ""; return; }
    const w = host.clientWidth;
    if (!w) return; // not laid out yet (hidden tab): the ResizeObserver fires once it is
    const scale = Math.min(1, w / FRAME_W);
    frame.style.width = `${FRAME_W}px`;
    frame.style.height = `${FRAME_H}px`;
    frame.style.transform = `scale(${scale})`;
    host.style.height = `${Math.floor(FRAME_H * scale)}px`;
  }
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
  ro?.observe(host);
  return { fit, dispose: () => ro?.disconnect() };
}
