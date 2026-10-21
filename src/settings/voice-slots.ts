// The Voice Slots page (voice slots V6): opens as its own page tab in the session strip, like
// Dependencies. This file mounts it into any root (each mount queries on its own and stops painting
// on dispose), opens the tab and keeps one Settings › Audio row that opens it. The DOM is
// voice-slots-view.ts; the data is `voice_slots_status`, and Trust Current is `voice_slots_trust`.
import "../styles/voice-slots.css";
import { copyText } from "../clipboard";
import { iconImg } from "../icon-img";
import { lucide } from "../icons";
import { invoke } from "../ipc";
import type { VoiceSlot, VoiceSlotStatus } from "../ipc-voice";
import { asideForPage, backOnPageClose } from "../onboarding/aside";
import { renderVoiceSlots } from "./voice-slots-view";
import { closeShortcutsModal } from "./modal";
import { addSettingRow } from "./registry";
import { registerVoiceRewriteRow } from "./voice-rewrite";

const PAGE_ID = "voice-slots";

export function mountVoiceSlots(root: HTMLElement): () => void {
  const page = root.ownerDocument.createElement("div");
  page.className = "vs-page";
  root.appendChild(page);
  let rows: VoiceSlotStatus[] | null = null;
  let error: string | null = null;
  let busy = false;
  // A load asked for while one runs: that query may have hashed before a re-pin, so one more
  // runs after it instead of the ask being dropped.
  let reloadQueued = false;
  let confirming: VoiceSlot | null = null;
  let trusting: VoiceSlot | null = null;
  let actionError = "";
  let disposed = false;

  const setError = (msg: string): void => {
    actionError = msg;
    paint();
  };

  function load(): void {
    if (busy) {
      reloadQueued = true;
      return;
    }
    busy = true;
    paint();
    invoke("voice_slots_status").then(
      (r) => { rows = r; error = null; },
      (e) => { error = String(e); },
    ).finally(() => {
      busy = false;
      if (reloadQueued && !disposed) {
        reloadQueued = false;
        load();
      } else paint();
    });
  }

  function paint(): void {
    if (disposed) return;
    renderVoiceSlots(page, rows, error, busy, {
      redetect: () => {
        actionError = "";
        load();
      },
      askTrust: (slot) => {
        confirming = slot;
        paint();
      },
      cancelTrust: () => {
        confirming = null;
        paint();
      },
      trust: (slot) => {
        if (trusting || busy) return;
        trusting = slot;
        actionError = "";
        paint();
        invoke("voice_slots_trust", { slot }).then(
          () => { trusting = null; confirming = null; load(); },
          (e) => { trusting = null; setError(`Trust Failed: ${String(e)}`); },
        );
      },
      copy: (text) => {
        void copyText(text).then((ok) => setError(ok ? "" : "Copy Failed: Clipboard Refused"));
      },
    }, { confirming, trusting }, { icon: lucide, color: iconImg });
    if (actionError) {
      const line = page.ownerDocument.createElement("div");
      line.className = "vs-error";
      line.textContent = actionError;
      page.insertBefore(line, page.children[1] ?? null);
    }
  }

  load();
  return () => {
    disposed = true;
    page.remove();
  };
}

/** Opens the Voice Slots page tab, or activates it when it is already open; resolves its tab id.
 *  sessions is imported lazily so the settings bundle and tests never load xterm eagerly. */
export async function openVoiceSlotsTab(): Promise<string> {
  const { openPageTab } = await import("../panels/sessions");
  const id = await openPageTab({ id: PAGE_ID, title: "Voice Slots", mount: backOnPageClose(mountVoiceSlots) });
  asideForPage(); // onboarding overlay up: it steps aside until this tab closes
  return id;
}

let registered = false;

/** One Settings › Audio row whose button opens the page tab. */
export function registerVoiceSlotRows(): void {
  if (registered) return;
  registered = true;
  registerVoiceRewriteRow();
  addSettingRow({
    name: "Voice Slots",
    tip: "Which adapter and model fill speech to text, wake word, rewrite and text to speech, and how to fill a missing one.",
    category: "audio",
    keywords: () => "stt wake rewrite tts whisper kokoro adapter model pin trust",
    control: () => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ws-btn vs-open-page";
      b.textContent = "Open Voice Slots";
      b.addEventListener("click", () => {
        // Close first: the modal's close refocuses the previously active tab.
        closeShortcutsModal();
        openVoiceSlotsTab().catch((e) => console.error("Can't Open Voice Slots:", e));
      });
      return b;
    },
  });
}
