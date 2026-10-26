# slugkit

A tiny command line tool that turns titles into URL slugs.

```
node src/cli.js "Hello, World!"
hello-world
```

## Layout

- `src/slug.js` - the slug function
- `src/words.js` - helpers that split and trim text
- `src/cli.js` - reads titles from the arguments and prints one slug per title
- `test/slug.spec.mjs` - tests, run with `npm test`

## Notes

Slugs are lowercase, ASCII only, and joined with `-`. Accents are dropped, and
long titles are cut at 60 characters on a word boundary.
