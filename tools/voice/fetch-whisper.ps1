# Installs whisper.cpp's whisper-cli (CPU build) and a ggml model into content\vendor\whisper —
# the defaults Vidar's voice input expects (src-tauri\src\voice.rs, README "Voice input").
# Re-run to update. -Asset "whisper-cublas-12.4.0-bin-x64.zip" for the GPU build (~670 MB),
# -Model small.en for better accuracy at ~3x the latency.
# -Model silero-v5.1.2 fetches only the VAD model (for whisper-cli --vad) beside the whisper
# models; no zip, no whisper-cli.
# Pinned: the release tag and the HF commit are fixed, and every download is SHA256-checked
# against the tables below. A new tag or model needs a table entry (GitHub API
# releases/tags/<tag> `digest`; HF api/models/ggerganov/whisper.cpp?blobs=true `lfs.sha256`).
param(
  [string]$Model = "base.en",
  [string]$Asset = "whisper-bin-x64.zip",
  [string]$Tag = "v1.9.2"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # the progress bar throttles big downloads

$AssetSha256 = @{
  "v1.9.2/whisper-bin-x64.zip"               = "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a"
  "v1.9.2/whisper-blas-bin-x64.zip"          = "ffe5b47ca8e53a7677949f23a9c4641bbec4eee8a5714c3d14b67bb8d7b24a78"
  "v1.9.2/whisper-cublas-11.8.0-bin-x64.zip" = "1776668730f5594a0b15f930225779e863dd8280397f9ee7c6e47ccf82bbb203"
  "v1.9.2/whisper-cublas-12.4.0-bin-x64.zip" = "443110ddaad70d4290ab2e77179e31cf712035bbc4fad56bb4519a90c917b39c"
}
$HfCommit = "5359861c739e955e79d9a303bcbc70fb988958b1"
$ModelSha256 = @{
  "base.en"      = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"
  "tiny.en-q8_0" = "5bc2b3860aa151a4c6e7bb095e1fcce7cf12c7b020ca08dcec0c6d018bb7dd94"
  "silero-v5.1.2" = "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf"
}
# Models served from another HF repo than ggerganov/whisper.cpp (VAD-only: no zip/whisper-cli).
$ModelSource = @{
  "silero-v5.1.2" = @{ Repo = "ggml-org/whisper-vad"; Commit = "9ffd54a1e1ee413ddf265af9913beaf518d1639b"; File = "ggml-silero-v5.1.2.bin" }
}
$vadOnly = $ModelSource.ContainsKey($Model)
$assetSha = $AssetSha256["$Tag/$Asset"]
if (-not $vadOnly -and -not $assetSha) { throw "no SHA256 pinned for $Asset at $Tag; add it to `$AssetSha256" }
$modelSha = $ModelSha256[$Model]
if (-not $modelSha) { throw "no SHA256 pinned for model $Model; add it to `$ModelSha256" }

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. "$PSScriptRoot\..\lib\Paths.ps1"
$dest = Resolve-VidarPath -Id whisper -Root $root
New-Item -ItemType Directory -Force $dest | Out-Null
$tmp = Join-Path $env:TEMP "vidar-whisper"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $tmp "x") | Out-Null

if (-not $vadOnly) {
  # releases/download/<tag> needs no API call (the unauthenticated releases API is rate-limited)
  $zip = Join-Path $tmp $Asset
  Write-Host "Downloading $Asset ($Tag) ..."
  Invoke-WebRequest "https://github.com/ggml-org/whisper.cpp/releases/download/$Tag/$Asset" -OutFile $zip
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($got -ne $assetSha) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue; throw "SHA256 mismatch for $Asset`: expected $assetSha, got $got" }
  Expand-Archive $zip -DestinationPath (Join-Path $tmp "x") -Force
  $cli = Get-ChildItem (Join-Path $tmp "x") -Recurse -Filter whisper-cli.exe | Select-Object -First 1
  if (-not $cli) { throw "whisper-cli.exe not found inside $Asset" }
  # Only what Vidar runs: the cli, whisper.dll and the ggml*.dll set. The zip is the full
  # examples build (llama.dll, parakeet-*, stream, test-*), none of which we execute.
  Copy-Item $cli.FullName $dest -Force
  Get-ChildItem $cli.DirectoryName -File | Where-Object { $_.Name -eq 'whisper.dll' -or $_.Name -like 'ggml*.dll' } | Copy-Item -Destination $dest -Force
}

if ($vadOnly) {
  $src = $ModelSource[$Model]
  $bin = $src.File
  $url = "https://huggingface.co/$($src.Repo)/resolve/$($src.Commit)/$($src.File)"
} else {
  $bin = "ggml-$Model.bin"
  $url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/$HfCommit/$bin"
}
$binPath = Join-Path $dest $bin
Write-Host "Downloading $bin ..."
# curl, not Invoke-WebRequest: HF transfers here run at ~100 KB/s and drop mid-file
# ("response ended prematurely" after 21 min). -C - resumes a partial file,
# --retry rides out the drops. Re-running the script after a failure just continues.
& curl.exe -L --fail --retry 8 --retry-all-errors --retry-delay 3 -C - --progress-bar `
  -o $binPath $url
if ($LASTEXITCODE -ne 0) { throw "model download failed (curl exit $LASTEXITCODE); re-run to resume" }
# A bad file is deleted, not kept: with -C - a re-run would resume onto the corrupt bytes forever.
$got = (Get-FileHash $binPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($got -ne $modelSha) {
  Remove-Item $binPath -Force -ErrorAction SilentlyContinue
  throw "SHA256 mismatch for $bin`: expected $modelSha, got $got (file deleted; re-run to fetch it fresh)"
}

# Mark-of-the-Web off the downloaded binaries (CreateProcess doesn't check it, but keep it clean).
Get-ChildItem $dest -File | Unblock-File
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem $dest -File | Select-Object Name, @{ n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } }
