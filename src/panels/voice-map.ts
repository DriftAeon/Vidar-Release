/* Voice map: RMB on the mic button, the speaker button or the auto-speak
   switch opens this popover — the mic-to-speakers pipeline as pills, coloured from
   signals that already exist (listen-state event, lmstudio_status, speak_status,
   voice_slots_status_one for the rewrite slot, read once per open, and the speak button's
   SpeakApi.state()). Diagnostic only: no new events, no
   persistence. Left click on the three controls
   is unchanged; the two RMB "off" actions move in here as red buttons, which call the off() of
   the "listen" and "speak" capabilities through use(), so this module never touches
   listen.ts/speak.ts internals and never holds a stale object after a remount. Pills read
   green ("Ready") by default once configured; orange/red are reserved for busy/error, not for
   "nothing is mid-utterance right now"; grey is a stage that is switched off or unconfigured.
   Tooltips and buttons are Title Case, the rest of the bar's convention — the exception is a
   literal command or config value (`claude -p`, the rewrite backend), which is quoted as written. */
import { invoke, listen as ipcListen } from "../ipc";
import type { LmStatus } from "./lmstudio";
import type { VoiceSlotStatus } from "../ipc-voice";
import type { ListenApi } from "./listen";
import type { SpeakApi, SpeakState } from "./speak";
import { use } from "../capabilities/registry";
import { centerOn } from "../modules/place-menu";
import { openPopover, type ClosePopover } from "../modules/popover";
import { iconImg, type ColorIcon } from "../icon-img";

type Tint = "green" | "orange" | "red" | "grey";

/** Read per paint through the capability registry; null while that capability is off. */
const listenApi = () => use<ListenApi>("listen");
const speakApi = () => use<SpeakApi>("speak");
/** The speak button's state; null while speak is off, which the Reply/Speakers pills and
 *  Speak Off already handle. */
const speakState = () => speakApi()?.state() ?? null;

interface ListenStatePayload { state: string; error?: string }

let root: HTMLDivElement | null = null;
let inputPills: HTMLElement[] = [];
let replyPill: HTMLElement;
let rewritePill: HTMLElement;
let kokoroPill: HTMLElement;
let speakersPill: HTMLElement;
let listenOffBtn: HTMLButtonElement;
let speakOffBtn: HTMLButtonElement;
let cfgStrip: HTMLElement;
let unlistenState: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Mic and Speakers are icon-only cards: the icon file by label, the state in the tooltip as `<label> — <state>`. */
const ICON_CARDS: Record<string, ColorIcon> = { Mic: "mic", Speakers: "speaker-on" };

function paint(el: HTMLElement, tint: Tint, title: string) {
  const lead = el.dataset.icon;
  el.className = `vm-pill vm-${tint}${lead ? " vm-icon" : ""}`;
  el.title = lead ? `${lead} — ${title}` : title;
}

function row(labels: string[]): HTMLElement[] {
  const pills: HTMLElement[] = [];
  labels.forEach((label, i) => {
    if (i > 0) root!.lastElementChild!.append(Object.assign(document.createElement("div"), { className: "vm-arrow" }));
    const p = document.createElement("span");
    const icon = ICON_CARDS[label];
    if (icon) { p.dataset.icon = label; p.append(iconImg(icon)); } else p.textContent = label;
    paint(p, "grey", icon ? "Unknown" : label);
    pills.push(p);
    root!.lastElementChild!.append(p);
  });
  return pills;
}

