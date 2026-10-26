# Runes e2e seed

`seed.json` is the one config state every runes e2e layer starts from: `tools/sandbox/runes-seed.mjs --to <base>`,
the Rust snapshot test and the sandbox launcher materialise it the same way. `cases` names the entry behind each
regression case (run 2026-10-24-runesets-full-stack, plan v2 table 1-11).

## Materialising
- `files[]`: `path` is `<APP>/…`, `<HOME>/…` or `<WORK>/…` with `/` separators; no empty, `.` or `..` segment.
- Tokens: `<APP>` = `<base>\app`, `<HOME>` = `<base>\profile`, `<WORK>` = `<base>\work\runes-e2e`,
  `<WORK_SLUG>` = `memory_slug(<WORK>)` (`rules/import/memory.rs`), `<MEMORY_LIB>` = `slug("memory-" + <WORK_SLUG>)`
  (`rules/import/split.rs`). The Rust side calls those two functions; Node twins them in `runes-seed.mjs`.
- `text`: tokens replaced verbatim, bytes written as UTF-8, LF, no BOM.
- `json`: tokens replaced inside every string (keys and values) of the parsed value, then written as 2-space
  pretty JSON plus `\n` (`JSON.stringify(v, null, 2)` = `serde_json::to_string_pretty`, key order kept).
- `steps[]` run after the files: `git-worktree` = `git init -b main` in `repo`, `git add` the `add` list, commit
  (`user.name=e2e`, no signing, `GIT_*` env dropped), `git worktree add -b <branch> <worktree>`.
- `<APP>/contracts/module-bundles.json` and `<APP>/runes-e2e/` replace the install's own in a sandbox; the
  launcher's next Start restores the shipped files.

## Snapshot normalisation (every snapshot under `snap/`)
1. Strip a leading `\\?\` (also JSON-escaped `\\\\?\\`) before any comparison.
2. Replace the token roots longest first (`<WORK>` before `<APP>`/`<HOME>` when nested), matching both the
   canonicalised and the as-given temp path, case-insensitive, then `<WORK_SLUG>` and `<MEMORY_LIB>`.
3. Match each root in both slash forms and JSON-escaped (`\\`); write the token followed by `/` separators.
4. Drive letters compare case-insensitive; a short (8.3) temp path is canonicalised before replacing.
5. `date`, `importedOn` and any `YYYY-MM-DD` in an `origin:` header become `<DATE>`; timestamps become `<TS>`.
6. Ordering: arrays the reader builds from a folder scan sort by path; object keys keep the writer's order.
7. Snapshots are LF (`.gitattributes`); `UPDATE_RUNES_SNAP=1` rewrites them, never a hand edit.
