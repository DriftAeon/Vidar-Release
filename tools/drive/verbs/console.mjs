// `console`: errors and warnings the page logged since it loaded. The page keeps its own console
// store for the document's lifetime whether or not DevTools is attached, and Runtime.enable /
// Log.enable replay it to each new session — so a fresh connection sees load-time messages
// (WebGL shader errors are missed if capture begins after the reveal). Sources:
// Runtime.consoleAPICalled (console.error/warn/assert), Runtime.exceptionThrown (uncaught), and
// Log.entryAdded (browser-side: WebGL, network, security, deprecation). A Log entry with the same
// level and text as a Runtime one is the same message reported twice and is merged.
const CONSOLE_SETTLE_MS = 300; // replay arrives with the enable calls; this catches stragglers

export async function consoleSinceLoad({ send, withTimeout, EVAL_MS, events }) {
  await withTimeout(send("Runtime.enable"), EVAL_MS, "Runtime.enable");
  await withTimeout(send("Log.enable"), EVAL_MS, "Log.enable");
  await new Promise((r) => setTimeout(r, CONSOLE_SETTLE_MS));
  const argText = (a) => a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value))
    : a.unserializableValue ?? a.description ?? a.type;
  const at = (url, line) => (url ? `${url}:${(line ?? 0) + 1}` : "");
  const messages = [];
  for (const e of events) {
    const p = e.params ?? {};
    if (e.method === "Runtime.consoleAPICalled" && ["error", "warning", "assert"].includes(p.type)) {
      const f = p.stackTrace?.callFrames?.[0];
      messages.push({ level: p.type === "warning" ? "warning" : "error", source: `console.${p.type}`,
        text: (p.args ?? []).map(argText).join(" "), at: at(f?.url, f?.lineNumber) });
    } else if (e.method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails ?? {};
      messages.push({ level: "error", source: "exception", text: d.exception?.description ?? d.text ?? "", at: at(d.url, d.lineNumber) });
    } else if (e.method === "Log.entryAdded" && ["error", "warning"].includes(p.entry?.level)) {
      const x = p.entry;
      const twin = messages.find((m) => !m.merged && m.level === x.level && !m.source.startsWith("log.") && m.text === x.text);
      if (twin) { twin.merged = true; continue; }
      messages.push({ level: x.level, source: `log.${x.source}`, text: x.text, at: at(x.url, x.lineNumber) });
    }
  }
  for (const m of messages) delete m.merged;
  return {
    errors: messages.filter((m) => m.level === "error").length,
    warnings: messages.filter((m) => m.level === "warning").length,
    since: "page load (replayed console store)",
    messages,
  };
}
