// Unreal tab head: the MCP and RiderLink pills (unreal_mcp_status) as label, signal and tooltip. Pure.
import type { UnrealEnginePin, UnrealMcpPills, UnrealPill } from "../ipc";

type PillSignal = "ok" | "alert";

export interface PillView {
  key: "editorMcp" | "riderMcp" | "riderLink";
  label: string;
  signal: PillSignal;
  tooltip: string;
}

const NAMES: Record<PillView["key"], [string, string]> = {
  editorMcp: ["Editor MCP Up", "Editor MCP Down"],
  riderMcp: ["Rider MCP Up", "Rider MCP Down"],
  riderLink: ["RiderLink Connected", "RiderLink Not Connected"],
};

function pillView(key: PillView["key"], pill: UnrealPill): PillView {
  const label = NAMES[key][pill.up ? 0 : 1];
  return { key, label, signal: pill.up ? "ok" : "alert", tooltip: pill.reason ? `${label}: ${pill.reason}` : label };
}

/** The pills to draw, in head order; riderLink is absent when Rider is not up. */
export function pillViews(pills: UnrealMcpPills | null): PillView[] {
  if (!pills) return [];
  const out = [pillView("editorMcp", pills.editorMcp), pillView("riderMcp", pills.riderMcp)];
  if (pills.riderLink) out.push(pillView("riderLink", pills.riderLink));
  return out;
}

export interface PinView { label: string; tooltip: string; pinned: boolean }

export function pinView(pin: UnrealEnginePin | null): PinView {
  return pin
    ? { label: `Engine ${pin.engineVersion}`, tooltip: pin.engine, pinned: true }
    : { label: "No Engine Pinned", tooltip: "No engine is pinned for this project.", pinned: false };
}
