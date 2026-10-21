/* Auto-send: a bottom-bar switch right of the mic (#mic-group, index.html), built like
   auto-speak (panels/autospeak.ts) over the same named switch registry. On means a HOLD/TOGGLE
   dictation transcript is submitted after it is typed (voice.ts stop() reads the switch);
   it replaces the activation word for those two modes. Wake-word Listen keeps its own
   wakeword.autoSubmit. The file bridge\auto-send.json is the only truth. Mounted by the
   listen capability (capabilities/mounts/listen.ts), which shows it while the mic is on. */
import { initSwitch } from "./toggle-switch";
import { iconImg } from "../icon-img";

export async function initAutoSend(host: HTMLElement, signal?: AbortSignal) {
  const glyph = iconImg("send");
  glyph.classList.add("auto-send-icon");
  return initSwitch(host, {
    name: "auto-send",
    label: "Auto-Send",
    titles: { on: "Auto-Send Dictation", off: "Auto-Send Off" },
    glyph,
    signal,
  });
}
