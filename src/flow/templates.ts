// The Brainstorm starter plus the six linear starters, authored v1 graphs (input/agent/output only, every agent node
// with a ModelId, a `preset` field, and an explicit-placeholder task per §4.2). Leaf module — no
// value imports (node --test rule, §7); `FlowTemplate`/`FlowNode`/`FlowEdge` cross only as types.
// Seeded into `vidar.flow.templates.v1` by store.ts via store-core.ts's `seedTemplatesIfAbsent`
// when the templates key is absent (§4.1). Node ids and default tasks are frozen verbatim (§6);
// only the wording may be tuned later, never the placeholders.

import type { AgentPreset, FlowEdge, FlowNode, FlowTemplate } from "./model";

function inputNode(x: number, y: number): FlowNode {
  return {
    id: "input",
    kind: "input",
    title: "Input",
    x,
    y,
    fields: [
      { k: "shape", v: "free-text" },
      { k: "content", v: "" },
    ],
    fieldSpecs: [
      { k: "shape", required: true, kind: "select", options: ["free-text", "structured"] },
      { k: "content", required: true, kind: "text" },
    ],
    inputs: [],
    outputs: ["out"],
  };
}

function outputNode(x: number, y: number): FlowNode {
  return {
    id: "output",
    kind: "output",
    title: "Output",
    x,
    y,
    fields: [],
    inputs: ["in"],
    outputs: [],
  };
}

function agentNode(opts: {
  id: string;
  title: string;
  model: FlowNode["model"];
  preset: AgentPreset;
  task: string;
  x: number;
  y: number;
}): FlowNode {
  return {
    id: opts.id,
    kind: "agent",
    title: opts.title,
    x: opts.x,
    y: opts.y,
    model: opts.model,
    fields: [
      { k: "task", v: opts.task },
      { k: "preset", v: opts.preset },
    ],
    fieldSpecs: [{ k: "task", required: true, kind: "text" }],
    inputs: ["in"],
    outputs: ["out"],
  };
}

function chainEdges(nodeIds: string[]): FlowEdge[] {
  const edges: FlowEdge[] = [];
  for (let i = 0; i < nodeIds.length - 1; i++) {
    edges.push({
      id: `e${i + 1}`,
      from: { node: nodeIds[i], port: "out" },
      to: { node: nodeIds[i + 1], port: "in" },
    });
  }
  return edges;
}

/** Top-to-bottom default layout: every template and New's pair is a
 *  single chain, so the cards stack on one spine at x 0. The step is autoLayout's row rule
 *  (tallest card + 48 gap, rounded up to the 16 grid) applied to a nominal template card: title
 *  plus one field line is ~47px tall, so 96 keeps a ~48px gap. A card would have to grow past
 *  96px (several addon rows) before two rows touch. Saved graphs are not migrated. */
const STACK_TOP = 80;
const STACK_STEP_Y = 96;

/** y of the `i`-th card in a top-to-bottom chain. */
export function stackY(i: number): number {
  return STACK_TOP + i * STACK_STEP_Y;
}

export const EDIT_RULE = "Make file changes with your file-edit tool, not shell commands.";

const BRAINSTORM_FORMAT_REVIEW_EXECUTE: FlowTemplate = {
  id: "tpl-brainstorm-format-review-execute",
  name: "Brainstorm to Execution",
  description: "Format (Sonnet 5) → Review (Opus 5.5) → Execute (Sonnet 5)",
  graph: {
    name: "Brainstorm to Execution",
    nodes: [
      inputNode(0, stackY(0)),
      agentNode({
        id: "format",
        title: "Format",
        model: "claude-sonnet-5",
        preset: "brainstorm-format",
        task: "Turn this brain dump into one specific, structured task prompt.\n\n{{input}}",
        x: 0,
        y: stackY(1),
      }),
      agentNode({
        id: "review",
        title: "Review",
        model: "claude-opus-5-5",
        preset: "review",
        task: "Review this task prompt for ambiguity, missing constraints and risk. List findings with fixes.\n\nTask prompt:\n{{format}}",
        x: 0,
        y: stackY(2),
      }),
      agentNode({
        id: "execute",
        title: "Execute",
        model: "claude-sonnet-5",
        preset: "execute",
        task: `Carry out this task, applying the review notes. ${EDIT_RULE} End with a short report.\n\nTask:\n{{format}}\n\nReview notes:\n{{review}}`,
        x: 0,
        y: stackY(3),
      }),
      outputNode(0, stackY(4)),
    ],
    edges: chainEdges(["input", "format", "review", "execute", "output"]),
  },
};

