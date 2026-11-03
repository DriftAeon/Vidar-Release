#Requires -Version 7
# Turn a failed test log into one GitHub annotation per failing test, so a CI failure is readable
# without auth: the check-run annotations API is public, the job log is not.
# Usage: pwsh -File tools/gate/ci-annotate.ps1 -Kind cargo|node -Log <file> -Title <label> [-Max 9] [-Plain]
# -Kind cargo reads libtest output (`---- <name> stdout ----` blocks, the `failures:` list, crashed test
#   binaries, compile errors); -Kind node reads the node:test TAP reporter (`not ok` lines and their YAML).
# Prints `::error title=<Title>::<test name>: <first panic or error line>` per failing test, at most -Max;
# -Plain prints `FAIL <test name>: <line>` instead (tools/release/ci-local.ps1).
# Always prints at least one line, so a failure that names no test still shows. Exits 0: the caller's
# exit code fails the step, never this script. Refuses nothing; a missing log prints one line saying so.
param(
  [Parameter(Mandatory)][ValidateSet('cargo', 'node')][string]$Kind,
  [Parameter(Mandatory)][string]$Log,
  [Parameter(Mandatory)][string]$Title,
  [int]$Max = 9,
  [switch]$Plain
)
$ErrorActionPreference = 'Continue'

function Format-Data([string]$s) { $s.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A') }
function Format-Prop([string]$s) { (Format-Data $s).Replace(':', '%3A').Replace(',', '%2C') }
function Trim-Line([string]$s) { $t = $s.Trim(); if ($t.Length -gt 300) { $t.Substring(0, 300) + '...' } else { $t } }

if (-not (Test-Path -LiteralPath $Log)) {
  $hits = @([pscustomobject]@{ Name = '(no log)'; Line = "log not found: $Log" })
} else {
  $lines = @(Get-Content -LiteralPath $Log)
  $hits = [Collections.Generic.List[object]]::new()
  $seen = @{}
  function Add-Hit([string]$name, [string]$line) {
    if ($seen.ContainsKey($name)) { if (-not $seen[$name].Line -and $line) { $seen[$name].Line = $line }; return }
    $h = [pscustomobject]@{ Name = $name; Line = $line }
    $seen[$name] = $h; $hits.Add($h)
  }

  if ($Kind -eq 'cargo') {
    for ($i = 0; $i -lt $lines.Count; $i++) {
      $l = $lines[$i]
      if ($l -match '^---- (\S+) stdout ----$') {
        $name = $Matches[1]; $msg = ''
        for ($j = $i + 1; $j -lt $lines.Count -and $lines[$j] -notmatch '^---- \S+ stdout ----$' -and $lines[$j] -ne 'failures:'; $j++) {
          $p = $lines[$j]
          # Newer libtest prints the thread id: thread 'a::b' (20400) panicked at src\a.rs:1:2:
          if ($p -match "^thread '.*'( \(\d+\))? panicked at '(.*)', (\S+)$") { $msg = "$($Matches[2]) ($($Matches[3]))"; break }
          if ($p -match "^thread '.*'( \(\d+\))? panicked at (\S+):$") {
            $where = $Matches[2]; $text = if ($j + 1 -lt $lines.Count) { $lines[$j + 1] } else { '' }
            $msg = "$(Trim-Line $text) ($where)"; break
          }
        }
        Add-Hit $name $msg
      } elseif ($l -eq 'failures:') {
        for ($j = $i + 1; $j -lt $lines.Count; $j++) {
          if ($lines[$j] -match '^    (\S+)$') { Add-Hit $Matches[1] '' }
          elseif ($lines[$j] -ne '') { break }
        }
      } elseif ($l -match "process didn't exit successfully: (.+)$" -and $l -notmatch 'exit code: 101\)') {
        # A crashed test binary (stack overflow, access violation) names no test; the line names the binary.
        $what = $Matches[1]
        $bin = if ($what -match '([^\\/`" ]+?)(-[0-9a-f]{16})?\.exe') { $Matches[1] } else { 'test binary' }
        Add-Hit "$bin (crashed)" (Trim-Line $what)
      }
    }
    if ($hits.Count -eq 0) {
      foreach ($l in $lines) {
        if ($l -match '^error(\[E\d+\])?: (.+)$' -and $l -notmatch '^error: test failed') { Add-Hit "compile error $($hits.Count + 1)" (Trim-Line $l) }
        if ($hits.Count -ge 5) { break }
      }
    }
  } else {
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -notmatch '^(\s*)not ok \d+ - (.+?)(\s+#.*)?$') { continue }
      $indent = $Matches[1]; $name = $Matches[2]
      $type = ''; $msg = ''; $where = ''
      for ($j = $i + 1; $j -lt $lines.Count; $j++) {
        $y = $lines[$j]
        if ($y -match "^$indent  \.\.\.$") { break }
        if ($y -match "^$indent  failureType: '(.+)'$") { $type = $Matches[1] }
        elseif ($y -match "^$indent  location: '(.+)'$") { $where = $Matches[1] -replace '^file:///', '' }
        elseif (-not $msg -and $y -match "^$indent  error: '(.*)'$") { $msg = $Matches[1].Replace("''", "'") }
        elseif (-not $msg -and $y -match "^$indent  error: `"(.*)`"$") { $msg = $Matches[1].Replace('\"', '"').Replace('\\', '\') }
        elseif (-not $msg -and $y -match "^$indent  error: [|>]-?$") {
          # First non-empty line; a line ending in ':' ("Expected values to be strictly equal:") takes the next one too.
          for ($k = $j + 1; $k -lt $lines.Count -and $lines[$k] -notmatch "^$indent  \S"; $k++) {
            $t = $lines[$k].Trim(); if (-not $t) { continue }
            $msg = if ($msg) { "$msg $t" } else { $t }
            if (-not $msg.EndsWith(':')) { break }
          }
        }
      }
      if ($type -in 'subtestsFailed', 'cancelledByParent') { continue }
      if ($where -match '([^/\\]+\.m?[jt]s:\d+)') { $name = "$name [$($Matches[1])]" }
      Add-Hit $name (Trim-Line $msg)
    }
  }
  if ($hits.Count -eq 0) { $hits.Add([pscustomobject]@{ Name = '(unparsed)'; Line = "the step failed but $Log names no failing test" }) }
}

$shown = 0
foreach ($h in $hits) {
  if ($shown -ge $Max) { break }
  $text = if ($h.Line) { "$($h.Name): $($h.Line)" } else { $h.Name }
  if ($Plain) { "FAIL $text" } else { "::error title=$(Format-Prop $Title)::$(Format-Data $text)" }
  $shown++
}
if ($hits.Count -gt $Max) {
  $more = "$($hits.Count - $Max) more failing tests not shown"
  if ($Plain) { "FAIL $more" } else { "::error title=$(Format-Prop $Title)::$(Format-Data $more)" }
}
exit 0
