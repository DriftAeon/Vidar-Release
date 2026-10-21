---
name: keep-build-output-in-1
kind: rule
scope: [acme-claude-md]
state: active
activate: always
description: "Build"
origin: "2026-10-16 ~/Acme/CLAUDE.md:11"
---

Keep build output in C:\Projects\Acme\dist and never commit it.
The release script copies it from there.
