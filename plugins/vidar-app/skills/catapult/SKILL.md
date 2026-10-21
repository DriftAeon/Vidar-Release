---
name: catapult
description: Start from a handoff file written by the handoff skill. Use when the user passes a handoff path, says catapult, or opens a session meant to continue earlier work.
---

# catapult

Continue earlier work from a handoff. Argument: a handoff path (optional).

1. A path was given: read that file.
2. No path: find the newest handoff for the current directory.
   - Slug: the working directory with every run of non-alphanumeric characters replaced by one `-` (`D:\Work\My App` becomes `D-Work-My-App`).
   - Folder: `$env:VIDAR_AGENT_HOME\handoffs\<cwd-slug>\`. Files are named `<YYYY-MM-DD-HHmm>-<sid8>.md`; the newest by name wins.
   - `VIDAR_AGENT_HOME` empty, or no file found: say so in one line and stop; do not search elsewhere.
3. Read the file whole. Its headings are State, Next, Paths, Questions, then a footer with the old session id and `git status --short`.
4. Check the State claims that decide the next step against the working tree (`git status --short`, the named files). Where they differ, say how in one line and trust the tree.
5. Reply with three lines at most: where the work stands, the first step from Next, and any open Questions. Then start that first step unless a Question blocks it.

Never edit the handoff file. `Answer: <question> -> <answer>` lines at its end were appended by the session that wrote it and settle those Questions. A user answer given to this session goes into its own notes, not into the file.
