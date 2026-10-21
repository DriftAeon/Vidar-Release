// Settings build identity. Side effects are supplied by release.ts.
import type { BuildStamp } from "../build-stamp/stamp";

// The identity text: short commit, plus Local Changes only for a dirty local release build.
// A zip's manifest can record dirty (-AllowDirty), but the zip user has no local changes.
export function describeStamp(stamp: BuildStamp | null): { label: string; tip: string } {
  if (!stamp) return { label: "Dev Build", tip: "No build stamp beside this exe." };
  const changes = stamp.dirty && stamp.local ? " · Local Changes" : "";
  const built = stamp.builtUtc ? `Built ${stamp.builtUtc}.` : "Build time not recorded.";
  return { label: `${stamp.head.slice(0, 7)}${changes}`, tip: `${stamp.head}\n${built}` };
}

export function renderRelease(doc: Document, stamp: BuildStamp | null, open: () => Promise<unknown>): HTMLElement {
  const root = doc.createElement("div");
  root.className = "release-settings";
  const identity = doc.createElement("span");
  identity.className = stamp ? "release-commit" : "";
  const { label, tip } = describeStamp(stamp);
  identity.textContent = label;
  identity.title = tip;
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "ws-btn";
  button.textContent = "Open Releases";
  const status = doc.createElement("span");
  status.className = "release-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  button.addEventListener("click", () => {
    status.textContent = "";
    void open().catch(() => { status.textContent = "Could Not Open Releases"; });
  });
  root.append(identity, button, status);
  return root;
}
