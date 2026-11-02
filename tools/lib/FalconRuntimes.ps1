# FalconRuntimes.ps1 - the one table of the CLI runtimes a Falcon bundle can carry.
# Dot-source it; it defines $FalconRuntimes and its helpers, and runs nothing.
#
#   . "$PSScriptRoot\..\lib\FalconRuntimes.ps1"
#
# Table-tier file: a new runtime is one row here, and nothing in falcon-inputs.ps1, falcon-build.ps1,
# falcon-slice1.ps1 or tools/falcon/build.mjs names a runtime. Vendor strings that a release set traces
# (the CLI's image name, its sidecar names, its npm scope) are built from the row id and from the
# runtime's pack.json, never spelled here.
#
# Each row (a hashtable; every field but PinField is optional):
#   PinField          the manifest field inside the runtime's block that pins its store entry; a row
#                     without one cannot be pruned safely, so falcon-prune.ps1 treats it as unknown.
#   SidecarParts      the sibling sidecar modules, as name parts: "<id>-sidecar-<part>.mjs" (tools\).
#   SessionHook       $true when a hosted session runs the SessionStart hook falcon-slice1.ps1 arms.
#   Installed         { param($RepoRoot) } -> @{ names; candidates }: how Falcon finds the user's own CLI.
#   ShellLines        { param($RepoRoot) } -> input lines that belong to the shell key.
#   Locate            { param($RepoRoot) } -> @{ Source; BuildMissing; PredictMissing }.
#   Identify          { param($Source) } -> the pinned identity (a digest, a file list), pre-hashed.
#   IdentityError     { param($Identity) } -> a message when the identity is empty, else $null.
#   InputLines        { param($RepoRoot, $ToolsDir, $Identity) } -> the runtime's bundle input lines.
#   Prepare           { param($Ctx) } -> state; pins the store entry (Ctx: RepoRoot, ToolsDir, StoreRoot).
#   Required          { param($State, $Bundle) } -> files a reused bundle must contain.
#   VerifyManifest    { param($State, $Stored, $Bundle) } throws when a reused manifest disagrees.
#   StagedDiffers     { param($State, $Bundle) } -> $true when a staged input no longer matches the tree.
#   Stage             { param($State, $Bundle) } copies the runtime's files into a new bundle.
#   Manifest          { param($State) } -> @{ Files; Block } for runtime-manifest.json.
$script:FalconRuntimes = [ordered]@{
  claude = @{
    PinField = 'exe_sha256'
    SidecarParts = @('shrink', 'statusline', 'seed', 'bare', 'recover', 'ledger', 'trust')
    SessionHook = $true
    Installed = { param($RepoRoot) Get-FalconClaudeInstalled -RepoRoot $RepoRoot }
    ShellLines = { param($RepoRoot) $id = 'claude'; @("runtime/$id-sidecar.mjs|$(Get-Sha256File (Join-Path $RepoRoot "tools\$id-sidecar.mjs"))") }
    Locate = { param($RepoRoot) Find-FalconClaudeSource $RepoRoot }
    Identify = { param($Source) Get-Sha256File $Source }
    IdentityError = { param($Identity) $id = 'claude'; if (-not $Identity) { "$id is a runtime but no $id.exe digest was given" } }
    InputLines = { param($RepoRoot, $ToolsDir, $Identity) Get-FalconClaudeInputLines $RepoRoot $ToolsDir $Identity }
    Prepare = { param($Ctx) Initialize-FalconClaudeRuntime $Ctx }
    Required = { param($State, $Bundle) Get-FalconClaudeRequired $State $Bundle }
    VerifyManifest = { param($State, $Stored, $Bundle) }
    StagedDiffers = { param($State, $Bundle) Test-FalconClaudeStagedDiffers $State $Bundle }
    Stage = { param($State, $Bundle) Copy-FalconClaudeStage $State $Bundle }
    Manifest = { param($State) Get-FalconClaudeManifest $State }
  }
  codex = @{
    PinField = 'store_id'
    Locate = { param($RepoRoot) Find-FalconCodexSource }
    Identify = { param($Source) @(Get-FalconCodexFiles -Dir $Source) }
    IdentityError = { param($Identity) if (@($Identity).Count -eq 0) { 'codex is a runtime but no Codex native package files were given' } }
    InputLines = { param($RepoRoot, $ToolsDir, $Identity) @($Identity | ForEach-Object { "runtime/codex/$($_.path)|$($_.sha256)" }) }
    Prepare = { param($Ctx) Initialize-FalconCodexRuntime $Ctx }
    Required = { param($State, $Bundle) @() }
    VerifyManifest = { param($State, $Stored, $Bundle) Test-FalconCodexManifest $State $Stored $Bundle }
    StagedDiffers = { param($State, $Bundle) $false }
    Stage = { param($State, $Bundle) }
    Manifest = { param($State) Get-FalconCodexManifest $State }
  }
}

