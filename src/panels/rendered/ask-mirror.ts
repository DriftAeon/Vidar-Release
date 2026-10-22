// The body's one seam for asks that reach Relay or get drawn back into the tab: the subagent approval
// mirror (subagent-relay.ts) plus the card-backed question publisher (question-relay.ts) and the
// tab-side drawing (tab-asks.ts). The body calls sync() on every refreshState and card attach, redraw()
// after hydration or a transcript reset, and dispose() on close.

import type { ToolRecord } from "./state";
import type { QuestionHandle } from "./cards";
import { createSubagentRelay } from "./subagent-relay";
import { createQuestionRelay } from "./question-relay";
import { createTabAsks } from "./tab-asks";

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
  const sub = createSubagentRelay({ tabId, tabName, tools, approvals, hydrating });
  const questions = createQuestionRelay({ tabId, tabName, tools, openQuestions, hydrating });
  const tab = createTabAsks({ tabId, tabName, host, hydrating });
  return {
    sync(): void { sub.sync(); questions.refresh(); tab.refresh(); },
    redraw(): void { tab.redraw(); },
    dispose(): void { sub.dispose(); questions.dispose(); tab.dispose(); },
  };
}
