#requires -Version 7.0
# One self-cleaning Falcon probe run: build (or reuse) a bundle, start a host, drive it over
# protocol v1, print what came back, and ALWAYS tear down again.
#
# Usage: tools\falcon\falcon-probe.ps1 -Ops '<json array>' [-Model <alias>] [-LingerMs <n>] [-HoldSeconds <n>]
#                         [-Keep] [-Raw]
#        tools\falcon\falcon-probe.ps1 -OpsPath <file.json> ...
#
# Exists because the same six steps were being hand-rolled as loose shell every time something
# needed diagnosing, which left a host process and a temp directory behind on each run -- nine
# stray temp directories and a stray host in one afternoon. Each of those then needed a separate
# Stop-Process / Remove-Item, every one of which is an `ask` gate in this user's settings. Doing
# the whole run inside one script means one invocation and no follow-up cleanup: the teardown is
# in `finally`, so it happens on success, on failure, and on throw.
#
# What it prints (stdout, so it can be parsed or eyeballed):
#   frames  -- every protocol frame the probe received, one JSON object per line
#   host    -- the host's own stderr, which is where child stderr and exit codes surface
#   summary -- a single JSON object: bundle, host pid, per-request outcomes, session ids
#
# Safety: it kills exactly the host process it started itself, by pid, and never scans for or
# terminates anything else. It never touches vidar.exe, never starts or stops Vidar, and refuses
# to run if the bundle build fails. Spawning a session costs real account quota on the chosen
# model, so -Ops that spawns should be used deliberately.

[CmdletBinding(DefaultParameterSetName = 'Inline')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Inline')][string]$Ops,
    [Parameter(Mandatory, ParameterSetName = 'File')][string]$OpsPath,
    [string]$Model = 'haiku',
    [int]$LingerMs = 0,
    # Keep the host alive this long after the probe returns, for observing the live process tree.
    [int]$HoldSeconds = 0,
    [int]$TimeoutMs = 120000,
    [switch]$Keep,
    # Print raw frame lines only, with no summary. Useful when piping.
    [switch]$Raw
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. "$PSScriptRoot\..\lib\Paths.ps1"
. "$PSScriptRoot\SmokeRoot.ps1"
# A throwaway root under %TEMP%: its own pipes, and --admit-probe gives the
# session probe the full role. Ops that read the root (a profiled spawn, the
# gateway, rules_file) find nothing there.
$smokeRoot = New-FalconSmokeRoot
$registryPath = $smokeRoot.Registry
$storeRoot = Resolve-VidarPath -Id falconStore -Root $repoRoot

$hostProcess = $null
$workDir = Join-Path ([IO.Path]::GetTempPath()) ("falcon-probe-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir | Out-Null

try {
    $build = & (Join-Path $PSScriptRoot '..\release\falcon-build.ps1') -SkipFrontend |
        Select-Object -Last 1 | ConvertFrom-Json
    if (-not $build.executable) { throw 'falcon-build.ps1 returned no bundle' }

    # The session cwd is inside the work dir, so it disappears with it.
    $sessionCwd = Join-Path $workDir 'session'
    New-Item -ItemType Directory -Path $sessionCwd | Out-Null

    $opsFile = Join-Path $workDir 'ops.json'
    if ($PSCmdlet.ParameterSetName -eq 'File') {
        $opsText = Get-Content -LiteralPath $OpsPath -Raw
    } else {
        $opsText = $Ops
    }
    # <CWD> lets a caller name the throwaway session directory without knowing it in advance.
    $opsText = $opsText.Replace('<CWD>', $sessionCwd.Replace('\', '\\'))
    $opsText = $opsText.Replace('<MODEL>', $Model)
    [IO.File]::WriteAllText($opsFile, $opsText, [Text.UTF8Encoding]::new($false))

    $hostOut = Join-Path $workDir 'host.out'
    $hostErr = Join-Path $workDir 'host.err'
    $hostProcess = Start-Process -FilePath $build.executable -ArgumentList @(
        '--registry', $registryPath, '--bundle-id', $build.bundle_id, '--store', $storeRoot,
        '--admit-probe'
    ) -WorkingDirectory $build.bundle_path -RedirectStandardOutput $hostOut `
      -RedirectStandardError $hostErr -WindowStyle Hidden -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $registry = $null
    while (-not $registry) {
        if ($hostProcess.HasExited) {
            $why = (Test-Path $hostErr) ? (Get-Content -LiteralPath $hostErr -Raw) : ''
            throw "Falcon exited before publishing its registry ($($hostProcess.ExitCode)): $why"
        }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Falcon registry publication timed out' }
        if (Test-Path -LiteralPath $registryPath) {
            try {
                $candidate = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
                if ($candidate.pid -eq $hostProcess.Id) { $registry = $candidate }
            } catch {}
        }
        Start-Sleep -Milliseconds 100
    }

    $probeOut = Join-Path $workDir 'probe.out.jsonl'
    $probeErr = Join-Path $workDir 'probe.err.txt'
    $arguments = @('--session-probe', '--registry', $registryPath, '--ops', $opsFile)
    if ($LingerMs -gt 0) { $arguments += @('--linger-ms', $LingerMs) }
    $probe = Start-Process -FilePath $build.executable -ArgumentList $arguments `
        -RedirectStandardOutput $probeOut -RedirectStandardError $probeErr `
        -WindowStyle Hidden -PassThru
    if (-not $probe.WaitForExit($TimeoutMs)) {
        try { Stop-Process -Id $probe.Id -Force } catch {}
        throw "probe did not finish within $TimeoutMs ms"
    }

    if ($HoldSeconds -gt 0) { Start-Sleep -Seconds $HoldSeconds }

    $lines = @()
    if (Test-Path -LiteralPath $probeOut) {
        $lines = @(Get-Content -LiteralPath $probeOut | Where-Object { $_.Trim() })
    }
    '--- frames ---'
    $lines
    '--- host stderr ---'
    if (Test-Path -LiteralPath $hostErr) { Get-Content -LiteralPath $hostErr }

    if (-not $Raw) {
        $frames = @($lines | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} })
        $responses = @($frames | Where-Object { $_.t -eq 'response' } |
            ForEach-Object { [ordered]@{ request = $_.request; outcome = $_.outcome; error = $_.error } })
        $sessions = @($frames | Where-Object { $_.payload.session.session } |
            ForEach-Object { $_.payload.session.session } | Select-Object -Unique)
        '--- summary ---'
        [pscustomobject]@{
            bundle_id    = $build.bundle_id
            host_pid     = $hostProcess.Id
            probe_exit   = $probe.ExitCode
            frames       = $lines.Count
            events       = @($frames | Where-Object { $_.t -eq 'event' }).Count
            responses    = $responses
            sessions     = $sessions
            probe_stderr = (Test-Path $probeErr) ? ((Get-Content -LiteralPath $probeErr -Raw) ?? '').Trim() : ''
            work_dir     = $Keep ? $workDir : $null
        } | ConvertTo-Json -Depth 6 -Compress
    }
}
finally {
    # Always, on success or throw. Only ever the host this script started, by pid.
    if ($hostProcess -and -not $hostProcess.HasExited) {
        try { Stop-Process -Id $hostProcess.Id -Force } catch {}
        try { $hostProcess.WaitForExit(5000) | Out-Null } catch {}
    }
    if (-not $Keep) {
        Remove-Item -Recurse -Force -LiteralPath $workDir -ErrorAction SilentlyContinue
        if (-not $hostProcess -or $hostProcess.HasExited) { Remove-FalconSmokeRoot $smokeRoot.Root -Quiet }
    }
}
