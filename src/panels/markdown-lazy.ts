// markdown-build pulls in markdown-it (about 108 KB), which only Document, Relay docs, plan/report
// cards and Rendered text need. It loads on first use through this one door, so it stays out of the
// entry chunk and the modulepreload list. Async sites `await markdownReady()`; synchronous builders
// paint a plain-text placeholder and let `whenMarkdown` swap in the rendered tree.

type Markdown = typeof import("./markdown-build");

let loaded: Markdown | null = null;
let pending: Promise<Markdown> | null = null;

export function markdownReady(): Promise<Markdown> {
  pending ??= import("./markdown-build").then((m) => (loaded = m), (e) => { pending = null; throw e; });
  return pending;
}

/** The module once it has loaded, else null (and a load is started). */
export function markdownLoaded(): Markdown | null {
  if (!loaded) void markdownReady().catch(() => {});
  return loaded;
}

/** Runs `fill` now when the parser is loaded (same task, as before), else after it loads. */
export function whenMarkdown(fill: (m: Markdown) => void): void {
  if (loaded) { fill(loaded); return; }
  markdownReady().then(fill, () => {}); // a failed load leaves the placeholder text on screen
}