// ---- Linear starter set ----
// Input → stages → Analyze / Telemetry → Output. The final stage keeps preset "academy" so
// engine.ts still records its output as the run's suggestions. No run measurements reach any
// prompt yet (placeholders resolve to upstream outputs only), so Analyze says so instead of guessing.

type Stage = { id: string; title: string; model: FlowNode["model"]; preset: AgentPreset; task: string };

const OPUS: FlowNode["model"] = "claude-opus-5-5";
const SONNET: FlowNode["model"] = "claude-sonnet-5";
const MODEL_NAMES: Record<string, string> = { "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5": "Sonnet 5" };

function analyzeStage(prior: Stage[]): Stage {
  const outputs = prior.map((s) => `${s.title}:\n{{${s.id}}}`).join("\n\n");
  return {
    id: "analyze",
    title: "Analyze / Telemetry",
    model: SONNET,
    preset: "academy",
    task:
      "Review how this flow performed, not the work itself (Verify covers that). Change nothing. " +
      "Run measurements (time, cost, retries) are not provided: mark them unavailable rather than estimating. " +
      "Report compactly under: Outcome (was the request fulfilled, what remains unverified), " +
      "Efficiency (where retries or repeated context accumulated, from the stage outputs), " +
      "Stage Value (which steps caught something useful, duplicated work or missed information), " +
      "Suggested Adjustment (at most 3 changes to prompts, stage order or model allocation; suggestions only).\n\n" +
      `Request:\n{{input}}\n\n${outputs}`,
  };
}

function linearTemplate(id: string, name: string, stages: Stage[]): FlowTemplate {
  const all = [...stages, analyzeStage(stages)];
  const agents = all.map((s, i) => agentNode({ ...s, x: 0, y: stackY(i + 1) }));
  return {
    id,
    name,
    description: all.map((s) => `${s.title} (${MODEL_NAMES[s.model ?? ""] ?? s.model})`).join(" → "),
    graph: {
      name,
      nodes: [inputNode(0, stackY(0)), ...agents, outputNode(0, stackY(all.length + 1))],
      edges: chainEdges(["input", ...all.map((s) => s.id), "output"]),
    },
  };
}

const NO_EDITS = "Change no files.";

const PLANNED_IMPLEMENTATION = linearTemplate("tpl-planned-implementation", "Planned Implementation", [
  { id: "plan", title: "Plan", model: OPUS, preset: "plan", task: `Write an implementation plan for this request. ${NO_EDITS}\n\nRequest:\n{{input}}` },
  { id: "review", title: "Review", model: OPUS, preset: "review", task: `Challenge this plan against the request. List findings by severity with the fix for each. ${NO_EDITS}\n\nRequest:\n{{input}}\n\nPlan:\n{{plan}}` },
  { id: "revise", title: "Revise", model: SONNET, preset: "revise", task: `Revise the plan to address every review finding. Output the full revised plan. ${NO_EDITS}\n\nPlan:\n{{plan}}\n\nReview:\n{{review}}` },
  { id: "execute", title: "Execute", model: SONNET, preset: "execute", task: `Implement this plan in the working directory. ${EDIT_RULE} End with a short report of what changed.\n\nPlan:\n{{revise}}` },
  { id: "verify", title: "Verify", model: SONNET, preset: "custom", task: `Check the work against the request and plan: run the relevant build and tests, then report what passed, what failed and what is unverified, with evidence. ${NO_EDITS}\n\nRequest:\n{{input}}\n\nPlan:\n{{revise}}\n\nExecution report:\n{{execute}}` },
]);

