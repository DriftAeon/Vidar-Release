// One proxy backend's /status record, shared by the rack and the LM Studio module. `lastList`
// is how the tools were last enumerated ("never", "live", "disk", "live, 16/115 allowed",
// "offline, cache from <iso>, 16/96 allowed"; see mcp.rs): a record, not a health check.
// The row keeps the state word and the tool count; the rest is hover detail.
import { label } from "../format";

export interface BackendStatus {
  name: string;
  enabled: boolean;
  lastList: string;
  lastListTime: string | null;
  schemaCache: boolean;
}

export interface BackendSummary {
  live: boolean;
  /** Short row text after the backend name: "16/96 tools", "offline", "disabled"… */
  parts: string[];
  title: string;
}

export function summarizeBackend(b: BackendStatus): BackendSummary {
  const segs = b.lastList.split(",").map((s) => s.trim());
  const state = segs[0];
  const live = state === "live";
  const allowed = segs.map((s) => /^(\d+)\/(\d+) allowed$/.exec(s)).find(Boolean);
  const parts: string[] = [];
  if (state === "never") parts.push("Not Listed");
  else if (!live) parts.push(label(state));
  if (allowed) parts.push(`${allowed[1]}/${allowed[2]} Tools`);
  if (!b.enabled && state !== "disabled") parts.push("Disabled"); // a disabled listing already says it
  const when = b.lastListTime ? ` at ${b.lastListTime.replace("T", " ").slice(0, 16)}` : "";
  const title = [
    b.lastList === "never" ? "Never listed" : `Last listed: ${b.lastList}${when}`,
    b.schemaCache ? "Schema cache on disk" : "",
    "A record of the last listing, not a health check",
  ].filter(Boolean).join("\n");
  return { live, parts, title };
}
