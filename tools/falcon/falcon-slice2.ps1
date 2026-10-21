#requires -Version 7.0
# Slice 2 live proof: durable state, the attach cut, the controller lease, and Falcon-owned prompts.
#
# Criteria-based like falcon-slice1.ps1, and the same rule applies: `ok` is the AND of every
# criterion, nothing is hardcoded true, and a step that could not run records false plus its reason.
# A proof that reports "mostly passed" is not a proof.
#
# What this exercises that slice 1 did not:
#   - the controller lease is CONNECTION-bound, so it must be acquired and used on one connection,
#     and must be gone once that connection ends. Both halves are asserted.
#   - a mutation without the lease is refused BY NAME, not merely refused.
#   - Falcon owns the prompt queue: a prompt is retractable while it waits, and prompts survive the
#     client that queued them going away. While the sidecar held the queue neither was possible.
#   - the journal replays: hydrate through the attach cut returns the records the run just wrote.
#
# Costs one short real Claude turn (default model: haiku) against the account, same as slice 1.
# Refuses to touch Vidar: never starts, stops or drives it, and kills only the host it launched.

[CmdletBinding()]
param(
    [switch]$SkipVidarBuilds,
    [string]$Model = 'haiku',
    [switch]$KeepBundle
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. "$PSScriptRoot\..\lib\Paths.ps1"
. "$PSScriptRoot\SmokeRoot.ps1"
# A throwaway root under %TEMP%: its own pipes, and --admit-probe gives the
# session probe the full role.
$smokeRoot = New-FalconSmokeRoot
$registryPath = $smokeRoot.Registry

$hostProcess = $null
$workDir = Join-Path ([IO.Path]::GetTempPath()) ("falcon-slice2-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir | Out-Null

$criteria = [ordered]@{}
function Add-Criterion {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Ok,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Detail
    )
    $criteria[$Name] = [ordered]@{ ok = $Ok; detail = $Detail }
}

function Write-Ops {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][object[]]$Ops)
    # -Depth matters: a submit's content and a lease both nest, and the default depth of 2
    # silently renders nested objects as type names.
    $json = ConvertTo-Json -InputObject @($Ops) -Depth 12
    [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

function Invoke-Probe {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][object[]]$Ops,
        [Parameter(Mandatory)][string]$Label,
        [int]$LingerMs = 0,
        [int]$TimeoutMs = 180000
    )
    $opsPath = Join-Path $workDir "$Label.ops.json"
    Write-Ops -Path $opsPath -Ops $Ops
    $out = Join-Path $workDir "$Label.out.jsonl"
    $err = Join-Path $workDir "$Label.err.txt"
    $arguments = @('--session-probe', '--registry', $registryPath, '--ops', $opsPath)
    if ($LingerMs -gt 0) { $arguments += @('--linger-ms', $LingerMs) }
    $process = Start-Process -FilePath $Executable -ArgumentList $arguments `
        -RedirectStandardOutput $out -RedirectStandardError $err `
        -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit($TimeoutMs)) {
        try { Stop-Process -Id $process.Id -Force } catch {}
        throw "$Label probe did not finish within $TimeoutMs ms"
    }
    $frames = @()
    if (Test-Path -LiteralPath $out) {
        $frames = @(Get-Content -LiteralPath $out |
            Where-Object { $_.Trim() } |
            ForEach-Object { try { $_ | ConvertFrom-Json } catch {} })
    }
    [pscustomobject]@{
        ExitCode = $process.ExitCode
        Frames   = $frames
        Stderr   = (Test-Path $err) ? (Get-Content -LiteralPath $err -Raw) : ''
    }
}

function Get-Response {
    param([object[]]$Frames, [int]$Request)
    $Frames | Where-Object { $_.t -eq 'response' -and $_.request -eq $Request } | Select-Object -First 1
}

# The probe sends its own `negotiate` first, as request 1, so the Nth operation
# in an ops file answers to request N+1. Named rather than written as literals:
# an off-by-one here silently reads the wrong response and reports a clean,
# confident, wrong verdict.
function Get-OpResponse {
    param([object[]]$Frames, [Parameter(Mandatory)][int]$Index)
    Get-Response -Frames $Frames -Request ($Index + 1)
}

