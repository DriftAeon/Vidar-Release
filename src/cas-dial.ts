// src\cas-dial.ts — the CAS dial in the bottom bar (#bottombar): its face (one grey brush icon in every mode),
// the mode switch and the CAS selector menu. Split from main.ts; initCasDial runs at the dial's
// original spot in main.ts, after initTheme().
import { MODES, MODE_ORDER, applyTheme, currentMode, onThemeChange, type ModeName } from "./theme";
import brushIcon from "./assets/brush.svg";

let dial!: HTMLElement;
let glyph!: HTMLElement;
let dialIcon!: HTMLImageElement;
let casMenu!: HTMLDivElement;

function setDialFace(iconSrc: string | undefined) {
  if (iconSrc) {
    dialIcon.src = iconSrc;
    dialIcon.classList.remove("hidden");
    glyph.classList.add("hidden");
    dial.classList.add("iconized");
  } else {
    dialIcon.classList.add("hidden");
    glyph.classList.remove("hidden");
    dial.classList.remove("iconized");
  }
}

function updateDial() {
  const m = MODES[currentMode()];
  glyph.textContent = m.glyph;
  setDialFace(brushIcon);
  dial.title = `CAS: ${m.label}`;
}

function switchMode(m: ModeName) {
  applyTheme(m); // must precede updateDial — it reads currentMode()
  updateDial();
}

function openCasMenu() {
  casMenu.classList.remove("hidden");
  [...casMenu.children].forEach((el, i) =>
    el.classList.toggle("current", MODE_ORDER[i] === currentMode()),
  );
  // the dial sits in the bottom bar (#bottombar): the menu stands on the bar's top edge, directly above the
  // dial (right edges aligned, so it opens inward from the window's right edge; clamped inside the window)
  const r = dial.getBoundingClientRect();
  const barTop = (dial.closest<HTMLElement>("#bottombar") ?? dial).getBoundingClientRect().top;
  const w = casMenu.offsetWidth;
  casMenu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  casMenu.style.top = `${Math.max(8, barTop - casMenu.offsetHeight - 4)}px`;
}

export function initCasDial(): void {
  dial = document.getElementById("cas-dial")!;
  glyph = document.getElementById("cas-glyph")!;
  dialIcon = document.getElementById("cas-icon") as HTMLImageElement;
  /* CAS selector: vertical neon-plate list, one entry per mode in its own
     accent (cursor color doubles as the mode accent in JS) */
  casMenu = document.createElement("div");
  casMenu.id = "cas-menu";
  casMenu.className = "hidden";
  document.body.appendChild(casMenu);
  for (const name of MODE_ORDER) {
    const m = MODES[name];
    const b = document.createElement("button");
    b.textContent = m.label;
    b.style.setProperty("--cas-c", m.plate ?? m.xterm.cursor);
    b.addEventListener("click", () => {
      casMenu.classList.add("hidden");
      if (name !== currentMode()) switchMode(name);
    });
    casMenu.appendChild(b);
  }

  dial.addEventListener("click", () => {
    if (casMenu.classList.contains("hidden")) openCasMenu();
    else casMenu.classList.add("hidden");
  });
  dial.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openCasMenu();
  });
  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (!casMenu.contains(t) && !dial.contains(t)) casMenu.classList.add("hidden");
  });
  updateDial();
  onThemeChange(updateDial); // a theme set elsewhere (onboarding) moves the dial too
}
