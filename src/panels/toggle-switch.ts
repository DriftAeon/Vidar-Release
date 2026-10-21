/* One bottom-bar switch over Rust's named switch registry (
   src-tauri/src/settings/switches.rs `read_switch(name)` / `set_switch(name, on)`).
   The file under bridge\ is the only truth: read on mount, written on every flip,
   and a failed write repaints the previous state. Owns the DOM (optional glyph,
   the `.switch` track with its checkbox and knob), the host's state class and
   title; each caller (closelock.ts, autospeak.ts) keeps
   its own side effects in `onChange` and on the returned handle. */
import { invoke } from "../ipc";

export interface SwitchOpts {
  /** Registry name in switches.rs: "close-lock" | "auto-speak" | "auto-send". */
  name: string;
  /** aria-label of the checkbox; lowercased, it also prefixes the console error. */
  label: string;
  /** Host title in each state. */
  titles: { on: string; off: string };
  /** Class toggled on the host while on; close-lock's CSS keys on "locked". */
  stateClass?: string;
  /** Prepended to the host before the track. */
  glyph?: Element;
  /** After a successful flip, with the value the file now holds. Not called on mount. */
  onChange?: (on: boolean) => void;
  /** Every paint: mount, successful flip, failed-write repaint. */
  onState?: (on: boolean) => void;
  /** Aborting it drops the change listener (panels/index.ts or capabilities/registry.ts dispose). */
  signal?: AbortSignal;
}

export interface SwitchHandle {
  /** Live painted state, not the value read at mount. */
  isOn(): boolean;
}

/** Builds the switch, then resolves once the persisted state is read and painted. */
export async function initSwitch(host: HTMLElement, opts: SwitchOpts): Promise<SwitchHandle> {
  const stateClass = opts.stateClass ?? "on";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("aria-label", opts.label);
  const track = document.createElement("span");
  track.className = "switch";
  track.append(input, Object.assign(document.createElement("span"), { className: "knob" }));
  if (opts.glyph) host.append(opts.glyph);
  host.append(track);

  const paint = (on: boolean) => {
    input.checked = on;
    host.classList.remove("error");
    host.classList.toggle(stateClass, on);
    host.title = on ? opts.titles.on : opts.titles.off;
    opts.onState?.(on);
  };

  let seq = 0; // the latest flip owns the paint; an older reply is dropped
  input.addEventListener("change", async () => {
    const want = input.checked;
    const mine = ++seq;
    paint(want); // the knob follows the click at once
    try {
      const got = await invoke("set_switch", { name: opts.name, on: want });
      if (mine !== seq) return;
      paint(got);
      opts.onChange?.(got);
    } catch (e) {
      console.error(`${opts.label.toLowerCase()}:`, e);
      if (mine !== seq) return;
      paint(!want); // the file is the truth; a failed write means no change
      host.classList.add("error");
      host.title = "Could not save; the switch is back where it was."; // copy-ok: full-sentence tooltip
    }
  }, { signal: opts.signal });

  let on = false;
  try {
    // `=== true`: the browser mock answers undefined, which reads as off.
    on = (await invoke("read_switch", { name: opts.name })) === true;
  } catch {
    /* browser mode: the mock has no answer, stay off */
  }
  paint(on);
  return { isOn: () => input.checked };
}
