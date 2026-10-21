#Requires -Version 7
# Read-only ACL snapshot for the sandbox runs: shows whether a (Codex) session changed permissions on the
# real profile. Writes nothing but the -Out file; never calls icacls or Set-Acl.
# Records, per path: {path, sddl} from (Get-Acl -LiteralPath).Sddl for the profile folder, each direct child of
# it, each direct child of AppData\Local and AppData\Roaming, and the sandbox base folder (default %TEMP%).
# Also the size and mtime of ~\.codex\cap_sid and the line count of today's ~\.codex\.sandbox\sandbox.<date>.log.
#
# Usage: pwsh -File tools/sandbox/acl-snapshot.ps1 -Out <json> [-SandboxBase <dir>]
#        pwsh -File tools/sandbox/acl-snapshot.ps1 -Out <json> -Compare <earlier.json> [-SandboxBase <dir>]
#   -Out          where the snapshot goes (UTF-8, no BOM). Required.
#   -Compare      an earlier snapshot: prints "ACL: 0 changed", or "ACL: <n> changed" and one line per added,
#                 removed or changed path; then one line each for a changed cap_sid or sandbox log.
#   -SandboxBase  extra folder to record; default %TEMP%.
# Refuses (exit 2): no -Out, an unreadable -Compare file. A path whose ACL cannot be read is recorded with a
# null sddl and counted like any other value. Exit 0 otherwise, changed or not: it reports, it does not gate.
param(
  [Parameter(Mandatory)][string]$Out,
  [string]$Compare,
  [string]$SandboxBase = $env:TEMP
)
$ErrorActionPreference = "Stop"
$Utf8 = [Text.UTF8Encoding]::new($false)
$home_ = $env:USERPROFILE

function Get-Sddl([string]$p) {
  try { (Get-Acl -LiteralPath $p).Sddl } catch { $null }
}

if ($Compare -and -not (Test-Path -LiteralPath $Compare -PathType Leaf)) {
  [Console]::Error.WriteLine("REFUSED: no snapshot at $Compare."); exit 2
}

$paths = [System.Collections.Generic.List[string]]::new()
$paths.Add($home_)
foreach ($dir in @($home_, (Join-Path $home_ "AppData\Local"), (Join-Path $home_ "AppData\Roaming"))) {
  if (Test-Path -LiteralPath $dir -PathType Container) {
    foreach ($c in Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue) { $paths.Add($c.FullName) }
  }
}
if ($SandboxBase -and (Test-Path -LiteralPath $SandboxBase)) { $paths.Add($SandboxBase) }
$entries = foreach ($p in ($paths | Select-Object -Unique)) { [ordered]@{ path = $p; sddl = (Get-Sddl $p) } }

$capSid = Join-Path $home_ ".codex\cap_sid"
$cap = $null
if (Test-Path -LiteralPath $capSid -PathType Leaf) {
  $f = Get-Item -LiteralPath $capSid
  $cap = [ordered]@{ size = $f.Length; mtimeUtc = $f.LastWriteTimeUtc.ToString("o") }
}
$logPath = Join-Path $home_ (".codex\.sandbox\sandbox.{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
$log = $null
if (Test-Path -LiteralPath $logPath -PathType Leaf) {
  $n = 0; foreach ($l in [IO.File]::ReadLines($logPath)) { $n++ }
  $log = [ordered]@{ path = $logPath; lines = $n }
}

$doc = [ordered]@{ createdUtc = [datetime]::UtcNow.ToString("o"); entries = @($entries); capSid = $cap; sandboxLog = $log }
[IO.File]::WriteAllText($Out, (ConvertTo-Json -InputObject $doc -Depth 5), $Utf8)

if ($Compare) {
  $old = [IO.File]::ReadAllText($Compare, $Utf8) | ConvertFrom-Json
  $oldMap = @{}; foreach ($e in $old.entries) { $oldMap[[string]$e.path] = $e.sddl }
  $newMap = @{}; foreach ($e in $entries) { $newMap[[string]$e.path] = $e.sddl }
  $diff = [System.Collections.Generic.List[string]]::new()
  foreach ($k in ($newMap.Keys | Sort-Object)) {
    if (-not $oldMap.ContainsKey($k)) { $diff.Add("added   $k") }
    elseif ($oldMap[$k] -ne $newMap[$k]) { $diff.Add("changed $k") }
  }
  foreach ($k in ($oldMap.Keys | Sort-Object)) { if (-not $newMap.ContainsKey($k)) { $diff.Add("removed $k") } }
  "ACL: $($diff.Count) changed"
  $diff
  $oc = $old.capSid; $nc = $cap
  if (($null -ne $oc) -ne ($null -ne $nc) -or ($oc -and ($oc.size -ne $nc.size -or ([datetime]$oc.mtimeUtc).ToUniversalTime().Ticks -ne ([datetime]$nc.mtimeUtc).ToUniversalTime().Ticks))) { "cap_sid: changed" }
  $ol = if ($old.sandboxLog) { [int]$old.sandboxLog.lines } else { 0 }
  $nl = if ($log) { [int]$log.lines } else { 0 }
  if ($nl -ne $ol) { "sandbox log: $($nl - $ol) new lines" }
} else {
  "ACL snapshot: $(@($entries).Count) paths -> $Out"
}
exit 0
