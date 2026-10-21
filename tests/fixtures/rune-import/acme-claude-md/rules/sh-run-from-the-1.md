---
name: sh-run-from-the-1
kind: rule
scope: [acme-claude-md]
state: active
activate: always
description: "Build"
origin: "2026-10-16 ~/Acme/CLAUDE.md:14"
---

```sh
# run from the repo root
npm test -- --reporter dot
```
