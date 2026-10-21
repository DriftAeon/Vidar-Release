#Requires -Version 7
<#
P0 live probe for the Slack inbox tab: read-only Slack Web API calls with a user token (xoxp-).
Run in a normal terminal (it prompts for the token, so not a `!` line):
    pwsh -File tools/slack/probe.ps1
The token is read at a hidden prompt (or SLACK_PROBE_TOKEN for testing), kept in memory only, and never
printed, logged or written. Output is HTTP status, ok/error codes and counts: no message text, ids or links.
Refuses: exits 1 with no token, and stops after check 1 if auth.test fails.
Plan: docs/projects/slack/inbox-tab-plan.md § P0
#>
$ErrorActionPreference = 'Stop'

$t = $env:SLACK_PROBE_TOKEN
if (-not $t) {
    $sec = Read-Host -Prompt 'Slack User OAuth Token' -AsSecureString
    $t = [System.Net.NetworkCredential]::new('', $sec).Password
}
if (-not $t) { Write-Host 'no token given'; exit 1 }

$summary = [ordered]@{}

# Returns @{ Status; Json; RetryAfter; Failed } and prints nothing sensitive on error.
function Invoke-Slack {
    param([string]$Method, [string]$Query = '', [switch]$Post)
    $res = @{ Status = 0; Json = $null; RetryAfter = $null; Failed = $false }
    try {
        $uri = "https://slack.com/api/$Method"
        $hdr = @{ Authorization = "Bearer $t" }
        if ($Post) {
            $r = Invoke-WebRequest -Method Post -Uri $uri -Headers $hdr -Body $Query `
                -ContentType 'application/x-www-form-urlencoded' -SkipHttpErrorCheck -TimeoutSec 20
        } else {
            $u = if ($Query) { "${uri}?$Query" } else { $uri }
            $r = Invoke-WebRequest -Method Get -Uri $u -Headers $hdr -SkipHttpErrorCheck -TimeoutSec 20
        }
        $res.Status = [int]$r.StatusCode
        if ($res.Status -eq 429) {
            $res.RetryAfter = [string]($r.Headers['Retry-After'] | Select-Object -First 1)
        }
        try { $res.Json = $r.Content | ConvertFrom-Json -Depth 20 } catch { $res.Json = $null }
    } catch {
        $res.Failed = $true
        $type = $_.Exception.GetType().Name
        Write-Host "  $Method request failed: $type"
    }
    return $res
}

function Show-Status {
    param([string]$Method, $R)
    if ($R.Failed) { return }
    $ok = if ($R.Json) { $R.Json.ok } else { 'unparsed' }
    $err = if ($R.Json -and $R.Json.PSObject.Properties['error']) { $R.Json.error } else { '-' }
    Write-Host "  $Method  http=$($R.Status) ok=$ok error=$err"
}

function Test-Rate {
    param([string]$Method, $R)
    if (-not $R.Failed -and $R.Status -eq 429) {
        Write-Host "  $Method  http=429 retry-after=$($R.RetryAfter) (skipping rest of this check)"
        return $true
    }
    return $false
}

function Get-Prop { param($o, [string]$n) if ($null -ne $o -and $o.PSObject.Properties[$n]) { $o.$n } else { $null } }

function Search-Messages {
    param([string]$Query, [int]$Count = 100)
    $q = "query=$([uri]::EscapeDataString($Query))&count=$Count&sort=timestamp&sort_dir=desc&highlight=false"
    Start-Sleep -Milliseconds 1500
    return Invoke-Slack -Method 'search.messages' -Query $q
}

function Get-Matches {
    param($R)
    $m = Get-Prop (Get-Prop $R.Json 'messages') 'matches'
    if ($null -eq $m) { return @() }
    return @($m)
}

# 1. auth.test
Write-Host '== 1. auth.test'
$r = Invoke-Slack -Method 'auth.test'
Show-Status 'auth.test' $r
$uid = $null
if ($r.Failed -or $r.Status -eq 429 -or -not $r.Json -or $r.Json.ok -ne $true) {
    if ($r.Status -eq 429) { Write-Host "  retry-after=$($r.RetryAfter)" }
    $code = if ($r.Failed) { 'request_failed' } elseif ($r.Json) { Get-Prop $r.Json 'error' } else { "http_$($r.Status)" }
    $summary['1 auth.test'] = "fail $code"
    Write-Host 'auth failed; stopping.'
    Write-Host '== Summary'
    $summary.GetEnumerator() | ForEach-Object { Write-Host "  $($_.Key): $($_.Value)" }
    exit 1
}
$uid = [string](Get-Prop $r.Json 'user_id')
$hostOk = ([string](Get-Prop $r.Json 'url')) -match '^https://[a-z0-9][a-z0-9-]{0,62}\.slack\.com/$'
Write-Host "  user_id present: $([bool]$uid)"
Write-Host "  host ok: $hostOk"
$summary['1 auth.test'] = if ($uid -and $hostOk) { 'pass' } else { 'fail shape' }

# 2. Mentions
Write-Host '== 2. Mentions (search.messages)'
$forms = @(
    @{ Label = '<@UID>';     Query = "<@$uid>";   Token = "<@$uid>" },
    @{ Label = '<!here>';    Query = '<!here>';   Token = '<!here' },
    @{ Label = '@here';      Query = '@here';     Token = '<!here' },
    @{ Label = '<!channel>'; Query = '<!channel>'; Token = '<!channel' },
    @{ Label = '@channel';   Query = '@channel';  Token = '<!channel' }
)
$mFail = $null; $mAny = $false; $mSemantic = $false; $mRate = $false
foreach ($f in $forms) {
    $r = Search-Messages $f.Query
    if (Test-Rate "search $($f.Label)" $r) { $mRate = $true; break }
    if ($r.Failed) { $mFail = 'request_failed'; continue }
    Write-Host "  [$($f.Label)]"
    Show-Status 'search.messages' $r
    if (-not $r.Json -or $r.Json.ok -ne $true) {
        $mFail = if ($r.Json) { Get-Prop $r.Json 'error' } else { "http_$($r.Status)" }
        continue
    }
    $ms = Get-Matches $r
    $total = Get-Prop (Get-Prop $r.Json 'messages') 'total'
    $withTok = @($ms | Where-Object { ([string](Get-Prop $_ 'text')).Contains($f.Token) }).Count
    Write-Host "    total=$total returned=$($ms.Count) with-raw-token=$withTok"
    if ($ms.Count -gt 0) { $mAny = $true }
    if ($withTok -gt 0) { $mSemantic = $true }
}
$summary['2 mentions'] = if ($mFail) { "fail $mFail" } elseif ($mSemantic) { 'pass' } elseif ($mRate) { 'inconclusive (rate limited)' } elseif ($mAny) { 'fail (matches carry no raw token)' } else { 'inconclusive (no matches)' }

# 3. Groups
Write-Host '== 3. User groups'
$r = Invoke-Slack -Method 'usergroups.list' -Query 'include_users=true'
if (Test-Rate 'usergroups.list' $r) {
    $summary['3 groups'] = 'inconclusive (rate limited)'
} elseif ($r.Failed) {
    $summary['3 groups'] = 'fail request_failed'
} else {
    Show-Status 'usergroups.list' $r
    if (-not $r.Json -or $r.Json.ok -ne $true) {
        $summary['3 groups'] = "fail $(if ($r.Json) { Get-Prop $r.Json 'error' } else { "http_$($r.Status)" })"
    } else {
        $groups = @(Get-Prop $r.Json 'usergroups')
        $groups = @($groups | Where-Object { $null -ne $_ })
        $allUsers = $true
        foreach ($g in $groups) { if ($null -eq (Get-Prop $g 'users')) { $allUsers = $false } }
        $mine = @($groups | Where-Object { $null -ne (Get-Prop $_ 'users') -and (@($_.users) -contains $uid) })
        Write-Host "  groups=$($groups.Count) every-group-has-users[]=$allUsers containing-you=$($mine.Count)"
        if ($mine.Count -eq 0) {
            $summary['3 groups'] = 'inconclusive (no group contains you)'
        } else {
            $g = $mine[0]
            $handle = [string](Get-Prop $g 'handle'); $gid = [string](Get-Prop $g 'id')
            $gForms = @(
                @{ Label = '@handle';        Query = "@$handle";           Token = '<!subteam^' },
                @{ Label = '<!subteam^ID>';  Query = "<!subteam^$gid>";    Token = '<!subteam^' }
            )
            $gSem = $false; $gAny = $false; $gFail = $null
            foreach ($f in $gForms) {
                $sr = Search-Messages $f.Query
                if (Test-Rate "search $($f.Label)" $sr) { break }
                if ($sr.Failed) { $gFail = 'request_failed'; continue }
                Write-Host "  [$($f.Label)]"
                Show-Status 'search.messages' $sr
                if (-not $sr.Json -or $sr.Json.ok -ne $true) {
                    $gFail = if ($sr.Json) { Get-Prop $sr.Json 'error' } else { "http_$($sr.Status)" }
                    continue
                }
                $ms = Get-Matches $sr
                $withTok = @($ms | Where-Object { ([string](Get-Prop $_ 'text')).Contains($f.Token) }).Count
                Write-Host "    returned=$($ms.Count) with-raw-subteam=$withTok"
                if ($ms.Count -gt 0) { $gAny = $true }
                if ($withTok -gt 0) { $gSem = $true }
            }
            $summary['3 groups'] = if ($gFail) { "fail $gFail" } elseif ($gSem -and $allUsers) { 'pass' } elseif ($gSem) { 'fail (users[] missing)' } elseif ($gAny) { 'fail (matches carry no raw subteam)' } else { 'inconclusive (no matches)' }
        }
    }
}

# 4. DM discriminator
Write-Host '== 4. DM discriminator'
$yesterday = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
$r = Search-Messages "after:$yesterday"
if (Test-Rate 'search after:<yesterday>' $r) {
    $summary['4 dm discriminator'] = 'inconclusive (rate limited)'
} elseif ($r.Failed) {
    $summary['4 dm discriminator'] = 'fail request_failed'
} else {
    Show-Status 'search.messages' $r
    if (-not $r.Json -or $r.Json.ok -ne $true) {
        $summary['4 dm discriminator'] = "fail $(if ($r.Json) { Get-Prop $r.Json 'error' } else { "http_$($r.Status)" })"
    } else {
        $ms = Get-Matches $r
        Write-Host "  returned=$($ms.Count)"
        if ($ms.Count -eq 0) {
            $summary['4 dm discriminator'] = 'inconclusive (no matches)'
        } else {
            $typeIm = @($ms | Where-Object { (Get-Prop $_ 'type') -eq 'im' }).Count
            $isIm   = @($ms | Where-Object { (Get-Prop (Get-Prop $_ 'channel') 'is_im') -eq $true }).Count
            $isMpim = @($ms | Where-Object { (Get-Prop (Get-Prop $_ 'channel') 'is_mpim') -eq $true }).Count
            $isPriv = @($ms | Where-Object { (Get-Prop (Get-Prop $_ 'channel') 'is_private') -eq $true }).Count
            $none   = @($ms | Where-Object {
                (Get-Prop $_ 'type') -ne 'im' -and
                (Get-Prop (Get-Prop $_ 'channel') 'is_im') -ne $true -and
                (Get-Prop (Get-Prop $_ 'channel') 'is_mpim') -ne $true }).Count
            $types = @($ms | ForEach-Object { [string](Get-Prop $_ 'type') } | Sort-Object -Unique)
            Write-Host "  type=im: $typeIm"
            Write-Host "  channel.is_im: $isIm"
            Write-Host "  channel.is_mpim: $isMpim"
            Write-Host "  channel.is_private: $isPriv"
            Write-Host "  none of type=im/is_im/is_mpim: $none"
            Write-Host "  distinct type values: $($types -join ', ')"
            $summary['4 dm discriminator'] = if (($typeIm + $isIm + $isMpim) -gt 0) { 'pass' } else { 'inconclusive (no DM-shaped matches)' }
        }
    }
}

# 5. AI search
Write-Host '== 5. AI search (assistant.search.context)'
Write-Host '  note: missing_scope is expected until search:read.im / search:read.mpim are added'
$q = "query=$([uri]::EscapeDataString('*'))&channel_types=$([uri]::EscapeDataString('im,mpim'))"
Start-Sleep -Milliseconds 1500
$r = Invoke-Slack -Method 'assistant.search.context' -Query $q
if (-not $r.Failed -and $r.Json -and $r.Json.ok -ne $true -and (Get-Prop $r.Json 'error') -in @('invalid_arguments', 'method_not_supported')) {
    Write-Host '  GET refused; retrying once as POST'
    Start-Sleep -Milliseconds 1500
    $r = Invoke-Slack -Method 'assistant.search.context' -Query $q -Post
}
if (Test-Rate 'assistant.search.context' $r) {
    $summary['5 ai search'] = 'inconclusive (rate limited)'
} elseif ($r.Failed) {
    $summary['5 ai search'] = 'fail request_failed'
} else {
    Show-Status 'assistant.search.context' $r
    if (-not $r.Json) {
        $summary['5 ai search'] = "fail http_$($r.Status)"
    } elseif ($r.Json.ok -eq $true) {
        $results = Get-Prop $r.Json 'results'
        $n = 0
        if ($null -ne $results) {
            $n = 0
            foreach ($p in $results.PSObject.Properties) { $n += @($p.Value).Count }
            if ($results -is [array]) { $n = $results.Count }
        }
        Write-Host "  results=$n"
        $summary['5 ai search'] = if ($n -gt 0) { 'pass' } else { 'inconclusive (no matches)' }
    } else {
        $needed = Get-Prop $r.Json 'needed'
        if ($needed) { Write-Host "  needed: $needed" }
        $summary['5 ai search'] = "fail $(Get-Prop $r.Json 'error')"
    }
}

Write-Host '== Summary'
foreach ($e in $summary.GetEnumerator()) { Write-Host "  $($e.Key): $($e.Value)" }
