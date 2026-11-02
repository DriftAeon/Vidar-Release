# tools/sandbox

Sandbox loop and write gate for a Vidar zip: the live install and the real profile stay untouched until a build is proven. Details live in each script's header.

- `check-zip.ps1`: checks a release zip without extracting it (no `runtime/` entry, required paths present).
- `launch.ps1`: extracts a zip into a sandbox with a fake user profile and fresh-logon env, refuses any redirect that lands in the real profile, starts `vidar.exe` (`-DryRun` stops before starting).
- `zip-boot.ps1`: unseeded boot check, run after `local-zip.ps1` on the fresh zip: launches it in a `%TEMP%\vidar-zipboot-<stamp>` sandbox with no seeded Falcon bundle, DevTools on port 9334, and reports the install root, the shipped bundle, the Rendered rows, onboarding and the host as PASS, FAIL or INCONCLUSIVE (exit 0, 1, 3; refused 2). Starts Vidar, so the main thread runs it, never a subagent (`-DryRun` only); dev-only, not in a release export. The verdict is the pure `zip-boot.mjs`.
- `clean-smoke.ps1`: checks a zip and its `.sha256`, then writes a Windows Sandbox run folder (`vidar.wsb`, templates from `clean-smoke/`); zip folder read-only, one writable mapping limited to the run folder; `-DryRun` writes nothing, `-Open` is the user's.
- `profile-snapshot.ps1`: path, size, mtime and SHA-256 snapshot of the real-profile roots; `-Compare` diffs two.
- `write-audit.ps1`: reads a kernel FileIO trace and flags writes by the sandbox's process tree into the real profile.

Order the user runs them (launch from a normal terminal, never from an agent session):

1. `pwsh -File tools/sandbox/check-zip.ps1 -Zip <zip>`
2. `pwsh -File tools/sandbox/profile-snapshot.ps1 -Out <dir>/before.json`
3. Elevated: `wpr -start FileIO -filemode`
4. `pwsh -File tools/sandbox/launch.ps1 -Zip <zip>` (note `root pid:` and `sandbox root:`), use the sandbox, close it
5. Elevated: `wpr -stop <dir>/sandbox.etl`
6. `pwsh -File tools/sandbox/write-audit.ps1 -Trace <dir>/sandbox.etl -RootPid <pid> -SandboxRoot <root>`
7. `pwsh -File tools/sandbox/profile-snapshot.ps1 -Out <dir>/after.json`, then `-Compare <dir>/before.json <dir>/after.json`
