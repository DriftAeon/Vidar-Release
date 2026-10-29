# Codex `notify` hook (config.toml root: notify = ["...\tools\desks\hidden-run\hidden-run.exe", "pwsh", ..., "-File", this]).
# hidden-run.exe is the windowless wrapper: pwsh is a console exe, so a Codex without a console
# (the code-mode host, 0.157.0) flashed a new terminal window on every turn.
# conhost --headless never runs the child, so it is not a usable wrapper (dead end, don't retry).
# Codex runs it after every turn with ONE argument: a JSON object
#   { type: "agent-turn-complete", thread-id, turn-id, cwd, input-messages, last-assistant-message }
# Two outputs, both atomic (unique tmp + rename), UTF-8 without BOM:
#   bridge\review\hook-alive.json        every turn — proves the hook is wired
#   bridge\review\<id>\done.json         when the reply ends with a line `ASTRA-DONE <id>`
#                                        (id = 8 hex) — the request-specific completion signal
# Nothing else is inferred: no "some turn ended" fallback.
# Diagnostic only: a turn whose reply does not end with the marker, in the cwd of
#   a review claimed under 20 minutes ago with no done.json and its report already written, logs
#   "turn ended without ASTRA-DONE; report for <id> exists" once per id (flag: <id>\diag.json).
#   It never writes done.json. The cwd match keeps other Codex tabs (notify is global) quiet; it compares
#   against `tabCwd` from <id>\dispatch-result.json (the armed tab's cwd, written by Vidar) when present.
# done.json is written only when the event cwd equals that `tabCwd` (normalised full path, case-insensitive);
#   a mismatch, a missing tabCwd or a request with no request.json (legacy glob) is a hook-errors.log line
#   only: no done.json, and no diag.json (a stray marker from another tab must not end a live wait).
# Never throws, always exits 0: a hook failure must never surface inside Codex. Problems go to
# bridge\review\hook-errors.log, capped at 64 KB.
# Root: the Vidar folder is two levels above this script ($PSScriptRoot = <vidar>\tools\desks).
#   Moving the script breaks it and the config.toml registration.
$ErrorActionPreference = 'Stop'
$vidar = Split-Path (Split-Path $PSScriptRoot)
. "$PSScriptRoot\..\lib\Paths.ps1"
$root = Resolve-VidarPath -Id review -Root $vidar
$enc = [System.Text.UTF8Encoding]::new($false)

function Write-Atomic([string]$path, [string]$text) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { [void][IO.Directory]::CreateDirectory($dir) }
    $tmp = Join-Path $dir ("." + [IO.Path]::GetFileName($path) + "." + [guid]::NewGuid().ToString('N') + ".tmp")
    [IO.File]::WriteAllText($tmp, $text, $enc)
    [IO.File]::Move($tmp, $path, $true)
}

function Log-Error([string]$msg) {
    try {
        $log = Join-Path $root 'hook-errors.log'
        if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 65536) {
            [IO.File]::WriteAllText($log, '', $enc)
        }
        [IO.File]::AppendAllText($log, "$(Get-Date -Format o) $msg`n", $enc)
    } catch {}
}

# The armed tab's cwd as Vidar recorded it in <id>\dispatch-result.json (`tabCwd`, written before the CR),
# normalised to a full path; $null when absent or unreadable. Vidar writes it, so a done event is only
# honoured from the tab Vidar typed into: notify is global and any Codex tab can end a reply with a marker.
function Get-TabCwd([string]$idDir) {
    try {
        $p = Join-Path $idDir 'dispatch-result.json'
        if (-not (Test-Path -LiteralPath $p)) { return $null }
        $r = Get-Content -LiteralPath $p -Raw -Encoding utf8 | ConvertFrom-Json
        if (-not $r -or -not $r.tabCwd) { return $null }
        return Get-NormalPath ([string]$r.tabCwd)
    } catch { return $null }
}

