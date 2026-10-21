# Fetch the wake-word models the listen sidecar needs and verify them against the stock
# openWakeWord manifest (content\packs\voice-stock\voice\openwakeword.json: every models[] entry and
# every files[] entry that declares a sha256). The manifest is the one pin; Vidar checks the
# same hashes before it spawns the sidecar. Run once on a fresh checkout; the .onnx files
# themselves are gitignored. Downloads are ask-first on this machine (guard-install.mjs); run
# this by hand after saying yes, never from a build script.
#
#   pwsh -NoProfile -File tools\voice\wakeword-models.ps1 [-Force]
#
# Sources: openWakeWord's v0.5.1 GitHub release for upstream assets, plus the model
# library's pinned download endpoint for curated additions. Publishers provide no hashes;
# ours were recorded at first fetch and a mismatch here is a stop, not a warning.
param([switch]$Force)
$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. "$PSScriptRoot\..\lib\Paths.ps1"
$manifest = Join-Path (Resolve-VidarPath -Id packs -Root $root) "voice-stock\voice\openwakeword.json"
$base = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1"
$sources = @{
  "atlas.onnx" = "https://openwakeword.com/api/models/1421/download?format=onnx"
  "pico.onnx" = "https://openwakeword.com/api/models/540/download?format=onnx"
}

if (-not (Test-Path -LiteralPath $manifest)) { throw "missing manifest: $manifest" }
$m = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
$entries = @($m.models) + @($m.files | Where-Object { $_ -isnot [string] -and $_.sha256 })

$bad = 0
foreach ($e in $entries) {
  if ($e.file -notlike "{vidar}/*") { throw "not a {vidar} path: $($e.file)" }
  if (-not $e.sha256 -or -not $e.bytes) { throw "no sha256/bytes in the manifest for $($e.file)" }
  $path = Join-Path $root ($e.file.Substring("{vidar}/".Length) -replace '/', '\')
  $name = Split-Path $path -Leaf
  $hash, $bytes = $e.sha256.ToLower(), [int64]$e.bytes
  New-Item -ItemType Directory -Force (Split-Path $path -Parent) | Out-Null
  if ($Force -or -not (Test-Path -LiteralPath $path)) {
    Write-Host "fetch $name"
    $uri = if ($sources.ContainsKey($name)) { $sources[$name] } else { "$base/$name" }
    Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $path
  }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
  $size = (Get-Item -LiteralPath $path).Length
  if ($actual -ne $hash -or $size -ne $bytes) {
    Write-Host "MISMATCH $name  sha256 $actual ($size bytes)  expected $hash ($bytes bytes)" -ForegroundColor Red
    Remove-Item -LiteralPath $path -Force
    $bad++
  } else {
    Write-Host "ok $name"
  }
}
if ($bad) { throw "$bad model(s) failed verification and were removed" }
Write-Host "all models verified" -ForegroundColor Green
