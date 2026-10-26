---
name: guard-driver
kind: hook
scope: [global]
agent: claude
required-by: vidar
event: PreToolUse
matcher: Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell
command: node "{{root}}\tools\agent-layer\guard-driver.mjs" --root "{{root}}"
description: Guards edits and shell calls in a Bare tab before they run
---
