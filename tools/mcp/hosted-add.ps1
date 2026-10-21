# Adds the hosted Notion, Slack and Atlassian MCP servers to one agent config home.
# Setup and sign-in steps: docs/reference/hosted-mcp.md.
# Usage, from the Vidar root (the target home is printed before anything is written):
#   pwsh -File tools/mcp/hosted-add.ps1 -Agent claude [-Home default|bare] [-Server all|notion|slack|atlassian]
#                                       [-Port <1024-65535>] [-Force] [-WhatIf]
#   pwsh -File tools/mcp/hosted-add.ps1 -Agent codex [-Home default|bare] [-Server all|notion|atlassian] [-WhatIf]
# Claude runs `claude mcp add -s user -t http`; slack carries Slack's published client id and callback port 3118.
# Codex runs `codex mcp add <name> --url <url>`; sign-in is a browser login, `codex mcp login <name>` if none opened.
# Codex -Home bare runs only `codex mcp login <name>` with CODEX_HOME = <Bare home>\codex-home for the child; never
# `mcp add`, because Vidar writes that config.toml on every spawn (servers are enabled by bareCodexMcp in vidar.json).
# Refuses:
#   - Claude default home when VIDAR_AGENT_HOME or CLAUDE_CONFIG_DIR is set (a profile or Bare tab);
#   - Claude bare when either is set to anything but the Bare home of this install root, or when that home
#     does not exist yet (open a Bare tab once first);
#   - Codex default when VIDAR_AGENT_HOME is set; -Port with Codex; -Force with Codex;
#   - Codex bare when VIDAR_AGENT_HOME or CODEX_HOME is set to anything but this install's Bare home (or its
#     codex-home), or when config.toml lacks [mcp_servers.<name>]:
#     "<name> is not enabled for Codex Bare: add it to bareCodexMcp in vidar.json and open a Codex Bare tab once";
#   - Codex Slack (manual only; Bare: "slack is manual only for Codex; see docs/reference/hosted-mcp.md"),
#     Codex default config.toml with an mcp_servers form it cannot read.
# An existing entry is skipped. -Force (Claude only) removes it and re-adds; a failed add restores the old entry.
# Reads the target file, never `mcp get`. -WhatIf prints every command and runs no CLI.
# The Bare home base is the real Local AppData from the registry (a Bare tab redirects USERPROFILE and LOCALAPPDATA). HOSTED_ADD_LOCALAPPDATA
# overrides it and is TEST-ONLY (tests/mcp-hosted-add.test.mjs); never set it by hand.
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)] [ValidateSet('claude', 'codex')] [string] $Agent,
    [Alias('Home')] [ValidateSet('default', 'bare')] [string] $HomeKind = 'default',
    [ValidateSet('all', 'notion', 'slack', 'atlassian')] [string] $Server = 'all',
    [ValidateRange(1024, 65535)] [int] $Port,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
# Exact argv to native tools (JSON survives the restore path); the default mode mangles quotes for exes.
$PSNativeCommandArgumentPassing = 'Standard'

function Stop-Refuse([string] $Message) {
    [Console]::Error.WriteLine($Message)
    exit 2
}

$servers = [ordered]@{
    notion    = 'https://mcp.notion.com/mcp'
    slack     = 'https://mcp.slack.com/mcp'
    atlassian = 'https://mcp.atlassian.com/v2/mcp'
}
$slackClientId = '1601185624273.8899143856786'
$slackCallbackPort = 3118
$docPath = 'docs/reference/hosted-mcp.md'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path

# ---- Argument checks ----
$names = if ($Server -eq 'all') { @($servers.Keys) } else { @($Server) }
if ($PSBoundParameters.ContainsKey('Port')) {
    if ($Agent -ne 'claude') { Stop-Refuse '-Port is Claude only.' }
    if ($Server -in 'all', 'slack') { Stop-Refuse '-Port needs a single server, notion or atlassian (slack keeps its registered callback port).' }
}
if ($Agent -eq 'codex') {
    if ($Force) { Stop-Refuse '-Force is Claude only.' }
    if ($Server -eq 'slack') {
        if ($HomeKind -eq 'bare') { Stop-Refuse "slack is manual only for Codex; see $docPath" }
        Stop-Refuse "Slack on Codex is manual only; see $docPath (Codex Slack)."
    }
    $names = @($names | Where-Object { $_ -ne 'slack' })
}

