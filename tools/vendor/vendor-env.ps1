<#
tools\vendor\vendor-env.ps1 — credential-name rule and pure gateway environment construction.

  . (Join-Path $PSScriptRoot 'vendor-env.ps1')
  $set = Get-VendorEnvSet -Config $gateway -Key $key
  $env_ = Get-VendorEnvironment -Inherited $inherited -Config $gateway -Key $key

$gateway is @{ BaseUrl; Env; MaxContext? } (vendor-prepare.ps1 builds it from a checked pack gateway block).

Dot-sourced by vendor-prepare.ps1 and tests\gateway-vendor-env.ps1; it defines functions only.
It refuses nothing itself and never reads, writes or logs the environment: callers pass the
inherited names in and apply the result.
#>

# Credential-shaped env names, case-insensitive (Windows env names are). flow.rs build_node_env's
# rule (ANTHROPIC_*, *_API_KEY, *_TOKEN, *_SECRET) is the core; this one is wider on purpose: flow.rs
# strips for Claude-model nodes too, where the extra names (Bedrock/Vertex switches, *_KEY) change
# behaviour, so it stays at the core. Never narrow this one below flow.rs's.
function Test-CredentialName([string]$Name) {
  $u = $Name.ToUpperInvariant()
  $u.StartsWith('ANTHROPIC_') -or $u.EndsWith('_API_KEY') -or $u.EndsWith('_TOKEN') -or $u.EndsWith('_SECRET') -or
  $u.EndsWith('_KEY') -or $u.EndsWith('_PASSWORD') -or $u.EndsWith('_PAT') -or $u.EndsWith('_CREDENTIALS') -or
  $u -in @('AWS_ACCESS_KEY_ID', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX')
}

# Pure construction: no environment reads, writes, or logging. Used by vendor-prepare.ps1.
function Get-VendorEnvSet([System.Collections.IDictionary]$Config, [string]$Key) {
  # The pack's flowModels.maxContext when the config carries one (a positive integer), else 1000000.
  $max = if ($Config.Contains('MaxContext') -and ($Config.MaxContext -is [int] -or $Config.MaxContext -is [long]) -and $Config.MaxContext -gt 0) { [string]$Config.MaxContext } else { '1000000' }
  $set = [ordered]@{ ANTHROPIC_BASE_URL = $Config.BaseUrl; ANTHROPIC_AUTH_TOKEN = $Key; CLAUDE_CODE_MAX_CONTEXT_TOKENS = $max }
  foreach ($k in $Config.Env.Keys) { $set[$k] = $Config.Env[$k] }
  return $set
}
function Get-VendorEnvironment([System.Collections.IDictionary]$Inherited, [System.Collections.IDictionary]$Config, [string]$Key) {
  $result = @{}
  foreach ($k in $Inherited.Keys) { if (-not (Test-CredentialName $k)) { $result[$k] = $Inherited[$k] } }
  $set = Get-VendorEnvSet -Config $Config -Key $Key
  foreach ($k in $set.Keys) { $result[$k] = $set[$k] }
  return $result
}
