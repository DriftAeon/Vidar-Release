#Requires -Version 7
# Print-only: emits a self-contained PowerShell 7 script that removes the Codex sandbox grants of one day. It
# reads ~\.codex\.sandbox\sandbox.<date>.log ("granting write ACE to <root>" lines) and ~\.codex\cap_sid
# (writable_root_by_path: root -> capability SID). It never changes an ACL and has no apply switch: the user
# saves the output to a .ps1 and runs it (apps closed, Vidar included), first with -DryRun to list.
# Why not icacls: icacls cannot map a Codex capability SID ("No mapping between account names and security
# IDs was done") and skips the whole line, so "/remove:g CodexSandboxUsers *<sid>" processed 0 files. The
# emitted script uses .NET FileSystemAclExtensions: GetAccessControl(Access) -> PurgeAccessRules(group) +
# PurgeAccessRules(cap SID) -> SetAccessControl. DACL only; inherited ACEs are left alone.
#
# Usage: pwsh -File tools/sandbox/codex-grants.ps1 [-Date yyyy-MM-dd] > grants-strip.ps1
#   then: pwsh -nop -f grants-strip.ps1 -DryRun   (lists "would remove N explicit ACE(s)"; drop -DryRun to apply)
#   -Date  the log day, default 2026-10-10 (the day a session with cwd ~ granted the profile children).
# Output: script header, '#' comment lines for roots with no SID, a $targets list of @(root, sid) rows (a List: one row stays a pair), then
# the purge loop.
# Order: roots deeper under AppData first, then .claude, .claude.json, AppData, AppData\Local,
# AppData\Roaming, Documents (the order of docs/runs/2026-10-13-bare-mode/reports/acl.md Q4(b)), then the rest
# in log order. A root with no SID in cap_sid is a '#' comment line, not a target.
# Refuses (exit 2): no log for the date, no cap_sid, a bad -Date. Reads only; writes nothing.
param([string]$Date = "2026-10-10")
$ErrorActionPreference = "Stop"
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') { [Console]::Error.WriteLine("REFUSED: -Date must be yyyy-MM-dd."); exit 2 }
$codex = Join-Path $env:USERPROFILE ".codex"
$log = Join-Path $codex ".sandbox\sandbox.$Date.log"
$capFile = Join-Path $codex "cap_sid"
foreach ($f in @($log, $capFile)) {
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { [Console]::Error.WriteLine("REFUSED: no file at $f."); exit 2 }
}
$sidByRoot = @{}
$cap = Get-Content -LiteralPath $capFile -Raw -Encoding utf8 | ConvertFrom-Json
foreach ($p in $cap.writable_root_by_path.PSObject.Properties) { $sidByRoot[$p.Name.ToLowerInvariant()] = [string]$p.Value }

$roots = [System.Collections.Generic.List[string]]::new()
foreach ($line in [IO.File]::ReadLines($log)) {
  if ($line -match 'granting write ACE to (.+?) for sandbox') {
    if (-not ($roots | Where-Object { $_ -ieq $Matches[1] })) { $roots.Add($Matches[1]) }
  }
}

$u = $env:USERPROFILE
$listed = @(".claude", ".claude.json", "AppData", "AppData\Local", "AppData\Roaming", "Documents") | ForEach-Object { Join-Path $u $_ }
$appdata = Join-Path $u "AppData"
$deep = @($roots | Where-Object { $_.StartsWith("$appdata\", [StringComparison]::OrdinalIgnoreCase) -and $listed -inotcontains $_ })
$head = @($listed | Where-Object { $r = $_; $roots | Where-Object { $_ -ieq $r } })
$rest = @($roots | Where-Object { $deep -inotcontains $_ -and $head -inotcontains $_ })

$count = 0
$rows = [System.Collections.Generic.List[string]]::new()
$notes = [System.Collections.Generic.List[string]]::new()
foreach ($root in @($deep) + @($head) + @($rest)) {
  $sid = $sidByRoot[$root.ToLowerInvariant().Replace('\', '/')]
  if ($sid) { $rows.Add("`$targets.Add(@('" + $root.Replace("'", "''") + "', '$sid'))"); $count++ }
  else { $notes.Add("# no capability SID in cap_sid for $root") }
}
$body = @'
#Requires -Version 7
# Emitted by tools/sandbox/codex-grants.ps1. Purges the explicit (non-inherited) ACEs of CodexSandboxUsers and of
# each root's capability SID, DACL only. Usage: pwsh -nop -f <this file> [-DryRun]  (apps closed; -DryRun lists only)
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$group = [System.Security.Principal.NTAccount]::new('CodexSandboxUsers').Translate([System.Security.Principal.SecurityIdentifier])
$sections = [System.Security.AccessControl.AccessControlSections]::Access
$done = 0; $failed = 0; $removed = 0
foreach ($t in $targets) {
  $path = $t[0]
  try {
    $cap = [System.Security.Principal.SecurityIdentifier]::new($t[1])
    $item = Get-Item -LiteralPath $path -Force
    $acl = if ($item.PSIsContainer) { [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.DirectoryInfo]$item, $sections) }
           else { [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.FileInfo]$item, $sections) }
    $hits = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) |
      Where-Object { $_.IdentityReference -eq $group -or $_.IdentityReference -eq $cap })
    if ($hits.Count -and -not $DryRun) {
      $acl.PurgeAccessRules($group); $acl.PurgeAccessRules($cap)
      if ($item.PSIsContainer) { [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]$item, $acl) }
      else { [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.FileInfo]$item, $acl) }
    }
    $removed += $hits.Count; $done++
    "{0} {1} explicit ACE(s): {2}" -f ($DryRun ? 'would remove' : 'removed'), $hits.Count, $path
  } catch { $failed++; "FAILED $path : $($_.Exception.Message)" }
}
"roots ok $done, failed $failed, ACEs $($DryRun ? 'found' : 'removed') $removed$($DryRun ? ' (dry run)' : '')"
'@
$lines = @($body.Split("`n")[0..3] | ForEach-Object { $_.TrimEnd("`r") })
$lines
$notes
'$targets = [System.Collections.Generic.List[object]]::new()'
$rows
($body.Split("`n")[4..($body.Split("`n").Count - 1)] | ForEach-Object { $_.TrimEnd("`r") })
[Console]::Error.WriteLine("codex-grants: script body for $count of $($roots.Count) roots granted on $Date (printed, none run)")
