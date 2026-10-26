#Requires -Version 7.5
# Sandbox launch of a Vidar zip: extract it, give it a fake user profile (no ~\.claude, no AppData of
# the real user) and a fresh-logon environment (tools\release\clean-env.ps1), then start vidar.exe.
# Who runs it: the user, in a normal terminal outside any agent session (stop S5), or the main thread
# (clean-env start). Subagents run -DryRun only.
#
# Usage: pwsh -File tools/sandbox/launch.ps1 -Zip <zip> [-Base <dir>] [-LiveRoot <dir>] [-Port <n>] [-Seed <set>] [-DryRun]
#        pwsh -File tools/sandbox/launch.ps1 -From <folder> [-Base <dir>] [-Port <n>] [-SeedBundle <dir>] [-ArgumentList <string>] [-DryRun]
#   -From      a staged install folder (vidar.exe inside) instead of a zip: no zip check, every other refusal
#              stays. The folder is copied, never moved or changed; one holding a runtime\ folder is refused.
#   -SeedBundle  a Falcon bundle folder copied (never linked; a link inside it is refused) to
#              <app>\runtime\bridge\falcon\bundles\<its name>, with current.json pointing at the copy.
#   -ArgumentList  command-line text appended to the vidar.exe start (e.g. --no-activate).
#        pwsh -File tools/sandbox/launch.ps1 -SeedOnly -Seed <set> -Base <sandbox> [-DryRun]
#   -Zip       release zip (local-zip.ps1 output). Checked by check-zip.ps1 first; a failing zip is refused.
#   -Base      sandbox folder. Omitted: a new %TEMP%\vidar-sandbox-<stamp>. Given and already a sandbox
#              (holds .vidar-sandbox): app files are replaced, runtime\ and profile\ (so the agent homes, at
#              profile\AppData\Local\Vidar\homes\<install-root-key>, and their logins) stay in place and are never copied (stop S7: close that sandbox Vidar first; the
#              launcher refuses while a process runs from it). Refused when it resolves inside, or holds,
#              this repo, its main checkout or -LiveRoot, or lies in the real profile outside %TEMP%.
#   -LiveRoot  the live install root to protect; default the main checkout (parent of git's common dir).
#   -Port      WebView2 DevTools port of the sandbox window, opt-in (any local process can drive the UI
#              through it); 0, the default, opens none. The live app keeps its own.
#   -Seed      plant a canary set before vidar.exe starts. `trial` (bare-mode P2, P3): the sites come from
#              tools/bare/canaries.json (the one list; sweep.mjs reads it too): one unique token per site,
#              CANARY-<SITE>-<8 hex>, each in an instruction-style line, in the fake profile (.claude\CLAUDE.md,
#              rules, skill canary-user, .claude.json MCP server canary-user, .agents skill canary-agents,
#              .codex AGENTS.md) and a git fixture repo <base>\profile\trial-repo (CLAUDE.md, rules, skill
#              canary-repo, .mcp.json server canary-repo,
#              agents-only\AGENTS.md with no CLAUDE.md beside it, agents-only\.agents\skills skill
#              canary-repo-agents for the Codex cells, sub\CLAUDE.md for the lazy load plus
#              sub\notes.txt that a cell reads to trigger it). The map goes to <base>\profile\canaries.json
#              (site -> token, path) for the trial checklist and the sweep. An existing .claude.json gets
#              only its canary server merged in (a home login survives; the pre-P3 `canary` entry is
#              removed). With -DryRun: prints the plan, plants nothing. An unknown set is refused (exit 2)
#              before anything is read or written.
#              `runes-e2e` runs node tools/sandbox/runes-seed.mjs --to <base> (the runes fixture, tests/fixtures/
#              runes-e2e) after the app wipe and copy and before the start; -DryRun passes --dry-run. A seeder
#              exit 1 (failed) or 2 (refused) stops the launch with that code. A later start without -Seed removes
#              what that seed left (app\runtime\runes and the manifest's files).
#              `explorer` runs node tools/sandbox/explorer-seed.mjs --to <base> --deny-root <real profile>: cheap model
#              and low effort defaults, the Claude deny list, prefer_mxc in both Codex homes, the git fixture project
#              (tests/fixtures/explorer); a later start without -Seed explorer runs its --revert.
#              `sample-project` / `sample-project-instructions` run node tools/sandbox/sample-seed.mjs --to <base> --set
#              <set>: the toy slugkit project (tests/fixtures/sample-project) as a git repo at <base>\work\<set>, set as
#              vidar.json defaultCwd and a saved workspace, so the first tab opens in it. The first has no CLAUDE.md,
#              AGENTS.md or .claude/; the second adds them plus one skill. A later start without a sample set removes
#              the folder (its --revert).
#   -SeedOnly  plant -Seed into an existing sandbox's profile (-Base, holding .vidar-sandbox) and stop: no
#              zip, no extraction, no vidar.exe, no run record. Tokens are re-minted; the sweep reads the map.
#   -DryRun    everything except starting vidar.exe: extract, build the child env, run the refusals.
#   -Env       extra child variables applied last (test hook; a bad redirect here must be refused).
# Layout: <base>\app (install root, vidar.exe), <base>\profile (fake USERPROFILE), <base>\.vidar-sandbox.
# Redirects USERPROFILE, HOME, HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA, TEMP and TMP into the fake
# profile. CLAUDE_CONFIG_DIR and CODEX_HOME stay unset (they follow the fake profile) unless the
# fresh-logon env carries them, then they point inside it. Before starting, every one is resolved and
# the launch refused (exit 2, naming the variable) if it lands in the real profile ($env:USERPROFILE
# at script start) outside the sandbox: the plan's "unsatisfied redirect" stop.
# Prints the sandbox root, install root, exe path, root PID and each redirected variable.
# Not a security sandbox: the child runs as the same Windows user. write-audit.ps1 is the gate.
# Run record: a real start appends one JSON line (kind, rootPid, sandboxRoot, realProfile, startedUtc) to
# %TEMP%\vidar-sandbox-runs.jsonl for traced-run.ps1; -DryRun writes none.
param(
  [string]$Zip,
  [string]$From,
  [string]$SeedBundle,
  [string]$ArgumentList = "",
  [string]$Base,
  [string]$LiveRoot,
  [int]$Port = 0,
  [string]$Seed,
  [switch]$SeedOnly,
  [switch]$DryRun,
  [hashtable]$Env = @{}
)
$ErrorActionPreference = "Stop"
$realProfile = $env:USERPROFILE
$marker = ".vidar-sandbox"

