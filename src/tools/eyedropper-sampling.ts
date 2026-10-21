// Serialized native polling continues across opaque iframes, where DOM moves stop.
export type Point = { clientX: number; clientY: number };
export type PixelSample = Point & { rgb: [number, number, number] };
const INTERVAL_MS = 75;

export function sampleLoop(
  sample: (point?: Point) => Promise<PixelSample | null>,
  receive: (value: PixelSample | null, pick: boolean, error?: unknown) => void,
) {
  let active = false;
  let generation = 0;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pick: Point | undefined;

  async function run() {
    if (!active || busy) return;
    busy = true;
    const gen = generation;
    const point = pick;
    pick = undefined;
    try {
      const value = await sample(point);
      if (active && gen === generation) receive(value, !!point);
    } catch (error) {
      if (active && gen === generation) receive(null, !!point, error);
    } finally {
      busy = false;
      if (active) timer = setTimeout(run, INTERVAL_MS);
    }
  }

  return {
    start() {
      active = true;
      generation++;
      void run();
    },
    stop() {
      active = false;
      generation++;
      pick = undefined;
      clearTimeout(timer);
    },
    pick(point: Point) {
      if (!active) return;
      pick = point; // Coalesce clicks while one native request is in flight.
      if (!busy) {
        clearTimeout(timer);
        void run();
      }
    },
  };
}

// The frame's rect cut to every clipping (scrolling) ancestor, so a shield never covers
// shell UI around a frame scrolled partly out of its container. Empty when fully clipped.
const styleOf = (el: Element) => el.ownerDocument.defaultView!.getComputedStyle(el);

function clippedRect(frame: HTMLElement) {
  const r = frame.getBoundingClientRect();
  let { left, top } = r;
  let right = r.left + r.width, bottom = r.top + r.height;
  for (let el = frame.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const { overflowX, overflowY } = styleOf(el);
    if (overflowX === "visible" && overflowY === "visible") continue;
    const c = el.getBoundingClientRect();
    left = Math.max(left, c.left); top = Math.max(top, c.top);
    right = Math.min(right, c.left + c.width); bottom = Math.min(bottom, c.top + c.height);
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// Transparent DOM shields keep iframe clicks in the shell while armed. They do not
// paint pixels, and are removed before hit testing so the iframe is still classified.
export function frameShields() {
  const shields = new Map<HTMLIFrameElement, HTMLElement>();
  return {
    update() {
      for (const [frame, shield] of shields) {
        if (!frame.isConnected) { shield.remove(); shields.delete(frame); }
      }
      for (const frame of document.querySelectorAll("iframe")) {
        const rect = clippedRect(frame);
        let shield = shields.get(frame);
        if (!shield) {
          shield = document.createElement("div");
          shield.className = "eyedrop-capture";
          document.body.appendChild(shield);
          shields.set(frame, shield);
        }
        Object.assign(shield.style, {
          left: `${rect.left}px`, top: `${rect.top}px`,
          width: `${rect.width}px`, height: `${rect.height}px`,
          display: rect.width && rect.height && frame.getClientRects().length
            && styleOf(frame).visibility !== "hidden" ? "block" : "none",
        });
      }
    },
    elementAt(x: number, y: number) {
      for (const shield of shields.values()) shield.style.pointerEvents = "none";
      const el = document.elementFromPoint(x, y);
      for (const shield of shields.values()) shield.style.pointerEvents = "";
      return el;
    },
    clear() {
      for (const shield of shields.values()) shield.remove();
      shields.clear();
    },
  };
}