function Get-NormalPath([string]$p) {
    try { return [IO.Path]::GetFullPath($p).TrimEnd('\', '/') } catch { return $null }
}

# A turn ended without the marker. Log (never complete) any review in this turn's cwd whose report
# is already on disk: the likely cause is prose after the marker or a marker inside a code fence.
function Write-UnmarkedDiagnostic($ev) {
    try {
        $cwd = ([string]$ev.cwd).TrimEnd('\', '/')
        if (-not $cwd) { return }
        foreach ($d in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue) {
            if ($d.Name -notmatch '^[0-9a-f]{8}$') { continue }
            $pending = Join-Path $d.FullName 'pending.json'
            if (-not (Test-Path -LiteralPath $pending)) { continue }
            if ((Test-Path -LiteralPath (Join-Path $d.FullName 'done.json')) -or (Test-Path -LiteralPath (Join-Path $d.FullName 'diag.json'))) { continue }
            if (((Get-Date) - (Get-Item -LiteralPath $pending).LastWriteTime).TotalMinutes -ge 20) { continue }
            $reqPath = Join-Path $d.FullName 'request.json'
            if (-not (Test-Path -LiteralPath $reqPath)) { continue }
            $req = $null
            try { $req = Get-Content -LiteralPath $reqPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { continue }
            if (-not $req -or -not $req.report -or -not $req.cwd) { continue }
            # Vidar's tabCwd wins over the requester's -Cwd when the dispatch was approved.
            $want = Get-TabCwd $d.FullName
            if (-not $want) { $want = ([string]$req.cwd).TrimEnd('\', '/') }
            if (-not [string]::Equals($want, $cwd, [StringComparison]::OrdinalIgnoreCase)) { continue }
            if (-not (Test-Path -LiteralPath ([string]$req.report) -PathType Leaf)) { continue }
            Log-Error "turn ended without ASTRA-DONE; report for $($d.Name) exists ($($req.report)); done.json not written"
            Write-Atomic (Join-Path $d.FullName 'diag.json') (@{ id = $d.Name; at = (Get-Date -Format o); 'turn-id' = $ev.'turn-id'; note = 'turn ended without ASTRA-DONE; report exists' } | ConvertTo-Json -Compress)
        }
    } catch { Log-Error "diagnostic: $($_.Exception.Message)" }
}

try {
    $raw = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
    if (-not $raw) { Log-Error 'no argument'; exit 0 }
    try { $ev = $raw | ConvertFrom-Json } catch { Log-Error "bad json: $($raw.Substring(0, [Math]::Min(200, $raw.Length)))"; exit 0 }
    if ($ev.type -ne 'agent-turn-complete') { exit 0 }

    $at = Get-Date -Format o
    $alive = @{ at = $at; type = $ev.type; 'thread-id' = $ev.'thread-id'; 'turn-id' = $ev.'turn-id'; cwd = $ev.cwd } | ConvertTo-Json -Compress
    Write-Atomic (Join-Path $root 'hook-alive.json') $alive

    $msg = [string]$ev.'last-assistant-message'
    $marked = $false
    if ($msg) {
        # The marker must be the FINAL non-empty line (a quoted "ASTRA-DONE x" mid-reply
        # doesn't count), the id must have an open pending record with no done yet, and the
        # findings file must exist (no unsolicited completions).
        $lines = @($msg -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
        $last = if ($lines.Count) { $lines[$lines.Count - 1] } else { '' }
        $m = [regex]::Match($last, '^\s*ASTRA-DONE\s+([0-9a-f]{8})\s*$')
        if ($m.Success) {
            $marked = $true
            $id = $m.Groups[1].Value
            $idDir = Join-Path $root $id
            # The requester's request.json names the report Astra must write
            # (astra-dispatch.ps1 -Report). Without it, the legacy findings glob still applies.
            # A request.json that exists but is unreadable or names no report FAILS CLOSED (falling through to the glob would let an unrelated findings file
            # complete a request that named another report). The glob is only for requests
            # published without a sidecar at all.
            $req = $null
            $reqPath = Join-Path $idDir 'request.json'
            $report = $null; $missing = ''
            if (Test-Path -LiteralPath $reqPath) {
                try { $req = Get-Content -LiteralPath $reqPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { $req = $null }
                if (-not $req -or -not $req.report) { $missing = 'request.json present but unreadable or without a report (fail closed)' }
                elseif (Test-Path -LiteralPath ([string]$req.report) -PathType Leaf) { $report = [string]$req.report }
                else { $missing = "report not written: $($req.report)" }
            } else {
                # The legacy findings glob (no request.json) is refused: with no request there is nothing
                # to tie the report to this dispatch, and a sandboxed tab could write any findings file.
                $missing = 'no request.json (legacy glob path refused)'
            }
            $tabCwd = Get-TabCwd $idDir
            $evCwd = Get-NormalPath ([string]$ev.cwd)
            if (-not (Test-Path -LiteralPath (Join-Path $idDir 'pending.json'))) { Log-Error "done for $id ignored: no pending record" }
            elseif (Test-Path -LiteralPath (Join-Path $idDir 'done.json')) { Log-Error "done for $id ignored: already done" }
            elseif (-not $report) { Log-Error "done for $id ignored: $missing" }
            elseif (-not $tabCwd) { Log-Error "done for $id ignored: no tabCwd in dispatch-result.json (not approved by Vidar, or not yet recorded)" }
            elseif (-not $evCwd -or -not [string]::Equals($evCwd, $tabCwd, [StringComparison]::OrdinalIgnoreCase)) { Log-Error "done for $id ignored: event cwd '$($ev.cwd)' is not the armed tab's cwd '$tabCwd'" }
            else {
                # Meter after, next to the meter before that the requester recorded: the real per-task cost.
                # Bound to this thread (the event carries it); the requester's "before" could only match by cwd.
                $after = $null
                try { $after = (& (Join-Path $PSScriptRoot 'codex-meter.ps1') -ThreadId ([string]$ev.'thread-id') -Cwd ([string]$ev.cwd)) | ConvertFrom-Json } catch { Log-Error "meter after for ${id}: $($_.Exception.Message)" }
                try {
                    $before = if ($req) { $req.meter_before } else { $null }
                    # The delta is account usage over the interval, and only when both readings sit in
                    # the same 5H window (same resets_at, neither rolled over). Otherwise null, with the reason.
                    $delta = $null; $why = $null
                    $b5 = $before.five_hour; $a5 = $after.five_hour
                    if ($null -eq $b5 -or $null -eq $a5 -or $null -eq $b5.used_percentage -or $null -eq $a5.used_percentage) { $why = 'a reading is missing' }
                    elseif ($b5.window_reset_since -or $a5.window_reset_since) { $why = 'a reading predates a window reset' }
                    elseif ([string]$b5.resets_at -ne [string]$a5.resets_at) { $why = 'readings are from different 5H windows' }
                    else { $delta = [int]$a5.used_percentage - [int]$b5.used_percentage }
                    $meter = [ordered]@{ id = $id; budget = $(if ($req) { $req.budget } else { $null }); before = $before; after = $after
                        five_hour_delta = $delta; delta_note = $(if ($why) { $why } else { 'account usage over the interval; meaningful only with one Codex tab' }) } | ConvertTo-Json -Compress -Depth 8
                    Write-Atomic (Join-Path $idDir 'meter.json') $meter
                } catch { Log-Error "meter.json for ${id}: $($_.Exception.Message)" }
                $done = @{ id = $id; at = $at; 'thread-id' = $ev.'thread-id'; 'turn-id' = $ev.'turn-id'; findings = $report; report = $report } | ConvertTo-Json -Compress
                Write-Atomic (Join-Path $idDir 'done.json') $done
            }
        }
    }
    if (-not $marked) { Write-UnmarkedDiagnostic $ev }
} catch {
    Log-Error "unhandled: $($_.Exception.Message)"
}
exit 0
