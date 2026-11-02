---
name: mcp-gate
kind: hook
scope: [global]
agent: claude
event: PreToolUse
matcher: mcp__.*
command: node "{{root}}\tools\bare\mcp-gate.mjs"
description: Gates MCP tool calls in a Bare tab before they run
---
