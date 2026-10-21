# Contributing

Issues and pull requests are welcome. Vidar is early and maintained by one person, so replies can
take a while, and larger changes are best raised as an issue before you write them.

## How Changes Land

Vidar is developed in a private repository and published here as snapshots. An accepted pull
request is applied there by hand and reaches this repository with the next snapshot, whose commit
credits you with a `Co-authored-by` line using the name and email from your sign-off.

## Sign Your Commits

Every commit in a pull request needs a `Signed-off-by` line, which certifies the
[Developer Certificate of Origin](https://developercertificate.org/): you wrote the change, or
have the right to submit it under this project's licence (Apache-2.0).

```
git commit -s
```

adds the line from your git name and email. A pull request with an unsigned commit can't be taken
until it is signed (`git commit --amend -s`, or `git rebase --signoff` for several).

## Before You Open A Pull Request

- `npm run build` and `npm test` pass.
- `cargo check` passes for `src-tauri/Cargo.toml` and `src-falcon/Cargo.toml` if you touched Rust.
- Security problems go through `SECURITY.md`, not a public issue.
