/* Dev-only fixture runner for the preview renderer, hosted by the Document tab (the
   Display tab that first held it folded into Document and Relay, 2026-10-16).
   Drives every manifest case through three phases and four (or five)
   configurations, emitting "VIDAR-HARNESS {json}" console markers the CDP
   harness uses to window its Network/Page/Log observations. Script sentinels
   arrive as postMessage from the frames (the only cross-origin signal).
   tools\drive\preview-harness.mjs observes it over the DevTools protocol. */

import { reconstruct, buildDocument, mountFrame, structuralCheck } from "./preview";

interface FixtureCase {
  id: string;
  file: string;
  category: "fetch" | "navigation" | "script" | "hint" | "positive" | "budget" | "activation";
  trigger: "automatic" | "activation";
  deadline_ms: number;
  expect: Record<string, string>;
}
interface Manifest { probe: string; cases: FixtureCase[] }

/** the host view's parts the runner writes into */
export interface FixtureHost {
  reveal: () => void;
  note: HTMLElement;
  /** the runner appends its own box here and writes only inside it */
  content: HTMLElement;
}

/** Dev builds only: the run button in `bar` and `window.__vidarRunFixtures` (tools/drive/preview-harness.mjs). */
export function mountFixtureRunner(bar: HTMLElement, host: FixtureHost): void {
  const run = document.createElement("button");
  run.id = "preview-fixtures";
  run.className = "ws-btn";
  run.textContent = "run preview fixtures";
  run.title = "Dev Fixtures";
  const fixtures = () => runFixtures(host);
  run.addEventListener("click", () => void fixtures());
  bar.appendChild(run);
  (window as unknown as { __vidarRunFixtures: () => Promise<void> }).__vidarRunFixtures = fixtures;
}

const PROBE_URL = "http://127.0.0.1:1447";
const sentinelHits: string[] = [];
window.addEventListener("message", (e) => {
  if (typeof e.data === "string" && e.data.startsWith("vidar-sentinel:")) sentinelHits.push(e.data);
});

function marker(o: Record<string, unknown>) {
  console.log("VIDAR-HARNESS " + JSON.stringify(o));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runFixtures(host: FixtureHost) {
  // The frames must be laid out: CSS backgrounds, fonts, cursors, <object> and
  // SVG references only load for rendered boxes (eager <img> is the exception).
  // Driven over CDP the workbench may be collapsed — open it on this tab first.
  host.reveal();
  await wait(150);
  const nonce = Date.now().toString(36);
  const res = await fetch("/tests/preview-fixtures/manifest.json");
  if (!res.ok) { host.note.textContent = `manifest: ${res.status}`; return; } // copy-ok: dev-only harness note
  const manifest = (await res.json()) as Manifest;
  const results: Record<string, unknown>[] = [];
  // the runner's own box inside the host, so the open document's view is left in place
  let box = host.content.querySelector<HTMLElement>(":scope > .preview-fixtures-run");
  if (!box) {
    box = document.createElement("div");
    box.className = "preview-fixtures-run";
    host.content.appendChild(box);
  }
  const out = document.createElement("pre");
  out.className = "display-source";
  box.replaceChildren(out);
  const log = (s: string) => { out.textContent += s + "\n"; };
  marker({ event: "run-start", nonce, cases: manifest.cases.length });

  for (const c of manifest.cases) {
    const raw = await (await fetch(`/tests/preview-fixtures/${c.file}`)).text();
    const sub = (config: string, phase: string) =>
      raw
        .replaceAll("{{URL}}", `${PROBE_URL}/${c.id}?run=${nonce}&case=${c.id}&config=${config}&phase=${phase}`)
        .replaceAll("{{SENTINEL}}", `vidar-sentinel:${nonce}:${c.id}:${config}`);

    // phase: parse-only
    marker({ event: "start", nonce, case: c.id, phase: "parse", config: "-" });
    new DOMParser().parseFromString(sub("-", "parse"), "text/html");
    await wait(300);
    marker({ event: "end", nonce, case: c.id, phase: "parse", config: "-" });

    // phase: reconstruct-only (build, don't mount) + structural check
    marker({ event: "start", nonce, case: c.id, phase: "reconstruct", config: "-" });
    const r = reconstruct(sub("-", "reconstruct"));
    const structural = r.fellBack ? [] : structuralCheck(buildDocument(r, false));
    await wait(300);
    marker({ event: "end", nonce, case: c.id, phase: "reconstruct", config: "-", fellBack: r.fellBack, dropped: r.dropped, structural });
    results.push({ case: c.id, phase: "reconstruct", fellBack: r.fellBack, structural, dropped: r.dropped });

    // phase: mount, per configuration (all keep sandbox="")
    const configs: [string, () => string, string][] = [
      ["control", () => sub("control", "mount"), ""],
      ["csp-only", () => buildDocument({ styles: [], body: sub("csp-only", "mount") }, true), ""],
      ["recon-only", () => { const x = reconstruct(sub("recon-only", "mount")); return x.fellBack ? "" : buildDocument(x, false); }, ""],
      ["full", () => { const x = reconstruct(sub("full", "mount")); return x.fellBack ? "" : buildDocument(x, true); }, ""],
    ];
    // positive control for the script sentinel: scripts ALLOWED, proves the sentinel fires
    if (c.category === "script") configs.push(["control-scripts", () => sub("control-scripts", "mount"), "allow-scripts"]);

    for (const [config, build, sandbox] of configs) {
      const before = sentinelHits.length;
      marker({ event: "start", nonce, case: c.id, phase: "mount", config });
      const doc = build();
      let frame: HTMLIFrameElement | null = null;
      if (doc) {
        frame = mountFrame(doc, sandbox);
        frame.style.height = "120px";
        out.before(frame);
      }
      await wait(c.deadline_ms);
      frame?.remove();
      const hits = sentinelHits.slice(before).filter((s) => s.endsWith(`:${c.id}:${config}`));
      marker({ event: "end", nonce, case: c.id, phase: "mount", config, sentinel: hits.length, empty: !doc });
      results.push({ case: c.id, phase: "mount", config, sentinel: hits.length, expect: c.expect[config] ?? "-" });
      log(`${c.id.padEnd(28)} ${config.padEnd(15)} sentinel=${hits.length} expect=${c.expect[config] ?? "-"}`);
    }
  }
  marker({ event: "run-end", nonce, results: results.length });
  log("\nrun complete — read tools/drive/preview-harness.mjs output for network/navigation/CSP per window");
}
