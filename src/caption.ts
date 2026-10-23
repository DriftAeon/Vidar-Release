/* Vidar-drawn caption row. src-tauri/src/caption.rs removes the native caption and DWM keeps
   painting min/max/close over the row's right end, so this row only carries the app icon and the
   title, inset to line up with the character stage. Height comes from `caption_metrics` (today's
   native caption height at the window's DPI and maximize state); background and text are the
   colours syncCaption (theme.ts) sends DWM. No metrics (plain browser mode) → the row stays hidden. */
import { invoke } from "./ipc";
import { onThemeChange, xtermTheme } from "./theme";
import iconUrl from "../src-tauri/icons/titlebar-32.png";

function paintColours() {
  const t = xtermTheme();
  const root = document.documentElement.style;
  root.setProperty("--caption-bg", t.background);
  root.setProperty("--caption-fg", t.foreground);
}

async function measure(row: HTMLElement) {
  const m = await invoke("caption_metrics").catch(() => undefined);
  if (!m) return;
  // Physical → CSS pixels; devicePixelRatio carries both the DPI scale and page zoom.
  const ratio = window.devicePixelRatio || 1;
  const root = document.documentElement.style;
  root.setProperty("--caption-h", `${m.height / ratio}px`);
  root.setProperty("--caption-buttons-w", `${m.buttonsWidth / ratio}px`);
  root.setProperty("--caption-band", `${m.band / ratio}px`);
  row.toggleAttribute("data-maximized", m.maximized);
  row.dataset.ready = "";
}

export function initCaption() {
  const row = document.createElement("header");
  row.id = "caption";
  const icon = document.createElement("img");
  icon.className = "caption-icon";
  icon.src = iconUrl;
  icon.alt = "";
  icon.draggable = false;
  const title = document.createElement("span");
  title.className = "caption-title";
  title.textContent = "Vidar";
  row.append(icon, title);
  document.body.prepend(row);

  paintColours();
  onThemeChange(paintColours);
  void measure(row);
  // Maximize, restore, a DPI move and page zoom all fire resize; one measure per frame.
  let queued = false;
  window.addEventListener("resize", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      void measure(row);
    });
  });
  // A DPI move can keep the CSS viewport size, so no resize fires: a resolution media query
  // matches one ratio only, so it is re-armed after every change.
  const watchRatio = () => {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener(
      "change",
      () => {
        void measure(row);
        watchRatio();
      },
      { once: true },
    );
  };
  watchRatio();
}