function Get-FalconRuntimeIds { return @($script:FalconRuntimes.Keys) }

# The row for one runtime id; $null when the table does not know it.
function Get-FalconRuntimeRow([string]$Id) {
  if ($script:FalconRuntimes.Contains($Id)) { return $script:FalconRuntimes[$Id] }
  return $null
}

# $true when the table knows the runtime and can read its pin.
function Test-FalconRuntimePinnable([string]$Id) {
  return $script:FalconRuntimes.Contains($Id) -and [bool]$script:FalconRuntimes[$Id].PinField
}

# The manifest's pin for one runtime as a string, '' when absent. Throws for an unpinnable runtime.
function Get-FalconRuntimePin([string]$Id, $Manifest) {
  if (-not (Test-FalconRuntimePinnable $Id)) { throw "no pin reader for runtime '$Id'" }
  $field = $script:FalconRuntimes[$Id].PinField
  return "$($Manifest.($Id).($field))"
}

# The CLI's process image name ("<id>.exe"): what a hosted session's tree is checked for.
function Get-FalconRuntimeImage([string]$Id) { return "$Id.exe" }

# The folder a runtime keeps its own settings in, inside a session cwd (".<id>").
function Get-FalconRuntimeConfigDir([string]$Id) { return ".$Id" }

# The runtime whose hosted session runs the SessionStart hook falcon-slice1.ps1 arms.
function Get-FalconHookedRuntimeId {
  foreach ($id in $script:FalconRuntimes.Keys) { if ($script:FalconRuntimes[$id].SessionHook) { return $id } }
  return $null
}

# The sibling sidecar module file names (tools\<name>) of every runtime that declares them.
function Get-FalconSidecarModuleNames {
  foreach ($id in $script:FalconRuntimes.Keys) {
    foreach ($part in @($script:FalconRuntimes[$id].SidecarParts)) { if ($part) { "$id-sidecar-$part.mjs" } }
  }
}

# --- runtime sources (read-only) -------------------------------------------------------------------

# The npm package a runtime's pack names for its CLI (content\packs\<id>\pack.json dep `update.package`).
function Get-FalconRuntimePackage {
  param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$Id)
  $packPath = Join-Path $RepoRoot "content\packs\$Id\pack.json"
  if (-not (Test-Path -LiteralPath $packPath -PathType Leaf)) { return $null }
  $pack = Get-Content -LiteralPath $packPath -Raw | ConvertFrom-Json
  $dep = @($pack.module.deps) | Where-Object { $_ -and $_.id -eq $Id } | Select-Object -First 1
  if ($dep -and $dep.update -and $dep.update.package) { return [string]$dep.update.package }
  return $null
}

