---
name: gate
kind: plugin
scope: [global]
agent: claude
surface: rendered
source: {{root}}/plugins/gate
env:
  - CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
description: The gate plugin, Rendered only; its env keeps the hooks module on in a cold config dir
---
