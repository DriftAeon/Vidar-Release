# Desks Pack (Opt-In)

Astra reviews: another agent session asks for a Codex reviewer, you approve it in Vidar, Astra
writes a findings file, and a Codex hook tells the asker it is done. Vidar works without this
pack; until it is set up, the Astra launcher row is hidden and Astra asks are refused with
"Desks Pack Not Set Up".

## What Is In It

- `astra-dispatch.ps1`: publishes a review request for Vidar to open.
- `codex-notify.ps1`: the Codex `notify` hook; writes `done.json` when a review finishes.
- `hidden-run\`: a small windowless wrapper for that hook (`build.ps1`, `hidden-run.cs`).
- `gemini-review.ps1`, `codex-meter.ps1`: optional helpers (a Gemini review, the Codex meter).
- `workbench.ps1`: reads the tray blocks in `bridge\workbench`; not part of Astra.

Not in it: the Vidar side (`src-tauri\src\open.rs`, `review.rs`) ships with Vidar and stays idle
without these scripts.

## The Gate

Vidar treats the pack as set up when `tools\desks\hidden-run\hidden-run.exe` exists and Codex is
installed. The exe is built locally and never exported, so a fresh copy starts with the pack off.
It shows as "Desks Pack" under Settings, Dependencies.

## Setup

You need the Codex CLI, logged in. Then follow the three steps in
`docs\reference\desks-astra-bridge.md`, section "Desks Pack (Opt-In)":

1. Build `hidden-run.exe` (this turns the gate on).
2. Point the `notify` line in `~\.codex\config.toml` at this Vidar folder.
3. Restart the Codex tab, finish one turn, and check `bridge\review\hook-alive.json` updated.
   Skip this check and reviews still run, but the asker never hears they finished.

Keep the scripts in `tools\desks\`: they find the Vidar folder from their own location, and the
`notify` line names this path.

## Opting Out

- Delete `tools\desks\hidden-run\hidden-run.exe`: the Astra row hides and asks are refused.
- Hide the Astra row in the launcher to stop spawning it; review asks still refuse only when the
  `desks` or `codex` dependency is missing.
