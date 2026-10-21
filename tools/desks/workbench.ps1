#requires -Version 7.0
# Read what Vidar's workbench is holding: the Tray's blocks and the Document tab's open file.
# Usage: workbench.ps1 list
#        workbench.ps1 get <name>        # Alpha, Bravo, ... or "document"
#        workbench.ps1 get <name> -Path  # print the path only, never the content
#
# Source is bridge\workbench\<name>.json, one file per entry, written by Vidar on add and
# deleted on remove (src-tauri\src\bridge\workbench.rs, src\panels\workbench.ts). Read-only: nothing here
# puts anything INTO the tray, and there is no way to; Display is the route for showing the user
# something.
#
# Text blocks carry their content inline (capped at 64 KiB, `truncated` says when it was cut) so
# a pasted block or an OCR crop is readable without the user having clicked Copy Path first.
# File blocks and log crops carry `path` instead. An image block has a path only if it has been
# saved; otherwise there is nothing to hand over and `get` says so.
#
# Names are reused after the alphabet wraps and `at` is what actually pins a block, so a name
# looked up a minute ago may now be a different block. `list` prints `at` for that reason.
#
# The folder is cleared when Vidar starts: no entries means an empty tray or Vidar is not running,
# and the two are not distinguished here on purpose - both mean "nothing to read".
param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('list', 'get')][string]$Action,
    [Parameter(Position = 1)][string]$Name,
    [switch]$Path
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\lib\Paths.ps1"
$dir = Resolve-VidarPath -Id workbench -Root (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "no workbench dir ($dir) - has this Vidar build ever run?" }

function Read-Entry([string]$file) {
    try { [IO.File]::ReadAllText($file).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { $null }
}

if ($Action -eq 'list') {
    $entries = Get-ChildItem -LiteralPath $dir -Filter *.json -File -ErrorAction SilentlyContinue |
        ForEach-Object { Read-Entry $_.FullName } | Where-Object { $_ }
    if (-not $entries) { 'workbench is empty'; exit 0 }
    $entries | Sort-Object { $_.at } | ForEach-Object {
        $what = if ($_.path) { $_.path } elseif ($null -ne $_.text) { "$($_.text.Length) chars inline" } else { 'no content available' }
        $when = if ($_.at) { ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$_.at)).LocalDateTime.ToString('HH:mm:ss') } else { '' }
        '{0,-10} {1,-9} {2,-8} {3}' -f $_.name, $_.kind, $when, $what
    }
    exit 0
}

if (-not $Name) { throw 'get needs a name: workbench.ps1 get Alpha' }
# The frontend allowlists entry names to letters, digits and -; match it so a name with a
# separator fails here rather than reaching Join-Path.
if ($Name -notmatch '^[A-Za-z0-9-]{1,32}$') { throw "'$Name' is not an entry name (letters, digits and - only)" }
$file = Join-Path $dir "$Name.json"
if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "no entry '$Name'. Run 'workbench.ps1 list' - names change as blocks come and go."
}
$e = Read-Entry $file
if (-not $e) { throw "entry '$Name' is unreadable" }

if ($Path) {
    if (-not $e.path) { throw "'$Name' has no file on disk (it is inline text, or an unsaved image); omit -Path to read it" }
    $e.path
    exit 0
}
if ($e.annotation) { "# annotation: $($e.annotation)" }
if ($e.path) { "# $Name -> $($e.path)"; exit 0 }
if ($null -ne $e.text) {
    if ($e.truncated) { "# $Name (truncated at 64 KiB)" }
    $e.text
    exit 0
}
throw "'$Name' is a $($e.kind) block with nothing readable yet: save it in the Tray (Copy Path) and try again"
