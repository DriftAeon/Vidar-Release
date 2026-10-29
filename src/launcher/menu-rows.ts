// src\launcher\menu-rows.ts — stateless launcher row builders: vendor marks, the one-line and
// two-line rows, the permission-mode labels. Split from menu.ts; imports only icon assets.
import openaiIcon from "../assets/openai.png";
import claudeIcon from "../assets/claude.png";
import geminiIcon from "../assets/gemini.png";
import piIcon from "../assets/pi.png";
import terminalIcon from "../assets/terminal.png";
import localIcon from "../assets/local.png";

// Vendor marks for launcher entries, matched on the label. Keyed by agent name
// so a config-authored launcher picks the icon up without extra config. The
// tint makes a row scannable before the label is read: Claude's is sampled from
// its own art (#f28866, the blade colour); Codex and the plain shell get fixed
// vendor hues (blue, green) so all three read distinctly in every theme —
// tints are deliberately NOT theme accents, or a row would vanish into the
// matching CAS mode.
export interface VendorMark {
  match: RegExp;
  icon: string;
  tint?: string;
}

const LAUNCHER_ICONS: VendorMark[] = [
  { match: /\bcodex\b/i, icon: openaiIcon, tint: "var(--agent-codex)" },
  { match: /\bclaude\b/i, icon: claudeIcon, tint: "var(--agent-claude)" },
  // four-point sparkle drawn by Astra Code through the Display gate (tools/tab-art/gemini.svg)
  { match: /\bgemini\b/i, icon: geminiIcon, tint: "var(--agent-gemini)" },
  // PI_V1 from the user's CAS-Icons set, resized to 128 px; the same file also
  // backs the "Pi Playground" desktop shortcut via CAS-Icons\ico\PI_V1.ico.
  { match: /\bpi\b/i, icon: piIcon, tint: "var(--agent-pi)" },
  // Zero_V8 from the user's CAS-Icons set, resized to 128 px. No tint: it is the one polychrome mark, deliberately — the row that
  // opens a model running on this machine should not look like the vendor rows.
  { match: /\blocal\b/i, icon: localIcon },
  // Windows Terminal's own Square44x44 mark (copied from the appx Images dir)
  { match: /\b(powershell|pwsh|terminal)\b/i, icon: terminalIcon, tint: "var(--agent-shell)" },
];

// Gateway module marks (launcher/gateways.ts): art and tint come from the pack, matched on its id.
// The art arrives over async IPC after the type rows are first built, so setting the marks tells
// the listeners (menu.ts redraws the type rows), or the gateway rows stay without an icon.
let gatewayMarks: VendorMark[] = [];
const markListeners = new Set<() => void>();
export function gatewayMark(id: string, icon: string, tint?: string): VendorMark {
  return { match: new RegExp(`(?<![a-z0-9-])${id}(?![a-z0-9-])`, "i"), icon, tint };
}
export function setGatewayMarks(marks: VendorMark[]): void {
  gatewayMarks = marks;
  for (const fn of [...markListeners]) fn();
}
export function onGatewayMarksChange(fn: () => void): () => void {
  markListeners.add(fn);
  return () => { markListeners.delete(fn); };
}

export function markFor(hay: string): VendorMark | undefined {
  return LAUNCHER_ICONS.find((m) => m.match.test(hay)) ?? gatewayMarks.find((m) => m.match.test(hay));
}

// One menu row, with the vendor mark and tint when the text names a vendor.
export function menuRow(parent: HTMLElement, text: string, mark?: VendorMark): HTMLButtonElement {
  const b = document.createElement("button");
  if (mark) {
    b.className = "menu-icon-row";
    const ico = document.createElement("span");
    ico.className = "menu-icon";
    ico.style.setProperty("--menu-icon", `url("${mark.icon}")`);
    if (mark.tint) {
      b.dataset.vendor = "";
      b.style.setProperty("--vendor", mark.tint);
    }
    const label = document.createElement("span");
    label.textContent = text;
    b.append(ico, label);
  } else {
    b.textContent = text;
  }
  parent.appendChild(b);
  return b;
}

// A two-line row: label over a dim sub-line (the Active list's shape).
export function twoLineRow(parent: HTMLElement, label: string, sub: string, title?: string): HTMLButtonElement {
  const b = menuRow(parent, label);
  b.classList.add("launcher-session");
  const s = document.createElement("span");
  s.className = "launcher-sub-line";
  s.textContent = sub;
  b.appendChild(s);
  if (title) b.title = title;
  return b;
}

export const MODE_LABEL: Record<string, string> = { default: "Default", acceptEdits: "Accept Edits", plan: "Plan", auto: "Auto" };
