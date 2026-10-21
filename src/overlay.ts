// Marquee overlay page: one CSS drag; Rust maps it to measured physical bounds.
// Runs in its own transparent window (label "ocr-overlay"); see src-tauri/src/ocr.rs.

import { invoke } from "./ipc";

const box = document.getElementById("box")!;
const size = document.getElementById("size")!;
const hint = document.getElementById("hint")!;

let start: { x: number; y: number } | null = null;
let busy = false;

function rect(e: MouseEvent) {
  const x = Math.min(start!.x, e.clientX);
  const y = Math.min(start!.y, e.clientY);
  const w = Math.abs(e.clientX - start!.x);
  const h = Math.abs(e.clientY - start!.y);
  return { x, y, w, h };
}

function draw(e: MouseEvent) {
  if (!start) return;
  const r = rect(e);
  box.style.left = `${r.x}px`;
  box.style.top = `${r.y}px`;
  box.style.width = `${r.w}px`;
  box.style.height = `${r.h}px`;
  const dpr = window.devicePixelRatio;
  size.textContent = `${Math.round(r.w * dpr)} × ${Math.round(r.h * dpr)}`;
  size.style.left = `${r.x + r.w + 8}px`;
  size.style.top = `${r.y + r.h + 8}px`;
}

function cancel() {
  if (busy) return;
  void invoke("ocr_cancel", {});
}

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || busy) return;
  start = { x: e.clientX, y: e.clientY };
  box.style.display = "block";
  size.style.display = "block";
  hint.style.display = "none";
  draw(e);
});

document.addEventListener("mousemove", draw);

document.addEventListener("mouseup", (e) => {
  if (e.button !== 0 || !start || busy) return;
  const r = rect(e);
  start = null;
  busy = true;
  hint.textContent = "Reading…";
  hint.style.display = "block";
  // Fractional CSS size: innerWidth/innerHeight are rounded integers and skew the mapping.
  const viewport = document.documentElement.getBoundingClientRect();
  void invoke("ocr_capture", {
    ...r,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  }).catch(() => {
    // Rust reports errors on the main window and closes the overlay.
  });
});

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  cancel();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancel();
});

// clicking away (alt-tab etc.) leaves a dead overlay on top of everything —
// treat loss of focus as cancel
window.addEventListener("blur", () => {
  // ends this pick only; the tool stays armed (ocr.rs cancel_event)
  if (!busy) void invoke("ocr_cancel", { blur: true });
});
