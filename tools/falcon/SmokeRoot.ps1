# Throwaway Vidar root for the Falcon smokes. Dot-source it:
#   . "$PSScriptRoot\SmokeRoot.ps1"
#   $smoke = New-FalconSmokeRoot          # { Root; Registry }
#   ... start falcon.exe --registry $smoke.Registry --admit-probe ...
#   Remove-FalconSmokeRoot $smoke.Root -Quiet   # in finally, after the host stopped
#
# A host started on this root gets its own pipe and mutex names (they are per
# root), so the smoke never meets the user's real host. Under the temp
# directory, `--admit-probe` lets the probe (the host's own falcon.exe image)
# and any `--admit-image` path in at full role; on any other root the host
# ignores the flag. The root holds nothing but the registry's grandparent:
# plain spawns read nothing else from the root, and the store and runtimes
# come from --store and the bundle.
#
# Refuses: Remove-FalconSmokeRoot deletes only a falcon-smoke-root-* folder
# directly under the temp directory. A direct call throws on anything else;
# with -Quiet (the callers' finally blocks) it warns instead.

. "$PSScriptRoot\..\lib\Paths.ps1"

function New-FalconSmokeRoot {
    $temp = [System.IO.Path]::GetTempPath()
    $root = Join-Path $temp ("falcon-smoke-root-" + [guid]::NewGuid().ToString('N'))
    $registry = Join-Path $root ((Get-VidarRel -Id falconRegistry) -replace '/', '\')
    # The host creates the registry's parent itself, but not above it.
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent (Split-Path -Parent $registry)) | Out-Null
    [pscustomobject]@{ Root = $root; Registry = $registry }
}

function Remove-FalconSmokeRoot {
    # -Quiet is for finally blocks: a refusal or a failed delete becomes a
    # warning, so it cannot hide the error that sent the script there.
    param([Parameter(Mandatory)][string]$Root, [switch]$Quiet)
    try {
        $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
        $full = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
        $parent = Split-Path -Parent $full
        $leaf = Split-Path -Leaf $full
        if ($parent -ne $temp -or $leaf -notlike 'falcon-smoke-root-*') {
            throw "refusing to remove ${Root}: not a falcon-smoke-root-* folder under $temp"
        }
        if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
    }
    catch {
        if (-not $Quiet) { throw }
        Write-Warning "smoke root not removed: $($_.Exception.Message)"
    }
}
