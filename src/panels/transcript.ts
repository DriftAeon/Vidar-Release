// src\panels\transcript.ts — `ctl.read`'s tail extraction. Leaf module: reads
// the caller's own rendered tab's live DOM transcript, no store of its own
// (`read` design section).

import { sessionContainer } from "./sessions";

/** Last `maxBytes` UTF-8 bytes of `tabId`'s `.rendered-transcript` text
 *  (`rendered.ts:468`), decode-safe — the cut never splits a code point.
 *  `null` if the tab has no container or no transcript element. */
export function transcriptTail(tabId: string, maxBytes: number): string | null {
  const container = sessionContainer(tabId);
  if (!container) return null;
  const el = container.querySelector(".rendered-transcript");
  if (!el) return null;
  const text = el.textContent ?? "";
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.slice(start));
}
