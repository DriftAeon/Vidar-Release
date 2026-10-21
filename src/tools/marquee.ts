// Marquee: drag a rectangle over anything on screen, get its text.
//
// Windows "Text Extractor" shape: the target is an asset name in Unreal, a
// label in a screenshot, an error in a dialog — not the terminal, which already
// has drag-select + Ctrl+C. Arming opens a transparent overlay across the whole
// virtual screen (ocr.rs); the drag is captured with GDI and read by the OCR
// engine built into Windows. The text lands in an editable box here.

import { invoke } from "../ipc";
import { listen } from "../ipc";
import { revealWorkbench } from "../panels/workbench";
import { addTextBlock } from "../panels/workbench-tray";
import { copyText } from "../clipboard";
import { iconImg } from "../icon-img";
import { disarmTool, type Tool } from "../panels/toolbench";

interface OcrOutcome {
  text: string;
  width: number;
  height: number;
  debugCrop?: string;
}
interface OcrError {
  message: string;
  debugCrop?: string;
}

export function marqueeTool(): Tool {
  let armed = false;
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  let statEl: HTMLElement;
  let textEl: HTMLTextAreaElement;
  let againBtn: HTMLButtonElement;
  let copyBtn: HTMLButtonElement;
  let resultEl: HTMLElement;
  let pathEl: HTMLElement;
  let reveal: ((visible: boolean) => void) | undefined;

  function show(msg: string, err = false, copied = false) {
    resultEl.textContent = msg;
    resultEl.classList.toggle("tool-err", err);
    resultEl.classList.toggle("mq-copied", copied);
  }

  /** VIDAR_OCR_DEBUG's saved crop, on its own line under the message; empty hides it. */
  function showPath(path?: string) {
    pathEl.textContent = path ? `Capture: ${path}` : "";
    pathEl.hidden = !path;
  }

  function setStat(msg: string, idle: boolean) {
    statEl.textContent = msg;
    statEl.classList.toggle("tool-readout-idle", idle);
  }

  function refreshButtons() {
    const has = textEl.value.trim().length > 0;
    copyBtn.disabled = !has;
  }

  function begin() {
    if (disposed) return;
    // the panel would sit inside the screen region the capture reads (and over what the user wants to grab)
    reveal?.(false);
    setStat("Drag a Rectangle…", true);
    show("");
    showPath();
    invoke("ocr_begin").catch((e) => { if (!disposed) { reveal?.(true); show(String(e), true); } });
  }

  async function copy(text: string) {
    const ok = await copyText(text);
    if (disposed) return;
    show(ok ? "Copied ✓" : "Copy Failed", !ok, ok);
  }

  return {
    id: "marquee",
    glyph: "▣",
    icon: "/icons/color/marquee.svg",
    label: "Marquee — read text from any region of the screen",
    // acts on the screen, not a Vidar surface
    canvas: "none",
    revealOnArm: false,
    create: marqueeTool,

    mount(host: HTMLElement, revealHost?: (visible: boolean) => void) {
      reveal = revealHost;
      host.innerHTML = `
        <p class="tool-readout" id="mq-stat">—</p>
        <textarea class="tool-text" id="mq-text" spellcheck="false"
          placeholder="Recognised Text"></textarea>
        <button class="tool-send icon-btn" id="mq-copy" aria-label="Copy Text" title="Copy Text"></button>
        <button class="tool-send" id="mq-tray">To Tray</button>
        <button class="tool-send subtle" id="mq-again">Marquee Again</button>
        <p class="dim sub" id="mq-result"></p>
        <p class="dim sub" id="mq-path" hidden></p>`;

      statEl = host.querySelector<HTMLElement>("#mq-stat")!;
      textEl = host.querySelector<HTMLTextAreaElement>("#mq-text")!;
      againBtn = host.querySelector<HTMLButtonElement>("#mq-again")!;
      copyBtn = host.querySelector<HTMLButtonElement>("#mq-copy")!;
      copyBtn.appendChild(iconImg("copy"));
      resultEl = host.querySelector<HTMLElement>("#mq-result")!;
      pathEl = host.querySelector<HTMLElement>("#mq-path")!;
      refreshButtons();

      textEl.addEventListener("input", refreshButtons);
      againBtn.addEventListener("click", begin);

      copyBtn.addEventListener("click", () => void copy(textEl.value));

      host.querySelector<HTMLButtonElement>("#mq-tray")!.addEventListener("click", () => {
        if (!textEl.value.trim()) return show("Nothing to Add", true);
        const r = addTextBlock(textEl.value, "marquee");
        if (!r.ok) return show(r.reason, true);
        revealWorkbench(); // no focus move, no destination change
      });

      void listen<OcrOutcome>("ocr-result", (e) => {
        if (disposed) return;
        if (armed) reveal?.(true);
        const { text, width, height, debugCrop } = e.payload;
        textEl.value = text;
        refreshButtons();
        const lines = text ? text.split("\n").length : 0;
        setStat(
          text
            ? `${lines} Line${lines === 1 ? "" : "s"} · ${text.length.toLocaleString()} Chars · ${width}×${height}px`
            : `No Text Found in ${width}×${height}px`,
          !text,
        );
        show("");
        showPath(debugCrop);
        if (text) textEl.focus();
      }).then((off) => { if (disposed) off(); else unlisteners.push(off); });
      void listen<OcrError>("ocr-error", (e) => {
        if (disposed) return;
        if (armed) reveal?.(true);
        setStat("—", true);
        show(e.payload.message, true);
        showPath(e.payload.debugCrop);
      }).then((off) => { if (disposed) off(); else unlisteners.push(off); });
      // A drag under 4 px closes the overlay (ocr.rs) but keeps the tool armed for Marquee Again
      void listen("ocr-empty", () => {
        if (disposed || !armed) return;
        reveal?.(true);
        setStat("—", true);
      }).then((off) => { if (disposed) off(); else unlisteners.push(off); });
      // Esc or right-click on the overlay (its own window, so toolbench never sees the key) ends the
      // tool; so does the overlay losing focus (overlay.ts blur), which shares the ocr_cancel command
      void listen("ocr-cancel", () => {
        if (disposed) return;
        if (armed) disarmTool();
      }).then((off) => { if (disposed) off(); else unlisteners.push(off); });
    },

    arm() {
      if (disposed) return;
      armed = true;
      begin();
    },

    disarm() {
      if (!armed) return;
      armed = false;
      // closes the overlay if it's still up; harmless otherwise
      void invoke("ocr_cancel", {});
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (armed) {
        armed = false;
        void invoke("ocr_cancel", {});
      }
      for (const off of unlisteners.splice(0)) off();
    },
  };
}
