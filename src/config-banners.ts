import { lucide } from "./icons";

/** Text each banner id was dismissed with, for the page's life. The same text stays dismissed;
 *  a different one shows the banner again. */
const dismissed = new Map<string, string>();

/** Sets the text of one banner (#config-error, #config-notice, #prefs-error), creating it on
 *  first use inside the shared bottom-right #config-banners stack so two banners never overlap.
 *  Setting it again replaces the text in place and keeps the close button; the page never holds
 *  two banners with one id. */
export function setBanner(id: string, text: string): void {
  if (!text) return;
  if (dismissed.get(id) === text) return;
  dismissed.delete(id);
  let stack = document.getElementById("config-banners");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "config-banners";
    document.body.appendChild(stack);
  }
  let banner = document.getElementById(id);
  let span: HTMLElement | null = null;
  if (!banner) {
    banner = document.createElement("div");
    banner.id = id;
    span = document.createElement("span");
    span.className = "banner-text";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cx-ico banner-close";
    close.title = "Dismiss";
    close.setAttribute("aria-label", "Dismiss");
    close.append(lucide("x"));
    close.addEventListener("click", () => {
      dismissed.set(id, banner!.querySelector(".banner-text")?.textContent ?? "");
      banner!.remove();
    });
    banner.append(span, close);
    stack.appendChild(banner);
  } else {
    span = banner.querySelector(".banner-text");
  }
  if (span) span.textContent = text;
}

/** Removes one banner (the condition behind it no longer holds). */
export function clearBanner(id: string): void {
  document.getElementById(id)?.remove();
}
