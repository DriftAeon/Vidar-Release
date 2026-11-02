---
name: vidar-context-codex
kind: rule
scope: [global]
agent: codex
needs: [vidar-control]
description: How a Codex Bare session reaches Vidar control and drive
---
Vidar control: list tabs, prompt or spawn an agent tab, wait on one, show a file or ask the user through the vidar_drive MCP tools, or the control CLI (one bus round trip per call, one line back; exit 4 means not a Vidar tab):
node "{{root}}\tools\control\vidar.mjs" state | read | show <path> | focus <tab> | prompt <tab> <text> | spawn <agent> --model m (--brief p | --text t) | ask <question> | wait <tab>
