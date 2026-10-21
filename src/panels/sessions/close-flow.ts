// Optimistic close: the tab leaves the bar and the view first; the body, its event route and its
// timers stay alive off-DOM until shutdown/detach settles, then `finalize` runs exactly once.
// Pure and import-free (everything injected: node's test runner cannot resolve extensionless
// sibling imports), so the ordering is testable without a Rendered body.

interface ClosingBody {
  shutdown(): Promise<void>;
  detach(): Promise<void>;
  abandon(): Promise<void>;
  disconnected(): boolean;
}

export interface CloseFlowDeps {
  kind: "hosted" | "local";
  label: string;
  body: ClosingBody;
  /** tab button, container and tab-map entry leave now */
  removeView: () => void;
  /** dispose the body and clear its container; called once, in `finally` */
  finalize: () => void;
  /** hosted: `hostedCloseDecision` for a shutdown error; "remove" means Falcon was unreachable */
  classify: (error: unknown) => "remove" | "keep";
  /** a notice: the backend may still be running */
  fail: (label: string, message: string) => void;
}

export async function closeInBackground(d: CloseFlowDeps): Promise<void> {
  d.removeView();
  try {
    if (d.kind === "local") {
      await d.body.detach();
      return;
    }
    if (d.body.disconnected()) {
      void d.body.abandon();
      d.fail(d.label, "Falcon unreachable");
      return;
    }
    try {
      await d.body.shutdown();
    } catch (e) {
      // remove-class (unreachable) and keep-class (timeout) both leave the session's fate unknown
      const unreachable = d.classify(e) === "remove";
      void d.body.abandon();
      d.fail(d.label, unreachable ? `Falcon unreachable: ${String(e)}` : String(e));
    }
  } catch (e) {
    d.fail(d.label, String(e));
  } finally {
    d.finalize();
  }
}
