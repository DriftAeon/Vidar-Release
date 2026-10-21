#requires -Version 7.0
# Dock a Falcon-hosted Claude session out of the Falcon shell and into a Vidar
# tab, from inside the session itself. Usage (run from inside the hosted
# process; no args):
#   tools\falcon\dock.ps1 [-TimeoutSec 30]
#
# Identifies the session from $env:FALCON_SESSION (set on every Falcon-hosted
# Claude process, src-falcon\src\claude.rs::spawn_request) and drops a request
# for the Falcon SHELL to pick up: src-tauri\src\open.rs cannot be the dock
# trigger (its poller runs inside Vidar and would race the shell, which must
# detach first - src-tauri\src\falcon\dock.rs, "tools\falcon\dock.ps1 -> the shell"
# comment). The shell (src\falcon.ts) polls bridge\falcon\dock-request.json
# every 500ms, claims it by rename to .claimed (same convention as
# open.rs::scan), and on a fresh one runs the same Dock path its own button
# uses (detach -> falcon_handoff_write dock -> falcon_dock_ask), then writes
# bridge\falcon\dock-result.json.
#
# Publishes bridge\falcon\dock-request.json {session, ts, id} atomically (tmp +
# rename), and blocks on bridge\falcon\dock-result.json {session, id, ok, reason}.
# The id is this request's own 8-hex tag: a verdict is only accepted when both
# session and id match, so a previous timed-out run's late result can never be
# read as this run's.
#
# Exit codes: 0 done (the shell detached and Vidar adopted the session into a
# tab); 1 refused, failed, or no verdict inside -TimeoutSec (default 30s). The
# reason goes to stderr in both failure cases; stdout carries only the
# one-line outcome on success. No armed-tab check: anything that can write
# bridge\falcon can already do this (docs\reference\desks-ask-gate.md, jettison section).
param(
    [int]$TimeoutSec = 30
)
$ErrorActionPreference = 'Stop'
$enc = [Text.UTF8Encoding]::new($false)
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. "$PSScriptRoot\..\lib\Paths.ps1"
$root = Resolve-VidarPath -Id falcon -Root $repo

$session = $env:FALCON_SESSION
if (-not $session) {
    Write-Error 'no $env:FALCON_SESSION - this is not a Falcon-hosted process'
    exit 1
}
if ($session.Length -gt 200 -or $session -notmatch '^[\x20-\x7e]+$') {
    Write-Error "FALCON_SESSION '$session' is not 1-200 printable ASCII characters - refusing to ask"
    exit 1
}
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    Write-Error "no falcon bridge dir ($root) - has a Falcon shell ever run?"
    exit 1
}

$requestPath = Join-Path $root 'dock-request.json'
$resultPath = Join-Path $root 'dock-result.json'

# The shell's poll claims by renaming dock-request.json to .claimed, so a
# stale result from an earlier run must not be read as this run's verdict.
if (Test-Path -LiteralPath $resultPath) {
    Remove-Item -LiteralPath $resultPath -Force
}

$tsMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$id = [guid]::NewGuid().ToString('N').Substring(0, 8)
$json = [ordered]@{
    session = $session
    ts      = $tsMs
    id      = $id
} | ConvertTo-Json -Compress
$tmp = Join-Path $root "dock-request.$([guid]::NewGuid().ToString('N').Substring(0,8)).tmp"
[IO.File]::WriteAllText($tmp, $json, $enc)
[IO.File]::Move($tmp, $requestPath, $true)

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while (-not (Test-Path -LiteralPath $resultPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path -LiteralPath $resultPath)) {
    Write-Error "no verdict in $TimeoutSec s - the shell may still be claiming the request, do not re-ask"
    exit 1
}
Start-Sleep -Milliseconds 200
$r = [IO.File]::ReadAllText($resultPath).TrimStart([char]0xFEFF) | ConvertFrom-Json
if ($r.session -ne $session -or $r.id -ne $id) {
    Write-Error "dock-result.json is for session $($r.session) id $($r.id), not $session/$id - stale read, do not re-ask"
    exit 1
}
if ($r.ok) {
    "docked: session $session is now in a Vidar tab."
    exit 0
}
Write-Error "dock refused: $($r.reason)"
exit 1