try {
    # ---- 1. deploy a bundle and start a host ------------------------------
    $buildArgs = @{}
    if ($SkipVidarBuilds) { $buildArgs['SkipFrontend'] = $true }
    # `-Last 1`: the build writes progress before its JSON, so piping the whole
    # stream to ConvertFrom-Json parses the wrong line.
    $buildResult = & (Join-Path $PSScriptRoot '..\release\falcon-build.ps1') @buildArgs |
        Select-Object -Last 1 | ConvertFrom-Json
    if (-not $buildResult.executable) { throw 'falcon-build.ps1 returned no bundle' }
    $executable = $buildResult.executable
    Add-Criterion -Name 'bundle_built' -Ok ([bool]$executable) -Detail "bundle $($buildResult.bundle_id)"

    $hostOut = Join-Path $workDir 'host.out.txt'
    $hostErr = Join-Path $workDir 'host.err.txt'
    $storeRoot = Resolve-VidarPath -Id falconStore -Root $repoRoot
    # Same launch shape as slice 1, read from that script rather than guessed:
    # the host takes --registry/--bundle-id/--store and runs from the bundle.
    $hostProcess = Start-Process -FilePath $executable -ArgumentList @(
        '--registry', $registryPath,
        '--bundle-id', $buildResult.bundle_id,
        '--store', $storeRoot,
        '--admit-probe'
    ) -WorkingDirectory $buildResult.bundle_path -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $hostOut -RedirectStandardError $hostErr

    $ready = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $registryPath) {
            try {
                $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
                if ($registry.pid -eq $hostProcess.Id) { $ready = $true; break }
            } catch {}
        }
        Start-Sleep -Milliseconds 200
    }
    Add-Criterion -Name 'host_started' -Ok $ready -Detail ($ready ? "host pid $($hostProcess.Id) owns the registry" : 'the host never registered itself')
    if (-not $ready) { throw 'host did not start' }

    $sessionCwd = Join-Path $workDir 'session'
    New-Item -ItemType Directory -Path $sessionCwd | Out-Null

    # ---- 2. one connection: spawn, refuse unleased, acquire, queue --------
    # All on ONE probe on purpose. The lease is bound to the connection, so
    # splitting these across probes could not work even if the server were
    # correct -- which is itself asserted by the next probe.
    $controller = Invoke-Probe -Executable $executable -Label 'controller' -LingerMs 90000 -Ops @(
        @{ op = 'spawn'; cwd = $sessionCwd; permission_mode = 'default'; model = $Model },
        # A mutation with a lease nobody holds must be refused by name, not accepted by default.
        @{ op = 'submit'; session = '$session'; generation = '$generation'
           lease = @{ token = 'not-a-real-token'; revision = 0 }
           content = 'this must never reach the agent'; expect = 'failed' },
        @{ op = 'acquire-control'; session = '$session' },
        # Attach BEFORE submitting. The agent's reply is pushed to attached
        # connections as it happens, so attaching afterwards would miss the
        # very events this run has to observe.
        @{ op = 'attach'; session = '$session' },
        # Two prompts: the first runs, the second is retracted while it waits.
        # `$prompt` always binds to the most recent submit, so the retraction
        # below targets the second one -- the one still in the queue.
        @{ op = 'submit'; session = '$session'; generation = '$generation'; lease = '$lease'
           content = 'Reply with exactly: SLICE2-OK' },
        @{ op = 'submit'; session = '$session'; generation = '$generation'; lease = '$lease'
           content = 'this prompt is retracted before it is ever dispatched' },
        @{ op = 'retract-prompt'; session = '$session'; generation = '$generation'; lease = '$lease'
           prompt = '$prompt' },
        @{ op = 'list' }
    )

    $spawn = Get-OpResponse -Frames $controller.Frames -Index 1
    $session = $spawn.payload.session.session
    Add-Criterion -Name 'session_spawned' -Ok ([bool]$session) -Detail ($session ? "session $session" : 'spawn did not apply')
    if (-not $session) { throw 'spawn failed' }

    $unleased = Get-OpResponse -Frames $controller.Frames -Index 2
    $namedRefusal = $unleased.outcome -eq 'failed' -and $unleased.error -match 'controller'
    Add-Criterion -Name 'unleased_mutation_refused_by_name' -Ok $namedRefusal `
        -Detail ($namedRefusal ? "refused: '$($unleased.error)'" : "expected a named controller refusal, got outcome '$($unleased.outcome)' error '$($unleased.error)'")

    $acquire = Get-OpResponse -Frames $controller.Frames -Index 3
    $leaseOk = $acquire.outcome -eq 'applied' -and $acquire.payload.token -and $acquire.payload.revision -ge 1
    Add-Criterion -Name 'control_acquired' -Ok $leaseOk `
        -Detail ($leaseOk ? "lease revision $($acquire.payload.revision)" : 'acquire-control did not return a token and revision')

    $firstSubmit = Get-OpResponse -Frames $controller.Frames -Index 5
    $queuedOk = $firstSubmit.outcome -eq 'applied' -and $firstSubmit.payload.prompt
    Add-Criterion -Name 'prompt_queued_with_an_id' -Ok $queuedOk `
        -Detail ($queuedOk ? "prompt $($firstSubmit.payload.prompt) queued and dispatched=$($firstSubmit.payload.dispatched)" : 'submit did not return a prompt id')

    # `applied` alone is not evidence: a retraction that was reported but never
    # took effect looks identical. The `list` taken AFTER the retraction, on the
    # same connection, must also show the queue empty -- otherwise a prompt that
    # was retracted-then-dispatched anyway would still score this criterion.
    $retract = Get-OpResponse -Frames $controller.Frames -Index 7
    $controllerList = Get-OpResponse -Frames $controller.Frames -Index 8
    $listedHere = @($controllerList.payload.sessions | Where-Object { $_.session -eq $session })
    $stillQueued = ($listedHere.Count -eq 1) ? @($listedHere[0].queued_prompts) : @('<no list>')
    $retractedId = $retract.payload.retracted
    $retractOk = $retract.outcome -eq 'applied' -and ($stillQueued -notcontains $retractedId)
    Add-Criterion -Name 'waiting_prompt_retracted' -Ok $retractOk `
        -Detail ($retractOk ? "retracted $retractedId and it is absent from the queue afterwards (queue: $(($stillQueued -join ', ')))" : "retract outcome '$($retract.outcome)'; queue afterwards: $(($stillQueued -join ', '))")

    $attach = Get-OpResponse -Frames $controller.Frames -Index 4
    $through = $attach.payload.through
    Add-Criterion -Name 'attach_returned_a_cut' -Ok ($null -ne $through) `
        -Detail ($null -ne $through ? "attach cut at journal position $through" : 'attach returned no through')

    $agentEvents = @($controller.Frames | Where-Object { $_.t -eq 'event' -and $_.kind -eq 'agent' })
    $assistantText = ($agentEvents |
        Where-Object { $_.line.type -eq 'assistant' } |
        ForEach-Object { $_.line.message.content } |
        Where-Object { $_.type -eq 'text' } |
        ForEach-Object { $_.text }) -join ''
    $sentinelOk = $assistantText -match 'SLICE2-OK'
    Add-Criterion -Name 'queued_prompt_reached_the_agent' -Ok $sentinelOk `
        -Detail ($sentinelOk ? "the agent answered the queued prompt ($($agentEvents.Count) agent events)" : 'the queued prompt never produced the sentinel')

    # ---- 3. a NEW connection: the lease died with the old one -------------
    # The controller probe has exited, so its connection is gone. If the lease
    # outlived it, this acquire fails and the session is permanently undriveable.
    $second = Invoke-Probe -Executable $executable -Label 'second' -Ops @(
        @{ op = 'attach'; session = $session },
        # `$through` is THIS attach's cut, not the controller probe's. The
        # controller attached before the prompts existed, so its cut bounds
        # hydration below them -- which returns a short, correct history that
        # looks identical to the prompt records never being written.
        @{ op = 'hydrate'; session = $session; after = 0; through = '$through' },
        @{ op = 'acquire-control'; session = $session },
        @{ op = 'list' }
    )

    # The bound actually used is THIS probe's cut, not $through from the
    # controller probe. Reported from the response rather than from the older
    # variable: a detail line naming the wrong number is how a passing proof
    # still misleads whoever reads it next.
    $secondAttach = Get-OpResponse -Frames $second.Frames -Index 1
    $secondCut = $secondAttach.payload.through
    $hydrate = Get-OpResponse -Frames $second.Frames -Index 2
    $records = @($hydrate.payload.records)
    $hydrateOk = $hydrate.outcome -eq 'applied' -and $records.Count -gt 0
    Add-Criterion -Name 'journal_replays_through_the_cut' -Ok $hydrateOk `
        -Detail ($hydrateOk ? "hydrate returned $($records.Count) record(s) through $secondCut (the reattaching client's own cut; the first client's was $through)" : "hydrate returned nothing: $($hydrate.error)")

    # The prompt records are the slice-2 claim: Falcon wrote them, not the sidecar.
    # `Body` is tagged `record` (journal.rs), NOT `t` like a ServerFrame -- two
    # different discriminators in one protocol, and reading the wrong one here
    # would report an empty kind list as a clean failure.
    $kinds = @($records | ForEach-Object { $_.body.record })
    $promptRecorded = ($kinds -contains 'prompt-queued')
    $retractRecorded = ($kinds -contains 'prompt-retracted')
    Add-Criterion -Name 'prompt_lifecycle_is_journalled' -Ok ($promptRecorded -and $retractRecorded) `
        -Detail "record kinds: $(($kinds | Select-Object -Unique) -join ', ')"

    $reacquire = Get-OpResponse -Frames $second.Frames -Index 3
    $reacquireOk = $reacquire.outcome -eq 'applied' -and $reacquire.payload.revision -gt $acquire.payload.revision
    Add-Criterion -Name 'lease_died_with_its_connection' -Ok $reacquireOk `
        -Detail ($reacquireOk ? "a new connection acquired it at revision $($reacquire.payload.revision), above the old $($acquire.payload.revision)" : "a new connection could not take the lease: $($reacquire.error)")

    $list = Get-OpResponse -Frames $second.Frames -Index 4
    $listed = @($list.payload.sessions | Where-Object { $_.session -eq $session })
    $survived = $listed.Count -eq 1 -and -not $listed[0].exited
    Add-Criterion -Name 'session_survived_both_clients' -Ok $survived `
        -Detail ($survived ? "session $session still hosted after every client that touched it exited" : 'the session did not survive its clients')

    $notDegraded = $listed.Count -eq 1 -and -not $listed[0].degraded
    Add-Criterion -Name 'session_not_degraded' -Ok $notDegraded `
        -Detail ($notDegraded ? 'every journal append in this run succeeded' : "session is degraded: $($listed[0].degraded)")

    # ---- 4. the existing checks -------------------------------------------
    $checks = [ordered]@{}
    & cargo test --offline --manifest-path (Join-Path $repoRoot 'src-falcon\Cargo.toml')
    $checks['cargo test src-falcon'] = ($LASTEXITCODE -eq 0)
    & git -C $repoRoot diff --check
    $checks['git diff --check'] = ($LASTEXITCODE -eq 0)
    foreach ($check in $checks.GetEnumerator()) {
        Add-Criterion -Name $check.Key -Ok ([bool]$check.Value) -Detail ($check.Value ? 'passed' : 'failed')
    }

    $failures = @($criteria.GetEnumerator() | Where-Object { -not $_.Value.ok } | ForEach-Object { $_.Key })

    [pscustomobject]@{
        ok                = ($failures.Count -eq 0)
        failures          = $failures
        bundle_id         = $buildResult.bundle_id
        host_pid          = $hostProcess.Id
        session           = $session
        model             = $Model
        lease_revisions   = [ordered]@{ first = $acquire.payload.revision; after_reconnect = $reacquire.payload.revision }
        attach_cut        = [ordered]@{ first_client = $through; reattaching_client = $secondCut }
        journal_records   = $records.Count
        agent_events      = $agentEvents.Count
        criteria          = $criteria
        checks            = $checks
    } | ConvertTo-Json -Depth 8 -Compress

    if ($failures.Count -gt 0) { throw "slice-2 proof failed on: $($failures -join ', ')" }
}
finally {
    if ($hostProcess -and -not $hostProcess.HasExited) {
        try { Stop-Process -Id $hostProcess.Id -Force } catch {}
    }
    if (-not $KeepBundle) {
        try { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }
    if (-not $hostProcess -or $hostProcess.WaitForExit(5000)) { Remove-FalconSmokeRoot $smokeRoot.Root -Quiet }
}
