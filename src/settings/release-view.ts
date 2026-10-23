// Settings build identity. Side effects are supplied by release.ts.
import type { BuildStamp } from "../build-stamp/stamp";
import type { ReleaseReply } from "../startup-updates/release";

// The identity text: short commit, plus Local Changes only for a dirty local release build.
// A zip's manifest can record dirty (-AllowDirty), but the zip user has no local changes.
export function describeStamp(stamp: BuildStamp | null): { label: string; tip: string } {
  if (!stamp) return { label: "Dev Build", tip: "No build stamp beside this exe." };
  const changes = stamp.dirty && stamp.local ? " · Local Changes" : "";
  const built = stamp.builtUtc ? `Built ${stamp.builtUtc}.` : "Build time not recorded.";
  return { label: `${stamp.head.slice(0, 7)}${changes}`, tip: `${stamp.head}\n${built}` };
}

/** Check Now's status line: the reason, sentence case, rides in the tooltip. Pack offers count as
 *  updates, so the up-to-date line shows only when nothing at all is offered. */
export function describeCheck(reply: ReleaseReply): { text: string; tip: string } {
  if (reply.status === "ok") return { text: reply.core || reply.packs.length ? "Update Available" : "Vidar Is Up to Date", tip: "" };
  return { text: causeText(reply), tip: reply.reason };
}

/** One short Title Case line per failure, from the status and the Rust reason sentence. */
function causeText(reply: Exclude<ReleaseReply, { status: "ok" }>): string {
  if (reply.status === "offline") return "Could Not Reach GitHub";
  if (reply.status === "notPublished") return "No Release Published Yet";
  const status = /^GitHub answered with status (\d+)\./.exec(reply.reason);
  if (status) return `GitHub Returned Status ${status[1]}`;
  if (reply.reason === "The release index is too large.") return "Release Index Too Large";
  if (/^The release index (is not text|could not be read)\./.test(reply.reason)) return "Release Index Unreadable";
  if (reply.reason.startsWith("The request failed:")) return "Request Failed";
  return GENERIC_CHECK_FAILURE;
}

const GENERIC_CHECK_FAILURE = "Could Not Check for Updates";

/** The thrown-command path: the cause rides on the line only when short; the full text is the tooltip. */
export function describeThrown(e: unknown): { text: string; tip: string } {
  const tip = String(e ?? "");
  const cause = tip.replace(/^Error:\s*/, "").trim();
  const short = cause.length > 0 && cause.length <= 40 && !cause.includes("\n");
  return { text: short ? `${GENERIC_CHECK_FAILURE}: ${cause}` : GENERIC_CHECK_FAILURE, tip };
}

/** The Check for Updates at Launch switch; on unless state says false (the caller resolves it). */
export function renderLaunchSwitch(doc: Document, on: Promise<boolean>, save: (on: boolean) => Promise<unknown>,
  setError: (msg: string) => void): HTMLButtonElement {
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "module-settings__switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", "Check for Updates at Launch");
  toggle.setAttribute("aria-checked", "true");
  void on.then((v) => toggle.setAttribute("aria-checked", String(v)));
  toggle.addEventListener("click", () => {
    const want = toggle.getAttribute("aria-checked") !== "true";
    toggle.disabled = true;
    save(want).then(
      () => { toggle.setAttribute("aria-checked", String(want)); setError(""); },
      (e) => setError(String(e)),
    ).finally(() => { toggle.disabled = false; });
  });
  return toggle;
}

export function renderRelease(doc: Document, stamp: BuildStamp | null, open: () => Promise<unknown>,
  checkNow?: () => Promise<ReleaseReply>): HTMLElement {
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
    status.title = "";
    void open().catch(() => { status.textContent = "Could Not Open Releases"; });
  });
  root.append(identity, button);
  if (checkNow) {
    const check = doc.createElement("button");
    check.type = "button";
    check.className = "ws-btn";
    check.textContent = "Check Now";
    check.addEventListener("click", () => {
      status.textContent = "";
      status.title = "";
      check.disabled = true;
      void checkNow().then(
        (reply) => describeCheck(reply),
        (e) => describeThrown(e),
      ).then(({ text, tip }) => {
        status.textContent = text;
        status.title = tip;
      }).finally(() => { check.disabled = false; });
    });
    root.appendChild(check);
  }
  root.appendChild(status);
  return root;
}