function Get-Norm([string]$p) {
  $full = [IO.Path]::GetFullPath($p)
  # Follow a junction or symlink at the leaf, so a link into the repo cannot pass as a sandbox.
  if (Test-Path -LiteralPath $full) {
    $item = Get-Item -LiteralPath $full -Force
    if ($item.LinkType) { $t = $item.ResolveLinkTarget($true); if ($t) { $full = $t.FullName } }
  }
  $full.TrimEnd('\', '/')
}
function Test-Under([string]$p, [string]$root) {
  $a = Get-Norm $p; $r = Get-Norm $root
  ($a -ieq $r) -or $a.StartsWith($r + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Stop-Refused([string]$msg) { [Console]::Error.WriteLine("REFUSED: $msg"); exit 2 }

# ---- -Seed trial: canary plan and planting (sites: tools/bare/canaries.json) ----
# One token per site; each file holds one instruction-style line naming it. A Bare tab must neither
# quote nor obey any of them; a default Claude tab in the same sandbox does (positive control).
$canarySpecPath = Join-Path $PSScriptRoot "..\bare\canaries.json"
$canarySpec = if (Test-Path -LiteralPath $canarySpecPath) { Get-Content -LiteralPath $canarySpecPath -Raw | ConvertFrom-Json }
$runesSeedSet = "runes-e2e"   # not a canary set: tools/sandbox/runes-seed.mjs plants tests/fixtures/runes-e2e/seed.json
$explorerSeedSet = "explorer" # tools/sandbox/explorer-seed.mjs: cheap model defaults, Claude deny list, prefer_mxc, fixture project
$sampleSeedSets = @("sample-project", "sample-project-instructions")   # tools/sandbox/sample-seed.mjs: toy project as the first tab's cwd
$seedSets = @(if ($canarySpec) { $canarySpec.set }) + $runesSeedSet + $explorerSeedSet + $sampleSeedSets
if ($PSBoundParameters.ContainsKey("Seed") -and $Seed -notin $seedSets) {
  Stop-Refused "unknown -Seed set '$Seed' (known: $($seedSets -join ', '); from $canarySpecPath)."
}
function New-CanaryToken([string]$site) {
  "CANARY-$site-" + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(4))
}
function Get-CanaryLine([string]$token) { $canarySpec.instruction.Replace("{token}", $token) }
# A stdio MCP server that answers initialize with the canary as its instructions and lists no tools,
# so a session that loads the config sees the token. The entry holds only standard keys (type,
# command, args): an unknown key could fail the schema and read as a negative positive control.
function Get-CanaryServer([string]$name, [string]$token) {
  # Single-quoted JS literals only: a double quote in a Windows command-line argument is an escaping risk.
  $lit = { param($s) "'" + ($s -replace '\\', '\\' -replace "'", "\'") + "'" }
  $info = "{name:$(& $lit $name),version:'1'}"
  $text = & $lit (Get-CanaryLine $token)
  $js = "let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\n'))>=0){" +
    "const l=b.slice(0,i);b=b.slice(i+1);let m;try{m=JSON.parse(l)}catch{continue}if(m.id===undefined)continue;" +
    "let r={};if(m.method==='initialize')r={protocolVersion:(m.params&&m.params.protocolVersion)||'2025-06-18'," +
    "capabilities:{tools:{}},serverInfo:$info,instructions:$text};" +
    "else if(m.method==='tools/list')r={tools:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\n')}})"
  [ordered]@{ type = "stdio"; command = "node"; args = @("-e", $js) }
}
function Get-SeedPlan([string]$set, [string]$prof) {
  $repo = Join-Path $prof "trial-repo"
  $skill = { param($n, $t) "---`nname: $n`ndescription: $(Get-CanaryLine $t)`n---`n`n$(Get-CanaryLine $t)`n" }
  $rows = foreach ($s in $canarySpec.sites) {
    @{ site = $s.id; scope = $s.scope; path = (Join-Path $prof ($s.path -replace '/', '\')); kind = $s.kind
       name = $s.name; token = (New-CanaryToken $s.id); skill = $skill }
  }
  $files = foreach ($f in @($canarySpec.fixtures)) { @{ path = (Join-Path $prof ($f.path -replace '/', '\')); text = $f.text } }
  [pscustomobject]@{ set = $set; repo = $repo; rows = @($rows); files = @($files); map = (Join-Path $prof "canaries.json") }
}
function Write-Utf8([string]$path, [string]$text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))
}
function Invoke-SeedPlan($plan, [string]$prof) {
  New-Item -ItemType Directory -Force -Path $plan.repo | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $plan.repo ".git"))) {
    git init -q $plan.repo
    if ($LASTEXITCODE -ne 0) { Stop-Refused "git init failed for $($plan.repo) (exit $LASTEXITCODE)." }
  }
  foreach ($r in $plan.rows) {
    switch ($r.kind) {
      "line" { Write-Utf8 $r.path ((Get-CanaryLine $r.token) + "`n") }
      "skill" { Write-Utf8 $r.path (& $r.skill $r.name $r.token) }
      "mcp" { Write-Utf8 $r.path ((ConvertTo-Json -Depth 10 -InputObject ([ordered]@{ mcpServers = [ordered]@{ $r.name = (Get-CanaryServer $r.name $r.token) } })) + "`n") }
      "mcp-merge" {
        # Claude's own state file: keep everything in it (login, onboarding), set only this site's server
        # (and drop the pre-P3 `canary` entry, which the repo server of the same name shadowed).
        # -DateKind String keeps ISO timestamps as the strings they were (no DateTime round-trip).
        $state = [ordered]@{}
        if (Test-Path -LiteralPath $r.path) {
          $state = Get-Content -LiteralPath $r.path -Raw | ConvertFrom-Json -AsHashtable -DateKind String
          if ($null -eq $state) { $state = [ordered]@{} }
        }
        if (-not $state.Contains("mcpServers") -or $state["mcpServers"] -isnot [Collections.IDictionary]) { $state["mcpServers"] = [ordered]@{} }
        $state["mcpServers"].Remove("canary")
        $state["mcpServers"][$r.name] = Get-CanaryServer $r.name $r.token
        Write-Utf8 $r.path ((ConvertTo-Json -Depth 100 -InputObject $state) + "`n")
      }
    }
  }
  foreach ($f in $plan.files) { Write-Utf8 $f.path $f.text }
  $sites = [ordered]@{}
  foreach ($r in $plan.rows) { $sites[$r.site] = [ordered]@{ token = $r.token; path = $r.path; scope = $r.scope } }
  $userMd = ($plan.rows | Where-Object site -eq "USERMD").path
  $map = [ordered]@{
    set = $plan.set; seededUtc = (Get-Date).ToUniversalTime().ToString("o"); repo = $plan.repo; sites = $sites
    # NOTES 19:2x: Claude's parent-folder walk reads <ancestor>\.claude\CLAUDE.md whatever CLAUDE_CONFIG_DIR
    # says, so a tab opened in trial-repo also reaches the USERMD file as an ancestor (project) load.
    ancestor = [ordered]@{ site = "USERMD"; path = $userMd; seenFrom = $plan.repo
      note = "A tab whose cwd is trial-repo (or anything under the fake profile) sees this file through the parent-folder walk: negative in Bare, positive in a default tab." }
  }
  Write-Utf8 $plan.map ((ConvertTo-Json -Depth 10 -InputObject $map) + "`n")
}
function Invoke-Seed([string]$prof) {
  if ($Seed -eq $runesSeedSet) {
    # The seeder owns its guards and manifest; its exit code is ours (2 refused, 1 failed).
    $seeder = Join-Path $PSScriptRoot "runes-seed.mjs"
    $sbase = Split-Path -Parent $prof
    $seedArgs = @($seeder, "--to", $sbase) + @(if ($DryRun) { "--dry-run" })
    "seed ${Seed}: node $seeder --to $sbase$(if ($DryRun) { ' --dry-run (nothing written)' })"
    $out = & node @seedArgs 2>&1
    $code = $LASTEXITCODE
    foreach ($l in $out) { "  $l" }
    if ($code -ne 0) { [Console]::Error.WriteLine("runes-seed.mjs exited $code; launch stopped."); exit $code }
    return
  }
  if ($Seed -eq $explorerSeedSet) {
    $seeder = Join-Path $PSScriptRoot "explorer-seed.mjs"
    $sbase = Split-Path -Parent $prof
    $seedArgs = @($seeder, "--to", $sbase, "--deny-root", $realProfile) + @(if ($DryRun) { "--dry-run" })
    "seed ${Seed}: node $seeder --to $sbase$(if ($DryRun) { ' --dry-run (nothing written)' })"
    $out = & node @seedArgs 2>&1
    $code = $LASTEXITCODE
    foreach ($l in $out) { "  $l" }
    if ($code -ne 0) { [Console]::Error.WriteLine("explorer-seed.mjs exited $code; launch stopped."); exit $code }
    return
  }
  if ($Seed -in $sampleSeedSets) {
    $seeder = Join-Path $PSScriptRoot "sample-seed.mjs"
    $sbase = Split-Path -Parent $prof
    $seedArgs = @($seeder, "--to", $sbase, "--set", $Seed) + @(if ($DryRun) { "--dry-run" })
    "seed ${Seed}: node $seeder --to $sbase --set $Seed$(if ($DryRun) { ' --dry-run (nothing written)' })"
    $out = & node @seedArgs 2>&1
    $code = $LASTEXITCODE
    foreach ($l in $out) { "  $l" }
    if ($code -ne 0) { [Console]::Error.WriteLine("sample-seed.mjs exited $code; launch stopped."); exit $code }
    return
  }
  $plan = Get-SeedPlan $Seed $prof
  $verb = if ($DryRun) { "would plant" } else { "planted" }
  "seed ${Seed}: $verb $($plan.rows.Count) canaries$(if ($DryRun) { ' (tokens re-minted on a real run)' })"
  if ($DryRun) { "  git init $($plan.repo)" }
  else { Invoke-SeedPlan $plan $prof }
  foreach ($r in $plan.rows) { "  {0,-10} {1}  {2}$(if ($r.name) { "  ($($r.kind -replace '-merge') $($r.name))" })" -f $r.site, $r.token, $r.path }
  foreach ($f in $plan.files) { "  fixture    $($f.path)" }
  "  ancestor: USERMD is also the parent-folder walk's file for a tab opened in $($plan.repo)"
  "  map: $($plan.map)$(if ($DryRun) { ' (not written)' })"
}

if ($SeedOnly) {
  if (-not $Seed -or -not $Base) { Stop-Refused "-SeedOnly needs -Seed <set> and -Base <existing sandbox>." }
  $Base = Get-Norm $Base
  if (-not (Test-Path -LiteralPath (Join-Path $Base $marker))) { Stop-Refused "-Base $Base holds no $marker; -SeedOnly plants only into a sandbox this launcher made." }
  Invoke-Seed (Join-Path $Base "profile")
  exit 0
}
if ($From -and $Zip) { Stop-Refused "-Zip and -From are exclusive." }
if (-not $Zip -and -not $From) { Stop-Refused "-Zip <zip> or -From <folder> is required (or -SeedOnly)." }
. (Join-Path $PSScriptRoot "..\lib\Paths.ps1")
if ($From) {
  if (-not (Test-Path -LiteralPath $From -PathType Container)) { Stop-Refused "no folder at $From" }
  $From = (Resolve-Path -LiteralPath $From).Path
  if (-not (Test-Path -LiteralPath (Join-Path $From "vidar.exe") -PathType Leaf)) { Stop-Refused "no vidar.exe in $From" }
  if (Test-Path -LiteralPath (Join-Path $From (Get-VidarRel -Id runtime))) { Stop-Refused "$From holds a runtime\ folder; a staged build never carries one." }
} else {
  if (-not (Test-Path -LiteralPath $Zip -PathType Leaf)) { Stop-Refused "no zip at $Zip" }
  $Zip = (Resolve-Path -LiteralPath $Zip).Path
}
if ($SeedBundle -and -not (Test-Path -LiteralPath $SeedBundle -PathType Container)) { Stop-Refused "no bundle folder at $SeedBundle" }

# Protected roots: this repo (worktree or checkout), the main checkout, the live install.
$protected = [ordered]@{}
$top = git -C $PSScriptRoot rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -eq 0 -and $top) {
  $protected["repo"] = Get-Norm $top
  $common = git -C $PSScriptRoot rev-parse --path-format=absolute --git-common-dir 2>$null
  if ($LASTEXITCODE -eq 0 -and $common) { $protected["main checkout"] = Get-Norm (Split-Path -Parent (Get-Norm $common)) }
}
if (-not $LiveRoot -and $protected.Contains("main checkout")) { $LiveRoot = $protected["main checkout"] }
if ($LiveRoot) { $protected["live root"] = Get-Norm $LiveRoot }
else { "WARNING: no git checkout around $PSScriptRoot and no -LiveRoot; only the real-profile refusal guards -Base." }

# Sandbox base.
$reuse = $false
$Base = if ($Base) { Get-Norm $Base } else { Get-Norm (Join-Path $env:TEMP ("vidar-sandbox-" + (Get-Date -Format "yyyyMMdd-HHmmss"))) }
foreach ($k in $protected.Keys) {
  $r = $protected[$k]
  if (Test-Under $Base $r) { Stop-Refused "-Base $Base resolves inside the $k ($r)." }
  if (Test-Under $r $Base) { Stop-Refused "-Base $Base holds the $k ($r)." }
}
if (Test-Under $realProfile $Base) { Stop-Refused "-Base $Base holds the real profile ($realProfile)." }
if ((Test-Under $Base $realProfile) -and -not (Test-Under $Base $env:TEMP)) {
  Stop-Refused "-Base $Base lies in the real profile outside %TEMP% ($env:TEMP)."
}
if (Test-Path -LiteralPath $Base -PathType Container) {
  $reuse = Test-Path -LiteralPath (Join-Path $Base $marker)
  if (-not $reuse -and @(Get-ChildItem -LiteralPath $Base -Force).Count) {
    Stop-Refused "-Base $Base is not empty and holds no $marker; only a folder this launcher made is reused."
  }
}

# The zip passes check-zip.ps1 or nothing is extracted.
if (-not $From) {
  & (Join-Path $PSScriptRoot "check-zip.ps1") -Zip $Zip
  if ($LASTEXITCODE -ne 0) { Stop-Refused "check-zip.ps1 failed for $Zip (exit $LASTEXITCODE)." }
}

$app = Join-Path $Base "app"
$prof = Join-Path $Base "profile"
if ($reuse) {
  # S7: never replace files under a running sandbox Vidar.
  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (Test-Under $_.Path $app) })
  if ($running.Count) {
    Stop-Refused ("sandbox still running from $app" + ': ' + (($running | ForEach-Object { "$($_.Name) $($_.Id)" }) -join ', ') + '. Close that Vidar first.')
  }
}
$exe = Join-Path $app "vidar.exe"

