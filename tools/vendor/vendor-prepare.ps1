#Requires -Version 7
<#
tools\vendor\vendor-prepare.ps1 — the only way a gateway launcher row reaches `claude` (board A3).
Raw tabs come through vendor-tab.ps1; Rendered tabs through tools\claude-sidecar.mjs --gateway.

  & "$env:VIDAR_ROOT/tools/vendor/vendor-prepare.ps1" -Vendor <id> [-Protect <dir>...] [-PrintFence]
  pwsh -NoProfile -NonInteractive -File vendor-prepare.ps1 -Vendor <id> -Node <node.exe>
       -Sidecar <claude-sidecar.mjs> -SidecarArgs <base64 JSON string[]>

-Vendor is a gateway module id. Its launch values (baseUrl, keyVar, model, env) come only from the
approved snapshot Vidar's module scan writes (contracts/paths.json id gatewaySnapshot,
bridge\gateways.json, version 1): the entry whose `id` equals -Vendor, case-sensitively. This script
never parses the raw pack; it only hashes <packs>/<entry.pack>/pack.json (SHA-256, streamed) and
compares it with the entry's packSha256. It refuses, before anything else and before the fence is
built, and `claude` never starts:
  - no snapshot file, unparsable JSON, a version other than 1, or no entry for -Vendor:
    (or an entry whose `pack` field is not the same string as -Vendor, case-sensitively):
    "gateway '<id>' is not approved by Vidar: restart Vidar to check the pack";
  - a missing pack file or a hash that differs (the pack was edited after Vidar checked it):
    "pack '<id>' changed since Vidar checked it: Trust Current in Dependencies accepts it".
The gateway is resolved before anything else runs (git included), so a refused gateway spawns nothing.
The gateway trust rules of contracts/modules.json are then applied again to the snapshot values, as
a second layer: baseUrl starts https://; keyVar matches the contract's keyVarPattern, equals
<ID>_API_KEY (upper-cased, `-` as `_`) and has no ANTHROPIC_ or CLAUDE_ prefix; every env key is in
the contract's gateway.envAllowlist; model, and every env value whose key ends in _MODEL, matches the
contract's modelPattern. From the hash-checked pack it also refuses a gateway whose pack has no env
dep probing the keyVar, or whose keyVar the dependency catalog or another module's deps already probe
(the Rust rules "No Dep Probes keyVar" and "keyVar Is Claimed By"), and it reads the model's
flowModels.maxContext for CLAUDE_CODE_MAX_CONTEXT_TOKENS (1000000 when the pack has none).

-Sidecar, -Node, -SidecarArgs (the Rendered path, all three together): instead of `claude`, run
`<Node> <Sidecar> <decoded SidecarArgs> --model <vendor model> --vendor-settings <fence>
--vendor-plugin <dir> --vendor-prompt <text>` under the same checked environment, and exit with
its code. SidecarArgs is base64 of a JSON string array, nonsecret arguments only; the key stays
in the environment.

It builds the vendor fence, checks it, and only then starts `claude --settings <fence>`. Any
failure throws before `claude` runs: a broken or missing fence stops the launch, it never opens
an unfenced tab. (The old rows carried the fence as a free-form flag inside a `-Command` string;
a `{vidarRoot}` token there reached `claude` unexpanded and the tab opened unfenced, no error.)

Fence = vendor-fence.base.json (portable rules) + the hook and Edit denies resolved against this
checkout's root ($PSScriptRoot\..\..) + `Edit(<dir>/CLAUDE.md|.claude/**)` per -Protect dir. It is
written to bridge\vendor\<vendor>-<tab>-<pid>.settings.json (gitignored state, one file per
process so two launches never rewrite each other's), read back from disk and checked against:
  - an allowlist of top-level keys (`env`, `disableAllHooks` and anything unlisted fail);
  - a floor of denies held HERE, not in the base, so a weakened base fails instead of passing;
  - every base deny and every root/-Protect deny (catches ConvertTo-Json depth truncation);
  - the hook command string, exactly; the guard script and `node` present (a missing `node` makes
    the hook a non-blocking error, so the Bash guard would drop silently);
  - a live probe: the guard is fed a Bash write into <root>/.claude and must exit 2.
What it cannot prove is that `claude` loaded the file; the user smoke is that proof.
-PrintFence stops after the checks (before the key read) and prints the fence path and JSON.

Vendor rules, all learned the hard way (2026-09-20), moved here from src\launcher\roster.ts:
  - A gateway vendor ships no CLI of its own here; it exposes an Anthropic-shaped endpoint, so this runs the same
    `claude` with ANTHROPIC_BASE_URL rerouted. `--model` is on the command line on purpose:
    ~\.claude\settings.json may pin a model, and settings beat ANTHROPIC_MODEL; only the flag wins.
    ANTHROPIC_DEFAULT_HAIKU_MODEL covers background calls (titles, compaction) that never see it.
  - The key goes in ANTHROPIC_AUTH_TOKEN, never ANTHROPIC_API_KEY. With a claude.ai login the CLI
    prefers OAuth over an unapproved API_KEY, so the first gateway tab sent the Claude Max token
    to the vendor endpoint (401). AUTH_TOKEN bypasses that: the banner reads "API Usage Billing".
  - ANTHROPIC_API_KEY is removed first: Claude Code sends whichever is set, and a key inherited
    from whatever launched Vidar would go to a third party. Vidar leaks its env into every tab, so
    every credential-shaped name goes too (Test-CredentialName: flow.rs's rule plus *_KEY,
    *_PASSWORD, *_PAT, *_CREDENTIALS, AWS_ACCESS_KEY_ID and the Bedrock/Vertex switches).
  - ~/.claude/settings.json (and settings.local.json) are loaded by the vendor `claude` too, and so
    are the project's <cwd or git top>/.claude/settings(.local).json, so an `env` entry with a
    credential-shaped name or an `apiKeyHelper` there would put the credential back after the strip,
    and `disableAllHooks` would drop the guard. Any of them refuses the launch (names only in the message).
  - The fence denies Read of ~/.claude/.credentials.json (the Claude login) and of the other
    vendors' logins (Codex, Pi, Gemini), and Bash/PowerShell commands naming them or reading the
    User environment (HKCU\Environment, GetEnvironmentVariable with a User/Machine target).
  - The key is read from the User scope first, $env: only as a fallback. Vidar snapshots its env at
    launch, so $env: is empty in an instance started before the key was set; the throw makes that visible.
  - CLAUDE_CODE_MAX_CONTEXT_TOKENS: a gateway model id is not in Claude Code's catalog, so it assumes
    200k and compacts against it. The first gateway models were 1M-token models. The env var, not a `[1m]` suffix: the suffix
    is a catalog marker and may reach the vendor endpoint unstripped.
  - Rule forms: repo paths take the plain `C:/...` form (`//C:/...` let a write through), and only
    Edit(path) rules gate file writes; Write(path) is ignored with a startup warning.
The vendor env lives only for the `claude` call: it is restored when `claude` exits, so typing
`claude` afterwards in the same (-NoExit) tab is not a vendor session without its fence.
#>
param(
  [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{0,31}$', Options = 'None')][string]$Vendor,
  [string[]]$Protect = @(),
  [switch]$PrintFence,
  [string]$Sidecar,
  [string]$Node,
  [string]$SidecarArgs
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

# Inside a Claude Code session the vendor `claude` would be a nested child carrying that session's
# markers (spawn_pty scrubs CLAUDECODE, so a Vidar tab never has it). Refuse rather than launch.
if ($env:CLAUDECODE) {
  $host.UI.WriteErrorLine('vendor-tab: CLAUDECODE is set (running inside a Claude Code session); open the vendor tab from the Vidar launcher instead. claude not started.')
  exit 1
}
# CLAUDE_CONFIG_DIR relocates the user settings root to a dir this script neither checks nor fences.
# Refused outright (no hook here for checking another root).
if ($env:CLAUDE_CONFIG_DIR) {
  $host.UI.WriteErrorLine('vendor-tab: CLAUDE_CONFIG_DIR is set; the vendor fence does not cover a relocated Claude config dir. Unset it to open a vendor tab. claude not started.')
  exit 1
}

function Fwd([string]$p) { ($p -replace '\\', '/').TrimEnd('/') }
# Null removes the variable. Not [Environment]::SetEnvironmentVariable($k, $null): under pwsh 7.6 a
# native child still sees that name, set to "" (verified 2026-09-27 with node's process.env).
function Set-ProcessEnv([string]$Name, $Value) {
  if ($null -eq $Value) { Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue }
  else { Set-Item -LiteralPath "Env:$Name" -Value $Value }
}
. (Join-Path $PSScriptRoot 'vendor-env.ps1')
# User- and project-scope Claude settings are loaded by the vendor `claude` as well; an `env` entry
# with a credential-shaped name or an `apiKeyHelper` there re-injects a credential after the strip,
# and `disableAllHooks` switches off the guard hook the fence relies on. Project scope is the cwd
# `claude` starts in plus its git top level (a subfolder launch). Returns one line per offending
# file, names only; an unreadable file is an offence (fail closed).
function Get-ProjectDirs {
  $dirs = @((Get-Location).ProviderPath)
  if (Get-Command git -CommandType Application -ErrorAction SilentlyContinue) {
    $top = git rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -eq 0 -and $top) { $dirs += [IO.Path]::GetFullPath($top) }
  } else {
    Write-Warning 'vendor-tab: git not found, so the git top level project .claude is neither checked nor fenced (only the cwd is).'
  }
  $dirs | Select-Object -Unique
}
function Get-SettingsCredentialFindings {
  $home_ = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  $dirs = @($home_) + $ProjectDirs
  $paths = @(foreach ($d in $dirs) { foreach ($f in 'settings.json', 'settings.local.json') { [IO.Path]::GetFullPath((Join-Path $d ".claude/$f")) } })
  foreach ($p in ($paths | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
    try { $j = Get-Content -Raw -LiteralPath $p | ConvertFrom-Json -AsHashtable }
    catch { "$p could not be parsed"; continue }
    if ($null -eq $j) { continue }
    $bad = @()
    if ($j.env -is [System.Collections.IDictionary]) { $bad += @($j.env.Keys | Where-Object { Test-CredentialName $_ } | ForEach-Object { "env.$_" }) }
    if ($j.ContainsKey('apiKeyHelper')) { $bad += 'apiKeyHelper' }
    if ($j.ContainsKey('disableAllHooks') -and -not ($j.disableAllHooks -is [bool] -and $j.disableAllHooks -eq $false)) { $bad += 'disableAllHooks' }
    if ($bad.Count) { "$p sets $($bad -join ', ')" }
  }
}

$root = Split-Path (Split-Path $PSScriptRoot)
$rootFwd = Fwd $root
. "$PSScriptRoot\..\lib\Paths.ps1"
. "$PSScriptRoot\..\lib\BridgeIo.ps1"

# The gateway declaration, from Vidar's approved snapshot (the pack is only hashed), checked again
# against contracts/modules.json (see the header).
# Returns the shape vendor-env.ps1 takes: BaseUrl, KeyVar, Model, Env, and MaxContext when the pack's
# flowModels entry for the model carries one.
function Get-GatewayConfig([string]$Id) {
  $contract = Get-Content -Raw -LiteralPath (Join-Path $root 'contracts/modules.json') | ConvertFrom-Json -AsHashtable
  $rules = $contract.gateway
  # Rust (the module scan) is the only validator that grants trust; it writes the approved snapshot.
  # Nothing is read from the raw pack here except its hash, compared with the one Rust parsed.
  $unapproved = "gateway '$Id' is not approved by Vidar: restart Vidar to check the pack"
  # .NET's `$` matches before a final newline, so a pattern alone lets "value\n" through.
  $hasNewline = { param($s) $s -is [string] -and $s -match '[\r\n]' }
  $snapFile = Resolve-VidarPath -Id gatewaySnapshot -Root $root
  if (-not (Test-Path -LiteralPath $snapFile -PathType Leaf)) { throw $unapproved }
  try { $snap = Get-Content -Raw -LiteralPath $snapFile | ConvertFrom-Json -AsHashtable } catch { throw $unapproved }
  if ($snap -isnot [System.Collections.IDictionary] -or $snap.version -isnot [ValueType] -or $snap.version -is [bool] -or $snap.version -ne 1) { throw $unapproved }
  $g = @($snap.gateways | Where-Object { $_ -is [System.Collections.IDictionary] -and $_.id -is [string] -and $_.id -ceq $Id })[0]
  if ($null -eq $g) { throw $unapproved }
  if ($g.pack -isnot [string] -or $g.pack -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $g.pack -ceq '..' -or $g.packSha256 -isnot [string]) { throw $unapproved }
  if ($g.pack -cne $Id -or (& $hasNewline $g.pack) -or (& $hasNewline $g.packSha256)) { throw $unapproved }
  $file = Join-Path (Resolve-VidarPath -Id packs -Root $root) "$($g.pack)/pack.json"
  $changed = "pack '$Id' changed since Vidar checked it: Trust Current in Dependencies accepts it"
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw $changed }
  $sha = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sha -cne $g.packSha256.ToLowerInvariant()) { throw $changed }
  # Second layer on the snapshot values (Rust already checked them).
  $prefix = [string]$rules.baseUrlPrefix
  if ($g.baseUrl -isnot [string] -or (& $hasNewline $g.baseUrl) -or -not $g.baseUrl.StartsWith($prefix, [StringComparison]::Ordinal) -or $g.baseUrl.Length -le $prefix.Length) {
    throw "gateway '$Id' baseUrl must start $prefix"
  }
  $want = ($Id.ToUpperInvariant() -replace '-', '_') + '_API_KEY'
  if ($g.keyVar -isnot [string] -or (& $hasNewline $g.keyVar) -or $g.keyVar -cnotmatch [string]$rules.keyVarPattern -or $g.keyVar -cne $want) {
    throw "gateway '$Id' keyVar must be $want"
  }
  foreach ($p in $rules.keyVarForbiddenPrefixes) {
    if ($g.keyVar.StartsWith([string]$p, [StringComparison]::Ordinal)) { throw "gateway '$Id' keyVar has the forbidden prefix $p" }
  }
  # The pack's hash matched the one Rust approved, so its deps and flowModels are the bytes Rust read.
  # Two rules Rust enforces on them (manifest.rs check_gateway "No Dep Probes keyVar", scan.rs
  # "keyVar ... Is Claimed By"): a dep of this pack probes the keyVar, and nothing else claims it.
  try { $pack = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json -AsHashtable } catch { throw $changed }
  $mod = if ($pack -is [System.Collections.IDictionary] -and $pack.module -is [System.Collections.IDictionary]) { $pack.module } else { @{} }
  $envProbes = { param($deps) @(@($deps) | Where-Object { $_ -is [System.Collections.IDictionary] -and $_.probe -is [System.Collections.IDictionary] -and $_.probe.kind -ceq 'env' -and $_.probe.name -is [string] } | ForEach-Object { $_.probe.name }) }
  if ((& $envProbes $mod.deps) -cnotcontains $g.keyVar) { throw "gateway '$Id' has no dependency probing $($g.keyVar)" }
  $catalog = Get-Content -Raw -LiteralPath (Join-Path $root 'contracts/dependencies.json') | ConvertFrom-Json -AsHashtable
  if ((& $envProbes $catalog.deps) -ccontains $g.keyVar) { throw "gateway '$Id' keyVar $($g.keyVar) is claimed by the dependency catalog" }
  $others = @($contract.core | Where-Object { $_.id -cne $Id } | ForEach-Object { @{ Id = $_.id; Deps = $_.deps } })
  foreach ($dir in Get-ChildItem -LiteralPath (Split-Path (Split-Path $file)) -Directory -ErrorAction SilentlyContinue) {
    if ($dir.Name -ceq $g.pack) { continue }
    $pf = Join-Path $dir.FullName 'pack.json'
    if (-not (Test-Path -LiteralPath $pf -PathType Leaf)) { continue }
    try { $op = Get-Content -Raw -LiteralPath $pf | ConvertFrom-Json -AsHashtable } catch { continue }
    if ($op -isnot [System.Collections.IDictionary]) { continue }
    $om = if ($op.module -is [System.Collections.IDictionary]) { $op.module } else { @{} }
    $oid = if ($om.id -is [string]) { $om.id } elseif ($op.id -is [string]) { $op.id } else { $dir.Name }
    if ($oid -cne $Id) { $others += @{ Id = $oid; Deps = $om.deps } }
  }
  $claimant = $others | Where-Object { (& $envProbes $_.Deps) -ccontains $g.keyVar } | Select-Object -First 1
  if ($claimant) { throw "gateway '$Id' keyVar $($g.keyVar) is claimed by module $($claimant.Id)" }
  # CLAUDE_CODE_MAX_CONTEXT_TOKENS follows the pack's flowModels entry for the gateway's model.
  $maxContext = $null
  foreach ($fm in @($mod.flowModels)) {
    if ($fm -is [System.Collections.IDictionary] -and $fm.id -is [string] -and $fm.id -ceq $g.model -and ($fm.maxContext -is [int] -or $fm.maxContext -is [long]) -and $fm.maxContext -gt 0) { $maxContext = $fm.maxContext; break }
  }
  $modelRx = [string]$rules.modelPattern
  if ($g.model -isnot [string] -or (& $hasNewline $g.model) -or $g.model -cnotmatch $modelRx) { throw "gateway '$Id' model is not a model id" }
  $allowed = @($rules.envAllowlist)
  $envSet = [ordered]@{}
  if ($null -ne $g.env) {
    if ($g.env -isnot [System.Collections.IDictionary]) { throw "gateway '$Id' env is not an object" }
    foreach ($k in $g.env.Keys) {
      if ($allowed -cnotcontains $k) { throw "gateway '$Id' env key $k is not in gateway.envAllowlist" }
      if ($g.env[$k] -isnot [string] -or (& $hasNewline $g.env[$k])) { throw "gateway '$Id' env $k is not a string" }
      if ($k.EndsWith('_MODEL', [StringComparison]::Ordinal) -and $g.env[$k] -cnotmatch $modelRx) { throw "gateway '$Id' env $k is not a model id" }
      $envSet[$k] = $g.env[$k]
    }
  }
  $cfg = [ordered]@{ BaseUrl = $g.baseUrl; KeyVar = $g.keyVar; Model = $g.model; Env = $envSet }
  if ($null -ne $maxContext) { $cfg.MaxContext = $maxContext }
  $cfg
}
try { $v = Get-GatewayConfig $Vendor }
catch {
  $host.UI.WriteErrorLine("vendor-tab: $($_.Exception.Message). claude not started.")
  exit 1
}
# After the gateway check on purpose: a refused gateway must not even spawn git.
$ProjectDirs = @(Get-ProjectDirs)
# `/model` allowlist (2026-09-28): the tier aliases plus the vendor's own ids, so Fable (a Claude-only
# alias the vendor endpoint still answers under) leaves the picker. Aliases alone are not enough: an
# allowlisted alias cannot redirect through ANTHROPIC_DEFAULT_*_MODEL to an id outside the list.
$Models = @(@('opus', 'sonnet', 'haiku', $v.Model) + @($v.Env.Keys | Where-Object { $_ -like '*_MODEL' } | ForEach-Object { $v.Env[$_] }) | Select-Object -Unique)

# Denies that must be in every fence whatever the base file says.
$Floor = @(
  'Agent(Hound)', 'Agent(Striker)', 'Agent(Orion)',
  'Edit(~/.claude/settings.json)', 'Edit(~/.claude/settings.local.json)', 'Edit(~/.claude/CLAUDE.md)',
  'Edit(~/.claude/agents/**)', 'Edit(~/.claude/skills/**)', 'Edit(~/.claude/hooks/**)',
  'PowerShell(Set-Content*)', 'PowerShell(Out-File*)', 'PowerShell(Add-Content*)'
)
# Top-level keys the fence may carry; anything else (`env`, `disableAllHooks`, ...) added to the
# base fails the read-back instead of riding along into the tab.
$AllowedKeys = @('disableClaudeAiConnectors', 'permissions', 'hooks', 'availableModels')
# The Claude login (OAuth tokens), the other vendors' logins and the User environment (where the
# keys live) must not be readable by a third-party model. Added to every fence here and checked on
# read-back. The Bash/PowerShell rules are wildcard matches on the command text: floors, not a
# boundary (a glob like `.cred*`, an alias or a script file slips past them). Nothing the fence or
# the tab's startup runs goes through these tools: the key read below happens in this script,
# before `claude`, and the guard runs as a hook, which permission rules do not gate.
$CredDeny = @(
  'Read(~/.claude/.credentials.json)',
  'Read(~/.codex/auth.json)', 'Read(~/.pi/agent/auth.json)', 'Read(~/.gemini/**)',
  # The User environment is the registry key HKCU\Environment (plus the Machine key under Session
  # Manager) and the User/Machine targets of GetEnvironmentVariable; each rule names that resource,
  # so other registry reads and process-level env reads stay allowed. The wildcard match may be
  # case-sensitive, hence the casings; the guard hook does the case-insensitive match.
  'Bash(*.credentials*)', 'Bash(*auth.json*)', 'Bash(*.gemini*)',
  'Bash(*HKCU*Environment*)', 'Bash(*hkcu*environment*)', 'Bash(*HKCU*ENVIRONMENT*)',
  'Bash(*HKEY_CURRENT_USER*Environment*)', 'Bash(*hkey_current_user*environment*)', 'Bash(*HKEY_CURRENT_USER*ENVIRONMENT*)',
  'Bash(*Session Manager*Environment*)',
  'Bash(*GetEnvironmentVariable*User*)', 'Bash(*GetEnvironmentVariable*Machine*)',
  'PowerShell(*.credentials*)', 'PowerShell(*auth.json*)', 'PowerShell(*.gemini*)',
  'PowerShell(*HKCU*Environment*)', 'PowerShell(*hkcu*environment*)', 'PowerShell(*HKEY_CURRENT_USER*Environment*)',
  'PowerShell(*Session Manager*Environment*)',
  'PowerShell(*GetEnvironmentVariable*User*)', 'PowerShell(*GetEnvironmentVariable*Machine*)'
)

$bridgeVendorDir = "$(Resolve-VidarPath -Id bridge -Root $root)\vendor"
$guard = Join-Path $PSScriptRoot 'guard-vendor-write.mjs'
$hookCmd = "node `"$(Fwd $guard)`""

# Root-resolved denies: the repo's instruction files, and the fence's own sources and output, so a
# tab cannot loosen the fence it runs under (the guard protects the same paths from Bash).
$rootDeny = @(
  "Edit($rootFwd/CLAUDE.md)", "Edit($rootFwd/AGENTS.md)", "Edit($rootFwd/.claude/**)",
  "Edit($rootFwd/tools/vendor/**)", "Edit($(Fwd $bridgeVendorDir)/**)"
)
# The project's own .claude (cwd and git top level) is loaded as settings; a model that could write
# it would rewrite its own fence mid-session (guard-vendor-write.mjs protects the same dirs from Bash).
foreach ($d in $ProjectDirs) { $rootDeny += "Edit($(Fwd $d)/.claude/**)" }
foreach ($d in $Protect) {
  if (-not [IO.Path]::IsPathRooted($d)) { throw "vendor-tab: -Protect '$d' is not an absolute path" }
  $p = Fwd ([IO.Path]::GetFullPath($d))
  $rootDeny += "Edit($p/CLAUDE.md)", "Edit($p/.claude/**)"
}

$base = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'vendor-fence.base.json') | ConvertFrom-Json -AsHashtable
$baseDeny = @($base.permissions.deny)
$fence = $base
$fence.permissions.deny = @($baseDeny + $rootDeny + $CredDeny | Select-Object -Unique)
$fence.availableModels = $Models
$fence.hooks = @{ PreToolUse = @(
  @{ matcher = 'Bash'; hooks = @(@{ type = 'command'; command = $hookCmd }) },
  @{ matcher = 'PowerShell'; hooks = @(@{ type = 'command'; command = $hookCmd }) }
) }

$tag = ($env:VIDAR_TAB -replace '[^A-Za-z0-9_-]', '')
if (-not $tag) { $tag = 'shell' }
$dir = $bridgeVendorDir
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$fencePath = Join-Path $dir "$Vendor-$tag-$PID.settings.json"
Write-BridgeJsonAtomic -Path $fencePath -Value ($fence | ConvertTo-Json -Depth 10)

try {
  $bytes = [IO.File]::ReadAllBytes($fencePath)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { throw 'fence file has a BOM' }
  $back = [Text.UTF8Encoding]::new($false).GetString($bytes) | ConvertFrom-Json -AsHashtable
  $extra = @($back.Keys | Where-Object { $AllowedKeys -cnotcontains $_ })
  if ($extra.Count) { throw "fence carries top-level keys outside the allowlist: $($extra -join ', ')" }
  $deny = @($back.permissions.deny)
  $missing = @($Floor + $CredDeny + $baseDeny + $rootDeny | Where-Object { $deny -cnotcontains $_ })
  if ($missing.Count) { throw "fence is missing deny rules: $($missing -join ', ')" }
  if ((@($back.availableModels) -join ',') -cne ($Models -join ',')) { throw "fence availableModels is '$(@($back.availableModels) -join ',')', expected '$($Models -join ',')'" }
  $cmds = @($back.hooks.PreToolUse | Where-Object { $_.matcher -ceq 'Bash' } | ForEach-Object { $_.hooks } |
      Where-Object { $_.type -ceq 'command' } | ForEach-Object { $_.command })
  if ($cmds -cnotcontains $hookCmd) { throw "fence has no Bash hook running $hookCmd" }
  $psCmds = @($back.hooks.PreToolUse | Where-Object { $_.matcher -ceq 'PowerShell' } | ForEach-Object { $_.hooks } |
      Where-Object { $_.type -ceq 'command' } | ForEach-Object { $_.command })
  if ($psCmds -cnotcontains $hookCmd) { throw "fence has no PowerShell hook running $hookCmd" }
  if (-not (Test-Path -LiteralPath $guard -PathType Leaf)) { throw "guard script not found: $guard" }
  $null = Get-Command node -CommandType Application
  $probe = @{ tool_name = 'Bash'; tool_input = @{ command = "echo x > `"$rootFwd/.claude/vendor-fence-probe`"" } } | ConvertTo-Json -Compress
  $env:VIDAR_FENCE_PROBE = '1'
  try { $probe | & node $guard 2>$null | Out-Null; $code = $LASTEXITCODE } finally { Remove-Item Env:VIDAR_FENCE_PROBE -ErrorAction SilentlyContinue }
  if ($code -ne 2) { throw "guard did not block a probe write into $rootFwd/.claude (exit $code)" }
} catch {
  Remove-Item -LiteralPath $fencePath -ErrorAction SilentlyContinue
  throw "Vendor fence check failed, claude not started: $($_.Exception.Message)"
}

