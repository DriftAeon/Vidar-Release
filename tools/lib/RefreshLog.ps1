# Step timings for the refresh shortcuts (tools\release\refresh.ps1, falcon-refresh.ps1): one JSON line
# per run appended to runtime\refresh-log.jsonl, so desktop-shortcut runs leave a record after the
# console closes. Never throws: a logging failure must not fail or hold up a refresh.
#
#   . "$PSScriptRoot\..\lib\RefreshLog.ps1"
#   Start-RefreshLog -Script vidar -Root $root -Flags @{ debug = [bool]$Debug }
#   Start-RefreshStep npm      # closes the previous step, opens this one
#   Complete-RefreshLog -Ok $true [-Extra @{ bundle_id = ... }]   # or -Ok $false -Message $msg
#
# Line shape: {"ts","script","ok","total_s","steps":{"<name>":<seconds>,...},"flags",...extra,"error"}
. "$PSScriptRoot\Paths.ps1"
$script:RefreshLog = $null

function Start-RefreshLog([string]$Script, [string]$Root, [hashtable]$Flags = @{}) {
  $script:RefreshLog = @{
    script = $Script; root = $Root; flags = $Flags; started = Get-Date
    steps = [ordered]@{}; current = $null; currentAt = $null; written = $false
  }
}

function Start-RefreshStep([string]$Name) {
  $log = $script:RefreshLog
  if (-not $log) { return }
  $now = Get-Date
  if ($log.current) { $log.steps[$log.current] = [math]::Round(($now - $log.currentAt).TotalSeconds, 1) }
  $log.current = $Name
  $log.currentAt = $now
}

function Complete-RefreshLog([bool]$Ok, [string]$Message = '', [hashtable]$Extra = @{}) {
  $log = $script:RefreshLog
  if (-not $log -or $log.written) { return }
  try {
    Start-RefreshStep $null
    $log.written = $true
    $line = [ordered]@{
      ts = $log.started.ToString('o'); script = $log.script; ok = $Ok
      total_s = [math]::Round(((Get-Date) - $log.started).TotalSeconds, 1)
      steps = $log.steps; flags = $log.flags
    }
    foreach ($k in $Extra.Keys) { $line[$k] = $Extra[$k] }
    if ($Message) { $line.error = $Message }
    $file = Join-Path (Resolve-VidarPath -Id runtime -Root $log.root) 'refresh-log.jsonl'
    $json = ($line | ConvertTo-Json -Compress -Depth 4) + "`n"
    [IO.File]::AppendAllText($file, $json, [Text.UTF8Encoding]::new($false))
  } catch { }
}
