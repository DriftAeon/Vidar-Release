# Agent Profiles (optional pack)

Four Claude Code subagent profiles that split work by cost: the main session plans, decides and
reviews; cheaper or narrower bodies do the searching, the mechanical edits and the adversarial
review. Vidar does not read this folder at runtime and runs the same without it. Nothing is
installed until you copy the files yourself.

## The profiles

| Profile | Model | Tools | What it does |
|---|---|---|---|
| Hound | haiku | read-only | Broad searches, presence checks, summaries of big logs or outputs. Returns `path:line` and a short answer, never file bodies. |
| Striker | sonnet | read + write | Executes a settled brief: build-fix-test loops, edits with a known target, smoke runs. Stays inside the brief's paths, stops after two failed fixes with a post-mortem. |
| Orion | opus | read-only | Adversarial review of a plan or diff: verifies each numbered claim against source, then attacks the design; returns a verdict and ranked findings. |
| Plan-O | opus | read-only | Surveys the source and drafts an implementation plan in file-disjoint waves, with verify steps, risks and open questions. Returns the plan as text. |

The usual loop: Plan-O drafts, Orion reviews the plan, Striker executes, Orion reviews the diff.
Hound takes any lookup that would otherwise pull large files into the main session.

Striker assumes Windows (it carries a PowerShell tool and PowerShell rules). On another OS, drop
`PowerShell` from its `tools:` line and the PowerShell sentences from the body.

For batches where a wrong fix round costs more than the tokens, make an Opus twin: copy
`Striker.md` to a new file (for example `Striker-O.md`), and change `name:` and set `model: opus`.

## Install (opt-in, reversible)

Claude Code loads user-level subagents from `~/.claude/agents/`. Copy the four files there; `-n`
leaves any profile you already have under the same name untouched. From a Claude Code prompt in
the Vidar folder:

```
! mkdir -p ~/.claude/agents && cp -n content/packs/agent-profiles/agents/*.md ~/.claude/agents/
```

Or in PowerShell from the Vidar folder:

```
New-Item -ItemType Directory -Force "$HOME/.claude/agents" | Out-Null; Get-ChildItem content/packs/agent-profiles/agents/*.md | ForEach-Object { $t = Join-Path "$HOME/.claude/agents" $_.Name; if (-not (Test-Path $t)) { Copy-Item $_ $t } }
```

Start a new Claude Code session; `/agents` lists them. To use one, name it in the ask
("have Hound find where X is set") or let the main session pick it from the description.

To remove them, delete the four files:

```
! rm ~/.claude/agents/hound.md ~/.claude/agents/Striker.md ~/.claude/agents/orion.md ~/.claude/agents/Plan-O.md
```

To copy them into a single project instead of your whole account, use `<project>/.claude/agents/`.

## CLAUDE_CODE_SUBAGENT_MODEL

An environment variable that sets the model for subagents that do not name one themselves
(generic agents, workflow stages without a `model:`). The four profiles here pin their own model
in their front matter. Setting it to `sonnet` keeps unnamed helpers off Opus, which is where
most of the cost saving comes from. Put it in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" } }
```

Leave it unset and unnamed subagents follow Claude Code's own default.

## Writing briefs for them

- Settle the scope before spawning: an executor faithfully expands a wrong brief.
- Name the paths it may touch, the command that proves it worked, and the report you want back.
- Read-only profiles (Hound, Orion, Plan-O) cannot write files; they return text and the main
  session files it.
- A background agent that hits a permission prompt waits for an answer that never comes. The
  Striker rules route file writes through Write/Edit for that reason; keep them.
