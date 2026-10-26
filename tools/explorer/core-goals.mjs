// Explorer runs live in runtime/explorer/<stamp>/ with run-log.jsonl, findings.jsonl,
// shots/*.png|jpg, and state/ (baselines and hashes, removed by the run's down step).
// Required fresh, before first send controls for both agents.
export const CORE_GOAL_IDS = [
  "core-fresh-model-claude", "core-fresh-model-codex",
  "core-fresh-effort-claude", "core-fresh-effort-codex",
  "core-fresh-mode-claude", "core-fresh-mode-codex",
  "core-fresh-cwd-claude", "core-fresh-cwd-codex",
];
