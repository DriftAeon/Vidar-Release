---
name: gate-hook-command
kind: hook
scope: [global]
agent: codex
event: Stop
command: node gate-notify.mjs --token sk-secret-1
description: A Codex-only hook rune with a command; the command is a secret
---
