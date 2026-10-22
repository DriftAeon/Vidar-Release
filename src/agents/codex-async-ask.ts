// Codex `request_user_input_async`: the model's ask lands as an agentMessage item with
// `delivery: "async"` and `questions` (schema AsyncUserInputQuestion: `title`, `options` as plain
// strings or null; no descriptions, no multi-select; one or several questions). The tool returns
// `{accepted:true}` at once and the turn ends, so the answer is the thread's next user message.

import type { AgentEvent } from "./protocol";

type Json = Record<string, unknown>;

export interface AsyncQuestion { title: string; options: string[] }

/** The item's questions when it is an async ask with at least one titled question, else null. */
export function asyncAskQuestions(item: Json): AsyncQuestion[] | null {
  if (item.type !== "agentMessage" || item.delivery !== "async" || !Array.isArray(item.questions)) return null;
  const qs: AsyncQuestion[] = [];
  for (const raw of item.questions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const q = raw as Json;
    if (typeof q.title !== "string" || !q.title.trim()) continue;
    const options = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string" && o.trim() !== "") : [];
    qs.push({ title: q.title, options });
  }
  return qs.length ? qs : null;
}

/** A completed async ask's events, else null: the empty close drops any streamed copy of the
 *  flattened text, and the card replaces it. */
export function asyncAskEvents(item: Json): AgentEvent[] | null {
  const questions = asyncAskQuestions(item);
  const blockId = typeof item.id === "string" ? item.id : "";
  return questions ? [{ kind: "text_done", blockId, markdown: "", parentToolUseId: null }, { kind: "ask_async", blockId, questions }] : null;
}

/** The question form's input (question-form.ts): a stable id per question so duplicate titles
 *  keep separate answers, and an Other row on every question. */
export function asyncAskFormInput(qs: AsyncQuestion[]): { questions: Json[] } {
  return { questions: qs.map((q, i) => ({ id: `q${i}`, question: q.title, isOther: true, options: q.options.map((label) => ({ label })) })) };
}

/** The user message that answers the ask: `<title>: <choice>` per question, notes after a blank line. */
export function asyncAnswerText(qs: AsyncQuestion[], answers: Record<string, string>, notes = ""): string {
  const lines = qs.map((q, i) => `${q.title}: ${(answers[`q${i}`] ?? "").trim()}`);
  const n = notes.trim();
  return n ? `${lines.join("\n")}\n\n${n}` : lines.join("\n");
}
