# speak.ps1 — read the latest Claude reply aloud (rewrite slot → Kokoro), from any terminal.
#
# Usage: tools\voice\speak.ps1 [-Cwd <dir>] [-Text "..."] [-NoRewrite] [-Dry] [-Voice af_heart]
#   [-Arm|-Status|-Stop|-StopVidar]
#   -Cwd       which project's transcripts to read (default: the current directory)
#   -Text      speak this instead of a transcript
#   -NoRewrite the empty-slot path: strip markdown and read verbatim (A/B the rewrite's
#              value)
#   -Dry       print what would be spoken, no audio
#   -Arm       load the voice (warm Kokoro process + the rewrite adapter's warm) and stop
#   -Status    is the voice up? (the tts adapter's status: sidecar and owner, plus the rewrite's)
#   -Stop      ask the warm Kokoro process to exit, only if a terminal (owner "cli") started it
#   -StopVidar the same for a Kokoro that Vidar started (owner "vidar"); a stop is owner-scoped
#
# Both adapters are voice slots (`tts`, `rewrite`), read from bridge\voice-slots\resolved.json,
# which Vidar writes on every Speak press (voice_slots::write_resolved); there is no default
# adapter here. The file is passed in every mode whenever it exists (the tts slot needs it);
# a read or -Arm without -NoRewrite also requires it present and fresh: a missing one is an
# error, never a fallback. A file older than vidar.json or any pack manifest is
# refused as stale (press Speak in Vidar to rewrite it). Not covered: pins. They are checked
# only when Vidar writes the file, so a pinned artefact changed since the last press runs
# unchecked from here. Thin wrapper over local-voice\speak.py with the
# local-voice venv's python; the script header there is the documentation. Exit code is the
# script's. The bottom-bar Speak button runs the same script (src-tauri\src\speak.rs).
param(
  [string]$Cwd = (Get-Location).Path,
  [string]$Text,
  [switch]$NoRewrite,
  [switch]$Dry,
  [string]$Voice,
  [switch]$Arm,
  [switch]$Status,
  [switch]$Stop,
  [switch]$StopVidar
)
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. "$PSScriptRoot\..\lib\Paths.ps1"
$python = Resolve-VidarPath -Id localVoicePython -Root $root
$script = Resolve-VidarPath -Id speakScript -Root $root
$slots = Join-Path (Resolve-VidarPath -Id voiceSlots -Root $root) 'resolved.json'
if (-not (Test-Path $python)) { Write-Error "local-voice venv missing: $python"; exit 2 }

if ($StopVidar) { $Stop = [switch]$true }
$args = @($script, '--cwd', $Cwd)
# The tts slot comes from this file in every mode (speak.py resolves the Kokoro adapter from it
# for a read, -Arm, -Status and -Stop alike), so it is passed whenever it exists. Only a read
# or -Arm that also uses the rewrite slot insists on it being present and fresh.
if (-not $Stop -and -not $Status -and -not $NoRewrite) {
  if (-not (Test-Path $slots)) {
    Write-Error "No resolved voice slots at ${slots}: press Speak in Vidar once (it writes the file), or pass -NoRewrite"
    exit 2
  }
  $written = (Get-Item $slots).LastWriteTimeUtc
  $inputs = @(Get-Item (Resolve-VidarPath -Id config -Root $root) -ErrorAction SilentlyContinue) +
    @(Get-ChildItem (Join-Path (Resolve-VidarPath -Id packs -Root $root) '*\voice\*.json'), (Join-Path (Resolve-VidarPath -Id packs -Root $root) '*\pack.json') -ErrorAction SilentlyContinue)
  $newer = $inputs | Where-Object { $_.LastWriteTimeUtc -gt $written } | Select-Object -First 1
  if ($newer) {
    Write-Error "Stale voice slots: $($newer.FullName) changed after ${slots} was written; press Speak in Vidar once to rewrite it, or pass -NoRewrite"
    exit 2
  }
}
if (Test-Path $slots) { $args += @('--slots-file', $slots) }
if ($StopVidar) { $args += @('--owner', 'vidar') }
if ($PSBoundParameters.ContainsKey('Text')) { $args += @('--text', $Text) }
if ($NoRewrite) { $args += '--no-rewrite' }
if ($Dry) { $args += '--dry' }
if ($Voice) { $args += @('--voice', $Voice) }
if ($Arm) { $args += '--arm' }
if ($Status) { $args += '--status' }
if ($Stop) { $args += '--stop' }
& $python @args
exit $LASTEXITCODE
