#requires -Version 7.3
# Jettison a Falcon-hosted Claude session out of its Vidar tab, from inside the
# session itself. Usage (run from inside the hosted process; no args):
#   tools\falcon\jettison.ps1 [-TimeoutSec 30]
#
# Identifies the session from $env:FALCON_SESSION (set on every Falcon-hosted
# Claude process, src-falcon\src\claude.rs::spawn_request) and asks Vidar over
# the ask gate (src-tauri\src\open.rs) with kind "jettison" and that session id.
# open.rs auto-approves it (docs\reference\desks-ask-gate.md - same reasoning
# as "dock": this is the tab-menu's own "Jettison to Falcon" click, just
# script-driven), finds the Vidar tab hosting the session and runs the same
# jettisonSession() the menu uses (src\panels\sessions\hosted.ts). No dialog, no
# armed-tab check: anything that can write bridge\open can already do this.
#
# Bus first: ping the Falcon bus host (tools\bus\bus-client.mjs ping); if it
# answers, send the ask on topic ask.open and read the verdict from the reply.
# Client exit 3 (no host, pipe refused, no subscriber) falls back to the file
# path: publish bridge\open\dispatch\<id>.json atomically (tmp + rename) and
# block on bridge\open\<id>\result.json. Exit 2 (no reply in time) is reported
# as unknown and never re-asked; any other non-zero exit is reported, never
# re-asked on file.
#
# Exit codes: 0 done (the tab detached and the session is in the Falcon
# shell); 1 refused, failed, or no verdict inside -TimeoutSec (default 30s).
# The reason goes to stderr in both failure cases; stdout carries only the
# one-line outcome on success.
param(
    [int]$TimeoutSec = 30
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. "$PSScriptRoot\..\lib\Paths.ps1"
. "$PSScriptRoot\..\lib\BridgeIo.ps1"
$root = Resolve-VidarPath -Id open -Root $repo
$dir = Resolve-VidarPath -Id openDispatch -Root $repo
$busClient = Join-Path $repo 'tools\bus\bus-client.mjs'

$session = $env:FALCON_SESSION
if (-not $session) {
    Write-Error 'no $env:FALCON_SESSION - this is not a Falcon-hosted process'
    exit 1
}
if ($session.Length -gt 200 -or $session -notmatch '^[\x20-\x7e]+$') {
    Write-Error "FALCON_SESSION '$session' is not 1-200 printable ASCII characters - refusing to ask"
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

function Write-Verdict($r) {
    if ($r.verdict -eq 'approved') {
        "jettisoned ${id}: session $session is now in the Falcon shell (tab $($r.tab))."
        exit 0
    }
    $verdict = if ($r.verdict) { $r.verdict } else { 'refused' }
    Write-Error "$verdict ${id}: $($r.reason)"
    exit 1
}

# Bus path. Native exit codes are read from $LASTEXITCODE; stderr is captured
# so a connect failure stays quiet when the file path takes over.
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($node) {
    $null = & $node.Source $busClient ping 2>&1
    if ($LASTEXITCODE -eq 0) {
        $out = & $node.Source $busClient request ask.open --json $json --timeout ($TimeoutSec * 1000) 2>&1
        $code = $LASTEXITCODE
        $stdout = ($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
        $stderr = ($out | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
        if ($code -eq 0) {
            $reply = $stdout | ConvertFrom-Json
            # An older Vidar answers {ok:false, reason:"kind not on the bus yet"}
            # with no verdict; that is always refused before claim (open.rs), so
            # the file path cannot double-ask.
            if ($reply.verdict) { Write-Verdict $reply }
            # else fall through to the files
        }
        elseif ($code -eq 3 -and $stderr -match 'bus gone:') {
            # Pipe dropped after the ping answered: the ask may have been delivered.
            Write-Error "unknown ${id}: bus gone after delivery ($stderr) - the ask may still be live, do not re-ask"
            exit 1
        }
        elseif ($code -eq 2) {
            Write-Error "unknown ${id}: no verdict in $TimeoutSec s on the bus - the ask may still be live, do not re-ask"
            exit 1
        }
        elseif ($code -ne 3) {
            Write-Error "failed ${id}: bus-client exit ${code}: $stderr"
            exit 1
        }
        # Exit 0 without a verdict, or exit 3 (not connected / no subscriber):
        # fall through to the files.
    }
}

# File path.
if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    Write-Error "no open dispatch dir ($dir) - has this Vidar build ever run?"
    exit 1
}
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
Write-Verdict ([IO.File]::ReadAllText($resultPath).TrimStart([char]0xFEFF) | ConvertFrom-Json)
