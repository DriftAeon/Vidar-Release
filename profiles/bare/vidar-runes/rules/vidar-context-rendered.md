---
name: vidar-context-rendered
kind: rule
scope: [global]
agent: claude
surface: rendered
needs: [vidar-control, vidar-drive]
description: How a Rendered Claude Bare session ends turns and asks the user
---
# Vidar app layer (Rendered tab)

- The control CLI is `node "{{root}}\tools\control\vidar.mjs"`; every `vidar.mjs` call below runs through it.
- Text before a tool call is dimmed until the turn ends: on a long turn, one short line naming what you're on; the result goes in the final reply.
- End a turn waiting on a background agent with a line naming the agent; a finished turn ends with the verdict or the question.
- A call that is the user's to make never goes inline as an option list: if the turn cannot continue, an Ask card; otherwise `vidar.mjs ask "<q>" --choice a,b --pending --context "<what it's for>"` (MCP `ask`, `pending: true`) and end the turn. Question: Title Case topic, colon, sentence-case question. Choices Title Case; one `--detail` per choice with its trade-off; the pick's label ends `(Recommended)` (drawn as a star), never "pick" in a detail. The reply holds the diagnosis only: no option list, no repeat of the details. When the user answers a pending ask in the thread instead of from Relay, run `vidar.mjs unpend` (MCP `unpend`) before acting on the answer; a Relay answer or a tab-card answer (`Answer to pending question <id>: ...`) is already cleared. Detached (`vidar.mjs` answers `err no requester`): every call goes to an Ask card in the thread, never to Relay.
