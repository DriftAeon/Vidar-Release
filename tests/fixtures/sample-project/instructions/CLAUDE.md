# slugkit

Small Node CLI that turns titles into URL slugs. ES modules, no dependencies.

## Commands
- `npm test` runs the tests in `test/` with the built-in runner.
- `node src/cli.js "Some Title"` prints the slug.

## Conventions
- Keep `src/slug.js` free of I/O; only `src/cli.js` reads arguments or prints.
- Add a test in `test/slug.spec.mjs` for every behaviour change.
- Prefer small pure functions in `src/words.js` over new files.
