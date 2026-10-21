# Pure credential-boundary test. No vendor key lookup, child CLI, or file writes.
. (Join-Path $PSScriptRoot '../tools/vendor/vendor-env.ps1')
$config = @{ BaseUrl = 'https://example.invalid/anthropic'; Env = @{ ANTHROPIC_DEFAULT_HAIKU_MODEL = 'fixture-model' } }
$inherited = @{ Path = 'fixture-path'; FALCON_SESSION = 'fixture-session' }
foreach ($name in @('ANTHROPIC_API_KEY', 'anthropic_auth_token', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ACME_API_KEY', 'OTHER_API_KEY','AWS_ACCESS_KEY_ID', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'SERVICE_KEY', 'SERVICE_PASSWORD', 'SERVICE_PAT',
    'SERVICE_CREDENTIALS', 'SERVICE_TOKEN', 'SERVICE_SECRET', 'VIDAR_CTL_SECRET')) {
  $inherited[$name] = 'inherited-fixture'
}
$env_ = Get-VendorEnvironment -Inherited $inherited -Config $config -Key 'selected-fixture'
foreach ($name in $inherited.Keys) {
  if ((Test-CredentialName $name) -and $name -notlike 'ANTHROPIC_*' -and $env_.ContainsKey($name)) { throw "Credential strip failed for $name" }
}
if ($env_.ANTHROPIC_API_KEY -or $env_.ANTHROPIC_AUTH_TOKEN -cne 'selected-fixture') { throw 'Auth strip/set failed' }
if ($env_.ANTHROPIC_BASE_URL -cne $config.BaseUrl) { throw 'Endpoint set failed' }
if ($env_.ANTHROPIC_DEFAULT_HAIKU_MODEL -cne $config.Env.ANTHROPIC_DEFAULT_HAIKU_MODEL) { throw 'Model set failed' }
if ($env_.Path -cne 'fixture-path' -or $env_.FALCON_SESSION -cne 'fixture-session') { throw 'Noncredential identity lost' }
if ($inherited.ANTHROPIC_API_KEY -cne 'inherited-fixture') { throw 'Pure construction mutated input' }
if ($env_.CLAUDE_CODE_MAX_CONTEXT_TOKENS -cne '1000000') { throw 'Default context lost' }
$sized = Get-VendorEnvSet -Config ($config + @{ MaxContext = 200000 }) -Key 'k'
if ($sized.CLAUDE_CODE_MAX_CONTEXT_TOKENS -cne '200000') { throw 'Pack context ignored' }
$bad = Get-VendorEnvSet -Config ($config + @{ MaxContext = 'x' }) -Key 'k'
if ($bad.CLAUDE_CODE_MAX_CONTEXT_TOKENS -cne '1000000') { throw 'Bad pack context not defaulted' }
'PASS: Gateway Environment Strip and Set'
