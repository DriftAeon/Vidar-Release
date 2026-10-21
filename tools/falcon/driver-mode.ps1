#requires -Version 7.0
# Driver mode truth file for a Falcon-hosted session: runtime\bridge\driver\<session>.json.
# A PreToolUse guard (guard-driver.mjs) reads it and keeps the session from building or editing itself.
#   tools\falcon\driver-mode.ps1 on|off [-Session <id>]
# Session defaults to $env:FALCON_SESSION. `off` is refused from inside the target session.
# Exit codes: 0 done; 1 refused or bad input.
param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('on', 'off')][string]$Mode,
    [string]$Session
)
$ErrorActionPreference = 'Stop'
$enc = [Text.UTF8Encoding]::new($false)
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. "$PSScriptRoot\..\lib\Paths.ps1"

if (-not $Session) { $Session = $env:FALCON_SESSION }
if (-not $Session) {
    [Console]::Error.WriteLine('driver-mode: no -Session and no $env:FALCON_SESSION')
    exit 1
}
if ($Session -cnotmatch '^s[0-9a-f]{8}-[0-9]{8}\z') {
    [Console]::Error.WriteLine("driver-mode: session '$Session' does not match ^s[0-9a-f]{8}-[0-9]{8}\z")
    exit 1
}

$dir = Resolve-VidarPath -Id driverMode -Root $repo
$file = Join-Path $dir "$Session.json"

if ($Mode -eq 'on') {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $since = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
    $json = [ordered]@{ on = $true; since = $since } | ConvertTo-Json -Compress
    $tmp = "$file.tmp"
    [IO.File]::WriteAllText($tmp, $json, $enc)
    Move-Item -LiteralPath $tmp -Destination $file -Force
    Write-Output "driver mode on: $Session"
    exit 0
}

if ($env:FALCON_SESSION -and $env:FALCON_SESSION -eq $Session) {
    [Console]::Error.WriteLine('driver-mode: off refused - this is the target session; turn it off from another shell')
    exit 1
}
Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
Write-Output "driver mode off: $Session"
exit 0
