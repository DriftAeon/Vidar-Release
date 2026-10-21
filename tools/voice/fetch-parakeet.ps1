# Installs the Parakeet TDT 0.6b ONNX (int8) model files into <localVoice>\models\<Dir> and the
# onnx-asr wheel into the localVoicePython environment (no dependencies pulled; they are already there).
# Usage: pwsh -File tools/voice/fetch-parakeet.ps1 [-Variant v2]
# Re-run to update; present files whose SHA256 matches the pin are skipped.
# Pinned: the HF commit is fixed and every file is SHA256-checked against $Pins. A file with a
# $null hash would be unpinned: its sha256 and size are printed for pinning in the manifest.
# A pinned mismatch deletes the file and throws. Refuses a variant with no pin table.
param(
  [string]$Variant = "v2"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # the progress bar throttles big downloads

$Pins = @{
  "v2" = @{
    Repo   = "istupakov/parakeet-tdt-0.6b-v2-onnx"
    Commit = "0bbb45a3365852604aef28b538a8f066f4ccaa85"
    Dir    = "parakeet-tdt-0.6b-v2"
    Files  = @(
      @{ Name = "encoder-model.int8.onnx";       Size = 652184014; Sha256 = "3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155" }
      @{ Name = "decoder_joint-model.int8.onnx"; Size = 8998286;   Sha256 = "a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3" }
      @{ Name = "nemo128.onnx";                  Size = 139764;    Sha256 = "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f" }
      @{ Name = "config.json";                   Size = 97;        Sha256 = "666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466" }
      @{ Name = "vocab.txt";                     Size = 9384;      Sha256 = "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d" }
    )
  }
}
$WheelUrl    = "https://files.pythonhosted.org/packages/6a/60/2fa469a2ee674c35ab48821a1039762ae7b9d0b88188ac1012e779477f76/onnx_asr-0.12.0-py3-none-any.whl"
$WheelSha256 = "5e7ceca454609819ea7833f61e2302e0c8f6ece4f8a78b66c5daba53cb51de4a"
$WheelVer    = "0.12.0"

$pin = $Pins[$Variant]
if (-not $pin) { throw "no pin table for variant $Variant" }

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. "$PSScriptRoot\..\lib\Paths.ps1"
$dest = Join-Path (Resolve-VidarPath -Id localVoice -Root $root) (Join-Path "models" $pin.Dir)
$python = Resolve-VidarPath -Id localVoicePython -Root $root
New-Item -ItemType Directory -Force $dest | Out-Null

function Get-Sha256($path) { (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() }

foreach ($f in $pin.Files) {
  $path = Join-Path $dest $f.Name
  if ($f.Sha256 -and (Test-Path $path) -and ((Get-Sha256 $path) -eq $f.Sha256)) {
    Write-Host "$($f.Name): present, hash ok"
    continue
  }
  Write-Host "Downloading $($f.Name) ..."
  # curl, not Invoke-WebRequest: HF transfers drop mid-file; -C - resumes, --retry rides out drops.
  & curl.exe -L --fail --retry 8 --retry-all-errors --retry-delay 3 -C - --progress-bar `
    -o $path "https://huggingface.co/$($pin.Repo)/resolve/$($pin.Commit)/$($f.Name)"
  if ($LASTEXITCODE -ne 0) { throw "download of $($f.Name) failed (curl exit $LASTEXITCODE); re-run to resume" }
  $got = Get-Sha256 $path
  if ($f.Sha256) {
    # A bad file is deleted, not kept: with -C - a re-run would resume onto the corrupt bytes forever.
    if ($got -ne $f.Sha256) {
      Remove-Item $path -Force -ErrorAction SilentlyContinue
      throw "SHA256 mismatch for $($f.Name)`: expected $($f.Sha256), got $got (file deleted; re-run to fetch it fresh)"
    }
  } else {
    Write-Host "$($f.Name) $((Get-Item $path).Length) $got"
  }
}

# onnx-asr wheel: --no-deps, the environment already carries onnxruntime and numpy.
$have = $null
try { $have = (& $python -c "import onnx_asr, importlib.metadata as m; print(m.version('onnx-asr'))" 2>$null | Select-Object -First 1) } catch { $have = $null }
if ($have -and "$have".Trim() -eq $WheelVer) {
  Write-Host "onnx-asr ${WheelVer}: present"
} else {
  $tmp = Join-Path $env:TEMP "vidar-parakeet"
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $whl = Join-Path $tmp "onnx_asr-$WheelVer-py3-none-any.whl"
  Write-Host "Downloading onnx_asr $WheelVer ..."
  & curl.exe -L --fail --retry 8 --retry-all-errors --retry-delay 3 --progress-bar -o $whl $WheelUrl
  if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue; throw "wheel download failed (curl exit $LASTEXITCODE)" }
  $got = Get-Sha256 $whl
  if ($got -ne $WheelSha256) {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    throw "SHA256 mismatch for onnx_asr wheel`: expected $WheelSha256, got $got"
  }
  & $python -m pip install --no-deps $whl
  $rc = $LASTEXITCODE
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  if ($rc -ne 0) { throw "pip install failed (exit $rc)" }
}

# Mark-of-the-Web off the downloaded files.
Get-ChildItem $dest -File | Unblock-File
Get-ChildItem $dest -File | Select-Object Name, Length
