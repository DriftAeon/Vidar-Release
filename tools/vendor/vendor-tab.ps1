#Requires -Version 7
<#
tools\vendor\vendor-tab.ps1 — the Raw (terminal) entry point for a gateway module's launcher row.

  & "$env:VIDAR_ROOT/tools/vendor/vendor-tab.ps1" -Vendor <id> [-Protect <dir>...] [-PrintFence]

It passes its arguments to vendor-prepare.ps1, which reads the approved gateway snapshot, builds and checks the
fence, sets the gateway environment and starts `claude`; Rendered gateway tabs reach the same
preparation through tools\claude-sidecar.mjs. It refuses whatever vendor-prepare.ps1 refuses (an id
off the module id pattern, a gateway absent from Vidar's approved snapshot or whose pack changed
since Vidar checked it, values breaking the gateway rules, a weakened fence, a re-injected
credential, a missing key): `claude` never starts.
#>
param(
  [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{0,31}$', Options = 'None')][string]$Vendor,
  [string[]]$Protect = @(),
  [switch]$PrintFence
)
# A refusal's `exit 1` inside the preparation ends only that script, so its code is passed on here;
# without this a refused launch exited 0. The preparation sets an explicit code on every path.
& (Join-Path $PSScriptRoot 'vendor-prepare.ps1') @PSBoundParameters
exit $LASTEXITCODE
