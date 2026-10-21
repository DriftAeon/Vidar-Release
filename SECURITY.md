# Security

## Reporting

Open a GitHub issue marked security, or file a private security advisory on this repository. Do not
post tokens, session contents or exploit details in a public issue; ask for the private advisory
route first if the report needs them.

## Threat Model

Vidar runs coding agents as your Windows user. Anything that can already run code as your user can do
what Vidar can: read your files, start processes and use the agent sign-ins on your account. Vidar
does not defend against a hostile process running as you; it limits what its own components accept
from other local processes.

## Known Limits

- **Launch settings are trusted (H2).** The launch keys in `vidar.json` decide what Vidar starts. Anything that
  can write the install folder can change them, including removing the guard keys, and can equally
  change the scripts and plugins Vidar launches. There is no separate pin on those keys.
- **Falcon frontend is unhashed (H4).** The Falcon frontend and `falcon.exe` load from the install
  folder without a hash check. Replacing them needs write access to that folder, so this is the same
  class as install-folder tampering.
- **Install folder permissions.** A new folder directly under `C:\` lets every signed-in Windows
  account change its contents by default, which opens H2 and H4 to other accounts on a shared PC.
  Vidar does not check this; clone or install it under your user profile.
- **Falcon host access (H3 residuals).** The Falcon host gives full control only to itself and to
  the install's `vidar.exe` (or, in a source checkout, the release or debug build under
  `src-tauri\target`). Every other client gets bus access: it can publish and subscribe, but it
  cannot subscribe to the control stream (`ctl.*`, other than the reply topic it named) and cannot
  show, hide or shut down the host. What remains:
  - A bus client can publish on any topic, control requests included, so it can answer an open
    prompt (`ask.open`) or name the `reply_to` topic for its own request.
  - A process running as your user can inject into or replace `vidar.exe`, and anything that can
    write `src-tauri\target` can replace the build that gets full control (the same class as H2).
  - A renamed `vidar.exe` gets bus access only, so its tabs cannot control the host.
  - Relaunches with `-Debug` open Chromium DevTools (CDP) debug ports that any local process can
    use to drive the UI.
  - Any process that can run programs can start the install's Falcon host itself.
- **Tokens (H11).** Integration tokens are wrapped with DPAPI in Windows Credential Manager. This
  stops generic credential harvesters only; code running as your user can still unwrap them. An
  older build cannot read wrapped tokens. Moving the install folder, or an administrator resetting
  your Windows password, means signing in again.
- **Codex Bare tabs (H10).** A Codex Bare tab trusts a project folder only when your own Codex config
  trusts it. Otherwise the tab warns you to trust the folder in your Codex config.
