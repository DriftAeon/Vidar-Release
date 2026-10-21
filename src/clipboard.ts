/* One copy path for the whole app. navigator.clipboard is unproven in this WebView2
   shell — it can reject on a permission or focus state the page never sees — so every
   caller needs the same legacy rescue. tools/eyedropper.ts and tools/marquee.ts already
   call through here; panels/inspect.ts and panels/workbench.ts still carry their own
   copies of it, and should move here when they are next touched. */

/** true if the text reached the clipboard, by either route. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
