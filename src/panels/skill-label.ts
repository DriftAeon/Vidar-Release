// Display name for a skill or MCP tool button: "adversarial-diff-review" → "Adversarial Diff Review".

import { titleWords } from "../format";

export const skillLabel = (name: string): string => titleWords(name);
