// LM Studio: not an MCP server itself. It sits behind the proxy's local-llm
// backend (a stdio bridge to its OpenAI-compatible server), so it is a row in
// the MCP servers rack rather than a card of its own.
// Expanding the row asks LM Studio directly (is the server up, what is
// loaded) and then names the proxy row that fronts it, if one does — that
// second fact comes from the proxy's own /status, not from assumption.
//
// Observation only: Vidar never starts or stops it; the row says how to.
// Fetched on first expand and on Refresh; no polling.

import { invoke } from "../ipc";
import { label } from "../format";
import { iconImg } from "../icon-img";
import { summarizeBackend, type BackendStatus } from "./backend-status";
import { text } from "./rack-row";

interface LmModel {
  id: string;
  kind: string;
  state: string;
}

export interface LmStatus {
  origin: string;
  source: string;
  state: string;
  models: LmModel[];
  detail: string;
}


export interface ProxyCandidate {
  name: string;
  url: string;
}

// green = answered; amber = reachable but not usable; dim = down. Fixed hues, not theme accents.
const DOT: Record<string, string> = { up: "mod-dot-ok", timeout: "mod-dot-warn", unsupported: "mod-dot-warn", "off-loopback": "mod-dot-warn", down: "mod-dot-off" };

function line(cls: string, dot: string, body: string, hover?: string): HTMLElement {
  const row = document.createElement("div");
  row.className = `mod-line ${cls}`;
  row.append(text(`mod-dot ${dot}`, "● "), text("", body));
  if (hover) row.title = hover;
  return row;
}

/** Which proxy row fronts LM Studio: the first candidate whose /status lists a local-llm backend. */
// `lmUp`: the proxy's local-llm backend lists its tools whether or not LM Studio is up (it only
// calls LM Studio when a tool runs), so its "live" alone painted green beside "Not Running".
async function viaProxy(candidates: ProxyCandidate[], lmUp: boolean): Promise<HTMLElement | null> {
  for (const c of candidates) {
    let backends: BackendStatus[];
    try {
      backends = await invoke("proxy_status", { url: c.url });
    } catch {
      continue; // not a proxy, or down — the next candidate may be
    }
    const b = backends.find((x) => x.name === "local-llm");
    if (!b) continue;
    const { live, parts, title } = summarizeBackend(b);
    return line("sub", live && lmUp ? "mod-dot-ok" : "mod-dot-off", [`Via ${label(c.name)}`, ...parts].join(" · "), title);
  }
  return null; // no proxy fronting it is a normal setup, not a note
}

export async function renderLmStudioDetail(host: HTMLElement, candidates: ProxyCandidate[]) {
  const bar = document.createElement("div");
  bar.className = "mod-head-row"; // status line left, Refresh right, one row
  const head = document.createElement("div");
  const refresh = document.createElement("button");
  refresh.className = "mod-refresh";
  refresh.replaceChildren(iconImg("refresh"));
  refresh.title = "Refresh";
  bar.append(head, refresh);
  const body = document.createElement("div");
  body.className = "rack-list";
  host.replaceChildren(bar, body);

  // Refresh dims while a read runs (disabled + aria-busy); the last head and rows stay until the
  // new ones replace them together. "Querying…" shows only on the first load.
  const load = async () => {
    if (refresh.disabled) return;
    refresh.disabled = true;
    refresh.setAttribute("aria-busy", "true");
    if (!head.firstChild) head.replaceChildren(text("dim sub", "Querying…"));
    try {
      await draw();
    } finally {
      refresh.disabled = false;
      refresh.removeAttribute("aria-busy");
    }
  };
  const draw = async () => {
    let st: LmStatus;
    try {
      st = await invoke("lmstudio_status");
    } catch (e) {
      const err = text("sub tool-err", "Can't Read LM Studio Status");
      err.title = String(e);
      head.replaceChildren(err);
      body.replaceChildren();
      return;
    }
    const rows: HTMLElement[] = [];
    const where = st.origin.replace(/^http:\/\//, "") + (st.source === "default" ? " (default address)" : "");
    const label: Record<string, string> = {
      up: "Running",
      down: "Not Running",
      timeout: "No Reply",
      unsupported: "Unrecognised API",
      "off-loopback": "Not Checked: Off Loopback",
    };
    const hint = st.state === "down" ? "Start it with: lms server start" : st.detail;
    // "sub" like every other status line in the rack: at 12px it read as a different style beside "Via Proxy" (2026-10-05)
    const headLine = line("sub", DOT[st.state] ?? "mod-dot-off", label[st.state] ?? st.state, [where, hint].filter(Boolean).join("\n"));
    if (st.state === "up") {
      const loaded = st.models.filter((m) => m.state === "loaded");
      const rest = st.models.length - loaded.length;
      if (!loaded.length) rows.push(line("sub", "mod-dot-off", "No Model Loaded"));
      for (const m of loaded) rows.push(line("sub", "mod-dot-ok", `${m.id}${m.kind ? ` · ${m.kind}` : ""}`, "loaded"));
      if (rest > 0) rows.push(text("dim sub", `+${rest} Downloaded`));
    }
    const proxyRow = await viaProxy(candidates, st.state === "up");
    if (proxyRow) rows.push(proxyRow);
    head.replaceChildren(headLine);
    body.replaceChildren(...rows);
  };
  refresh.addEventListener("click", (e) => { e.stopPropagation(); void load(); });
  await load();
}
