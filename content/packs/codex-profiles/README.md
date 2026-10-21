# Codex Profiles (optional pack)

Five Codex custom agents that split work by role: one reviews, one searches, one executes, one
attacks a plan or diff, one plans. Vidar does not read this folder at runtime and runs the same
without it. Nothing is installed until you copy the files yourself.

## The profiles

| Profile | Sandbox | What it does |
|---|---|---|
| Reviewer | read-only | Reviews named files or a diff against the brief's questions. Returns findings and the smallest next step. Runs `gpt-6-astra` at low effort. |
| scout | read-only | Bounded evidence searches and summaries. Returns `path:line` and a short answer, labelled VERIFIED or INFERRED. |
| builder | workspace-write | Executes a settled brief inside its named paths to a green gate. Stops after two failures at the same problem and reports. |
| critic | read-only | Adversarial review of a plan or diff: verifies each numbered claim against source, then attacks the design. |
| planner | read-only | Surveys the named source and returns an implementation plan in file-disjoint waves, as text. |

None of them delegate: each file sets `[agents] enabled = false`. The model names are starting
points; check your account has them, or delete the `model` lines to inherit your own.

## Install (opt-in, reversible)

Codex loads user-level custom agents from `~/.codex/agents/`. Copy the files there; `-n` leaves any
agent you already have under the same name untouched. From a prompt in the Vidar folder:

```
! mkdir -p ~/.codex/agents && cp -n content/packs/codex-profiles/agents/*.toml ~/.codex/agents/
```

Or in PowerShell from the Vidar folder:

```
New-Item -ItemType Directory -Force "$HOME/.codex/agents" | Out-Null; Get-ChildItem content/packs/codex-profiles/agents/*.toml | ForEach-Object { $t = Join-Path "$HOME/.codex/agents" $_.Name; if (-not (Test-Path $t)) { Copy-Item $_ $t } }
```

Start a new Codex session and name the agent in the ask ("have the scout find where X is set").

To remove them, delete the five files:

```
! rm ~/.codex/agents/reviewer.toml ~/.codex/agents/scout.toml ~/.codex/agents/builder.toml ~/.codex/agents/critic.toml ~/.codex/agents/planner.toml
```

To copy them into a single project instead of your whole account, use `<project>/.codex/agents/`.

## Writing briefs for them

- Settle the scope before spawning: an executor faithfully expands a wrong brief.
- Name the paths it may touch, the command that proves it worked, and the report you want back.
- Read-only profiles return text; the session that asked files it.
- All profiles draw on the one Codex account meter, so run them one at a time.
