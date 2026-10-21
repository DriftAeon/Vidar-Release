# Vidar app layer (Raw tab)

- While a Vidar tab holds the session no port is needed: `node tools\control\vidar.mjs` is the `ctl.*` bus CLI (verbs and usage: its header); try it before asking for `-Debug`. `err no requester` means no tab holds it (Jettisoned, or started outside Vidar): the bus is down for this session, so never retry it.
- To show the user something, put one .svg/.html/.png in `runtime\bridge\display`; Relay signals it and holds Approve/Deny, and Document lists it read-only under Display (`docs\reference\workbench-display-gate.md`). Briefs, findings and other .md go in `runtime\bridge\display\reviews\`, never the top of `display`.
