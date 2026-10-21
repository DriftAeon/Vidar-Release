// Display name for a skill or MCP tool button: "adversarial-diff-review" → "Adversarial Diff Review".

export const skillLabel = (name: string): string =>
  name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
