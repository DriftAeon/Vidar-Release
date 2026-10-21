#requires -Version 7.0
# Prove Vidar's Falcon client can talk to a real Falcon host.
#
# Usage: falcon-vidar-smoke.ps1 [-SkipVidarBuilds] [-KeepHost]
#
# Exists because one assumption in src-tauri\src\falcon\connection.rs cannot be checked by reading
# it: that a Windows named pipe can be opened as a plain std::fs::File and framed over, rather than
# needing the `windows` crate and an explicit CreateFileW. Everything else in the falcon client
# (falcon.rs and its falcon\ children) is pure translation with unit tests; this is the part that
# is only true if a live host says so.
#
# It builds the src-tauri test binary, starts a Falcon host on a throwaway root under %TEMP% that
# admits that binary at full role (--admit-probe --admit-image; `list` needs it), runs the
# `#[ignore]`d integration test against it with FALCON_SMOKE_ROOT pointing there, and always stops
# the host again -- the teardown is in `finally`, so it happens on success, on failure and on throw.
#
# falcon-build.ps1 stages its bundle in this checkout's bundles folder; a bundle this run added is removed at
# the end (after the host exited), one that was already there is left alone.
#
# Refuses to touch Vidar: never starts, stops or drives it. Spawns no Claude session, so it costs
# no account quota. It kills exactly the host process it started itself, by pid.

[CmdletBinding()]
param(
    [switch]$SkipVidarBuilds,
    [switch]$KeepHost
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. "$PSScriptRoot\..\lib\Paths.ps1"
. "$PSScriptRoot\SmokeRoot.ps1"
$smokeRoot = New-FalconSmokeRoot
$registryPath = $smokeRoot.Registry
$storeRoot = Resolve-VidarPath -Id falconStore -Root $repoRoot
$hostProcess = $null
# falcon-build.ps1 stages into this checkout's bundles folder (it has no root parameter). A bundle this run
# adds is removed again in `finally`; one that already existed (current, previous, another build's) stays.
$bundlesRoot = Resolve-VidarPath -Id falconBundles -Root $repoRoot
$bundlesBefore = @(Get-ChildItem -LiteralPath $bundlesRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object Name)
$workDir = Join-Path ([IO.Path]::GetTempPath()) ("falcon-vidar-smoke-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir | Out-Null

try {
    $buildArgs = @{}
    if ($SkipVidarBuilds) { $buildArgs['SkipFrontend'] = $true }
    $buildResult = & (Join-Path $PSScriptRoot '..\release\falcon-build.ps1') @buildArgs |
        Select-Object -Last 1 | ConvertFrom-Json
    if (-not $buildResult.executable) { throw 'falcon-build.ps1 returned no bundle' }

    # The test binary is the client; the host admits exactly this image.
    $artifacts = & cargo test --offline --no-run --message-format=json `
        --manifest-path (Join-Path $repoRoot 'src-tauri\Cargo.toml') --bin vidar
    if ($LASTEXITCODE -ne 0) { throw "test build failed with exit code $LASTEXITCODE" }
    $testExe = @($artifacts | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } |
        Where-Object { $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable } |
        ForEach-Object { $_.executable }) | Select-Object -Last 1
    if (-not $testExe) { throw 'cargo reported no test executable for the vidar bin' }

    $hostProcess = Start-Process -FilePath $buildResult.executable -ArgumentList @(
        '--registry', $registryPath,
        '--bundle-id', $buildResult.bundle_id,
        '--store', $storeRoot,
        '--admit-probe',
        '--admit-image', $testExe
    ) -WorkingDirectory $buildResult.bundle_path -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $workDir 'host.out.txt') `
        -RedirectStandardError (Join-Path $workDir 'host.err.txt')

    $ready = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $registryPath) {
            try {
                $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
                if ($registry.pid -eq $hostProcess.Id) { $ready = $true; break }
            } catch {}
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready) { throw "the falcon host never registered itself (pid $($hostProcess.Id))" }

    # `--ignored` runs exactly the tests that are ignored by default, which is the one we want.
    # Run the admitted binary itself, so the image the host sees is the one it was told about.
    $env:FALCON_SMOKE_ROOT = $smokeRoot.Root
    try { & $testExe a_live_host_accepts_this_client --ignored --nocapture }
    finally { Remove-Item Env:FALCON_SMOKE_ROOT -ErrorAction SilentlyContinue }
    $ok = ($LASTEXITCODE -eq 0)

    [pscustomobject]@{
        ok        = $ok
        bundle_id = $buildResult.bundle_id
        host_pid  = $hostProcess.Id
        endpoint  = $registry.session_endpoint
        detail    = $ok ? 'the vidar client opened, negotiated and listed against a live host' : 'the live-host test failed; see the cargo output above'
    } | ConvertTo-Json -Compress

    if (-not $ok) { throw 'falcon-vidar smoke failed' }
}
finally {
    if (-not $KeepHost -and $hostProcess -and -not $hostProcess.HasExited) {
        try { Stop-Process -Id $hostProcess.Id -Force } catch {}
    }
    try { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    if (-not $KeepHost -and (-not $hostProcess -or $hostProcess.WaitForExit(5000))) {
        Remove-FalconSmokeRoot $smokeRoot.Root -Quiet
        # Only after the host (which runs from the bundle) has exited, and only a bundle this run added.
        if ($buildResult -and $buildResult.bundle_id -and ($bundlesBefore -notcontains $buildResult.bundle_id)) {
            $own = Join-Path $bundlesRoot $buildResult.bundle_id
            if ((Split-Path -Parent $own) -eq $bundlesRoot.TrimEnd('\') -and (Test-Path -LiteralPath $own -PathType Container)) {
                try { Remove-Item -LiteralPath $own -Recurse -Force -ErrorAction SilentlyContinue } catch {}
            }
        }
    }
}