if ($PrintFence) {
  $fencePath
  Get-Content -Raw -LiteralPath $fencePath
  exit 0 # explicit: $LASTEXITCODE still holds the guard probe's 2, and vendor-tab.ps1 passes it on
}

# From here every exit (missing key, plugin dir failure, claude's own exit) removes the fence file.
$saved = @{}
try {
  $found = @(Get-SettingsCredentialFindings)
  if ($found.Count) { throw "vendor-tab: user or project Claude settings would re-inject a credential or switch off the fence hook in the vendor session: $($found -join '; '). Remove those entries (credential-shaped env names, apiKeyHelper, disableAllHooks) to open a vendor tab. claude not started." }

  # User scope first (see the header); the process env is the fallback, so a key set only for this
  # shell (or by the test harness) still works. Either way it is stripped below and rides as AUTH_TOKEN.
  $key = [Environment]::GetEnvironmentVariable($v.KeyVar, 'User')
  if (-not $key) { $key = [Environment]::GetEnvironmentVariable($v.KeyVar, 'Process') }
  if (-not $key) { throw "$($v.KeyVar) is not set (User scope or this process)" }

  $plugin = Fwd (Join-Path $HOME ".claude/vendor/$Vendor")
  New-Item -ItemType Directory -Force -Path $plugin | Out-Null

  $inherited = @{}
  Get-ChildItem Env: | ForEach-Object { $inherited[$_.Name] = $_.Value }
  $prepared = Get-VendorEnvironment -Inherited $inherited -Config $v -Key $key
  $set = Get-VendorEnvSet -Config $v -Key $key
  # Credential strip (Test-CredentialName, flow.rs's rule widened): every credential-shaped name in
  # this process (case-insensitive) is removed before `claude` starts,
  # so another gateway's key (OTHER_API_KEY in an ACME tab, TYPESAFE_API_KEY), CLAUDE_CODE_OAUTH_TOKEN
  # and VIDAR_CTL_TOKEN never reach the third-party endpoint's session. This tab's own key rides only
  # as ANTHROPIC_AUTH_TOKEN, set from $set after the strip.
  $strip = @($inherited.Keys | Where-Object { -not $prepared.ContainsKey($_) })
  foreach ($k in @($set.Keys) + $strip) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }

  $model = $v.Model
  $prompt = "Vendor seat: Hound, Striker and Orion are Claude-billed and unavailable here; do not attempt them. Your own skills, agents, hooks and notes live in $plugin (writable); the shared Claude config under ~/.claude and the repo CLAUDE.md/.claude are read-only to you."
  foreach ($k in $strip) { Set-ProcessEnv $k $null }
  foreach ($k in $set.Keys) { Set-ProcessEnv $k $prepared[$k] }
  if ($Sidecar) {
    # Only nonsecret sidecar arguments cross this boundary. Credentials stay in the environment.
    $args_ = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SidecarArgs)) | ConvertFrom-Json)
    $args_ += @('--model', $model, '--vendor-settings', (Fwd $fencePath), '--vendor-plugin', $plugin, '--vendor-prompt', $prompt)
    & $Node $Sidecar @args_
    $childExit = $LASTEXITCODE
  } else {
    & claude --model $model --settings (Fwd $fencePath) --plugin-dir $plugin --append-system-prompt $prompt
    $childExit = $LASTEXITCODE
  }
} finally {
  foreach ($k in $saved.Keys) { Set-ProcessEnv $k $saved[$k] }
  Remove-Item -LiteralPath $fencePath -ErrorAction SilentlyContinue
}

exit $childExit
