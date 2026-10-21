#requires -Version 7.0
# Jettison a Falcon-hosted Claude session out of its Vidar tab, from inside the
# session itself. Usage (run from inside the hosted process; no args):
#   tools\falcon\jettison.ps1 [-TimeoutSec 30]
#
# Identifies the session from $env:FALCON_SESSION (set on every Falcon-hosted
# Claude process, src-falcon\src\claude.rs::spawn_request) and asks Vidar over
# the ask gate (bridge\open, src-tauri\src\open.rs) with kind "jettison" and
# that session id. open.rs auto-approves it (docs\reference\desks-ask-gate.md - same reasoning
# as "dock": this is the tab-menu's own "Jettison to Falcon" click, just
# script-driven), finds the Vidar tab hosting the session and runs the same
# jettisonSession() the menu uses (src\panels\sessions\hosted.ts). No dialog, no
# armed-tab check: anything that can write bridge\open can already do this.
#
# Publishes bridge\open\dispatch\<id>.json atomically (tmp + rename), like any
# ask-gate requester, and blocks on bridge\open\<id>\result.json.
#
# Exit codes: 0 done (the tab detached and the session is in the Falcon
# shell); 1 refused, failed, or no verdict inside -TimeoutSec (default 30s).
# The reason goes to stderr in both failure cases; stdout carries only the
# one-line outcome on success.
param(
    [int]$TimeoutSec = 30
)
$ErrorActionPreference = 'Stop'
$enc = [Text.UTF8Encoding]::new($false)
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. "$PSScriptRoot\..\lib\Paths.ps1"
. "$PSScriptRoot\..\lib\BridgeIo.ps1"
$root = Resolve-VidarPath -Id open -Root $repo
$dir = Resolve-VidarPath -Id openDispatch -Root $repo

$session = $env:FALCON_SESSION
if (-not $session) {
    Write-Error 'no $env:FALCON_SESSION - this is not a Falcon-hosted process'
    exit 1
}
if ($session.Length -gt 200 -or $session -notmatch '^[\x20-\x7e]+$') {
    Write-Error "FALCON_SESSION '$session' is not 1-200 printable ASCII characters - refusing to ask"
    exit 1
}
if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    Write-Error "no open dispatch dir ($dir) - has this Vidar build ever run?"
    exit 1
}

$id = [guid]::NewGuid().ToString('N').Substring(0, 8)
$json = [ordered]@{
    id        = $id
    kind      = 'jettison'
    reason    = 'script-driven jettison to Falcon'
    requester = 's0-jettison'
    session   = $session
} | ConvertTo-Json -Compress
$dst = Join-Path $dir "$id.json"
Write-BridgeJsonAtomic -Path $dst -Value $json

$resultPath = Join-Path $root "$id\result.json"
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while (-not (Test-Path -LiteralPath $resultPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path -LiteralPath $resultPath)) {
    Write-Error "unknown ${id}: no verdict in $TimeoutSec s - the ask may still be live, do not re-ask"
    exit 1
}
Start-Sleep -Milliseconds 200
$r = [IO.File]::ReadAllText($resultPath).TrimStart([char]0xFEFF) | ConvertFrom-Json
if ($r.verdict -eq 'approved') {
    "jettisoned ${id}: session $session is now in the Falcon shell (tab $($r.tab))."
    exit 0
}
Write-Error "$($r.verdict) ${id}: $($r.reason)"
exit 1