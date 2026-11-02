---
name: gate-hook-run
kind: hook
scope: [global]
event: PreToolUse
matcher: Bash
run:
  - {{root}}/tests/fixtures/rune-vault/sources/hooks/gate-hook-run.mjs
description: A hook rune with a run list
---
