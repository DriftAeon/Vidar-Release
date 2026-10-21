# PowerShell reader for contracts/paths.json. Twin of tools/lib/paths.mjs; same semantics.
# Dot-source: . "$PSScriptRoot/../lib/Paths.ps1"
# Get-VidarRel is the path under the root; Resolve-VidarPath joins it onto the root.
$script:VidarPathsContract = $null

function Get-VidarRoot {
    param([string]$Start)
    $marker = 'contracts/paths.json'
    foreach ($from in @($Start, $PSScriptRoot)) {
        if (-not $from) { continue }
        $dir = (Resolve-Path -LiteralPath $from).Path
        while ($dir) {
            if (Test-Path -LiteralPath (Join-Path $dir $marker)) { return $dir }
            $up = Split-Path -Parent $dir
            if (-not $up -or $up -eq $dir) { break }
            $dir = $up
        }
    }
    throw "paths: no directory containing $marker found"
}

function Get-VidarPathIds {
    if (-not $script:VidarPathsContract) {
        $file = Join-Path (Get-VidarRoot) 'contracts/paths.json'
        $script:VidarPathsContract = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    }
    return $script:VidarPathsContract.ids
}

function Get-VidarPathNode {
    param([string]$Id)
    $n = (Get-VidarPathIds).PSObject.Properties[$Id]
    if (-not $n) { throw "paths: unknown id `"$Id`"" }
    return $n.Value
}

function Get-VidarRel {
    param([Parameter(Mandatory)][string]$Id)
    $n = Get-VidarPathNode $Id
    $base = if ($n.under -eq 'root') { '' } else { Get-VidarRel -Id $n.under }
    return (@($base, $n.rel) | Where-Object { $_ }) -join '/'
}

function Resolve-VidarPath {
    param([Parameter(Mandatory)][string]$Id, [string]$Root)
    $base = if ($Root) { (Resolve-Path -LiteralPath $Root).Path } else { Get-VidarRoot }
    return (Join-Path $base (Get-VidarRel -Id $Id))
}
