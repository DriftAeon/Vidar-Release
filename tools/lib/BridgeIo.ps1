# Bridge JSON I/O: BOM-safe read, atomic write (tmp in same dir, then overwrite-move).
# Dot-source: . "$PSScriptRoot/../lib/BridgeIo.ps1"
$script:BridgeIoSeq = 0

function Read-BridgeJson {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = [IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF)
    if (-not $text.Trim()) { return $null }
    return $text | ConvertFrom-Json
}

function Write-BridgeJsonAtomic {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value, [int]$Depth = 10)
    $full = [IO.Path]::GetFullPath($Path)
    $dir = [IO.Path]::GetDirectoryName($full)
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $script:BridgeIoSeq++
    $tmp = "$full.$PID-$([DateTime]::UtcNow.Ticks)-$($script:BridgeIoSeq).tmp"
    try {
        $json = if ($Value -is [string]) { $Value } else { $Value | ConvertTo-Json -Depth $Depth }
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
        $fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
        [IO.File]::Move($tmp, $full, $true)
    } catch {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        throw
    }
}