const DIAGNOSE_AND_FIX = linearTemplate("tpl-diagnose-and-fix", "Diagnose and Fix", [
  { id: "investigate", title: "Investigate", model: SONNET, preset: "custom", task: `Gather evidence for this problem: reproduce it, collect errors, logs and the code paths involved. Report facts, marked verified or inferred. ${NO_EDITS}\n\nProblem:\n{{input}}` },
  { id: "diagnose", title: "Diagnose", model: OPUS, preset: "custom", task: `From the evidence, name the most likely root cause and why, the alternatives ruled out, and a proposed fix. ${NO_EDITS}\n\nProblem:\n{{input}}\n\nEvidence:\n{{investigate}}` },
  { id: "review-fix", title: "Review Fix", model: OPUS, preset: "review", task: `Challenge this diagnosis and proposed fix: does the evidence support the cause, and does the fix address it without side effects? Output the final fix to apply. If anything you cut leaves the reported symptom unfixed, say so plainly and list it as an open item. ${NO_EDITS}\n\nProblem:\n{{input}}\n\nEvidence:\n{{investigate}}\n\nDiagnosis:\n{{diagnose}}` },
  { id: "execute", title: "Execute", model: SONNET, preset: "execute", task: `Apply this fix in the working directory. ${EDIT_RULE} End with a short report of what changed.\n\nFix:\n{{review-fix}}` },
  { id: "verify", title: "Verify", model: SONNET, preset: "custom", task: `Confirm the problem is fixed: rerun the reproduction, build and tests. Report what passed, what failed and what is unverified, with evidence. ${NO_EDITS}\n\nProblem:\n{{input}}\n\nFix:\n{{review-fix}}\n\nExecution report:\n{{execute}}` },
]);

const IDEA_TO_BRIEF = linearTemplate("tpl-idea-to-brief", "Idea to Brief", [
  { id: "organize", title: "Organize", model: SONNET, preset: "brainstorm-format", task: `Organize this dump into a structured draft: goal, context, constraints, open questions. ${NO_EDITS}\n\n{{input}}` },
  { id: "challenge", title: "Challenge", model: OPUS, preset: "review", task: `Challenge this draft for ambiguity, missing constraints, hidden scope and risk. List findings with fixes. ${NO_EDITS}\n\nDraft:\n{{organize}}` },
  { id: "refine", title: "Refine", model: SONNET, preset: "revise", task: `Refine the draft to address every finding. Output the full refined draft. ${NO_EDITS}\n\nDraft:\n{{organize}}\n\nFindings:\n{{challenge}}` },
  { id: "brief", title: "Brief", model: SONNET, preset: "custom", task: `Write a bounded, actionable task brief from this draft: scope, files or areas, steps, how to verify, what is out of scope. Stop before implementation. ${NO_EDITS}\n\nDraft:\n{{refine}}` },
]);

const RESEARCH_AND_DECIDE = linearTemplate("tpl-research-and-decide", "Research and Decide", [
  { id: "frame", title: "Frame Question", model: OPUS, preset: "custom", task: `Frame the decision: the exact question, the options in play, and the criteria that decide it. ${NO_EDITS}\n\nRequest:\n{{input}}` },
  { id: "gather", title: "Gather Evidence", model: SONNET, preset: "custom", task: `Gather evidence for each option against each criterion. Cite sources or paths; mark each claim verified or inferred. ${NO_EDITS}\n\nFrame:\n{{frame}}` },
  { id: "compare", title: "Compare", model: OPUS, preset: "custom", task: `Compare the options on the evidence: tradeoffs per criterion, and where the evidence is thin. ${NO_EDITS}\n\nFrame:\n{{frame}}\n\nEvidence:\n{{gather}}` },
  { id: "recommend", title: "Recommend", model: OPUS, preset: "custom", task: `Recommend one option with the deciding reason, the evidence behind it, the tradeoffs accepted and the unresolved questions. ${NO_EDITS}\n\nFrame:\n{{frame}}\n\nComparison:\n{{compare}}` },
]);

