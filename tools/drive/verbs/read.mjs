// Rendered transcript markup: rendered.ts creates the transcript; sessions.ts
// marks the focused pane; user-block/text-stream/tool-pills create role rows.
export function readLines(doc, limit = 40) {
  const pane = doc.querySelector(".term-container.focused.rendered-host");
  const transcript = pane?.querySelector(".rendered-transcript");
  if (!transcript) return { error: "read: no active Rendered tab" };
  const tab = doc.querySelector(".session-btn.focused")?.dataset.id ?? pane.dataset.title ?? "";
  const lines = [];
  const rows = transcript.querySelectorAll(".blk-user, .blk-text, .blk-tool");
  for (const row of rows) {
    // Top-level conversation and tool rows only; nested output is disclosed in
    // a tool pill, and should not be counted again as a message.
    if (row.closest(".blk-tool") && !row.classList.contains("blk-tool")) continue;
    const role = row.classList.contains("blk-user") ? "user"
      : row.classList.contains("blk-text") ? "assistant" : "tool";
    const body = role === "tool" ? row.querySelector(":scope > summary") : row;
    const text = (body?.innerText ?? body?.textContent ?? "").trim();
    if (!text) continue;
    const rendered = text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
    for (const [i, part] of rendered.entries()) lines.push(i === 0 ? `${role}: ${part}` : part);
  }
  return { tab, lines: lines.slice(-limit), truncated: lines.length > limit };
}

export async function read({ a1, a2, evalJs }) {
  if (a1 !== undefined && a1 !== "--lines" || a1 === "--lines" && (a2 === undefined || !/^[1-9]\d*$/.test(a2) || Number(a2) > 200)
    || a1 === undefined && a2 !== undefined) {
    throw Object.assign(new Error("usage: read [--lines N] (1-200)"), { exitCode: 2 });
  }
  const limit = a1 === "--lines" ? Number(a2) : 40;
  const result = await evalJs(`(${readLines.toString()})(document, ${limit})`);
  if (result.error) throw Object.assign(new Error(result.error), { exitCode: 2 });
  return result;
}
