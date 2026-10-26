---
name: rune-merge
description: Merge pass over runes generated one source file at a time. Used by Vidar's Create Runes generator; not for interactive use.
---

# Rune merge

Each part below (a file, or a piece of one, possibly several files) was already turned into runes on its own.
You see every rune from every part; you decide only what one pass per part could not: which runes across
parts say the same thing, and how the
whole set is sectioned. You write no files and run no tools: your whole reply is one JSON object.

## Input

`Target agent`, then one line per rune:
`<id> | <kind> | <source paths> | <body>`.

## The contract

- Merge only runes an agent would apply identically (the same rule restated, or a narrower case that adds no
  condition). Keep both when one adds a condition. Never merge two different rules because they share a topic.
- A merge names the rune that stays (`into`), the runes it absorbs (`from`) and the merged `body`. Never soften:
  keep every never, must, always and do not. Prefer the words of the clearest copy. Sources are joined for you.
- Each rune id appears at most once across all `into` and `from`: no chains, no rune merged twice.
- `sections`: every remaining rune (not absorbed) in exactly one section; headings are 1 to 4 words,
  Title Case, grouping by what the rule governs, global layer before project layer where it makes sense.

## Reply

Exactly one JSON object, no prose, no fence, keys exactly `merge`, `sections`:

```json
{
  "merge": [{ "into": "no-force-push", "from": ["never-force-master"], "body": "Never force-push to master." }],
  "sections": [{ "heading": "Git", "ids": ["no-force-push", "test-before-commit"] }]
}
```
