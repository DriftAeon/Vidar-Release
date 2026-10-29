---
name: vidar-control
description: Drive a running Vidar from inside one of its tabs. Spawn, prompt, wait on, list or focus tabs, show a file, ask the user, run a Flow. Use to open a new tab.
---

# vidar-control

In a Codex Bare tab the vidar_drive MCP tools come first: same ten verbs (`state`, `read`, `show`, `focus`, `prompt`, `spawn`, `ask`, `unpend`, `wait`, `flow`), same cards, same one-line replies, `isError` where the CLI would exit non-zero. MCP `spawn` and `flow start` default `--cwd`
to the folder the session was launched in and resolves a relative `brief` against it. The CLI below is the fallback
when those tools are not listed; `<root>` is the folder in the control CLI line of your Vidar instructions.

Works from any Vidar tab (PTY or Falcon-hosted). Do not pre-check `VIDAR_TAB` or `FALCON_SESSION`:
run the verb; outside a tab the CLI itself exits 4 and says so, and that is the check. One bus round trip per
call, one line back.

```
node "<root>\tools\control\vidar.mjs" state [--json]
node "<root>\tools\control\vidar.mjs" read [--bytes n]
node "<root>\tools\control\vidar.mjs" show <path> [--focus]
node "<root>\tools\control\vidar.mjs" focus <tab>|workbench
node "<root>\tools\control\vidar.mjs" prompt <tab> [--notify] [--report p] <text...>
node "<root>\tools\control\vidar.mjs" spawn <agent> --model m [--cwd p] (--brief path | --text t) [--title t] [--notify] [--report p]
node "<root>\tools\control\vidar.mjs" ask <question> [--choice a,b,c [--detail text]...] [--placeholder text]
node "<root>\tools\control\vidar.mjs" unpend [id]
node "<root>\tools\control\vidar.mjs" wait <tab> [--report path] [--timeout s]
node "<root>\tools\control\vidar.mjs" flow start --template <id> (--input <text> | --input-file <path>) [--cwd <path>]
node "<root>\tools\control\vidar.mjs" flow start --graph <json-path> [--input <text> | --input-file <path>] [--cwd <path>]
node "<root>\tools\control\vidar.mjs" flow status <run-id>
node "<root>\tools\control\vidar.mjs" flow wait <run-id> [--timeout <s>]
```

Quote the script path: a root with spaces breaks an unquoted one.

`<tab>` is a tab id or a tab name (the exact title, case-insensitive; zero or several matches fail like an unknown id).
`wait` supersede is keyed on the ref as typed (an id and a name for one tab are two waits), and `wait` takes printable ASCII only.

- `state` — `active=<id> tabs=<n>` then `id kind agent title` per tab (every tab; the text line cuts a title at 48 chars).
  `--json` returns the same fields with full titles, never a whole snapshot dump.
- `read` — own tab only, byte-capped (default 4000, `--bytes n`); returns the live transcript tail,
  possibly mid-turn.
- `show` — `.md`/`.txt` under the repo open in Document; `.png`/`.svg`/`.html` must be a name
  directly inside `bridge\display` (the visual-review gate), nothing else. Returns
  `shown <pane> <name>`. A display file is selected in the Display list with its Approve/Deny
  gate; `err not listed in display: "<name>"` if the list doesn't have it. `--focus` reveals the
  workbench on the matching sub-tab (Document or Display).
