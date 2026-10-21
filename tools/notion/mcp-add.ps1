# Re-adds the hosted Notion MCP server with a fixed OAuth callback port.
# For when Notion rejects the random-port redirect (docs/reference/notion-tab.md, MCP Setup).
# Usage, from the Vidar root in the Claude tab whose config home should get it:
#   pwsh -File tools/notion/mcp-add.ps1 -Port 8080
# Refuses a port outside 1024-65535 and any scope but user, local or project. Touches only the
# entry named notion, and leaves OAuth to /mcp.
param(
    [Parameter(Mandatory)] [ValidateRange(1024, 65535)] [int] $Port,
    [ValidateSet('user', 'local', 'project')] [string] $Scope = 'user'
)

$ErrorActionPreference = 'Stop'
$url = 'https://mcp.notion.com/mcp'

Write-Host "claude mcp remove -s $Scope notion"
& claude mcp remove -s $Scope notion 2>$null | Out-Null
# A missing entry exits non-zero; that is the normal first-run case.

Write-Host "claude mcp add -s $Scope -t http --callback-port $Port notion $url"
& claude mcp add -s $Scope -t http --callback-port $Port notion $url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Added. Run /mcp, pick notion, then Authenticate.'