# Child env and the redirect refusal come before any file is written.
. (Join-Path $PSScriptRoot "..\release\clean-env.ps1")
$clean = Get-CleanEnvironment
$extra = [ordered]@{
  USERPROFILE = $prof; HOME = $prof; HOMEDRIVE = $prof.Substring(0, 2); HOMEPATH = $prof.Substring(2)
  APPDATA = (Join-Path $prof "AppData\Roaming"); LOCALAPPDATA = (Join-Path $prof "AppData\Local")
  TEMP = (Join-Path $prof "AppData\Local\Temp"); TMP = (Join-Path $prof "AppData\Local\Temp")
}
if ($Port -gt 0) { $extra["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=$Port" }
# Unset follows the fake profile; a fresh-logon value would point outside it, so override inside.
if ($clean.Contains("CLAUDE_CONFIG_DIR")) { $extra["CLAUDE_CONFIG_DIR"] = Join-Path $prof ".claude" }
if ($clean.Contains("CODEX_HOME")) { $extra["CODEX_HOME"] = Join-Path $prof ".codex" }
foreach ($k in $Env.Keys) { $extra[[string]$k] = [string]$Env[$k] }

# Effective child value per variable: -Extra wins over the fresh-logon env (Start-CleanProcess order).
function Get-ChildValue([string]$name) {
  foreach ($k in $extra.Keys) { if ($k -ieq $name) { return $extra[$k] } }
  foreach ($k in $clean.Keys) { if ($k -ieq $name) { return $clean[$k] } }
  $null
}
$childProfile = Get-ChildValue "USERPROFILE"
$checks = [ordered]@{}
foreach ($n in @("USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP")) { $checks[$n] = Get-ChildValue $n }
$homeDirPath = "$(Get-ChildValue 'HOMEDRIVE')$(Get-ChildValue 'HOMEPATH')"
$checks["HOMEDRIVE"] = $homeDirPath
$checks["HOMEPATH"] = $homeDirPath
foreach ($pair in @(@("CLAUDE_CONFIG_DIR", ".claude"), @("CODEX_HOME", ".codex"))) {
  $v = Get-ChildValue $pair[0]
  $checks[$pair[0]] = if ($v) { $v } elseif ($childProfile) { Join-Path $childProfile $pair[1] } else { $null }
}

"sandbox root: $Base$(if ($reuse) { ' (reused; runtime\ kept)' })"
"install root: $app"
"exe: $exe"
foreach ($n in $checks.Keys) {
  $set = Get-ChildValue $n
  $shown = switch ($n) {
    "HOMEDRIVE" { "$set (HOMEDRIVE+HOMEPATH = $($checks[$n]))" }
    "HOMEPATH" { "$set" }
    default { if ($set) { $set } else { "(unset; follows USERPROFILE: $($checks[$n]))" } }
  }
  "$n = $shown"
}

$bad = @()
foreach ($n in $checks.Keys) {
  $v = $checks[$n]
  if (-not $v) { $bad += "$n (unresolved)"; continue }
  if (-not [IO.Path]::IsPathRooted($v)) { $bad += "$n ($v is not an absolute path)"; continue }
  if ((Test-Under $v $realProfile) -and -not (Test-Under $v $Base)) { $bad += "$n ($v is in the real profile $realProfile)" }
}
if ($bad.Count) { Stop-Refused ("unsatisfied redirect: " + ($bad -join '; ')) }

New-Item -ItemType Directory -Force -Path $Base | Out-Null
Set-Content -LiteralPath (Join-Path $Base $marker) -Value "Vidar sandbox made by tools/sandbox/launch.ps1" -Encoding utf8NoBOM
$incoming = Join-Path $Base ("incoming-" + (Get-Date -Format "yyyyMMddHHmmss"))
if ($From) {
  $srcDir = $From
} else {
  Expand-Archive -LiteralPath $Zip -DestinationPath $incoming
  $srcExe = Get-ChildItem -LiteralPath $incoming -Recurse -Filter vidar.exe -File | Select-Object -First 1
  if (-not $srcExe) { Remove-Item -LiteralPath $incoming -Recurse -Force; Stop-Refused "no vidar.exe in $Zip" }
  $srcDir = $srcExe.DirectoryName
}
New-Item -ItemType Directory -Force -Path $app | Out-Null
$keep = Get-VidarRel -Id runtime   # runtime\homes and the rest of runtime\ survive a rebuild; never copied.
if ($reuse) {
  Get-ChildItem -LiteralPath $app -Force | Where-Object { $_.Name -ne $keep } | Remove-Item -Recurse -Force
  # runes-seed.mjs wrote vidar.json, contracts\module-bundles.json and runes-e2e\ (all gone with the wipe above,
  # then restored by the copy below) and app\runtime\runes\ (kept by the wipe, so removed here). A manifest from an
  # earlier seeded run means an unseeded Start also drops what that run wrote under the base, then the manifest.
  $seedManifest = Join-Path $Base ".runes-seed-manifest.json"
  if ($Seed -ne $runesSeedSet -and (Test-Path -LiteralPath $seedManifest -PathType Leaf)) {
    $imports = Resolve-VidarPath -Id runeImports -Root $app
    if (Test-Path -LiteralPath $imports) { Remove-Item -LiteralPath $imports -Recurse -Force }
    $m = Get-Content -LiteralPath $seedManifest -Raw | ConvertFrom-Json
    foreach ($p in @($m.files) + @($m.dirs)) {
      if ($p -is [string] -and (Test-Under $p $Base) -and -not (Test-Under $Base $p) -and (Test-Path -LiteralPath $p)) { Remove-Item -LiteralPath $p -Recurse -Force }
    }
    Remove-Item -LiteralPath $seedManifest -Force
    "unseeded start: removed the files an earlier runes-e2e seed left under $Base"
  }
  # The explorer seed edits settings/config files in place, so its manifest keeps their old text: revert restores it.
  if ($Seed -ne $explorerSeedSet -and (Test-Path -LiteralPath (Join-Path $Base ".explorer-seed-manifest.json") -PathType Leaf)) {
    $out = & node (Join-Path $PSScriptRoot "explorer-seed.mjs") --to $Base --revert 2>&1
    if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("explorer-seed.mjs --revert exited ${LASTEXITCODE}: $out"); exit $LASTEXITCODE }
    "unseeded start: reverted the explorer seed under $Base"
  }
  # The sample seed plants one folder under work\; a start with no sample set removes it (the seeder re-plants on its own).
  if ($Seed -notin $sampleSeedSets -and (Test-Path -LiteralPath (Join-Path $Base ".sample-seed-manifest.json") -PathType Leaf)) {
    $out = & node (Join-Path $PSScriptRoot "sample-seed.mjs") --to $Base --revert 2>&1
    if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("sample-seed.mjs --revert exited ${LASTEXITCODE}: $out"); exit $LASTEXITCODE }
    "unseeded start: removed the sample project under $Base"
  }
}
if ($From) {
  # Copy, never move: the staged folder stays as it was.
  Get-ChildItem -LiteralPath $srcDir -Force | Where-Object { $_.Name -ne $keep } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $app $_.Name) -Recurse -Force }
} else {
  Get-ChildItem -LiteralPath $srcDir -Force | Where-Object { $_.Name -ne $keep } |
    ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination (Join-Path $app $_.Name) }
  Remove-Item -LiteralPath $incoming -Recurse -Force
}
# The shell resolves User Shell Folders (%USERPROFILE%\Desktop, ...) through the redirected profile: a
# missing one makes the folder picker raise "Location is not available" (S5 rerun, 2026-10-13).
foreach ($d in @("AppData\Roaming", "AppData\Local\Temp", "Desktop", "Documents", "Downloads", "Music",
    "Pictures", "Videos", "Favorites", "Links")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $prof $d) | Out-Null
}
"extracted: $(if ($From) { $From } else { $Zip }) -> $app"

