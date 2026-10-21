# Vidar

Vidar is a Windows desktop terminal built for working with coding agents. It is a harness (the
terminal, workbench, bridge and gates) plus packs that plug in: agents, voice, profiles and
content. The ＋ menu offers the agents this build includes, and you pick which one is primary.
Each tab is a real PowerShell session. Rendered tabs draw the conversation as a page instead of
scrolling text. It is early-stage software with rough edges.
Vidar needs Windows 11 and PowerShell 7 (`pwsh`); have both in place before you download it.
This page gets you from the zip to your first tab.

## What You Need

Required:

- Windows 11, the only version Vidar has been tried on; Windows 10 is untried. Vidar draws its UI
  with Microsoft Edge WebView2, which Windows 11 already has.
- PowerShell 7 (`pwsh`), not the Windows PowerShell 5.1 that ships with Windows. Every tab is a
  PowerShell 7 session and Vidar's scripts require it: `winget install Microsoft.PowerShell`
- Node.js 22 or newer, which is not bundled: `winget install OpenJS.NodeJS.LTS`. Rendered tabs
  run through a Node script.
Optional: Git.

## Your Agents

<!-- agents:start -->
### Claude

- Install Claude Code in PowerShell: `irm https://claude.ai/install.ps1 | iex`.
- The Dependencies page checks for `claude.exe`, `claude.cmd` or `claude.ps1`; press Recheck after
  installing. If it reads Installed After Launch, restart Vidar. Claude Rendered tabs need `claude.exe`.
- Log in inside your first Claude tab: it runs Claude Code's own sign-in, and later Claude tabs
  share it.

### Codex

- Codex tabs can run as Rendered tabs: the conversation drawn as a page instead of scrolling text.
- Install the Codex CLI on your PATH in PowerShell after Node: `npm install -g @openai/codex`.
  Check it with `codex --version`; it should print a version. Installing it does not log you in.
- Choose Codex for your first tab, then Select Workspace… and a project folder: Codex never starts in your
  home folder. Log in inside the tab. If you are not signed in, the model
  control reads Not Logged In; open it and choose Log In With ChatGPT or Log In With API Key.
  No separate terminal is needed.
- If a Codex tab says it cannot start, check that `codex --version` works in a fresh PowerShell
  window.
- The desks pack provides Astra reviews by Codex and needs the Codex CLI.
- Read-aloud doesn't read Codex sessions yet, so a Codex-only setup gives it nothing to read.
- Vidar reads `~\.codex` for Codex's profile folder. The desks pack asks you to point Codex's
  `notify` hook in `~\.codex\config.toml` at this folder. You make that edit by hand, and undo
  it the same way.

### Gemini

Signs in through its own CLI, outside Vidar; its tabs use that sign-in.

### Local

Signs in through its own CLI, outside Vidar; its tabs use that sign-in.

### Pi

Signs in through its own CLI, outside Vidar; its tabs use that sign-in.
<!-- agents:end -->

## Download And Check The Zip

1. Download `Vidar-<version>.zip` from the Releases page.
2. Compare its hash with the SHA256 in that release's notes. In PowerShell:

   ```
   Get-FileHash .\Vidar-<version>.zip -Algorithm SHA256
   ```

   If the two hashes differ, do not open the zip; ask for a fresh copy.

## Extract It

Extract the zip under your user profile, for example `C:\Users\<you>\Vidar`. Do not use Program
Files: Vidar keeps its settings and state inside its own folder, and Program Files is read-only
for normal users.

Then unblock the files, since Windows marks anything downloaded as untrusted. In PowerShell:

```
Get-ChildItem -Recurse "$env:USERPROFILE\Vidar" | Unblock-File
```

Adjust the path if you extracted somewhere else.

## First Launch

Double-click `vidar.exe` in the extracted folder. Keep `vidar.exe` where it is: it finds
everything else beside it. The exe is unsigned, so Windows SmartScreen warns on first run: choose
More Info, then Run Anyway.

Everything Vidar saves stays in that folder: `vidar.json` (your settings), `runtime\vidar-state.json`, and
`runtime\bridge\`. Delete the folder and Vidar is gone. It opens with no tab; the ＋ button (or right-click
on it) is where you start.

## Your First Tab

The Dependencies page opens on first launch while a required tool is missing. Install what it
lists, then press Recheck. A tool that reads Installed After Launch needs Vidar restarted.

1. Press the ＋ button and choose your agent. With no saved workspace the list offers Home, which
   opens the tab in your default folder (your home folder unless `defaultCwd` is set in
   `vidar.json`), and Select Workspace…, which opens a folder picker and saves the folder as
   your first workspace.
2. Choose Rendered (or Raw for a plain terminal tab).
3. Log in as your agent's section under Your Agents says.
4. Type a message in the composer and send it. That is your first turn.

Vidar may show a background helper (Falcon) that keeps Rendered tabs alive; it closes itself a
few minutes after you quit. Leave it alone.

## Core And Optional

The core is the terminal, the launcher, Rendered tabs and their host, the workbench, and
Settings. Everything else is off unless you add it, and Vidar hides what is missing:

- Desks pack: off until you set it up; see `tools\desks\README.md`.
- Character packs: the animated character panel. None ship, so the panel stays hidden.
- Voice (dictation, wake word, read-aloud): the scripts and the stock voice slot manifests ship in
  `content\local-voice\` and `content\packs\voice-stock\`, but the Python environment
  (`content\local-voice\.venv`) and the speech models are not in the zip, so nothing works until
  you install them. Settings › Audio › Voice Slots lists each missing piece with the line to run
  by hand; Vidar never downloads for you.

## What It Touches Outside Its Folder

Vidar reads the profile folder of each of the agents this build includes to show session status,
recent sessions, handoffs and your MCP servers. By default it
writes nothing there.

## Updating

There is no updater. Close Vidar, extract the new zip into a fresh folder, and unblock it as
above. Copy `vidar.json` across if you want to keep your settings.

## Rough Edges

- Built and tested on one machine. If something fails on yours, the error text and what you
  clicked are the most useful thing to send back.
