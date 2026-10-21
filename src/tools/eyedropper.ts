// Eyedropper: one visible screen pixel, with supplementary CSS values for shell UI.
// Native polling works across opaque iframe, canvas and image boundaries.
import { disarmTool, type Tool } from "../panels/toolbench";
import { copyText } from "../clipboard";
import { invoke } from "../ipc";
import pickerIcon from "../assets/picker.png";
import { chooseReadout, cssReadout, hex, matchingToken, tokenMap } from "./eyedropper-readout";
import { frameShields, sampleLoop } from "./eyedropper-sampling";

const SUPPRESSED = ["click", "mousedown", "contextmenu", "dblclick", "auxclick"] as const;
const HISTORY_MAX = 6;

export function eyedropperTool(): Tool {
  let armed = false;
  let disposed = false;
  let generation = 0;
  let history: string[] = [];
  let current = chooseReadout(null, null);
  let tokens: ReadonlyMap<string, string> = new Map();
  let noteEl: HTMLElement;
  let histEl: HTMLElement;
  let notice = "";
  let noticeUntil = 0;
  const rows: { row: HTMLElement; swatch: HTMLElement; value: HTMLButtonElement }[] = [];
  const shields = frameShields();
  const loop = sampleLoop(
    (point) => {
      shields.update();
      return invoke("colour_sample", {
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, ...point,
      });
    },
    (sample, pick, error) => {
      const el = sample ? shields.elementAt(sample.clientX, sample.clientY) : null;
      current = chooseReadout(sample?.rgb ?? null, cssReadout(el));
      paint();
      if (pick && !current.picked && !error) {
        notice = "Nothing to Sample Here";
        noticeUntil = Date.now() + 900;
      }
      noteEl.textContent = error ? "Pixel Sampling Failed. Retrying."
        : Date.now() < noticeUntil ? notice : "";
      if (pick && current.picked) {
        const value = hex(current.picked);
        pushHistory(value);
        void copy(value);
      }
    },
  );

  function paint() {
    const values = [current.pixel, current.bg, current.fg];
    rows.forEach(({ row, swatch, value }, i) => {
      const rgb = values[i];
      row.classList.toggle("hidden", !rgb);
      if (!rgb) return;
      const h = hex(rgb);
      swatch.style.background = h;
      value.textContent = h;
      const token = i ? matchingToken(rgb, tokens) : null;
      value.title = "rgb(" + rgb.join(", ") + ")" + (token ? " · Matching CSS Token: " + token : ""); // copy-ok: CSS RGB function notation
      const label = row.querySelector<HTMLElement>(".eyedrop-label")!;
      label.textContent = i === 0 ? "Pixel" : i === 1 ? "CSS Bg" : "CSS Fg";
      if (token) label.textContent += " · " + token;
    });
  }

  async function copy(text: string) {
    if (disposed) return;
    const gen = generation;
    const ok = await copyText(text);
    if (!armed || disposed || gen !== generation) return;
    notice = ok ? "Copied" : "Copy Failed";
    noticeUntil = Date.now() + 900;
    noteEl.textContent = notice;
  }

  function pushHistory(h: string) {
    history = [h, ...history.filter((x) => x !== h)].slice(0, HISTORY_MAX);
    histEl.replaceChildren();
    for (const c of history) {
      const button = document.createElement("button");
      button.className = "eyedrop-hist";
      button.style.background = c;
      button.title = c + " (click to copy)";
      button.setAttribute("aria-label", "Copy " + c);
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        void copy(c);
      });
      histEl.appendChild(button);
    }
  }

  function onSuppressed(e: MouseEvent) {
    if ((e.target as Element).closest?.("#rightbar, #toolbench, #tool-options")) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "contextmenu") {
      disarmTool();
      return;
    }
    if (e.type === "click") loop.pick({ clientX: e.clientX, clientY: e.clientY });
  }

  // While sampling, Esc belongs to the picker: toolbench's own Escape skips terminals and text
  // fields, which is where focus usually sits mid-sample, so the button stayed pressed.
  function onEscape(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    disarmTool();
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    generation++;
    loop.stop();
    shields.clear();
    document.body.classList.remove("eyedrop-mode");
    for (const t of SUPPRESSED) document.removeEventListener(t, onSuppressed, true);
    window.removeEventListener("keydown", onEscape, true);
    current = chooseReadout(null, null);
    paint();
    noteEl.textContent = "";
  }

  return {
    id: "eyedropper",
    glyph: "⟐",
    icon: pickerIcon,
    label: "Picker — sample a colour anywhere in the shell",
    canvas: "none",
    create: eyedropperTool,

    mount(host: HTMLElement) {
      host.innerHTML = `
        <div class="eyedrop-readout"></div>
        <p class="dim sub" id="ed-note" role="status"></p>
        <div class="eyedrop-hist-row" id="ed-hist"></div>`;
      const readout = host.querySelector<HTMLElement>(".eyedrop-readout")!;
      rows.length = 0;
      for (let i = 0; i < 3; i++) {
        const row = document.createElement("div");
        row.className = "eyedrop-row hidden";
        row.innerHTML = `<span class="eyedrop-swatch"></span>
          <span class="eyedrop-label"></span><button class="eyedrop-hex">—</button>`;
        const value = row.querySelector<HTMLButtonElement>("button")!;
        value.addEventListener("click", () => {
          const rgb = [current.pixel, current.bg, current.fg][i];
          if (rgb) void copy(hex(rgb));
        });
        rows.push({ row, value, swatch: row.querySelector<HTMLElement>(".eyedrop-swatch")! });
        readout.appendChild(row);
      }
      noteEl = host.querySelector<HTMLElement>("#ed-note")!;
      histEl = host.querySelector<HTMLElement>("#ed-hist")!;
    },

    arm() {
      if (armed || disposed) return;
      armed = true;
      generation++;
      noticeUntil = 0;
      tokens = tokenMap(getComputedStyle(document.documentElement));
      current = chooseReadout(null, null);
      paint();
      noteEl.textContent = "Sampling…";
      document.body.classList.add("eyedrop-mode");
      for (const t of SUPPRESSED) document.addEventListener(t, onSuppressed, true);
      window.addEventListener("keydown", onEscape, true);
      loop.start();
    },

    disarm,

    dispose() {
      if (disposed) return;
      disarm();
      disposed = true;
      generation++;
      loop.stop();
      shields.clear();
      for (const t of SUPPRESSED) document.removeEventListener(t, onSuppressed, true);
    },
  };
}
