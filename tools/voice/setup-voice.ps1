# setup-voice.ps1 - one command that sets up Vidar's local voice stack.
#
#   pwsh -File tools/voice/setup-voice.ps1 [-DryRun] [-Yes] [-Speak] [-Root <checkout>]
#
# Steps: Python 3.11 (py launcher), venv, pip packages (lean ONNX set; -Speak adds the
# KPipeline Speak voice extra), Whisper CLI and model, Kokoro ONNX model files, wake-word
# models. Every step checks first and skips what is already in place. Before anything is
# fetched it prints one table (what, publisher, source, licence, size, check) and asks
# `Download these? [y/N]`; -Yes answers yes, -DryRun prints the table and changes nothing.
#
# Download sources:
#   - PyPI (pypi.org, files.pythonhosted.org) via pip: content/local-voice/requirements.txt,
#     and with -Speak content/local-voice/requirements-speak.txt (whose en-core-web-sm wheel
#     comes from github.com/explosion/spacy-models, SHA-256 pinned in the URL)
#   - Whisper CLI and model: tools/voice/fetch-whisper.ps1 (github.com/ggml-org/whisper.cpp
#     release v1.9.2, huggingface.co/ggerganov/whisper.cpp at a pinned commit; SHA-256 pinned there)
#   - Kokoro model files: github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
#     (kokoro-v1.0.int8.onnx, voices-v1.0.bin; byte size checked, SHA-256 printed)
#   - Wake-word models: tools/voice/wakeword-models.ps1 (github.com/dscripka/openWakeWord release
#     v0.5.1 and openwakeword.com; SHA-256 checked against the openwakeword.json pack manifest)
#
# Refuses: nothing is installed globally, no admin, no PATH change. Python itself is not
# downloaded: install Python 3.11 first if `py -3.11` is missing.
param(
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$Speak,
  [string]$Root
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$Root = (Resolve-Path $Root).Path

. (Join-Path $PSScriptRoot '..\lib\Paths.ps1')

$localVoice = Resolve-VidarPath -Id localVoice -Root $Root
$whisperDir = Resolve-VidarPath -Id whisper -Root $Root
$packsDir = Resolve-VidarPath -Id packs -Root $Root

$venvDir = Join-Path $localVoice '.venv'
$venvPython = Resolve-VidarPath -Id localVoicePython -Root $Root
$pipCache = Join-Path $localVoice '.cache\pip'
$requirements = Join-Path $localVoice 'requirements.txt'
$requirementsSpeak = Join-Path $localVoice 'requirements-speak.txt'
$kokoroDir = Join-Path $localVoice 'models\kokoro'
$kokoroBase = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
# Exact sizes of the model-files-v1.0 release assets (published 2025-01-28 by thewh1teagle).
# GitHub publishes no digest for them, so they are size-checked here, not hash-pinned upstream.
$KokoroBytes = [ordered]@{
  'kokoro-v1.0.int8.onnx' = 92361271
  'voices-v1.0.bin'       = 28214398
}
# SHA-256 pins: $null until set. Paste the hashes the first trusted run prints; once set,
# a mismatch deletes the file and stops.
$KokoroSha256 = @{
  'kokoro-v1.0.int8.onnx' = $null
  'voices-v1.0.bin'       = $null
}
$whisperModel = 'tiny.en-q8_0'

function Step {
  param([string]$Name, [bool]$Present, [string]$What, [scriptblock]$Action)
  if ($Present) { Write-Host "[skip]  $Name - $What"; return }
  if ($DryRun) { Write-Host "[would] $Name - $What"; return }
  Write-Host "[run]   $Name - $What"
  & $Action
}

function Invoke-Checked {
  param([string]$File, [string[]]$Arguments)
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') exited $LASTEXITCODE" }
}

# Reads the venv's installed metadata (python -I -B, no writes) and lists the requirement
# lines that are missing or at another version. URL pins (name @ url) check the name only.
function Get-MissingPackages {
  param([string]$RequirementsFile)
  if (-not (Test-Path $RequirementsFile)) { throw "Missing $RequirementsFile" }
  if (-not (Test-Path $venvPython)) { return @('(no venv yet: every package)') }
  $probe = @'
import sys, re
from importlib import metadata
def norm(n): return re.sub(r"[-_.]+", "-", n).lower()
have = {}
for d in metadata.distributions():
    name = d.metadata["Name"]
    if name: have[norm(name)] = d.version
for raw in open(sys.argv[1], encoding="utf-8"):
    line = raw.split(" #", 1)[0].strip()
    if not line or line.startswith("#") or line.startswith("-"):
        continue
    if " @ " in line:
        name, want = line.split(" @ ", 1)[0].strip(), None
    else:
        m = re.match(r"^([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*(?:==\s*([^\s;]+))?", line)
        if not m:
            continue
        name, want = m.group(1), m.group(2)
    got = have.get(norm(name))
    if got is None or (want and got.split("+")[0] != want.split("+")[0]):
        print(line.split(" @ ", 1)[0])
'@
  $out = & $venvPython -I -B -c $probe $RequirementsFile
  if ($LASTEXITCODE -ne 0) { throw "Package check failed for $RequirementsFile" }
  return @($out | Where-Object { $_ })
}

function Show-Missing {
  param([string[]]$Missing)
  foreach ($m in $Missing) { Write-Host "          missing: $m" }
}

function Test-KokoroFile {
  param([string]$Name)
  $p = Join-Path $kokoroDir $Name
  return (Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p).Length -eq $KokoroBytes[$Name])
}