const BOUNDED_REVIEW = linearTemplate("tpl-bounded-review", "Bounded Review", [
  { id: "scope", title: "Establish Scope", model: SONNET, preset: "custom", task: `Establish the review scope: the exact files, diff or paths in bounds, what to check them for, and what is out of bounds. ${NO_EDITS}\n\nRequest:\n{{input}}` },
  { id: "inspect", title: "Inspect", model: OPUS, preset: "review", task: `Inspect everything in scope. List findings with severity, the evidence (path:line) and a suggested fix. ${NO_EDITS}\n\nScope:\n{{scope}}` },
  { id: "challenge", title: "Challenge Findings", model: OPUS, preset: "review", task: `Challenge each finding: drop the ones the evidence does not support, correct severities, and note anything in scope that was missed. ${NO_EDITS}\n\nScope:\n{{scope}}\n\nFindings:\n{{inspect}}` },
  { id: "report", title: "Report", model: SONNET, preset: "custom", task: `Write the final review: findings ranked by severity, each with evidence and a fix. ${NO_EDITS}\n\nScope:\n{{scope}}\n\nChallenged findings:\n{{challenge}}` },
]);

const HANDOFF_AND_RESUME = linearTemplate("tpl-handoff-and-resume", "Handoff and Resume", [
  { id: "gather", title: "Gather State", model: SONNET, preset: "custom", task: `Gather the current state of this work: changed paths, decisions made, validation run and its results, open work. ${NO_EDITS}\n\nSession:\n{{input}}` },
  { id: "reconcile", title: "Reconcile", model: OPUS, preset: "review", task: `Reconcile the gathered state with the session: flag contradictions, stale claims and anything unverified. ${NO_EDITS}\n\nSession:\n{{input}}\n\nState:\n{{gather}}` },
  { id: "handoff", title: "Write Handoff", model: SONNET, preset: "custom", task: `Write the handoff: exact paths, decisions, validation, unresolved work and the next bounded step. ${NO_EDITS}\n\nState:\n{{gather}}\n\nReconciliation:\n{{reconcile}}` },
  { id: "check", title: "Check Handoff", model: OPUS, preset: "review", task: `Check that a fresh session could resume from this handoff alone. List gaps with fixes. ${NO_EDITS}\n\nHandoff:\n{{handoff}}\n\nReconciliation:\n{{reconcile}}` },
]);

/** Retired starter ids resolve to the surviving template when an older picker action supplies one. */
export const RETIRED_TEMPLATE_ALIASES: Readonly<Record<string, string>> = {
  "tpl-plan-review-revise-execute-academy": "tpl-planned-implementation",
};

/** Retired starter ids with no successor: reseed drops the stored copy, and no alias redirects them. */
export const RETIRED_STARTER_IDS: readonly string[] = ["tpl-codex-mcp-ab"];

/** Seeded into `vidar.flow.templates.v1` on first load (§4.1). */
export const STARTER_TEMPLATES: FlowTemplate[] = [
  PLANNED_IMPLEMENTATION,
  BRAINSTORM_FORMAT_REVIEW_EXECUTE,
  DIAGNOSE_AND_FIX,
  IDEA_TO_BRIEF,
  RESEARCH_AND_DECIDE,
  BOUNDED_REVIEW,
  HANDOFF_AND_RESUME,
];