if ($SeedBundle) {
  # Copy a Falcon bundle in and point current.json at the copy. A link inside the source is refused:
  # a copy that followed it would reach outside the bundle.
  $linked = @(Get-ChildItem -LiteralPath $SeedBundle -Recurse -Force | Where-Object { $_.LinkType })
  if (-not (Get-Item -LiteralPath $SeedBundle -Force).LinkType -and -not $linked.Count) {
    $bundleId = Split-Path -Leaf (Get-Norm $SeedBundle)
    $bundlesDir = Join-Path $app (Get-VidarRel -Id falconBundles)
    $dest = Join-Path $bundlesDir $bundleId
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $bundlesDir | Out-Null
    Copy-Item -LiteralPath $SeedBundle -Destination $dest -Recurse
    $falconExe = Get-ChildItem -LiteralPath $dest -Recurse -File -Filter falcon.exe | Select-Object -First 1
    if (-not $falconExe) { Stop-Refused "no falcon.exe in bundle $SeedBundle" }
    $pointer = Join-Path $app (Get-VidarRel -Id falconPointer)
    Write-Utf8 $pointer ((ConvertTo-Json -Compress -InputObject ([ordered]@{ bundle_id = $bundleId; executable = $falconExe.FullName })) + "`n")
    "seeded bundle: $bundleId"
  } else {
    Stop-Refused "bundle $SeedBundle is or holds a link; it is not copied."
  }
}

if ($Seed) { Invoke-Seed $prof }

if ($DryRun) { "DryRun: redirects satisfied; vidar.exe not started."; exit 0 }
$p = Start-CleanProcess -FilePath $exe -WorkingDirectory $app -ArgumentList $ArgumentList -Extra ([hashtable]$extra)
"root pid: $($p.Id)"
# Run record for traced-run.ps1. $env:TEMP is the real one: this script runs in the user's normal terminal and
# the redirects above reach only the child. Append only; -DryRun exits before here and writes none.
try {
  $record = [ordered]@{ kind = "launch"; rootPid = $p.Id; sandboxRoot = $Base; realProfile = $realProfile
    startedUtc = (Get-Date).ToUniversalTime().ToString("o") }
  [IO.File]::AppendAllText((Join-Path $env:TEMP "vidar-sandbox-runs.jsonl"),
    (ConvertTo-Json -InputObject $record -Compress) + "`n", [Text.UTF8Encoding]::new($false))
} catch { "WARNING: run record not written: $($_.Exception.Message)" }
