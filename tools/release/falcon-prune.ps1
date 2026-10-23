# falcon-prune.ps1 - retention for Falcon build artefacts: bundles under bridge\falcon\bundles,
# their per-bundle WebView2 profiles under %LOCALAPPDATA%\<src-falcon identifier>\<bundle-id>, and
# the content-addressed CLI store under bridge\falcon\store\{claude,codex}\<id>.
# falcon-refresh.ps1 runs it after it repoints current.json; it also runs on its own.
#
#   pwsh -NoProfile -File tools\release\falcon-prune.ps1 [-DryRun] [-Json]
#
#   -DryRun        print the keep/delete lists, delete nothing.
#   -Json          also print one JSON line {aborted, keep_bundles, delete_bundles, keep_profiles,
#                  delete_profiles, keep_store, delete_store} (store entries as "<kind>/<id>";
#                  tests/falcon-prune.test.mjs reads it).
#   -Root          Vidar root (default: two levels up from this script).
#   -LocalAppData  profile base (default: $env:LOCALAPPDATA).
#   -ProfileIdentifier  profile root name (default: src-falcon\tauri.conf.json identifier). Must
#                  end in ".falcon"; any other name is refused, so Vidar's own profile
#                  (com.*.vidar, which holds Flow graphs and run history) can never be pointed at.
#
# Keep: current.json's bundle, its previous_bundle_id (falcon-refresh.ps1 records it; older
# pointers fall back to the newest bundle created before current), registry.json's bundle
# (whether or not that host is alive), any bundle created after current (an in-flight build),
# any bundle or profile whose path appears in a running process's executable path or command
# line, and any bundle whose manifest cannot be read. Delete the rest.
# A profile follows its bundle: kept when its bundle id is kept, and deleted only when this root's
# bundles dir holds that bundle and this run deletes it. The profile root is shared by every install
# root on the machine, so a profile whose bundle this root never had is kept ("other install"). Only profile children
# whose names have the bundle-id shape (0.1.0-<hex>...) are ever deleted; anything else under the
# profile root (a root-level EBWebView, a stray folder) is kept and reported as not bundle-shaped.
# A store entry is kept when a kept bundle's manifest pins it (claude.exe_sha256, codex.store_id;
# a schema-4 manifest pins only the runtimes in its `runtimes` list, older ones both),
# when a process runs from it, or when it was created after current (an in-flight build copies
# into the store before its bundle exists). Only 64-hex directory names are deletable; tmp copies
# and strays are kept as not id-shaped. A kept bundle with an unreadable manifest or missing pin
# skips the store pass (all kept) without stopping the bundle and profile prune; so does a running
# falcon-build.ps1 into this root (it can reuse an unpinned entry before its bundle exists; a build whose
# absolute -File lies under another root is ignored, a relative one counts) or an unreadable store.
#
# Only build artefacts, the CLI store and WebView2 caches are in scope. Session journals
# (bridge\falcon\runtime\journals), transcripts and review reports are history and are never
# touched here.
#
# Fails closed (exit 1, nothing deleted): an unreadable current.json or registry.json, a missing
# current.json, an unreadable manifest for the current bundle, a non-.falcon identifier, a bundles
# dir or profile root that is a reparse point, or a failed process scan. A missing registry.json
# does not abort: no registry means no registered host, and a host running without one is still
# kept by the process scan (its exe path is inside its bundle). A directory is moved into a trash
# folder before it is deleted, so a bundle that is in use fails the move and stays whole.
#
# Not handled: an elevated msedgewebview2.exe hides its command line from this unelevated scan,
# which aborts the run (blind process) rather than guessing.
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Json,
  [string]$Root = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
  [string]$LocalAppData = $env:LOCALAPPDATA,
  # Profile root name under LocalAppData; default is src-falcon\tauri.conf.json `identifier`.
  # Set it to prune a root left by an earlier identifier (same keep rules apply).
  [string]$ProfileIdentifier
)
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\lib\Paths.ps1"
# Resolve falcon once and join the leaf rels under it.
$falconDir = Resolve-VidarPath -Id falcon -Root $Root
function Get-FalconPath([string]$Id) { Join-Path $falconDir ((Get-VidarPathNode $Id).rel.Replace('/', '\')) }
$bundlesDir = Get-FalconPath falconBundles
$trashDir = Join-Path $falconDir 'prune-trash'
$pointerPath = Get-FalconPath falconPointer
$registryPath = Get-FalconPath falconRegistry
$falconConfig = Join-Path $Root 'src-falcon\tauri.conf.json'
$safeName = '^[0-9A-Za-z][0-9A-Za-z._-]*$'
# Bundle ids are <version>-<hex hash>[-<hex>...] (falcon-build.ps1); only these are deletable profiles.
$bundleShape = '^\d+\.\d+\.\d+-[0-9a-f]{8}[0-9a-f-]*$'

function Log($text) { Write-Host "falcon-prune: $text" }

function Result($aborted, $keepB, $delB, $keepP, $delP, $keepS, $delS) {
  if ($Json) {
    [ordered]@{
      aborted = $aborted
      keep_bundles = @($keepB | Sort-Object)
      delete_bundles = @($delB | Sort-Object)
      keep_profiles = @($keepP | Sort-Object)
      delete_profiles = @($delP | Sort-Object)
      keep_store = @($keepS | Sort-Object)
      delete_store = @($delS | Sort-Object)
    } | ConvertTo-Json -Compress | Write-Output
  }
}

function Abort($why) {
  Log "ABORT, nothing deleted: $why"
  Result $why @() @() @() @() @() @()
  exit 1
}

function Test-Reparse($path) {
  return [bool]((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Read-JsonFile($path) {
  # $null when absent; throws when present but unreadable, so callers fail closed.
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Get-DirMB($path) {
  try {
    $sum = (Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction Stop | Measure-Object Length -Sum).Sum
    return [math]::Round(($sum ?? 0) / 1MB, 1)
  } catch { return '?' }
}

# --- anchors -----------------------------------------------------------------------------------
try { $pointer = Read-JsonFile $pointerPath } catch { Abort "current.json unreadable: $($_.Exception.Message)" }
if (-not $pointer -or -not $pointer.bundle_id) { Abort "no current.json bundle_id at $pointerPath" }
try { $registry = Read-JsonFile $registryPath } catch { Abort "registry.json unreadable: $($_.Exception.Message)" }
if ($registry -and -not $registry.bundle_id) { Abort "registry.json has no bundle_id" }
try {
  $identifier = (Read-JsonFile $falconConfig).identifier
} catch { Abort "src-falcon tauri.conf.json unreadable: $($_.Exception.Message)" }
if ($ProfileIdentifier) { $identifier = $ProfileIdentifier }
if (-not $identifier -or $identifier -notmatch $safeName) { Abort "src-falcon identifier missing or unsafe: '$identifier'" }
if ($identifier -notmatch '\.falcon$') { Abort "profile identifier '$identifier' is not a Falcon identifier (must end in .falcon)" }
if (-not $LocalAppData) { Abort 'LOCALAPPDATA is unset' }
$profileRoot = Join-Path $LocalAppData $identifier

# Every running process's image path and command line, lower-cased. A falcon or WebView2 process
# whose command line cannot be read could be using anything, so it aborts the run.
try {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch { Abort "process scan failed: $($_.Exception.Message)" }
$blind = @($procs | Where-Object { $_.Name -in 'falcon.exe', 'msedgewebview2.exe' -and -not $_.CommandLine })
if ($blind.Count -gt 0) { Abort "cannot read the command line of $($blind.Name -join ', ') pid $($blind.ProcessId -join ', ')" }
$procText = @($procs | ForEach-Object { ("$($_.ExecutablePath) $($_.CommandLine)").ToLowerInvariant() })
function Test-InUse($path) {
  $pattern = [regex]::Escape($path.ToLowerInvariant()) + '(?:[\\" ]|$)'
  foreach ($t in $procText) { if ($t -match $pattern) { return $true } }
  return $false
}

# --- bundles -----------------------------------------------------------------------------------
$bundleDirs = @()
if (Test-Path -LiteralPath $bundlesDir) {
  if (Test-Reparse $bundlesDir) { Abort "$bundlesDir is a reparse point" }
  try { $bundleDirs = @(Get-ChildItem -LiteralPath $bundlesDir -Directory -Force -ErrorAction Stop) }
  catch { Abort "cannot list $bundlesDir : $($_.Exception.Message)" }
}

$reasons = @{}
function Add-Keep($id, $why) {
  if (-not $id) { return }
  if (-not $reasons.ContainsKey($id)) { $reasons[$id] = [System.Collections.Generic.List[string]]::new() }
  [void]$reasons[$id].Add($why)
}
Add-Keep $pointer.bundle_id 'current'
if ($registry) { Add-Keep $registry.bundle_id 'registry' }

$created = @{}
foreach ($dir in $bundleDirs) {
  $id = $dir.Name
  if ($id -notmatch $safeName) { Add-Keep $id 'unexpected name'; continue }
  if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { Add-Keep $id 'reparse point'; continue }
  try {
    $manifest = Get-Content -LiteralPath (Join-Path $dir.FullName 'runtime-manifest.json') -Raw -ErrorAction Stop | ConvertFrom-Json
    if (-not $manifest.created_utc) { throw 'no created_utc' }
    # ConvertFrom-Json turns ISO strings into DateTime; normalise so the sort is by instant.
    $created[$id] = ([datetime]$manifest.created_utc).ToUniversalTime()
  } catch {
    Log "keep ${id}: manifest unreadable ($($_.Exception.Message))"
    Add-Keep $id 'manifest unreadable'
  }
  if (Test-InUse $dir.FullName) { Add-Keep $id 'in use by a process' }
}

if ($bundleDirs.Count -gt 0) {
  # Newer-than-current is an in-flight build; without current's timestamp that cannot be told apart.
  if (-not $created.ContainsKey($pointer.bundle_id)) { Abort "current bundle $($pointer.bundle_id) has no readable manifest created_utc" }
  $currentCreated = $created[$pointer.bundle_id]
  foreach ($e in $created.GetEnumerator()) { if ($e.Value -gt $currentCreated) { Add-Keep $e.Key 'newer than current (in flight)' } }
}

$previous = $pointer.previous_bundle_id
if (-not $previous -and $bundleDirs.Count -gt 0) {
  $previous = $created.GetEnumerator() | Where-Object { $_.Value -lt $currentCreated } |
    Sort-Object Value -Descending | Select-Object -First 1 | ForEach-Object Key
}
Add-Keep $previous 'previous'

$keepBundles = @($reasons.Keys)
$deleteBundles = @($bundleDirs | ForEach-Object Name | Where-Object { -not $reasons.ContainsKey($_) })

# --- profiles ----------------------------------------------------------------------------------
$profileDirs = @()
if (Test-Path -LiteralPath $profileRoot) {
  if (Test-Reparse $profileRoot) { Abort "$profileRoot is a reparse point" }
  try { $profileDirs = @(Get-ChildItem -LiteralPath $profileRoot -Directory -Force -ErrorAction Stop) }
  catch { Abort "cannot list $profileRoot : $($_.Exception.Message)" }
}
$keepProfiles = [System.Collections.Generic.List[string]]::new()
$deleteProfiles = [System.Collections.Generic.List[string]]::new()
$profileWhy = @{}
foreach ($dir in $profileDirs) {
  $id = $dir.Name
  $why = if ($id -cnotmatch $bundleShape) { 'not bundle-shaped' }
    elseif ($reasons.ContainsKey($id)) { 'bundle kept' }
    elseif ($deleteBundles -cnotcontains $id) { 'other install' }
    elseif ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { 'reparse point' }
    elseif (Test-InUse $dir.FullName) { 'in use by a process' }
  if ($why) { $keepProfiles.Add($id); $profileWhy[$id] = $why } else { $deleteProfiles.Add($id) }
}

# --- store -------------------------------------------------------------------------------------
# Pins come from every kept bundle on disk; any doubt skips the pass (keep all) without aborting.
$storeDir = Get-FalconPath falconStore
$keepStore = [System.Collections.Generic.List[string]]::new()
$deleteStore = [System.Collections.Generic.List[string]]::new()
$storeWhy = @{}
$storeSkip = $null
$pins = @{ claude = @(); codex = @() }
foreach ($id in $keepBundles) {
  $dir = Join-Path $bundlesDir $id
  # A kept id with no directory (stale registry or previous pointer) has nothing to pin.
  if ($id -notmatch $safeName -or -not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
  try {
    $m = Get-Content -LiteralPath (Join-Path $dir 'runtime-manifest.json') -Raw -ErrorAction Stop | ConvertFrom-Json
  } catch { $storeSkip = "kept bundle $id manifest unreadable"; break }
  # Schema 4+ declares which runtimes it carries (`runtimes`) and pins only those; older
  # bundles always carry both, so a missing pin there still skips the pass.
  $declared = @('claude', 'codex')
  if ($m.schema -is [ValueType] -and [int]$m.schema -ge 4) {
    $declared = @($m.runtimes | Where-Object { $_ -in 'claude', 'codex' })
    if ($declared.Count -eq 0) { $storeSkip = "kept bundle $id declares no runtimes"; break }
  }
  if (($declared -contains 'claude' -and -not $m.claude.exe_sha256) -or ($declared -contains 'codex' -and -not $m.codex.store_id)) {
    $storeSkip = "kept bundle $id has no store pins"; break
  }
  if ($declared -contains 'claude') { $pins.claude += "$($m.claude.exe_sha256)" }
  if ($declared -contains 'codex') { $pins.codex += "$($m.codex.store_id)" }
}
if (-not $storeSkip -and -not $created.ContainsKey($pointer.bundle_id)) { $storeSkip = 'no current bundle creation time' }
# A running falcon-build can reuse an old unpinned entry before its bundle dir (and pin) exists.
# Only a pwsh/powershell whose -File is falcon-build.ps1 counts: any command line that merely names
# the file (a `git commit -- tools/release/falcon-build.ps1` running the pre-commit gate) is not a build.
# Only the first -File counts: pwsh runs that script and passes everything after it as its arguments.
# Only a build into this root counts: falcon-build.ps1 has no root parameter and writes to the store of
# the checkout it lives in, so an absolute -File under another root cannot touch this store. A relative
# or otherwise unresolvable -File counts (the process's cwd is not visible here).
$fileArg = '(?i)(?:^|\s)-f(?:i(?:le?)?)?\s+("[^"]*"|\S+)'
function Test-BuildTargetsRoot([string]$file) {
  if ($file -notmatch '^(?:[A-Za-z]:[\\/]|\\\\|//)') { return $true }
  try {
    $full = [IO.Path]::GetFullPath($file.Replace('/', '\'))
    $rootFull = [IO.Path]::GetFullPath($Root.Replace('/', '\')).TrimEnd('\') + '\'
    return $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
  } catch { return $true }
}
$building = @($procs | Where-Object {
  if ($_.Name -notin 'pwsh.exe', 'powershell.exe' -or "$($_.CommandLine)" -notmatch $fileArg) { return $false }
  $file = $Matches[1].Trim('"')
  $file -match '(?i)(?:^|[\\/])falcon-build\.ps1$' -and (Test-BuildTargetsRoot $file)
})
if ($building.Count -gt 0) { $storeSkip ??= "falcon-build running (pid $($building.ProcessId -join ', '))" }
$storeEntries = @{ claude = @(); codex = @() }
# Store-side read failures skip the store pass; they never abort the bundle and profile prune.
try {
  if ((Test-Path -LiteralPath $storeDir) -and (Test-Reparse $storeDir)) { $storeSkip ??= "$storeDir is a reparse point" }
} catch { $storeSkip ??= "cannot read $storeDir" }
foreach ($kind in 'claude', 'codex') {
  $kindDir = Join-Path $storeDir $kind
  try {
    if (-not (Test-Path -LiteralPath $kindDir)) { continue }
    if (Test-Reparse $kindDir) { $storeSkip ??= "$kindDir is a reparse point"; continue }
    $storeEntries[$kind] = @(Get-ChildItem -LiteralPath $kindDir -Force -ErrorAction Stop)
  } catch { $storeSkip ??= "cannot read $kindDir" }
}
foreach ($kind in 'claude', 'codex') {
  foreach ($e in $storeEntries[$kind]) {
    $key = "$kind/$($e.Name)"
    # Store ids are 64 lowercase hex (claude.exe sha256, codex store_id); tmp copies and strays stay.
    $why = if ($e.Name -cnotmatch '^[0-9a-f]{64}$' -or -not $e.PSIsContainer) { 'not id-shaped' }
      elseif ($storeSkip) { 'store pass skipped' }
      elseif ($pins[$kind] -contains $e.Name) { 'pinned by a kept bundle' }
      elseif ($e.Attributes -band [IO.FileAttributes]::ReparsePoint) { 'reparse point' }
      elseif (Test-InUse $e.FullName) { 'in use by a process' }
      elseif ($e.CreationTimeUtc -gt $currentCreated) { 'newer than current (in flight)' }
    if ($why) { $keepStore.Add($key); $storeWhy[$key] = $why } else { $deleteStore.Add($key) }
  }
}

# --- report ------------------------------------------------------------------------------------
Log ("bundles {0}: keep {1}, delete {2}" -f $bundlesDir, $keepBundles.Count, $deleteBundles.Count)
foreach ($id in ($keepBundles | Sort-Object)) { Log "  keep   $id ($($reasons[$id] -join ', '))" }
foreach ($id in ($deleteBundles | Sort-Object)) { Log "  delete $id ($(Get-DirMB (Join-Path $bundlesDir $id)) MB)" }
Log ("profiles {0}: keep {1}, delete {2}" -f $profileRoot, $keepProfiles.Count, $deleteProfiles.Count)
foreach ($id in ($keepProfiles | Sort-Object)) { Log "  keep   $id ($($profileWhy[$id]))" }
foreach ($id in ($deleteProfiles | Sort-Object)) { Log "  delete $id ($(Get-DirMB (Join-Path $profileRoot $id)) MB)" }
Log ("store {0}: keep {1}, delete {2}" -f $storeDir, $keepStore.Count, $deleteStore.Count)
if ($storeSkip) { Log "  store pass skipped, keeping all: $storeSkip" }
foreach ($k in ($keepStore | Sort-Object)) { Log "  keep   $k ($($storeWhy[$k]))" }
foreach ($k in ($deleteStore | Sort-Object)) { Log "  delete $k ($(Get-DirMB (Join-Path $storeDir $k.Replace('/', '\'))) MB)" }

if ($DryRun) {
  Log 'dry run: nothing deleted'
  Result $null $keepBundles $deleteBundles $keepProfiles $deleteProfiles $keepStore $deleteStore
  exit 0
}

# --- delete: move aside first (fails whole if anything inside is open), then remove ------------
function Remove-Aside($path, $trash) {
  $aside = Join-Path $trash ("{0}-{1}" -f (Split-Path $path -Leaf), [Guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    Move-Item -LiteralPath $path -Destination $aside -ErrorAction Stop
  } catch {
    Log "  skip ${path}: move failed, left whole ($($_.Exception.Message))"
    return $false
  }
  try {
    Remove-Item -LiteralPath $aside -Recurse -Force -ErrorAction Stop
  } catch {
    Log "  moved but not fully removed: $aside ($($_.Exception.Message)); next run retries"
  }
  return $true
}

$failed = 0
if ($deleteBundles.Count -gt 0) {
  New-Item -ItemType Directory -Force -Path $trashDir | Out-Null
  foreach ($id in $deleteBundles) { if (-not (Remove-Aside (Join-Path $bundlesDir $id) $trashDir)) { $failed++ } }
}
if ($deleteProfiles.Count -gt 0) {
  $profileTrash = Join-Path $LocalAppData "$identifier.prune-trash"
  New-Item -ItemType Directory -Force -Path $profileTrash | Out-Null
  foreach ($id in $deleteProfiles) { if (-not (Remove-Aside (Join-Path $profileRoot $id) $profileTrash)) { $failed++ } }
}
if ($deleteStore.Count -gt 0) {
  # Same volume as the store, so the move is a rename; an open claude.exe or codex.exe fails it.
  New-Item -ItemType Directory -Force -Path $trashDir | Out-Null
  foreach ($k in $deleteStore) { if (-not (Remove-Aside (Join-Path $storeDir $k.Replace('/', '\')) $trashDir)) { $failed++ } }
}
$total = $deleteBundles.Count + $deleteProfiles.Count + $deleteStore.Count
# Leftovers from an earlier run whose remove step failed: already rejected, so clear them now.
foreach ($t in @($trashDir, (Join-Path $LocalAppData "$identifier.prune-trash"))) {
  if (Test-Path -LiteralPath $t) {
    Get-ChildItem -LiteralPath $t -Force | ForEach-Object {
      try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop }
      catch { Log "  trash leftover kept: $($_.FullName)" }
    }
  }
}
Log ("removed {0} of {1} bundle(s), profile(s) and store entries; {2} skipped" -f ($total - $failed), $total, $failed)
Result $null $keepBundles $deleteBundles $keepProfiles $deleteProfiles $keepStore $deleteStore