- `focus` — `focused <target>`; an unknown tab id is `err no tab "<target>"`.
- `prompt` — types `<text>` into `<tab>` and submits it; a human approves first (card queue below).
  Returns `delivered <tab>`. Flags go between `<tab>` and the text only: from the first non-flag
  word on, everything is text, verbatim (a `--notify` inside the text is text).
  With `--notify` the prompt goes straight to the tab's host instead (both tabs must be
  Falcon-hosted) and returns `delivered <tab> notify`; see lane-done push below.
  `err tab not ready` (rendered tab not accepting yet: retry later; nothing was sent); `err not delivered` (the host refused it after the hand-off; the text is back in the tab's composer, so do not retype it); `err raw tab` (never retry);
  `err no tab "<tab>"` for a closed one; raw and closed refuse before the card.
- `spawn` — opens a new tab for `<agent>` (`--model` required, a missing one is a usage error, exit 1, no card; `--cwd` optional); a human approves first.
  Returns `spawned <id>`; refuses `err no rendered variant for agent "<agent>"` before showing the
  card if the agent has no rendered body. `--brief <path>` (read by the client; a missing file is a
  usage error, exit 1, no card) or `--text <t>` is the first prompt, required (neither is a usage error),
  1-65536 bytes, no NUL, on the same card; only a Falcon-hosted agent (Claude) takes one, others get
  `err not a hosted agent` before the card. `--title` names the tab, else the app gives it a themed name. Returns `spawned <id> prompted`, or `err prompt <reason> (spawned <id>)` when the tab
  opened but the prompt did not go in (the tab stays open; do not re-send blindly, `read`/`state` first).
- `ask` — asks the user `<question>`, shown in your tab and in Relay (an overlay while your tab is on screen), never the approval modal; the first answer wins, from either. Up to 6 `--choice` values (the nth repeatable `--detail "<text>"`, 0-120 printable
  ASCII, describes the nth choice; needs `--choice`, never more than the choices) and an
  optional `--placeholder`. Without `--pending` it blocks until answered (about 280 s, then `err expired`) and returns `answered choice=<c> comment="<text>"`.
  A hosted Claude tab must use `--pending` or AskUserQuestion, not the blocking form.
  `ask --pending` returns at once (`ok pending <id8>`): no expiry, hosted
  tabs only, no `--placeholder`; optional `--context "<line>"` (1-80 printable ASCII) is the Relay header text. The user's answer arrives later as the tab's next user message,
  `Answer to pending question <id8>: choice=<json> comment=<json>`. Never wait or poll for it.
- `wait` — blocks until another rendered tab's state chip reads idle; no card. Returns
  `done <tab> report=<path|->` (`--report` is only echoed back, never read). `err dead` if the tab
  is gone or its chip reads Stopped/Disconnected; `err timeout` (exit 2) after `--timeout` seconds
  (default 600, max 3600); `err raw tab`, `err own tab` refused up front. Done needs the chip seen
  busy since the wait began, so `prompt X; wait X` blocks until that turn ends; on a tab that stays
  idle, done arrives after 10 s. At most 4 waits in flight per tab (the tab's CLI and its MCP
  server share them), 16 across all tabs (`err busy` past that); a new wait from the same tab on
  the same target replaces the old one, which answers `err superseded`. Closing the waiting tab
  ends its wait (`err requester gone`). A swap mid-wait answers `err bus gone` within about a
  second (exit 3); a webview reload or a crash still leaves the client hanging until `--timeout`
  + 15 s, then exit 2.

`flow start` prepares a straight chain with 1-6 Agent nodes and asks for approval on a Run Flow card. The card shows the full Input, every task and execution modifier. Approve saves and starts the frozen graph; returns `started graph=<id> run=<id>`. Deny returns `denied <comment>` with no graph or run. A save failure returns `err save <reason>` and starts nothing; `err flow busy` means another Flow run is live. A template needs one Input source; `--graph` reads JSON with `name`, `nodes`, and `edges`. MCP `flow` takes `action:"start"`, `template_id` plus `input` or `graph`, and optional `cwd`. With `graph`, `input` fills the graph's single Input node `content` field (exactly one Input node; refused when that field already holds different text).

An agent node may carry `"vault":"<Rune Vault id>"`: the vault it loads, which sets its Permission Mode and the exact tool names it may use without asking; unset = its agent's stock vault. The Run Flow card shows each node's Vault, Permission Mode and Allows. An unknown vault, or another agent's stock vault, is refused. A `permission-allowlist` addon is dropped on receipt; every tool request outside the vault's allows queues for approval.

A custom graph is a chain Input → 1-6 agents → Output; every key below is required except `x`/`y` (Vidar lays the graph out itself), `subtitle` and `addons`. Unknown keys are refused with the allowed set named. `model` must be a wired model id; ports are `out` → `in`; each agent needs a `task` field. This graph is tested (`tests/fixtures/flow-minimal-graph.json`):

```json
{ "name": "Summarize",
  "nodes": [
    { "id": "input", "kind": "input", "title": "Input",
      "fields": [{ "k": "shape", "v": "free-text" }, { "k": "content", "v": "Summarize the README." }],
      "inputs": [], "outputs": ["out"] },
    { "id": "summarize", "kind": "agent", "title": "Summarize", "model": "claude-sonnet-5",
      "fields": [{ "k": "task", "v": "Summarize this in three bullets: {{input}}" }],
      "inputs": ["in"], "outputs": ["out"] },
    { "id": "output", "kind": "output", "title": "Output", "fields": [], "inputs": ["in"], "outputs": [] }
  ],
  "edges": [
    { "id": "e1", "from": { "node": "input", "port": "out" }, "to": { "node": "summarize", "port": "in" } },
    { "id": "e2", "from": { "node": "summarize", "port": "out" }, "to": { "node": "output", "port": "in" } }
  ] }
```

`flow status <run-id>` and `flow wait <run-id> [--timeout <s>]` need no card. Both return one JSON line with the run id, status, nodes in chain order, each status and summary, and each absolute `output_file`. Read output files yourself. `wait` returns when the run is terminal; `err timeout` uses the 1-3600 s clamp. A denied start has no run id to wait on.

Lane-done push (`--notify [--report p]` on `prompt` and `spawn` with a prompt): after the card is
approved and the prompt is accepted, your tab later receives one line as a new prompt (no card; the
approval was the consent): `lane done|dead|timeout <tab> report="<p>"` (`report=-` without
`--report`; the path is echoed, never read; <= 400 bytes, printable, no `"`). done = the turn your
prompt started has ended; order-correlated (if the tab was mid-turn at send, that turn's end is
skipped). dead = the tab closed or reads Stopped/Disconnected for 3 s running; timeout = 600 s after the send. If you
are mid-turn, the host queues the line behind your turn; if it cannot be delivered the user gets a
toast instead. At most 4 outstanding per requesting tab (`err busy` before the card). Spawn replies
end ` notify` when a subscription was registered. Subscriptions live in the window: a swap or reload
drops them silently, so after a swap re-check with `state` and `read` instead of waiting.

Docked vs jettisoned: a Falcon-hosted session is docked while `state` answers `active=…`; a
jettisoned one gets `err no requester` (exit 1) on every verb. The client sends `VIDAR_CTL_SECRET`
with `FALCON_SESSION` when Falcon exported one; a session without it may be refused after the swap
that introduced it (restart that tab).

`prompt`/`spawn` share one approval-card queue: 3 in flight at a time (`err busy` past that),
each card self-expires after ~280 s (`err expired`) so an abandoned card cannot wedge the queue.
An Approve with under 40 s left on the card also answers `err expired` and does nothing.
Approve/Deny on the card returns `denied <comment>` on refusal. After a `spawn` or `prompt`, a
timeout (exit 2) or `err expired` means check `state` before retrying: the tab or prompt may exist.

Exit codes: 0 ok, 1 `err <reason>` (also printed on stdout), 2 timeout (incl. `wait`'s `err timeout`), 3 bus unavailable, 4 no
token in env (not a Vidar tab).