# ---- Target home, resolved once; every later step uses it ----
function Get-Norm([string] $Path) { ([IO.Path]::GetFullPath($Path)).TrimEnd('\').ToLowerInvariant() }

function Get-RealLocalAppData {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $profileDir = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid" -ErrorAction SilentlyContinue).ProfileImagePath
    if (-not $profileDir) { Stop-Refuse "No ProfileList entry for $sid; the Bare home cannot be placed." }
    $profileDir = [Environment]::ExpandEnvironmentVariables($profileDir)
    $raw = (Get-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders').GetValue('Local AppData', $null, 'DoNotExpandEnvironmentNames')
    if (-not $raw) { return Join-Path $profileDir 'AppData\Local' }
    $raw = [regex]::Replace($raw, '%USERPROFILE%', $profileDir.Replace('$', '$$'), 'IgnoreCase')
    return [Environment]::ExpandEnvironmentVariables($raw)
}

function Get-BareHomeRoot {
    $agentEnv = ([Uri] (Join-Path $PSScriptRoot '..' 'lib' 'agent-env.mjs')).AbsoluteUri
    # Not $env:LOCALAPPDATA nor GetFolderPath: a Bare tab redirects USERPROFILE, which both expand from,
    # nesting the path. The unexpanded shell folder with %USERPROFILE% taken from ProfileList is not redirected.
    $localBase = if ($env:HOSTED_ADD_LOCALAPPDATA) { $env:HOSTED_ADD_LOCALAPPDATA } else { Get-RealLocalAppData }
    $script = "import('$agentEnv').then(m => console.log(m.resolveHome(process.argv[1], process.argv[2])), e => { console.error(e.message); process.exit(1) })"
    $homeOut = & node -e $script $repoRoot $localBase 2>&1
    if ($LASTEXITCODE -ne 0) { Stop-Refuse "Could not resolve the Bare home: $homeOut" }
    return ([string] $homeOut).Trim()
}

$claudeConfigDir = $null   # CLAUDE_CONFIG_DIR for the child; $null = removed
$codexHomeDir = $null      # CODEX_HOME for the child (Codex Bare only)
$targetFile = $null        # file read for the existing-entry check
if ($Agent -eq 'codex' -and $HomeKind -eq 'bare') {
    $bareRoot = Get-BareHomeRoot
    $targetDir = Join-Path $bareRoot 'codex-home'
    foreach ($pair in @(@('VIDAR_AGENT_HOME', $env:VIDAR_AGENT_HOME), @('CODEX_HOME', $env:CODEX_HOME))) {
        if ($pair[1] -and (Get-Norm $pair[1]) -ne (Get-Norm $targetDir) -and (Get-Norm $pair[1]) -ne (Get-Norm $bareRoot)) {
            Stop-Refuse "$($pair[0]) is $($pair[1]), not this install's Bare home ($targetDir); refusing."
        }
    }
    $codexHomeDir = $targetDir
    $targetFile = Join-Path $targetDir 'config.toml'
} elseif ($Agent -eq 'claude') {
    if ($HomeKind -eq 'default') {
        if ($env:VIDAR_AGENT_HOME -or $env:CLAUDE_CONFIG_DIR) {
            Stop-Refuse 'VIDAR_AGENT_HOME or CLAUDE_CONFIG_DIR is set (a profile or Bare tab); run this from a plain terminal, or pass -Home bare.'
        }
        if (-not $env:USERPROFILE) { Stop-Refuse 'USERPROFILE is not set.' }
        $targetDir = $env:USERPROFILE
        $targetFile = Join-Path $targetDir '.claude.json'
    } else {
        $targetDir = Join-Path (Get-BareHomeRoot) 'claude-config'
        foreach ($pair in @(@('VIDAR_AGENT_HOME', $env:VIDAR_AGENT_HOME), @('CLAUDE_CONFIG_DIR', $env:CLAUDE_CONFIG_DIR))) {
            if ($pair[1] -and (Get-Norm $pair[1]) -ne (Get-Norm $targetDir)) {
                Stop-Refuse "$($pair[0]) is $($pair[1]), not this install's Bare home ($targetDir); refusing."
            }
        }
        if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) {
            Stop-Refuse "No Bare home at $targetDir. Open a Bare tab once first."
        }
        $claudeConfigDir = $targetDir
        $targetFile = Join-Path $targetDir '.claude.json'
    }
} else {
    if ($env:VIDAR_AGENT_HOME) { Stop-Refuse 'VIDAR_AGENT_HOME is set (a Bare tab); run this from a plain terminal.' }
    if ($env:CODEX_HOME) { $targetDir = $env:CODEX_HOME }
    elseif ($env:USERPROFILE) { $targetDir = Join-Path $env:USERPROFILE '.codex' }
    else { Stop-Refuse 'USERPROFILE is not set.' }
    $targetFile = Join-Path $targetDir 'config.toml'
}
Write-Host "Target: $targetDir ($Agent)"

# ---- Existing entries ----
function Get-ClaudeEntry([string] $Name) {
    if (-not (Test-Path -LiteralPath $targetFile)) { return $null }
    try { $json = Get-Content -LiteralPath $targetFile -Raw | ConvertFrom-Json }
    catch { Stop-Refuse "Can't read $targetFile as JSON; fix it first." }
    $prop = $json.PSObject.Properties['mcpServers']
    if (-not $prop -or $null -eq $prop.Value) { return $null }
    $entry = $prop.Value.PSObject.Properties[$Name]
    if ($entry) { return $entry.Value } else { return $null }
}

$codexText = ''
if ($Agent -eq 'codex' -and (Test-Path -LiteralPath $targetFile)) {
    $codexText = Get-Content -LiteralPath $targetFile -Raw
}
if ($Agent -eq 'codex' -and $HomeKind -eq 'default' -and $codexText) {
    $residue = ($codexText -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    $residue = [regex]::Replace($residue, '(?m)^\s*\[\s*mcp_servers\s*\.[^\]\r\n]*\][ \t]*(#.*)?$', '')
    if ($residue -match 'mcp_servers' -or $codexText.Contains("'''") -or $codexText.Contains('"""')) {
        foreach ($n in $names) { Write-Host "$n`: can't tell if $n exists; check config.toml" }
        Stop-Refuse "Found an mcp_servers form in $targetFile that this script can't read (inline table or dotted keys); check config.toml."
    }
}
function Test-CodexEntry([string] $Name) {
    $esc = [regex]::Escape($Name)
    return [regex]::IsMatch($codexText, "(?m)^\s*\[\s*mcp_servers\s*\.\s*`"?$esc`"?\s*(\.[^\]\r\n]*)?\]")
}
if ($Agent -eq 'codex' -and $HomeKind -eq 'bare') {
    # Vidar writes this config.toml on every spawn; a table missing here is enabled through vidar.json, never added by hand.
    foreach ($n in $names) {
        if (-not (Test-CodexEntry $n)) {
            Stop-Refuse "$n is not enabled for Codex Bare: add it to bareCodexMcp in vidar.json and open a Codex Bare tab once"
        }
    }
}

# ---- CLI runner ----
function Invoke-Cli([string] $Cli, [string[]] $CliArgs, [string] $Shown) {
    if ($WhatIfPreference) { Write-Host "WhatIf: $Shown"; return 0 }
    Write-Host $Shown
    & $Cli @CliArgs | Out-Host
    return $LASTEXITCODE
}

if (-not $WhatIfPreference) {
    if (-not (Get-Command $Agent -ErrorAction SilentlyContinue)) { Stop-Refuse "$Agent is not on PATH." }
}
if ($Agent -eq 'claude') {
    # Default home: the refusal above guarantees CLAUDE_CONFIG_DIR is already unset.
    if ($claudeConfigDir) { $env:CLAUDE_CONFIG_DIR = $claudeConfigDir }
}
if ($codexHomeDir) { $env:CODEX_HOME = $codexHomeDir }   # this process only; the child inherits it

$added = @()
$failed = $false
foreach ($name in $names) {
    $url = $servers[$name]
    if ($Agent -eq 'claude') {
        $old = Get-ClaudeEntry $name
        $oldJson = $null
        if ($old) {
            if (-not $Force) {
                Write-Host "$name`: already in $targetFile; skipped (-Force replaces it)."
                continue
            }
            $oldJson = $old | ConvertTo-Json -Depth 20 -Compress
            $code = Invoke-Cli 'claude' @('mcp', 'remove', '-s', 'user', $name) "claude mcp remove -s user $name"
            if ($code -ne 0) { [Console]::Error.WriteLine("$name`: remove failed (exit $code); left as is."); $failed = $true; continue }
        }
        $cliArgs = @('mcp', 'add', '-s', 'user', '-t', 'http')
        if ($name -eq 'slack') { $cliArgs += @('--client-id', $slackClientId, '--callback-port', "$slackCallbackPort") }
        elseif ($PSBoundParameters.ContainsKey('Port')) { $cliArgs += @('--callback-port', "$Port") }
        $cliArgs += @($name, $url)
        try {
            $code = Invoke-Cli 'claude' $cliArgs ('claude ' + ($cliArgs -join ' '))
            $addError = "claude mcp add failed (exit $code)."
        } catch {
            $code = -1
            $addError = "claude mcp add threw: $($_.Exception.Message)"
        }
        if ($code -ne 0) {
            [Console]::Error.WriteLine("$name`: $addError")
            if ($oldJson) {
                try {
                    $code2 = Invoke-Cli 'claude' @('mcp', 'add-json', '-s', 'user', $name, $oldJson) "claude mcp add-json -s user $name <previous entry>"
                } catch { $code2 = -1 }
                if ($code2 -eq 0) { [Console]::Error.WriteLine("$name`: previous entry restored.") }
                else { [Console]::Error.WriteLine("$name`: restore failed (exit $code2); re-add it by hand.") }
            }
            exit 1
        }
        $added += $name
    } elseif ($HomeKind -eq 'bare') {
        $cliArgs = @('mcp', 'login', $name)
        $code = Invoke-Cli 'codex' $cliArgs ('codex ' + ($cliArgs -join ' '))
        if ($code -ne 0) { [Console]::Error.WriteLine("$name`: codex mcp login failed (exit $code)."); exit 1 }
        $added += $name
    } else {
        if (Test-CodexEntry $name) {
            Write-Host "$name`: already in $targetFile; run codex mcp remove $name first."
            continue
        }
        $cliArgs = @('mcp', 'add', $name, '--url', $url)
        $code = Invoke-Cli 'codex' $cliArgs ('codex ' + ($cliArgs -join ' '))
        if ($code -ne 0) { [Console]::Error.WriteLine("$name`: codex mcp add failed (exit $code)."); exit 1 }
        $added += $name
    }
}
if ($Agent -eq 'codex' -and $Server -eq 'all') {
    Write-Host "slack: not added for Codex; see $docPath (Codex Slack)."
}

if ($failed) { exit 1 }
if ($WhatIfPreference) { Write-Host 'WhatIf: nothing was run.'; exit 0 }
if ($added.Count -eq 0) { Write-Host 'Nothing added.'; exit 0 }
if ($Agent -eq 'claude') {
    Write-Host "Added: $($added -join ', '). Open a new Raw Claude tab, run /mcp, then Authenticate each."
} else {
    if ($HomeKind -eq 'bare') { Write-Host "Signed in: $($added -join ', '). Tokens stay in the Codex Bare home." }
    else { Write-Host "Added: $($added -join ', '). If no browser sign-in opened, run codex mcp login <name>." }
}
