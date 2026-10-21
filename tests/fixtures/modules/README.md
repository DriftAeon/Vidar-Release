# Module fixtures

Each case folder is a packs root: `<case>/<pack-id>/pack.json`, scanned like `content/packs/`. Rules live in `contracts/modules.json`; the Rust scanner (U1) and `tools/release/modules-resolve.mjs` (U3) must reach the same outcome per case (the node side checks the `owns`, `agent.flow.script` and `agent.gatewayEnv` rules: `checkPackRules`). `tests/modules-contract.test.mjs` checks that every case folder has a row here.

| Folder | Outcome | Rule |
| --- | --- | --- |
| ok-gateway | accept | Gateway agent `acme`, dependsOn claude, keyVar `ACME_API_KEY`, key dep probe equals keyVar |
| ok-content | accept | Content `notes` with profiles {runner claude, dir agents}, runner in dependsOn |
| ok-plain | accept | Pack with no module block: implicit {kind content, level optional} |
| ok-owns | accept | Agent `runner` with `owns`, `agent.setup.order` and `agent.flow.script` naming one of its `owns` files |
| ok-capability | accept | Required-hideable capability with a DOM host and all `when` gates |
| ok-service-capability | accept | Optional hostless capability |
| bad-id-folder | reject | Id `other` does not match folder `acme` |
| bad-id-pattern | reject | Id `1acme` fails idPattern |
| bad-kind-unknown | reject | Kind `widget` is not a kind |
| bad-kind-surface | reject | A pack cannot claim a core surface |
| bad-baseurl-http | reject | Gateway baseUrl is `http://` |
| bad-keyvar-template | reject | keyVar `OTHER_API_KEY` is not `ACME_API_KEY` |
| bad-keyvar-anthropic | reject | keyVar `ANTHROPIC_API_KEY` has a forbidden prefix |
| bad-env-key | reject | Env key `ANTHROPIC_BASE_URL` is off the contract's gateway.envAllowlist |
| bad-gateway-env | reject | A pack declares `agent.gatewayEnv` (the allowlist is the contract's) |
| bad-flow-script | reject | `agent.flow.script` is not one of the pack's `owns` files |
| bad-owns-dotdot | reject | An `owns` path has a `..` segment |
| bad-owns-overlap | reject | `alpha` owns `tools/shared/`, `beta` owns a file inside it: both rejected |
| bad-dep-text | reject | Dep install note contains `%` |
| bad-duplicate-id | reject | Pack id `relay` duplicates the core relay module |
| bad-dependson-cycle | reject | `alpha` and `beta` depend on each other: both rejected |
| bad-profiles-runner | reject | profiles.runner claude is not in dependsOn |
| bad-oversize | reject | pack.json exceeds limits.manifestBytes |
