// Text handed to a terminal tab: control, format and line-separator characters out, then a byte cap on a
// code-point boundary. Same strip and cap as jira/model.ts sendText (copied, not imported).

const STRIP = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const encoder = new TextEncoder();

export function cleanSend(text: string, maxBytes: number): string {
  const clean = text.replace(STRIP, "");
  if (encoder.encode(clean).length <= maxBytes) return clean;
  let result = "";
  let bytes = 0;
  for (const codePoint of clean) {
    const next = encoder.encode(codePoint).length;
    if (bytes + next > maxBytes) break;
    result += codePoint;
    bytes += next;
  }
  return result;
}