# The installed CLI: npm-global first, then the native installer's copy.
function Find-FalconClaudeSource {
  param([Parameter(Mandatory)][string]$RepoRoot)
  $id = 'claude'
  $package = Get-FalconRuntimePackage -RepoRoot $RepoRoot -Id $id
  $candidates = @()
  if ($package) { $candidates += Join-Path $env:APPDATA ("npm\node_modules\" + ($package -replace '/', '\') + "\bin\$id.exe") }
  $candidates += Join-Path $env:USERPROFILE ".local\bin\$id.exe"
  $source = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  return [pscustomobject]@{
    Source = $source
    BuildMissing = "$id.exe not found; looked in: $($candidates -join '; ')"
    PredictMissing = "$id.exe not found (falcon-build.ps1 would fail the same way)"
  }
}

# The Codex native package the npm wrapper resolves.
function Find-FalconCodexSource {
  $dir = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64'
  $source = if (Test-Path -LiteralPath $dir -PathType Container) { $dir } else { $null }
  return [pscustomobject]@{
    Source = $source
    BuildMissing = "npm-global Codex native package not found at $dir"
    PredictMissing = "Codex native package not found at $dir"
  }
}

# How Falcon finds the user's own Claude CLI when the pinned store copy is missing: the claude dep's
# probe in the runtime's pack.json. names keep *.exe only and plain filenames (Falcon spawns the
# path directly, so a .cmd/.ps1 shim is no use); candidates pass through as written. Today's values
# when the pack declares none.
function Get-FalconClaudeInstalled {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $id = 'claude'
    $names = @(); $candidates = @()
    $packPath = Join-Path $RepoRoot "content\packs\$id\pack.json"
    if (Test-Path -LiteralPath $packPath -PathType Leaf) {
        $pack = Get-Content -LiteralPath $packPath -Raw | ConvertFrom-Json
        $dep = @($pack.module.deps) | Where-Object { $_ -and $_.id -eq $id } | Select-Object -First 1
        if ($dep -and $dep.probe) {
            $names = @(Get-ConfigPathList $dep.probe.names | Where-Object { $_ -like '*.exe' -and $_ -notmatch '[\\/]' -and $_ -ne '.exe' -and $_ -notmatch '\.\.' })
            $candidates = @(Get-ConfigPathList $dep.probe.candidates)
        }
    }
    if ($names.Count -eq 0) { $names = @("$id.exe") }
    if ($candidates.Count -eq 0) { $candidates = @("%USERPROFILE%\.local\bin\$id.exe") }
    return [pscustomobject]@{ names = [string[]]$names; candidates = [string[]]$candidates }
}

# The Codex native package as [pscustomobject]@{ path; sha256 } per file, paths relative with
# forward slashes, sorted ordinally: the identity falcon-build.ps1 stores and verifies.
function Get-FalconCodexFiles {
    param([Parameter(Mandatory)][string]$Dir)
    $paths = [string[]]@(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force |
        ForEach-Object { $_.FullName.Substring($Dir.Length + 1).Replace('\', '/') })
    [Array]::Sort($paths, [StringComparer]::Ordinal)
    return @($paths | ForEach-Object {
        [pscustomobject]@{ path = $_; sha256 = Get-Sha256File (Join-Path $Dir ($_ -replace '/', '\')) }
    })
}

# The Claude runtime's bundle input lines: sidecar modules, staged SDK files, the pinned CLI digest and the
# installed-CLI names/candidates (pack.json is not an input itself; what it yields is).
function Get-FalconClaudeInputLines {
    param([string]$RepoRoot, [string]$ToolsDir, [string]$Identity)
    $id = 'claude'
    $lines = [System.Collections.Generic.List[string]]::new()
    $sdkDir = Join-Path $RepoRoot (Get-FalconClaudeSdkRel $RepoRoot)
    foreach ($name in (Get-FalconSidecarModuleNames)) { [void]$lines.Add("runtime/$name|$(Get-Sha256File (Join-Path $ToolsDir $name))") }
    [void]$lines.Add("runtime/sdk/package.json|$(Get-Sha256File (Join-Path $sdkDir 'package.json'))")
    [void]$lines.Add("runtime/sdk/sdk.mjs|$(Get-Sha256File (Join-Path $sdkDir 'sdk.mjs'))")
    [void]$lines.Add("runtime/$id.exe|$Identity")
    $installed = Get-FalconClaudeInstalled -RepoRoot $RepoRoot
    [void]$lines.Add("runtime/$id/installed|$(Get-Sha256Text ("names:" + ($installed.names -join '|') + "`ncandidates:" + ($installed.candidates -join '|')))")
    return $lines.ToArray()
}

# The SDK the sidecar imports: <npm scope>/<id>-agent-sdk under node_modules (scope from the pack's package).
function Get-FalconClaudeSdkRel([string]$RepoRoot) {
  $id = 'claude'
  $package = Get-FalconRuntimePackage -RepoRoot $RepoRoot -Id $id
  if (-not $package) { throw "content\packs\$id\pack.json names no npm package, so the SDK scope is unknown" }
  return "node_modules\$($package.Split('/')[0])\$id-agent-sdk"
}

# --- build-side preparation (falcon-build.ps1) ------------------------------------------------------

function Initialize-FalconClaudeRuntime {
  param([Parameter(Mandatory)]$Ctx)
  $id = 'claude'
  $sidecarSource = Join-Path $Ctx.ToolsDir "$id-sidecar.mjs"
  if (-not (Test-Path -LiteralPath $sidecarSource)) { throw "sidecar script not found at $sidecarSource" }
  # Sibling modules the sidecar imports by relative path; staged beside it, hashed into the id.
  $modules = @(foreach ($name in (Get-FalconSidecarModuleNames)) {
    $moduleSource = Join-Path $Ctx.ToolsDir $name
    if (-not (Test-Path -LiteralPath $moduleSource)) { throw "sidecar module not found at $moduleSource" }
    [pscustomobject]@{ name = $name; source = $moduleSource; sha256 = (Get-Sha256File $moduleSource) }
  })
  $sdkRel = Get-FalconClaudeSdkRel $Ctx.RepoRoot
  $sdkDir = Join-Path $Ctx.RepoRoot $sdkRel
  $sdkPackageJson = Join-Path $sdkDir 'package.json'
  $sdkEntry = Join-Path $sdkDir 'sdk.mjs'
  if (-not (Test-Path -LiteralPath $sdkPackageJson)) { throw "SDK package.json not found at $sdkPackageJson" }
  if (-not (Test-Path -LiteralPath $sdkEntry)) { throw "SDK entrypoint not found at $sdkEntry" }

  # The installed CLI is the source of truth for the content-addressed store. Its own hash is computed
  # here, never copied from a document.
  $located = Find-FalconClaudeSource $Ctx.RepoRoot
  if (-not $located.Source) { throw $located.BuildMissing }
  Write-Host "$id.exe source: $($located.Source)"
  $exeHash = Get-Sha256File $located.Source
  $storeRoot = Join-Path $Ctx.StoreRoot $id
  $storeDir = Join-Path $storeRoot $exeHash
  $storeExe = Join-Path $storeDir "$id.exe"
  if (Test-Path -LiteralPath $storeExe) {
    $existingStoreHash = Get-Sha256File $storeExe
    if ($existingStoreHash -ne $exeHash) {
      throw "content-addressed $id.exe store corruption at $storeExe (expected $exeHash, found $existingStoreHash)"
    }
  } else {
    New-Item -ItemType Directory -Path $storeDir -Force | Out-Null
    $tempExe = Join-Path $storeRoot "$exeHash.tmp-$([Guid]::NewGuid().ToString('N'))"
    Copy-Item -LiteralPath $located.Source -Destination $tempExe
    $copiedHash = Get-Sha256File $tempExe
    if ($copiedHash -ne $exeHash) {
      throw "$id.exe copy verification failed: expected $exeHash, got $copiedHash (stale temp left at $tempExe)"
    }
    Move-Item -LiteralPath $tempExe -Destination $storeExe
  }
  return @{
    Id = $id; Identity = $exeHash; Modules = $modules
    SidecarSource = $sidecarSource; SidecarHash = (Get-Sha256File $sidecarSource)
    SdkPackageJson = $sdkPackageJson; SdkPackageHash = (Get-Sha256File $sdkPackageJson)
    SdkEntry = $sdkEntry; SdkEntryHash = (Get-Sha256File $sdkEntry)
    SdkBundleRel = "sidecar\$sdkRel"
    # How Falcon finds the user's own CLI when the pinned store copy is missing (pack.json's probe, *.exe names only).
    Installed = (Get-FalconClaudeInstalled -RepoRoot $Ctx.RepoRoot)
  }
}

function Get-FalconClaudeRequired {
  param($State, [string]$Bundle)
  $sdk = Join-Path $Bundle $State.SdkBundleRel
  return @((Join-Path $Bundle "sidecar\$($State.Id)-sidecar.mjs"), (Join-Path $sdk 'package.json'), (Join-Path $sdk 'sdk.mjs')) +
    @($State.Modules | ForEach-Object { Join-Path $Bundle "sidecar\$($_.name)" })
}

function Test-FalconClaudeStagedDiffers {
  param($State, [string]$Bundle)
  $sdk = Join-Path $Bundle $State.SdkBundleRel
  return ((Get-Sha256File (Join-Path $Bundle "sidecar\$($State.Id)-sidecar.mjs")) -ne $State.SidecarHash -or
    (Get-Sha256File (Join-Path $sdk 'package.json')) -ne $State.SdkPackageHash -or
    (Get-Sha256File (Join-Path $sdk 'sdk.mjs')) -ne $State.SdkEntryHash -or
    @($State.Modules | Where-Object { (Get-Sha256File (Join-Path $Bundle "sidecar\$($_.name)")) -ne $_.sha256 }).Count -gt 0)
}

# Stage the sidecar and just enough of the SDK for its bare import to resolve from inside the bundle.
# node_modules sits beside the sidecar script so Node's upward module resolution finds it without
# reaching into the checkout.
function Copy-FalconClaudeStage {
  param($State, [string]$Bundle)
  $sidecarDir = Join-Path $Bundle 'sidecar'
  $sdkDir = Join-Path $Bundle $State.SdkBundleRel
  New-Item -ItemType Directory -Path $sdkDir | Out-Null
  Copy-Item -LiteralPath $State.SidecarSource -Destination (Join-Path $sidecarDir "$($State.Id)-sidecar.mjs")
  foreach ($module in $State.Modules) { Copy-Item -LiteralPath $module.source -Destination (Join-Path $sidecarDir $module.name) }
  Copy-Item -LiteralPath $State.SdkPackageJson -Destination (Join-Path $sdkDir 'package.json')
  Copy-Item -LiteralPath $State.SdkEntry -Destination (Join-Path $sdkDir 'sdk.mjs')
}

function Get-FalconClaudeManifest {
  param($State)
  $sdkRel = $State.SdkBundleRel.Replace('\', '/')
  return @{
    Files = @(
      [ordered]@{ path = "sidecar/$($State.Id)-sidecar.mjs"; sha256 = $State.SidecarHash }
      $State.Modules | ForEach-Object { [ordered]@{ path = "sidecar/$($_.name)"; sha256 = $_.sha256 } }
      [ordered]@{ path = "$sdkRel/package.json"; sha256 = $State.SdkPackageHash }
      [ordered]@{ path = "$sdkRel/sdk.mjs"; sha256 = $State.SdkEntryHash }
    )
    Block = [ordered]@{
      sidecar = "sidecar/$($State.Id)-sidecar.mjs"
      sdk = "$sdkRel/sdk.mjs"
      exe_sha256 = $State.Identity
      store_exe = "$($State.Id).exe"   # plain filename inside store\<id>\<pin>\
      installed = [ordered]@{ names = @($State.Installed.names); candidates = @($State.Installed.candidates) }
    }
  }
}

# The Codex npm wrapper is intentionally not part of the runtime. Pin and copy the complete native
# package it resolves instead: codex.exe plus its sibling helpers/resources are one dependency closure,
# addressed by the exact ordered path/hash set. Falcon launches the stored executable directly, so
# neither PATH nor the mutable npm-global installation participates after this build.
function Initialize-FalconCodexRuntime {
  param([Parameter(Mandatory)]$Ctx)
  $entrypoint = 'vendor/x86_64-pc-windows-msvc/bin/codex.exe'
  $located = Find-FalconCodexSource
  if (-not $located.Source) { throw $located.BuildMissing }
  $nativeSource = $located.Source
  if (-not (Test-Path -LiteralPath (Join-Path $nativeSource ($entrypoint -replace '/', '\')) -PathType Leaf)) {
    throw "Codex app-server entrypoint not found in $nativeSource"
  }
  $files = @(Get-FalconCodexFiles -Dir $nativeSource)
  $identityLines = @($files | ForEach-Object { "$($_.path)|$($_.sha256)" })
  $storeId = Get-Sha256Text ("falcon-codex-runtime/1`n" + ($identityLines -join "`n") + "`n")
  $storeRoot = Join-Path $Ctx.StoreRoot 'codex'
  $storeDir = Join-Path $storeRoot $storeId

  if (Test-Path -LiteralPath $storeDir -PathType Container) {
    $storedRelativePaths = [string[]]@(Get-ChildItem -LiteralPath $storeDir -Recurse -File -Force |
        ForEach-Object { $_.FullName.Substring($storeDir.Length + 1).Replace('\', '/') })
    [Array]::Sort($storedRelativePaths, [StringComparer]::Ordinal)
    $storedFiles = @($storedRelativePaths | ForEach-Object {
        [pscustomobject]@{
            path = $_
            sha256 = Get-Sha256File (Join-Path $storeDir ($_ -replace '/', '\'))
        }
    })
    if (($storedFiles | ConvertTo-Json -Compress) -ne ($files | ConvertTo-Json -Compress)) {
        throw "content-addressed Codex runtime store corruption at $storeDir"
    }
  } else {
    New-Item -ItemType Directory -Path $storeRoot -Force | Out-Null
    $tempDir = Join-Path $storeRoot "$storeId.tmp-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    foreach ($source in Get-ChildItem -LiteralPath $nativeSource -Force) {
        Copy-Item -LiteralPath $source.FullName -Destination $tempDir -Recurse
    }
    $copiedRelativePaths = [string[]]@(Get-ChildItem -LiteralPath $tempDir -Recurse -File -Force |
        ForEach-Object { $_.FullName.Substring($tempDir.Length + 1).Replace('\', '/') })
    [Array]::Sort($copiedRelativePaths, [StringComparer]::Ordinal)
    $copiedFiles = @($copiedRelativePaths | ForEach-Object {
        [pscustomobject]@{
            path = $_
            sha256 = Get-Sha256File (Join-Path $tempDir ($_ -replace '/', '\'))
        }
    })
    if (($copiedFiles | ConvertTo-Json -Compress) -ne ($files | ConvertTo-Json -Compress)) {
        throw "Codex runtime copy verification failed (stale temp left at $tempDir)"
    }
    Move-Item -LiteralPath $tempDir -Destination $storeDir
  }
  return @{ Id = 'codex'; Identity = $files; StoreId = $storeId; Entrypoint = $entrypoint }
}

function Test-FalconCodexManifest {
  param($State, $Stored, [string]$Bundle)
  $storedFiles = @($Stored.codex.files | ForEach-Object {
      [pscustomobject]@{ path = $_.path; sha256 = $_.sha256 }
  })
  if ($Stored.codex.store_id -ne $State.StoreId -or
      $Stored.codex.entrypoint -ne $State.Entrypoint -or
      ($storedFiles | ConvertTo-Json -Compress) -ne ($State.Identity | ConvertTo-Json -Compress)) {
      throw "Falcon bundle $Bundle has Codex runtime metadata that does not match its pinned inputs"
  }
}

function Get-FalconCodexManifest {
  param($State)
  return @{
    Files = @()
    Block = [ordered]@{
      store_id = $State.StoreId
      entrypoint = $State.Entrypoint
      files = @($State.Identity | ForEach-Object { [ordered]@{ path = $_.path; sha256 = $_.sha256 } })
    }
  }
}