# --- Check what is already in place (no writes) ---

$py311 = $false
try {
  & py -3.11 -c 'import sys' 2>$null
  $py311 = ($LASTEXITCODE -eq 0)
} catch { $py311 = $false }

$hasVenv = Test-Path $venvPython
$missing = @(Get-MissingPackages $requirements)
$missingSpeak = @(if ($Speak) { Get-MissingPackages $requirementsSpeak })

$whisperFile = Join-Path $whisperDir "ggml-$whisperModel.bin"
$whisperCli = Join-Path $whisperDir 'whisper-cli.exe'
$whisperReady = (Test-Path $whisperFile) -and (Test-Path $whisperCli)

$kokoroMissing = @($KokoroBytes.Keys | Where-Object { -not (Test-KokoroFile $_) })

# Wake-word models: every manifest entry wakeword-models.ps1 pins (models[] and the files[]
# entries with a sha256). That script writes into its own checkout, not -Root.
$wakeScript = Join-Path $PSScriptRoot 'wakeword-models.ps1'
$wakeManifest = Join-Path $packsDir 'voice-stock\voice\openwakeword.json'
$wm = Get-Content -LiteralPath $wakeManifest -Raw | ConvertFrom-Json
$wakeEntries = @($wm.models) + @($wm.files | Where-Object { $_ -isnot [string] -and $_.PSObject.Properties['sha256'] -and $_.sha256 })
$wakeMissing = @($wakeEntries | ForEach-Object {
  Join-Path $Root ($_.file.Substring('{vidar}/'.Length) -replace '/', '\')
} | Where-Object { -not (Test-Path -LiteralPath $_) })

# --- What will be downloaded ---

$rows = [System.Collections.Generic.List[object]]::new()
function Add-Row($What, $Publisher, $Source, $Licence, $Size, $Check) {
  $rows.Add([pscustomobject]@{
    What = $What; Publisher = $Publisher; Source = $Source; Licence = $Licence; Size = $Size; Check = $Check
  })
}
if ($missing.Count -gt 0) {
  Add-Row 'Python packages (lean ONNX set)' 'Each project''s maintainers, via PyPI' `
    'pypi.org/simple, files.pythonhosted.org' 'MIT, BSD-3-Clause, Apache-2.0 per package; phonemizer GPL-3.0' `
    'up to ~150 MB' 'HTTPS; direct packages at exact == versions (versions, not hashes); pip resolves the rest'
}
if ($missingSpeak.Count -gt 0) {
  Add-Row 'Speak voice extra (kokoro, PyTorch CPU, spaCy)' 'hexgrad, PyTorch, Explosion, via PyPI' `
    'pypi.org, files.pythonhosted.org, github.com/explosion/spacy-models/releases' `
    'Apache-2.0 (kokoro, misaki); BSD-style (torch); MIT (spaCy)' '~1 GB' `
    'HTTPS; exact == versions; en-core-web-sm wheel SHA-256 pinned'
}
if (-not $whisperReady) {
  Add-Row 'whisper.cpp CLI and tiny.en model' 'ggml-org (whisper.cpp)' `
    'github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip; huggingface.co/ggerganov/whisper.cpp/resolve/<pinned commit>/ggml-tiny.en-q8_0.bin' `
    'MIT' '~15 MB zip + 44 MB model' 'SHA-256 pinned in fetch-whisper.ps1 for both files'
}
foreach ($f in $kokoroMissing) {
  Add-Row "Kokoro model file $f" 'thewh1teagle (kokoro-onnx), release model-files-v1.0, 2025-01-28' `
    "github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$f" `
    'Apache-2.0 (Kokoro-82M weights)' ('{0:N1} MB' -f ($KokoroBytes[$f] / 1MB)) `
    "exact byte size ($($KokoroBytes[$f])); SHA-256 printed; upstream publishes no hash"
}
if ($wakeMissing.Count -gt 0) {
  Add-Row 'Wake-word models (openWakeWord)' 'dscripka (openWakeWord); openwakeword.com model library' `
    'github.com/dscripka/openWakeWord/releases/download/v0.5.1; openwakeword.com/api/models' `
    'CC BY-NC-SA 4.0 (models)' '~7 MB' 'SHA-256 and byte size against the openwakeword.json pack manifest'
}

if (-not $py311) {
  Write-Host '[fail]  Python 3.11 - `py -3.11` not found; install Python 3.11 and rerun'
  if (-not $DryRun) { exit 1 }
} else {
  Write-Host '[skip]  Python 3.11 - py -3.11 present'
}

if ($rows.Count -gt 0) {
  Write-Host ''
  Write-Host 'To download:'
  foreach ($r in $rows) {
    Write-Host ''
    Write-Host "  $($r.What)"
    Write-Host "    Publisher: $($r.Publisher)"
    Write-Host "    Source:    $($r.Source)"
    Write-Host "    Licence:   $($r.Licence)"
    Write-Host "    Size:      $($r.Size)"
    Write-Host "    Check:     $($r.Check)"
  }
  Write-Host ''
  Write-Host "Everything lands inside this checkout ($localVoice and $whisperDir);"
  Write-Host 'fetch-whisper.ps1 unpacks its zip in %TEMP% first. Nothing is installed globally,'
  Write-Host 'no admin rights are needed and PATH is not changed.'
  Write-Host ''
  if (-not $DryRun -and -not $Yes) {
    $answer = Read-Host 'Download these? [y/N]'
    if ($answer -notmatch '^(y|yes)$') { Write-Host 'Nothing downloaded.'; exit 0 }
  }
} else {
  Write-Host 'Nothing to download.'
}

# --- Run ---

Step 'Venv' $hasVenv "create $venvDir" {
  Invoke-Checked 'py' @('-3.11', '-m', 'venv', $venvDir)
}

Step 'Packages' ($missing.Count -eq 0) "pip install -r $requirements" {
  Invoke-Checked $venvPython @('-m', 'pip', 'install', '--cache-dir', $pipCache, '-r', $requirements)
}
if ($missing.Count -gt 0) { Show-Missing $missing }

if ($Speak) {
  Step 'Speak extra' ($missingSpeak.Count -eq 0) "pip install -r $requirementsSpeak" {
    Invoke-Checked $venvPython @('-m', 'pip', 'install', '--cache-dir', $pipCache, '-r', $requirementsSpeak)
  }
  if ($missingSpeak.Count -gt 0) { Show-Missing $missingSpeak }
}

Step 'Whisper' $whisperReady "fetch-whisper.ps1 -Model $whisperModel" {
  Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'fetch-whisper.ps1'), '-Model', $whisperModel)
}

