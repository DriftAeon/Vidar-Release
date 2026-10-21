#Requires -Version 7
# Check a Vidar release zip without extracting it: no entry under runtime\ (no logins, transcripts or
# state ride along) and every required path present. Who runs it: the build chain after local-zip.ps1,
# launch.ps1 before it extracts, or anyone by hand. Read-only.
# Usage: pwsh -File tools/sandbox/check-zip.ps1 -Zip <zip> [-Profile <name>]
#   Required paths: the union of the `assets` arrays in profiles/<name>/*.json when that folder exists
#   in this repo; else the base list below. A path ending in / needs at least one entry under it.
#   Entry names are compared after one shared top folder (the zip's Vidar/) is stripped.
#   A zip built with -Set (release-manifest.json `set.id`) is not required to hold that set's cut paths
#   (modules-resolve.mjs <set> --cut): they are listed as skipped, not as missing. The set definition is
#   the set.json beside the zip when its id matches (the wrapper's ad-hoc <base>-custom sets live only
#   there), else tools/release/sets/<id>.json in this repo; with neither it refuses.
# Refuses (exit 1): any runtime/ entry, any missing required path, a -Profile folder with no assets.
# Prints the zip, the required list it checked and each result.
param(
  [Parameter(Mandatory)][string]$Zip,
  [Alias("Profile")][string]$LaunchProfile
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$baseList = @("vidar.exe", "contracts/", "plugins/vidar-app/", "tools/sandbox/launch.ps1")
$repo = git -C $PSScriptRoot rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $repo) { $repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }

$required = $baseList
$source = "base list"
if ($LaunchProfile) {
  $pdir = Join-Path $repo "profiles\$LaunchProfile"
  if (Test-Path -LiteralPath $pdir -PathType Container) {
    $assets = @()
    foreach ($f in Get-ChildItem -LiteralPath $pdir -Filter *.json -File) {
      $j = Get-Content -Raw -LiteralPath $f.FullName | ConvertFrom-Json
      if ($j.PSObject.Properties.Name -contains "assets") { $assets += @($j.assets) }
    }
    if (-not $assets.Count) { "FAIL: $pdir holds no assets list"; exit 1 }
    $required = @($assets | ForEach-Object { "$_".Replace('\', '/').TrimStart('/') } | Sort-Object -Unique)
    $source = "profile $LaunchProfile assets ($pdir)"
  } else {
    "note: no profiles\$LaunchProfile in $repo; using the base list"
  }
}

$Zip = (Resolve-Path -LiteralPath $Zip).Path
$archive = [IO.Compression.ZipFile]::OpenRead($Zip)
try { $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') }) }
finally { $archive.Dispose() }

# Strip one shared top folder (Vidar/) when every entry sits under it.
$tops = @($names | ForEach-Object { ($_ -split '/', 2)[0] } | Sort-Object -Unique)
$prefix = ""
if ($tops.Count -eq 1 -and @($names | Where-Object { $_ -notmatch '/' }).Count -eq 0) { $prefix = $tops[0] + "/" }
$rel = @($names | ForEach-Object { $_.Substring($prefix.Length) } | Where-Object { $_ })

# A zip built with -Set records the set id in its release-manifest.json; the set's cut paths (excluded
# modules' owns, omit) are not required, since the zip rightly lacks them. The cut list comes from this
# repo's tools\release\modules-resolve.mjs; without it, or without a set in the manifest, nothing is skipped.
$skipped = @()
$resolver = Join-Path $repo "tools\release\modules-resolve.mjs"
if ($rel -contains "release-manifest.json" -and (Test-Path -LiteralPath $resolver)) {
  $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
  try {
    $entry = $archive.Entries | Where-Object { $_.FullName.Replace('\', '/') -ieq "${prefix}release-manifest.json" } | Select-Object -First 1
    $setId = $null
    if ($entry) {
      $reader = [IO.StreamReader]::new($entry.Open())
      try { $setId = (($reader.ReadToEnd() | ConvertFrom-Json).set).id } finally { $reader.Dispose() }
    }
  } finally { $archive.Dispose() }
  if ($setId) {
    $besideSet = Join-Path (Split-Path $Zip -Parent) "set.json"
    $byName = Join-Path $repo "tools\release\sets\$setId.json"
    $besideId = $null
    if (Test-Path -LiteralPath $besideSet -PathType Leaf) {
      try { $besideId = (Get-Content -Raw -LiteralPath $besideSet | ConvertFrom-Json).id } catch { $besideId = $null }
    }
    if ($besideId -and "$besideId" -eq "$setId") { $setArg = $besideSet; "set source: $besideSet (beside the zip)" }
    elseif (Test-Path -LiteralPath $byName -PathType Leaf) { $setArg = $setId; "set source: $byName (by name)" }
    else { "FAIL: set ${setId}: no set.json beside the zip and no tools/release/sets/$setId.json"; exit 1 }
    $cutJson = node $resolver $setArg --cut
    if ($LASTEXITCODE -ne 0) { "FAIL: modules-resolve.mjs --cut failed for set $setId"; exit 1 }
    $cut = @((($cutJson -join "`n") | ConvertFrom-Json) | ForEach-Object { "$_" })
    $isCut = { param($r) [bool]($cut | Where-Object { if ($_.EndsWith('/')) { $r.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) } else { $r -ieq $_ -or $r.StartsWith("$_/", [StringComparison]::OrdinalIgnoreCase) } }) }
    $skipped = @($required | Where-Object { & $isCut $_ })
    $required = @($required | Where-Object { $skipped -notcontains $_ })
  }
}

"zip: $Zip ($($names.Count) entries$(if ($prefix) { ", top folder $prefix" }))"
if ($skipped.Count) { "skipped (cut by set ${setId}): $($skipped -join ', ')" }
"required ($source): $($required -join ', ')"
$fail = 0
$runtimeHits = @($rel | Where-Object { $_ -match '^runtime(/|$)' })
if ($runtimeHits.Count) {
  $fail++
  "FAIL runtime entries: $($runtimeHits.Count)"
  $runtimeHits | Select-Object -First 20 | ForEach-Object { "  $_" }
} else { "ok   no runtime entries" }
foreach ($r in $required) {
  $hit = if ($r.EndsWith('/')) { @($rel | Where-Object { $_.StartsWith($r, [StringComparison]::OrdinalIgnoreCase) }).Count }
         else { @($rel | Where-Object { $_ -ieq $r }).Count }
  if ($hit) { "ok   $r" } else { "FAIL missing $r"; $fail++ }
}
if ($fail) { "check-zip: FAIL ($fail)"; exit 1 }
"check-zip: PASS"
exit 0
