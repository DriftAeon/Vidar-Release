---
name: handoff
description: Write a session handoff file so a fresh session can continue the work. Use when the user says handoff, when the context gate asks for one, or before stopping at a context limit.
---

# handoff

Write one markdown file, then stop. The next session starts from it (`/catapult`).

Path: `$env:VIDAR_AGENT_HOME\handoffs\<cwd-slug>\<YYYY-MM-DD-HHmm>-<sid8>.md`

- `<cwd-slug>`: the session's working directory with every run of non-alphanumeric characters replaced by one `-` (`D:\Work\My App` becomes `D-Work-My-App`).
- `<sid8>`: the first 8 characters of the session id. If the context gate gave an exact path, use that path as is.
- `VIDAR_AGENT_HOME` is set in a Vidar Bare tab. If it is empty, say so and ask where to write; never guess a folder.
- Create the folder if needed. One Write. After that the only change is one appended line `Answer: <question> -> <answer>` each time the user answers one of its Questions (the context gate asks for it); never rewrite or edit anything else.

Headings, in this order, each short:

```
# State
What is done, what is half done, and the evidence (commands run, results). Facts only.

# Next
The next concrete steps, first one first.

# Paths
Files, folders and branches that matter, one per line.

# Questions
Open decisions and anything the user still has to answer. Write "None" when empty.
```

Footer, after the Questions section: a `Session: <full session id>` line, then the output of `git status --short` run in the working directory (omit the block outside a git repository).

Rules:

- Name things by path and command, not by memory of the conversation; the reader has none.
- Background agents still running: wait for them, absorb their reports, then write.
- Do not paste large outputs; point to the file that holds them.