function paintInput(state: string | null, error?: string) {
  if (!listenApi()) { inputPills.forEach((p) => paint(p, "grey", "Not Configured")); return; }
  if (error) { inputPills.forEach((p) => paint(p, "red", error)); return; }
  // Listen off drops the capture stream and kills the sidecar (listen.rs::listen_stop), so no
  // sample reaches any of these stages. Without this arm "off" fell through to the green "Ready"
  // default below and drew a live pipeline while the mic glyph was crossed out.
  if (!state || state === "off") { inputPills.forEach((p) => paint(p, "grey", "Listen Off")); return; }
  if (state === "busy") { inputPills.forEach((p) => paint(p, "orange", "Busy — Finishing the Last Utterance")); return; }
  const active = state === "listening" ? 1
    : state === "heard" || state === "recording" ? 2
    : state === "transcribing" ? 3
    : state === "delivering" ? 4
    : -1;
  const activeLabel = state === "listening" ? "Listening"
    : state === "heard" ? "Heard"
    : state === "recording" ? "Recording"
    : state === "transcribing" ? "Transcribing"
    : state === "delivering" ? "Delivering"
    : null;
  inputPills.forEach((p, i) => paint(p, "green", i === active && activeLabel ? activeLabel : "Ready"));
}

const isBusy = (s: SpeakState) => s === "arming" || s === "speaking";

function paintReply() {
  const s = speakState?.();
  if (!s) { paint(replyPill, "grey", "Unknown"); return; }
  if (s.error !== null) { paint(replyPill, "red", s.error || "Error"); return; }
  if (s.state === "off") { paint(replyPill, "grey", "Auto-Speak Off"); return; }
  if (isBusy(s.state)) { paint(replyPill, "orange", "Speaking"); return; }
  paint(replyPill, "green", "Ready");
}

/** The rewrite slot's row, read once per open: undefined until it
 *  arrives, null when the read failed. No backend is assumed. */
let rewriteRow: VoiceSlotStatus | null | undefined;

const OPENAI_COMPAT = "voice-stock/openai-compat";

function paintRewrite(lm: LmStatus | null) {
  const r = rewriteRow;
  if (r === undefined) { paint(rewritePill, "grey", "Rewrite"); return; }
  if (r === null) { paint(rewritePill, "red", "Can't Read Voice Slots"); return; }
  if (r.state === "empty") { paint(rewritePill, "grey", "Verbatim (Rewrite Slot Empty)"); return; }
  if (r.state !== "filled") { paint(rewritePill, "red", r.reason || (r.state === "missing" ? "Missing" : "Broken")); return; }
  // An adapter's label is quoted as written (`claude -p` stays lowercase: it is the command).
  if (r.adapter !== OPENAI_COMPAT) { paint(rewritePill, "green", r.label || r.adapter || "Filled"); return; }
  if (!lm || lm.state !== "up") { paint(rewritePill, "red", lm?.detail || lm?.state || "Down"); return; }
  // The slot's model id is what the server serves, passed verbatim (openai-compat modelIds).
  const loaded = !!r.model && lm.models?.some((m) => m.id === r.model && m.state === "loaded");
  paint(rewritePill, loaded ? "green" : "orange", loaded ? "Model Loaded" : "Server Up, No Model Loaded");
}

function paintSpeakers() {
  const s = speakState?.();
  if (!s) return;
  if (s.error !== null) paint(speakersPill, "red", "Error");
  else if (s.state === "off") paint(speakersPill, "grey", "Off");
  else if (isBusy(s.state)) paint(speakersPill, "orange", "Arming / Speaking");
  else paint(speakersPill, "green", "Armed");
}

async function poll() {
  try {
    const lm = await invoke("lmstudio_status");
    paintRewrite(lm);
  } catch { paintRewrite(null); }
  try {
    const s = await invoke("speak_status");
    paint(kokoroPill, s?.sidecar ? "green" : "grey", s?.sidecar ? "Warm" : "Off");
  } catch { paint(kokoroPill, "grey", "Unknown"); }
  paintSpeakers();
  paintReply();
  const listenState = root!.dataset.listenState;
  listenOffBtn.disabled = !listenApi() || !listenState || listenState === "off";
  const sb = speakState();
  speakOffBtn.disabled = !sb || sb.state === "off" || isBusy(sb.state);
}

