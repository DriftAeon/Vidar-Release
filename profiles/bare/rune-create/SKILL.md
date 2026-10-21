---
name: rune-create
description: Turn a user's agent rules files into runes, one rule each, cited line by line, returned as one JSON envelope for Vidar to validate and land. Used by Vidar's Create Runes generator; not for interactive use.
---

# Rune creation

You read the rules files below and return them as runes. You write no files and run no tools: your whole reply is
one JSON object. Vidar validates it, writes the rune files and refuses the reply outright if any rule here is broken.

## What a rune is

A rune is one Markdown file holding one rule or one fact: a header Vidar writes (`name`, `kind`, `scope`, `state`,
`activate`, `description`, `origin`) and a body that is the text the agent will read. A rune set slots runes into
headed sections; the set is what a tab loads. You supply only the content: id, kind, description, body, citations
and the section each rune sits in. Never write header syntax (`---`, `name:`) into a body.

## The contract

- One rule per rune. A source line holding two rules becomes two runes, both citing that line.
- Never soften a rule. Keep every never, must, always and do not as written; do not turn "never" into "avoid" or
  "must" into "should". A body may tighten wording, never loosen it.
- Cite every source line a rune draws on: `sources` lists `{path, line}` with the path exactly as the file header
  gives it and the `L<n>` number. Merged restatements cite every line they merge.
- Every non-blank line you do not use goes into `dropped` with its path, line and a short reason. Nothing is left
  out silently; headings and fence lines may be left uncited.
- No user-profile paths (`C:\Users\<name>\...`) and no `{{` in a body. Write `~` paths instead. A rune that cannot
  lose them is still returned; Vidar keeps it as a draft, switched off.
- `kind` is `rule` (an instruction) or `fact` (something true about the setup). Every rune is loaded always.
- `id`: lowercase letters, digits and single hyphens, 2 to 5 words, unique, naming the rule (`no-force-push`).
- `description`: one line under 80 characters saying what the rune holds.
- Every rune sits in exactly one section; every id a section lists is one of your runes. Sections follow the
  source's own headings where they make sense, in source order.

## Judgement

- Dedupe: the same rule stated twice (in one file or across files) becomes one rune citing every copy.
- Merge restatements: a rule and its narrower special case belong in one rune when an agent would apply them
  identically; keep both if the special case adds a condition.
- Drop stale or machine-specific lines with a reason: one-off task notes, changelog entries ("fixed X on ..."),
  paths that only exist on one machine, anything derivable from the code or git. A dated origin or a
  closes-when note on a rule is not stale; fold it into the body.
- Keep the reasoning a rule carries ("X, because Y") in its body; drop decoration, not causes.
- Budget: when a budget in characters is stated, the bodies together should fit it. Merge and tighten first;
  drop the least load-bearing runes (with a reason) only when merging is not enough.
- Prefer the source's words. Rewrite only to make one rune stand alone or to merge copies.

## Input

The user message states the target agent and an optional budget, then each file headed by its `~` path and line
count, every line prefixed `L<n>:`:

```text
Target agent: claude
Budget: none

=== FILE ~\.claude\CLAUDE.md (8 lines)
L1: # Git
L2:
L3: - Never force-push to master.
L4: - Always run the tests before a commit.
L5: - Don't force push, ever.
L6: - Fixed the cache bug on 2026-09-02.
L7: # Layout
L8: - Sources live under src/ and tests under tests/.
=== END
```

A file may arrive in parts, headed `(lines a-b of n)`; a `Context:` line under such a header names the headings above the part and is not citable, so cite only the `L<n>` lines shown.

## Reply

Exactly one JSON object and nothing else: no prose, no Markdown fence around it. Keys are exactly `runes`,
`sections` and `dropped` (an empty list when nothing is dropped); no other keys at any level. For the input above:

```json
{
  "runes": [
    {
      "id": "no-force-push",
      "kind": "rule",
      "description": "Never force-push to master",
      "body": "Never force-push to master.",
      "sources": [
        { "path": "~\\.claude\\CLAUDE.md", "line": 3 },
        { "path": "~\\.claude\\CLAUDE.md", "line": 5 }
      ]
    },
    {
      "id": "test-before-commit",
      "kind": "rule",
      "description": "Run the tests before every commit",
      "body": "Always run the tests before a commit.",
      "sources": [{ "path": "~\\.claude\\CLAUDE.md", "line": 4 }]
    },
    {
      "id": "source-layout",
      "kind": "fact",
      "description": "Where sources and tests live",
      "body": "Sources live under src/ and tests under tests/.",
      "sources": [{ "path": "~\\.claude\\CLAUDE.md", "line": 8 }]
    }
  ],
  "sections": [
    { "heading": "Git", "ids": ["no-force-push", "test-before-commit"] },
    { "heading": "Layout", "ids": ["source-layout"] }
  ],
  "dropped": [
    { "path": "~\\.claude\\CLAUDE.md", "line": 6, "reason": "changelog entry" }
  ]
}
```
