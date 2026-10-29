# Opens one http(s) URL in the user's normal browser profile, for Bare Claude tabs.
#
# Why: a Bare tab redirects USERPROFILE and LOCALAPPDATA, so a browser started by the agent (rundll32
# url,OpenURL) runs against an empty profile and the user cannot sign in with their normal session.
# This script first swaps its own environment for a fresh logon's (the rule tools/release/clean-env.ps1
# Get-CleanEnvironment follows: system names, HKCU\Volatile Environment, Machine then User variables),
# then hands the URL to ShellExecute, so the default browser starts with the real profile.
# Not explorer.exe "<url>": the Claude sign-in URL (~450 characters, state
# last; the cmd and pwsh layers pass it intact, measured 2026-10-21) reached the browser without its
# state parameter, inferred to be explorer parsing its argument as a path (MAX_PATH).
#
# Who sets BROWSER: profiles/bare/claude.json `overlay` points BROWSER at tools\bare\open-url.cmd, which
# calls this script. Claude Code spawns BROWSER with the URL as its single argument; exit 0 = opened.
#
# Usage: pwsh -NoProfile -File tools/bare/open-url.ps1 <url>
#
# Refuses: not exactly one argument (exit 2); a URL that is not absolute http or https, or whose text holds
# whitespace, a control character or a double quote (one stderr line, exit 1); HKCU\Volatile Environment
# unreadable (no browser is started on the redirected profile: a stderr line, then the URL alone on the
# next stderr line, exit 3).
#
# Test-only env: VIDAR_OPEN_URL_LOG = a file path; when set, the exact URL is written there (UTF-8, no
# newline) instead of launching anything. VIDAR_OPEN_URL_NO_VOLATILE = 1 acts as if HKCU\Volatile
# Environment could not be read; it is checked before the log hook, so it never launches either.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'

if ($null -eq $Rest -or $Rest.Count -ne 1) {
  [Console]::Error.WriteLine('open-url: expected exactly one URL argument')
  exit 2
}
$url = $Rest[0]

$parsed = $null
$ok = [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$parsed)
if (-not $ok -or ($parsed.Scheme -ne 'http' -and $parsed.Scheme -ne 'https') -or $url -match '[\s\x00-\x1F\x7F"]') {
  [Console]::Error.WriteLine('open-url: refused, only plain http and https URLs are opened')
  exit 1
}

$fresh = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
# A copy of tools/release/clean-env.ps1 $CleanEnvSystemNames: that file is export-ignored, so it is
# not beside this one in a friend's install. tests/bare-open-url.test.mjs keeps the two lists equal.
$systemNames = @(
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS', 'DriverData', 'SESSIONNAME'
)
foreach ($n in $systemNames) {
  $v = [Environment]::GetEnvironmentVariable($n)
  if ($null -ne $v) { $fresh[$n] = $v }
}
# Without the logon profile names the browser would start on the tab's redirected profile, the
# failure this script exists to avoid: the URL goes to stderr instead, beside the one the CLI prints.
$volatile = $null
try { $volatile = Get-Item 'HKCU:\Volatile Environment' -ErrorAction Stop } catch { $volatile = $null }
if (-not $volatile -or $env:VIDAR_OPEN_URL_NO_VOLATILE) {
  [Console]::Error.WriteLine('open-url: could not read the logon profile (HKCU\Volatile Environment); open this URL in your browser:')
  [Console]::Error.WriteLine($url)
  exit 3
}

if ($env:VIDAR_OPEN_URL_LOG) {
  [IO.File]::WriteAllText($env:VIDAR_OPEN_URL_LOG, $url, [Text.UTF8Encoding]::new($false))
  exit 0
}

foreach ($n in $volatile.GetValueNames()) { $fresh[$n] = [string]$volatile.GetValue($n) }
# The registry reads below expand %USERPROFILE% and friends against this process, so the real
# profile names go in first.
foreach ($k in $fresh.Keys) { [Environment]::SetEnvironmentVariable($k, $fresh[$k]) }
$machine = [Environment]::GetEnvironmentVariables('Machine')
$user = [Environment]::GetEnvironmentVariables('User')
foreach ($k in $machine.Keys) { $fresh[[string]$k] = [string]$machine[$k] }
foreach ($k in $user.Keys) { $fresh[[string]$k] = [string]$user[$k] }
$fresh['Path'] = (@($machine['Path'], $user['Path']) | Where-Object { $_ }) -join ';'
foreach ($k in @([Environment]::GetEnvironmentVariables().Keys)) {
  # Remove-Item, not SetEnvironmentVariable($k, $null): PowerShell passes $null as "", which keeps the name.
  if (-not $fresh.ContainsKey([string]$k)) { Remove-Item -LiteralPath "Env:\$k" -ErrorAction SilentlyContinue }
}
foreach ($k in $fresh.Keys) { [Environment]::SetEnvironmentVariable($k, $fresh[$k]) }

# ShellExecute of the URL itself: no command line to parse, so every query parameter arrives.
$psi = [Diagnostics.ProcessStartInfo]::new($url)
$psi.UseShellExecute = $true
$null = [Diagnostics.Process]::Start($psi)
exit 0