foreach ($f in $KokoroBytes.Keys) {
  $dest = Join-Path $kokoroDir $f
  Step "Kokoro $f" (Test-KokoroFile $f) "download to $kokoroDir" {
    New-Item -ItemType Directory -Force $kokoroDir | Out-Null
    $part = "$dest.part"
    Invoke-Checked 'curl.exe' @('-L', '--fail', '-o', $part, "$kokoroBase/$f")
    $size = (Get-Item -LiteralPath $part).Length
    if ($size -ne $KokoroBytes[$f]) {
      Remove-Item -LiteralPath $part -Force
      throw "$f is $size bytes, expected $($KokoroBytes[$f]); removed, rerun to fetch it fresh"
    }
    $sha = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLower()
    if ($KokoroSha256[$f] -and $sha -ne $KokoroSha256[$f]) {
      Remove-Item -LiteralPath $part -Force
      throw "$f SHA-256 $sha does not match the pin $($KokoroSha256[$f]); removed"
    }
    Move-Item -Force $part $dest
    Write-Host "          $f size ok ($size bytes), sha256 $sha"
  }
}

Step 'Wake word' ($wakeMissing.Count -eq 0) 'wakeword-models.ps1' {
  Invoke-Checked 'pwsh' @('-NoProfile', '-File', $wakeScript)
}
foreach ($w in $wakeMissing) { Write-Host "          missing: $w" }

if ($DryRun) { Write-Host 'Dry run: nothing changed.' } else { Write-Host 'Voice setup done.' }
