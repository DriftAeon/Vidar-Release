// The body's one seam for asks that reach Relay or get drawn back into the tab: the approval record
// publisher (approval-relay.ts), the card-backed question publisher (question-relay.ts) and the
// tab-side drawing of Relay questions (tab-asks.ts) and approval records (tab-approvals.ts). The body
// calls sync() on every refreshState and card attach, redraw() after hydration or a transcript reset,
// and dispose() on close.

import type { ToolRecord } from "./state";
import type { QuestionHandle } from "./cards";
import { createApprovalRelay } from "./approval-relay";
import { createQuestionRelay } from "./question-relay";
import { createTabAsks } from "./tab-asks";
import { createTabApprovals } from "./tab-approvals";

export interface AskMirrorDeps {
  tabId: string;
  tabName: string | null;
  tools: Map<string, ToolRecord>;
  /** pending approval cards by request id */
  approvals: Map<string, HTMLElement>;
  /** cards.ts openQuestions: a thunk, since createCards runs after the mirror is built */
  openQuestions: () => QuestionHandle[];
  hydrating: () => boolean;
  /** the transcript element tab cards are drawn into */
  host: HTMLElement;
}

export function createAskMirror(deps: AskMirrorDeps) {
  const { tabId, tabName, tools, approvals, openQuestions, hydrating, host } = deps;
  const records = createApprovalRelay({ tabId, tabName, tools, approvals, hydrating });
  const questions = createQuestionRelay({ tabId, tabName, tools, openQuestions, hydrating });
  const tab = createTabAsks({ tabId, tabName, host, hydrating });
  const tabApprovals = createTabApprovals({ tabId, tabName, host, hydrating });
  return {
    sync(): void { records.sync(); questions.refresh(); tab.refresh(); tabApprovals.refresh(); },
    redraw(): void { tab.redraw(); tabApprovals.redraw(); },
    dispose(): void { records.dispose(); questions.dispose(); tab.dispose(); tabApprovals.dispose(); },
  };
}
