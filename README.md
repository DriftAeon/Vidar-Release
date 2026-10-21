# DriftCell Vidar

Vidar is a Windows desktop terminal for working with coding agents. It is built with Tauri 2, Rust,
TypeScript and xterm.js. Each tab is a real PowerShell session; Rendered tabs draw an agent's
conversation as a page instead of scrolling text. A session host called Falcon keeps Rendered
sessions running across restarts of the app.

## Status

Early software with rough edges. Windows 11 only; Windows 10 and other systems are untried. It ships as
source to build yourself, with no official prebuilt releases yet.

## Requirements

- Windows 11 with Microsoft Edge WebView2 (included in Windows 11).
- PowerShell 7 (`pwsh`).
- Node.js 22 or newer.
- Rust stable for the MSVC target (`x86_64-pc-windows-msvc`), and the Visual Studio C++ build tools
  with a Windows SDK. Checked with Rust 1.98, Visual Studio 2026 Community (MSVC 14.5x) and
  Windows SDK 10.0.26100.
- Git.

Agent CLIs (Claude Code, Codex and others) are installed separately; `START-HERE.md` covers them.

## Build From Source

Clone under your user profile: a new folder directly under `C:\` can be changed by every signed-in
account on the PC (`SECURITY.md`, Known Limits). From the repository root, in PowerShell 7:

```
npm install
npm run build
npm run tauri build
```

- `npm install` installs the frontend and the Tauri CLI.
- `npm run build` runs the copy and UI lints, `tsc` and the Vite build into `dist/`. `npm run tauri build`
  runs it again as its before-build step.
- `npm run tauri build` compiles the app; installer bundling is off (`bundle.active` is false in
  `src-tauri/tauri.conf.json`), so it produces only the exe, at `src-tauri/target/release/vidar.exe`
  unless you set `CARGO_TARGET_DIR`.
- `npm run build:falcon` builds Falcon, the session host, and installs it for this checkout. It runs
  `npm run build`, copies the Falcon page into `dist-falcon/` and runs `cargo build --release` on
  `src-falcon/`. It then copies `falcon.exe`, the Claude sidecar and the Agent SDK from `node_modules`
  into `runtime\bridge\falcon\bundles\src-<id>\` and points `runtime\bridge\falcon\current.json` at
  that folder. Vidar starts Falcon from there, not from `src-falcon/target/`.
- Quit Vidar before you run `npm run build:falcon`. While a Falcon host for this folder is running,
  the script still copies the new bundle but leaves `current.json` alone and exits with code 2. The host
  exits about five minutes after its last tab closes; then run the script again.
- Falcon runs the Claude CLI and Codex you installed (`claude.exe` on `PATH` or in
  `%USERPROFILE%\.local\bin`, Codex from npm) and needs `node` on `PATH`. Rendered tabs for an agent
  stay unavailable until its CLI is installed.
- Tests: `npm test` runs the JavaScript suite. `cargo test --manifest-path src-tauri/Cargo.toml` needs
  `dist/` from `npm run build`; `cargo test --manifest-path src-falcon/Cargo.toml` needs `dist-falcon/`
  from `npm run build:falcon`.

Keep `vidar.exe` in its folder: Vidar finds its scripts and settings beside it, and saves its
state there. `vidar.example.json` shows the settings file. `START-HERE.md` walks through first launch
and your first tab.

## Licence

Apache-2.0. See `LICENSE.txt` and `NOTICE`.

## Trademarks

Third-party product names and logos belong to their owners and appear only to identify the tools
Vidar works with; see `NOTICE`. Vidar is not affiliated with or endorsed by Anthropic, OpenAI or any
other vendor.

## Claude Sign-In

Vidar has no Claude login of its own and runs no service between you and Anthropic. Every Claude tab
runs the Claude Code you installed, unmodified: terminal tabs start it directly, and Rendered tabs
drive it through Anthropic's Claude Agent SDK. Signing in runs Claude Code's own `claude auth login`,
which completes in your browser, and usage counts against your own account. Anthropic's
[legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) does not prevent
"an end user from signing in to the unmodified Claude Code binary with their own Claude
subscription", and its
[Agent SDK help article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
says "You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your
subscription limits."

Vidar's code never parses your Claude or Codex login file or sends it anywhere. It checks that the
file exists, reads its file ID and last-write time (metadata only) across the separate homes Vidar
keeps, and hard-links it between them, so you sign in once per agent (one helper copies the Claude
file when a link fails). A sign-in that changed is never overwritten: when a home's sign-in and the
shared one both changed, that tab keeps its own. Vidar is a free tool that runs on your PC, not a hosted
or commercial service. If Anthropic wants any of this done differently, it will change; open an
issue to reach the maintainer.

## Not The Infostealer

This project is unrelated to the Vidar malware family (the "Vidar Stealer"). Get this one only from this
repository and build it yourself; there are no official downloads. Treat any binary offered elsewhere under this name as
untrusted.

## Security

Report problems as described in `SECURITY.md`, which also lists known limits.
