# Rune import fixture (Bare onboarding)
- `source.md`: a rules file to split. It holds a fence right after a list item, a `+ ` list, a short list item and
  a short paragraph that merge into the brick before them, a table followed by a short item that must not merge
  into it, and a line with trailing spaces. The BOM and the CRLF line are added by the tests
  (`src-tauri/src/rules/import/mod.rs`, `tests/rune-import-cook.test.mjs`): git would rewrite both on disk.
- `normalised.md`: what a full keep cooks to (BOM, CRLF and trailing spaces gone, `+ ` bullets as `- `).
- `acme-claude-md/`: the writer's output for `source.md`, every brick kept and on row `claude-bare`
  (library `acme-claude-md`, source `~/Acme/CLAUDE.md`, date 2026-10-16). Byte goldens after CRLF to LF.
