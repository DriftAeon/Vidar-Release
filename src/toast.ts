// The one transient-toast mechanism: a single element per surface, re-created when it is no
// longer attached to its host, holding `ms` after the last call and then fading (the `fading`
// class, styled in zoom-toast.css). Sessions (#zoom-toast, on body) and Flow (#flow-zoom-toast,
// in the canvas) each own one through createToast and expose it as a one-line wrapper.
export function createToast(opts: { id: string; host: () => HTMLElement }): (message: string, ms?: number) => void {
  let el: HTMLElement | null = null;
  let timer: number | undefined;
  return (message, ms = 500) => {
    const host = opts.host();
    if (!el || el.parentElement !== host) {
      el?.remove();
      el = document.createElement("div");
      el.id = opts.id;
      host.appendChild(el);
    }
    const cur = el;
    cur.textContent = message;
    cur.classList.remove("fading");
    window.clearTimeout(timer);
    timer = window.setTimeout(() => cur.classList.add("fading"), ms);
  };
}