function buildConfigStrip() {
  cfgStrip.replaceChildren();
  const add = (k: string, v: string | undefined) => {
    if (!v) return;
    const r = document.createElement("div");
    r.className = "vm-cfg-row";
    r.append(Object.assign(document.createElement("span"), { textContent: k }),
      Object.assign(document.createElement("span"), { textContent: v }));
    cfgStrip.append(r);
  };
  const listen = listenApi();
  add("Wake Model", listen?.wakeword.model);
  add("Whisper Model", listen?.voice?.model);
  const r = rewriteRow;
  add("Rewrite", r ? (r.state === "empty" ? "Empty (Verbatim)" : r.adapter ?? undefined) : undefined);
}

function build() {
  root = document.createElement("div");
  root.id = "voice-map";
  root.className = "hidden";
  const input = document.createElement("div"); input.className = "vm-row";
  const output = document.createElement("div"); output.className = "vm-row";
  root.append(input);
  inputPills = row(["Mic", "Wake", "VAD", "Whisper", "Deliver"]);
  root.append(output);
  const [reply, rewrite, kokoro, speakers] = row(["Reply", "Rewrite", "Kokoro", "Speakers"]);
  replyPill = reply; rewritePill = rewrite; kokoroPill = kokoro; speakersPill = speakers;

  const actionsRow = document.createElement("div"); actionsRow.className = "vm-actions";
  listenOffBtn = document.createElement("button"); listenOffBtn.className = "vm-off"; listenOffBtn.textContent = "Listen Off";
  listenOffBtn.addEventListener("click", () => { listenApi()?.off(); close(); });
  speakOffBtn = document.createElement("button"); speakOffBtn.className = "vm-off"; speakOffBtn.textContent = "Speak Off";
  speakOffBtn.addEventListener("click", () => { speakApi()?.off(); close(); });
  actionsRow.append(listenOffBtn, speakOffBtn);
  root.append(actionsRow);

  cfgStrip = document.createElement("div"); cfgStrip.className = "vm-config";
  root.append(cfgStrip);

  document.body.append(root);
}

// Outside close and Escape are popover.ts's (capture-phase mousedown). No `anchor`: the map opens on
// contextmenu, after its own mousedown, and a left click on the mic/speaker/switch must still close it.
let closeMap: ClosePopover | null = null;

function teardown() {
  if (timer) { clearInterval(timer); timer = null; }
  if (unlistenState) { unlistenState(); unlistenState = null; }
}

function close() {
  if (closeMap) closeMap(); // hides, then onClose runs teardown
  else teardown();
}

export function openVoiceMap(anchor: HTMLElement): void {
  if (!root) build();
  close(); // a second RMB while open re-anchors; without this the old listener and timer would leak
  const closeThis = openPopover({
    el: root!, persistent: true, keys: "document",
    onClose: () => { if (closeMap === closeThis) closeMap = null; teardown(); },
  });
  closeMap = closeThis;
  rewriteRow = undefined;
  void invoke("voice_slots_status_one", { slot: "rewrite" })
    .then((row) => { rewriteRow = row; })
    .catch(() => { rewriteRow = null; })
    .finally(() => { if (!root!.classList.contains("hidden")) { buildConfigStrip(); void poll(); } });
  buildConfigStrip();
  // shown by openPopover above, so offsetWidth measures the popup; bottom-anchored here, not
  // through `place`, so a strip that fills in later grows the popup upward
  const r = anchor.getBoundingClientRect();
  root!.style.left = `${centerOn(r.left + r.width / 2, root!.offsetWidth, window.innerWidth)}px`;
  root!.style.bottom = `${window.innerHeight - r.top + 8}px`;
  paintInput(null);
  void invoke("listen_status").then((s) => { root!.dataset.listenState = s; paintInput(s); }).catch(() => paintInput(null));
  void ipcListen<ListenStatePayload>("listen-state", (e) => {
    root!.dataset.listenState = e.payload.state;
    paintInput(e.payload.state, e.payload.error);
  }).then((fn) => {
    // closed (or reopened) before the subscription resolved: drop it now, not never
    if (root!.classList.contains("hidden") || unlistenState) fn(); else unlistenState = fn;
  });
  void poll();
  timer = setInterval(() => void poll(), 2000);
}
