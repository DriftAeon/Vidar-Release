# Acme Rules

Keep every change small and reviewed before it lands.   

Ask first.

## Build

- Run the build with `npm run build` before every commit.
- Short one here.
- Keep build output in C:\Projects\Acme\dist and never commit it.
  The release script copies it from there.
- Tests run through the shared harness script:
```sh
# run from the repo root
npm test -- --reporter dot
```

## Style

+ Use sentence case in commit bodies and keep subjects short.
+ Wrap commit bodies at seventy-two characters.
  - A nested detail stays with its parent item.

<!-- tools table -->
| Tool | Use |
|---|---|
| npm | builds and tests |

- Lint too.
