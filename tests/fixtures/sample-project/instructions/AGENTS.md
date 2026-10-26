# Agent notes

slugkit is a tiny CLI library; keep changes small and reviewable.

- Run `npm test` before you finish; it takes about a second.
- Do not add dependencies. The built-in `node:test` runner is enough.
- Slugs are lowercase ASCII joined with `-`; changing that is a breaking change and needs a version bump in `package.json`.
- Leave the README layout list in step with the files in `src/`.
