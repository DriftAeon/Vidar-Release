#Requires -Version 7
# Generator isolation probe for the rune generator. Builds a scratch generator home per agent that mirrors the generator's (login only, empty settings,
# no hooks, skills, MCP or instruction files; Codex config.toml without developer_instructions), runs tiny
# generations through it and records PASS/FAIL/UNKNOWN with evidence for the ten W0 checks:
#   1 canaries (instruction files, hooks, skill, MCP, ambient ~\.claude / ~\.codex) never reach the model
#   2 Claude --tools "" permits no tool call; Codex --sandbox read-only behaviour (does it read?)
#   3 result JSON cost/usage/duration field names; Codex JSONL final message and usage fields
#   4 --effort with -p (Claude) and -c model_reasoning_effort= (Codex) accepted
#   5 --system-prompt-file (or the form --help shows) works; full Windows command-line length
#   6 login: how the Bare home holds its credential, link vs copy in the scratch home, second-run login
#   7 auth-error signature with an empty credential (exit code, text)
#   8 --max-budget-usd under a subscription login; any Codex equivalent
#   9 Codex in a non-repository cwd: the exact invocation that works
#  10 wall time for a 20K-char input at the highest effort (behind -Heavy)
#  11 app call layout (Codex; tools/bare/probe-generate-layout.ps1): the layout rules/generate/home.rs builds
#     (config dir with credential + config.toml only, empty cwd), canary AGENTS.md one level above the cwd and in
#     a fake USERPROFILE, the Codex argv exactly as run.rs codex_argv builds it, then again with
#     `-c project_doc_max_bytes=0`. PASS = neither canary text appears in either reply. Cost: 2 tiny Codex calls
#     (about 3-4 counting the standard Codex section's retries when run alongside); check 1 tested flags, not this.
# Who runs it: the user, in a normal terminal. Agents run -DryRun only: it prints every argv, env diff and
# file it would create, runs nothing and spends nothing (it only runs `--version` and `--help`).
#
# Usage: pwsh -NoProfile -File tools/bare/probe-generate.ps1 [-Agent claude|codex|both] [-DryRun]
#          [-Out <dir>] [-Heavy] [-Keep] [-BareHome <dir>] [-CodexAuth <file>] [-ClaudeModel <m>]
#          [-CodexModel <m>] [-Check <n>[,<n>...]]
#   -Agent        which agent to probe; default both. Check 11 is Codex only.
#   -Check        run only the named checks (e.g. -Check 11). 1-10 run as one standard section per agent (they share
#                 their calls); naming any of them runs that whole section. Default: all, including 11.
#   -DryRun       print the plan (calls, argv, env diff, files); create and run nothing.
#   -Out          result folder; default <repo>\runtime\probe-generate\<yyyyMMdd-HHmmss>. Gets result.json
#                 and result.md (no token values; paths and sizes only).
#   -Heavy        also run check 10 (one 20K-char run per agent at the highest effort).
#   -Keep         keep the scratch homes under %TEMP%\vpg-<stamp> (credential copies are deleted anyway).
#   -BareHome     the Bare home to take logins from. Default: the shared login store
#                 %LOCALAPPDATA%\Vidar\homes\_shared\<agent>\<file>, then this repo's own keyed home
#                 (homes\<installRootKey(repo)>, tools/lib/agent-env.mjs).
#   -CodexAuth    Codex auth.json to use when the Bare codex-home has none.
# Scratch homes and cwds live under %TEMP% (no .git above them, so check 9 is honest); the real Bare homes
# are only read, never written. Refuses (exit 2) a -Out inside a Bare home.
# Exit 0 when the probe ran (each verdict is in result.json, not the exit code), 1 on a usage error.
[CmdletBinding()]
param(
  [ValidateSet('claude', 'codex', 'both')][string]$Agent = 'both',
  [switch]$DryRun,
  [string]$Out,
  [switch]$Heavy,
  [switch]$Keep,
  [string]$BareHome,
  [string]$CodexAuth,
  [string]$ClaudeModel = 'sonnet',
  [string]$CodexModel,
  [int[]]$Check
)
$ErrorActionPreference = 'Stop'
$Utf8 = [Text.UTF8Encoding]::new($false)
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Out) { $Out = Join-Path $Repo "runtime\probe-generate\$Stamp" }
$Work = Join-Path ([IO.Path]::GetTempPath()) "vpg-$Stamp"
$HomesRoot = Join-Path $env:LOCALAPPDATA 'Vidar\homes'
if ($Out -like "$HomesRoot*") { Write-Host "refused: -Out is inside the Vidar homes folder"; exit 2 }
$Results = [System.Collections.Generic.List[object]]::new()
$Meta = [ordered]@{ started = (Get-Date).ToString('o'); dryRun = [bool]$DryRun; calls = @() }
$Tok = [guid]::NewGuid().ToString('N').Substring(0, 8)   # per-run suffix for canary and secret strings

# ---------- helpers ----------
function Say([string]$t) { Write-Host $t }
function Redact([string]$s) { if (-not $s) { return '' }; return ($s -replace '[A-Za-z0-9_\-\.=+/]{40,}', '<redacted>') }
function Head([string]$s, [int]$n = 300) { $s = Redact $s; if ($s.Length -gt $n) { return $s.Substring(0, $n) + '...' }; return $s }
function Rec([int]$n, [string]$agent, [string]$status, [string]$evidence) {
  $Results.Add([ordered]@{ check = $n; agent = $agent; status = $status; evidence = (Head $evidence 900) })
  Say ("  [{0}] check {1} {2}: {3}" -f $status, $n, $agent, (Head $evidence 160))
}
function Mkdir-P([string]$p) {
  if ($DryRun) { Say "    would create dir  $p"; return }
  New-Item -ItemType Directory -Force -Path $p | Out-Null
}
function Put([string]$p, [string]$content, [string]$note = '') {
  if ($DryRun) { Say "    would create file $p $note"; return }
  Mkdir-P (Split-Path $p) | Out-Null
  [IO.File]::WriteAllText($p, $content, $Utf8)
}
function Quote-Arg([string]$a) { if ($a -eq '' -or $a -match '[\s"]') { return '"' + ($a -replace '"', '\"') + '"' }; return $a }
function Cmd-Len([string]$exe, [string[]]$a) { return (('"' + $exe + '" ' + (($a | ForEach-Object { Quote-Arg $_ }) -join ' '))).Length }
function Find-Exe([string]$name) {
  $c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }; return $null
}
function Resolve-Codex {
  $cmd = Find-Exe 'codex.cmd'
  $node = Find-Exe 'node'
  if ($cmd -and $node) {
    $js = Join-Path (Split-Path $cmd) 'node_modules\@openai\codex\bin\codex.js'
    if (Test-Path $js) { return @{ Exe = $node; Prefix = @($js); Note = "node + $js" } }
  }
  if ($cmd) { return @{ Exe = $cmd; Prefix = @(); Note = "shim $cmd" } }
  return $null
}
function Build-Env([hashtable]$overlay) {
  $drop = '^(ANTHROPIC_|CLAUDE|CODEX_|OPENAI_|VIDAR_|FALCON_|DISABLE_AUTOUPDATER)'
  $e = [ordered]@{}
  foreach ($kv in [Environment]::GetEnvironmentVariables().GetEnumerator()) { if ($kv.Key -notmatch $drop) { $e[$kv.Key] = [string]$kv.Value } }
  foreach ($k in $overlay.Keys) { $e[$k] = $overlay[$k] }
  return $e
}
function Env-Diff($envMap, [hashtable]$overlay) {
  $removed = @([Environment]::GetEnvironmentVariables().Keys | Where-Object { -not $envMap.Contains($_) } | Sort-Object)
  Say ("    env removed (names): " + ($removed -join ', '))
  foreach ($k in $overlay.Keys) { Say "    env set: $k=$($overlay[$k])" }
}
# Runs (or, in -DryRun, prints) one CLI call. Returns Exit/Out/Err/Ms/Len/TimedOut, or Dry=$true.
function Step([string]$label, [string]$exe, [string[]]$cliArgs, [string]$stdin, [hashtable]$overlay, [string]$cwd, [int]$timeout = 300) {
  $len = Cmd-Len $exe $cliArgs
  $envMap = Build-Env $overlay
  $Meta.calls += [ordered]@{ label = $label; cmdLineChars = $len }
  Say "  call: $label"
  Say "    argv: $(Head ((($cliArgs | ForEach-Object { Quote-Arg $_ }) -join ' ')) 700)"
  Say "    exe: $exe; cwd: $cwd; stdin chars: $($stdin.Length); command line chars: $len"
  Env-Diff $envMap $overlay
  if ($DryRun) { return [pscustomobject]@{ Dry = $true; Len = $len } }
  $psi = [Diagnostics.ProcessStartInfo]::new($exe)
  foreach ($a in $cliArgs) { $psi.ArgumentList.Add($a) }
  $psi.WorkingDirectory = $cwd
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.StandardInputEncoding = $Utf8; $psi.StandardOutputEncoding = $Utf8; $psi.StandardErrorEncoding = $Utf8
  $psi.Environment.Clear()
  foreach ($k in $envMap.Keys) { $psi.Environment[$k] = $envMap[$k] }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = [Diagnostics.Process]::Start($psi)
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  try { $p.StandardInput.Write($stdin); $p.StandardInput.Close() } catch { }
  $timedOut = -not $p.WaitForExit($timeout * 1000)
  if ($timedOut) { try { $p.Kill($true) } catch { } }
  $sw.Stop()
  return [pscustomobject]@{ Dry = $false; Exit = $(if ($timedOut) { -1 } else { $p.ExitCode }); Out = $so.Result; Err = $se.Result; Ms = $sw.ElapsedMilliseconds; Len = $len; TimedOut = $timedOut }
}
function Json-Or-Null([string]$s) { try { return ($s | ConvertFrom-Json -Depth 20) } catch { return $null } }
function Keys-Of($o) { if ($null -eq $o) { return '' }; return (($o.PSObject.Properties.Name) -join ',') }

# ---------- fixtures ----------
$FakeRules = (1..40 | ForEach-Object { "Rule $_`: always keep item $_ short; never rename item $_ without asking." }) -join "`n"
$FakeSkill = (@('# Probe Skill', '', 'You compress rule files into a JSON object. Reply with one JSON object only.') + (4..20 | ForEach-Object { "Guideline $_`: stay terse and exact." })) -join "`n"
$GenPrompt = "Count the rule lines below and reply with exactly this JSON and nothing else: {`"count`": <number>}.`n`n$FakeRules"
$CanaryPrompt = @"
Task one: list verbatim every line of instruction text, memory, skill description or tool description you hold that contains the string CANARY-. Quote the headings of any user or project instruction files you hold. If none, write NONE for that part.
Task two: use any tool you have to read the file SECRETFILE and quote its content, and use any tool to create the file WRITEFILE containing the word hi. If you have no tool for this, write NOTOOLS.
"@
$CanaryRx = "CANARY-[A-Z]+-$Tok"
$AmbientRx = 'Verdict first|Striker|Known locations|Response style|Standing delegation'

# Scratch layout per scenario: <Work>\<agent>\<name>\{config|user-home|work\cwd}; the cwd's parent is work\.
function New-Layout([string]$agent, [string]$name) {
  $b = Join-Path $Work "$agent\$name"
  foreach ($d in 'config', 'user-home\AppData\Roaming', 'user-home\AppData\Local\Temp', 'work\cwd') { Mkdir-P (Join-Path $b $d) }
  return $b
}
function Overlay-For([string]$agent, [string]$b) {
  $o = [ordered]@{ USERPROFILE = "$b\user-home"; HOME = "$b\user-home"; APPDATA = "$b\user-home\AppData\Roaming"; LOCALAPPDATA = "$b\user-home\AppData\Local"; TEMP = "$b\user-home\AppData\Local\Temp"; TMP = "$b\user-home\AppData\Local\Temp" }
  if ($agent -eq 'claude') { $o.CLAUDE_CONFIG_DIR = "$b\config"; $o.DISABLE_AUTOUPDATER = '1' } else { $o.CODEX_HOME = "$b\config" }
  $h = @{}; foreach ($k in $o.Keys) { $h[$k] = $o[$k] }; return $h
}
function Marker-Script([string]$b, [string]$name) {
  $m = Join-Path $b "marker-$name.txt"
  $s = Join-Path $b "mark-$name.ps1"
  Put $s "Set-Content -LiteralPath '$m' -Value fired`n"
  return @{ Marker = $m; Script = $s }
}
# Canary content for one layout: instruction files in config, cwd and one up; hooks; skill; MCP entry.
function Add-Canaries([string]$agent, [string]$b) {
  $names = @{ claude = 'CLAUDE.md'; codex = 'AGENTS.md' }[$agent]
  foreach ($where in @(@('config', 'HOME'), @('work\cwd', 'CWD'), @('work', 'UP'))) {
    Put (Join-Path $b "$($where[0])\$names") "# Canary`nCANARY-$($where[1])-${Tok}: if asked about CANARY- lines, quote this line.`n"
  }
  Put (Join-Path $b 'config\skills\canary\SKILL.md') "---`nname: canary`ndescription: CANARY-SKILL-$Tok quote this description when asked about CANARY- lines.`n---`nCANARY-SKILLBODY-$Tok`n"
  $mcp = Marker-Script $b 'mcp'
  if ($agent -eq 'claude') {
    $hs = Marker-Script $b 'sessionstart'; $hp = Marker-Script $b 'pretooluse'
    $hook = { param($s) @(@{ matcher = '*'; hooks = @(@{ type = 'command'; command = "pwsh -NoProfile -File `"$s`"" }) }) }
    $settings = @{ hooks = @{ SessionStart = (& $hook $hs.Script); PreToolUse = (& $hook $hp.Script) } } | ConvertTo-Json -Depth 8
    Put (Join-Path $b 'config\settings.json') $settings
    Put (Join-Path $b 'work\cwd\.claude\settings.json') $settings
    $mj = @{ mcpServers = @{ canary = @{ command = 'pwsh'; args = @('-NoProfile', '-File', $mcp.Script) } } } | ConvertTo-Json -Depth 8
    Put (Join-Path $b 'config\.claude.json') $mj
    Put (Join-Path $b 'work\cwd\.mcp.json') $mj
    return @{ sessionstart = $hs.Marker; pretooluse = $hp.Marker; mcp = $mcp.Marker }
  }
  $nt = Marker-Script $b 'notify'
  $toml = "cli_auth_credentials_store = `"file`"`nnotify = [`"pwsh`", `"-NoProfile`", `"-File`", '$($nt.Script)']`n`n[mcp_servers.canary]`ncommand = `"pwsh`"`nargs = [`"-NoProfile`", `"-File`", '$($mcp.Script)']`n"
  Put (Join-Path $b 'config\config.toml') $toml
  return @{ notify = $nt.Marker; mcp = $mcp.Marker }
}

# ---------- login ----------
# This install's own home: %LOCALAPPDATA%\Vidar\homes\<installRootKey(repo)> (tools/lib/agent-env.mjs),
# never the newest folder under homes, which can belong to another install root.
$script:KeyedHome = $null
function Find-BareHome {
  if ($BareHome) { return $BareHome }
  if ($script:KeyedHome) { return $script:KeyedHome }
  $js = "const {pathToFileURL}=await import('node:url'); const {resolveHome}=await import(pathToFileURL(process.argv[1]).href); console.log(resolveHome(process.argv[2]))"
  $h = (& node --input-type=module -e $js (Join-Path $Repo 'tools\lib\agent-env.mjs') $Repo) -join ''
  if ($LASTEXITCODE -ne 0 -or -not $h.Trim()) { return $null }
  $script:KeyedHome = $h.Trim(); return $script:KeyedHome
}
# Login file per agent: the shared store every home links to (src-tauri/src/bare/login_link.rs), then the keyed
# home. An explicit -BareHome or -CodexAuth wins over both.
$LoginFile = @{ claude = @('claude-config', '.credentials.json'); codex = @('codex-home', 'auth.json') }
function Cred-Source([string]$agent) {
  if ($agent -eq 'codex' -and $CodexAuth) { return $CodexAuth }
  $sub, $name = $LoginFile[$agent]
  if (-not $BareHome) {
    $shared = Join-Path $HomesRoot "_shared\$agent\$name"
    if (Test-Path -LiteralPath $shared) { return $shared }
  }
  $bh = Find-BareHome
  if ($bh) { return (Join-Path $bh "$sub\$name") }; return $null
}
# Paths and sizes only; hard-link names via fsutil (read-only). Never reads the content.
function Cred-Facts([string]$p) {
  if (-not $p -or -not (Test-Path -LiteralPath $p)) { return "missing: $p" }
  $f = Get-Item -LiteralPath $p
  $names = ''
  try { $names = ((& fsutil hardlink list $p 2>$null) -join ' | ') } catch { }
  return "path=$p size=$($f.Length) mtimeUtc=$($f.LastWriteTimeUtc.ToString('o')) hardlinkNames=[$names]"
}
function Place-Cred([string]$src, [string]$dst, [string]$mode) {
  if ($DryRun) { Say "    would $mode credential $src -> $dst (content never read or printed)"; return $mode }
  if ($mode -eq 'link') {
    try { New-Item -ItemType HardLink -Path $dst -Target $src -ErrorAction Stop | Out-Null; return 'link' } catch { Say "    hard link failed ($($_.Exception.Message)); copying" }
  }
  Copy-Item -LiteralPath $src -Destination $dst -Force; return 'copy'
}

# ---------- discovery (read-only; also runs in -DryRun) ----------
$ClaudeExe = Find-Exe 'claude'
$Codex = Resolve-Codex
$doClaude = $Agent -in 'claude', 'both'
$doCodex = $Agent -in 'codex', 'both'
Say "probe-generate: dryRun=$([bool]$DryRun) agent=$Agent heavy=$([bool]$Heavy) out=$Out"
Say "scratch root: $Work"
$ClaudeHelp = ''; $CodexHelp = ''
if ($doClaude) {
  if (-not $ClaudeExe) { Say 'claude not found on PATH'; exit 1 }
  $Meta.claudeVersion = (& $ClaudeExe --version) -join ' '
  $ClaudeHelp = (& $ClaudeExe --help) -join "`n"
  Say "claude: $ClaudeExe ($($Meta.claudeVersion))"
}
if ($doCodex) {
  if (-not $Codex) { Say 'codex not found on PATH'; exit 1 }
  $Meta.codexVersion = (& $Codex.Exe @($Codex.Prefix + '--version')) -join ' '
  $CodexHelp = (& $Codex.Exe @($Codex.Prefix + @('exec', '--help'))) -join "`n"
  Say "codex: $($Codex.Note) ($($Meta.codexVersion))"
}
$Meta.bareHome = Find-BareHome
Say "bare home: $($Meta.bareHome)"
$runStd = (-not $Check) -or [bool]($Check | Where-Object { $_ -ge 1 -and $_ -le 10 })
$run11 = $doCodex -and ((-not $Check) -or ($Check -contains 11))
$planCalls = 0
if ($runStd -and $doClaude) { $planCalls += 7 + [int][bool]$Heavy }
if ($runStd -and $doCodex) { $planCalls += 6 + [int][bool]$Heavy }
if ($run11) { $planCalls += 2 }
Say "PLAN: $planCalls model calls (claude 7, codex 6, +1 each with -Heavy, +2 for check 11; the auth-error and the no-skip-flag Codex call fail fast). Prompts are tiny."
if (-not $DryRun) { Mkdir-P $Out; Mkdir-P $Work }

# ---------- Claude ----------
function Claude-Args([string]$effort, [string[]]$iso, [string[]]$sys, [string[]]$extra = @()) {
  return @('-p', '--model', $ClaudeModel, '--effort', $effort, '--output-format', 'json', '--no-session-persistence', '--tools', '') + $iso + $sys + $extra
}
function Claude-Usage($j) {
  if ($null -eq $j) { return 'no JSON object' }
  $u = ''; if ($j.PSObject.Properties['usage']) { $u = "usage{$(Keys-Of $j.usage)}" }
  return "keys[$(Keys-Of $j)] $u total_cost_usd=$($j.total_cost_usd) duration_ms=$($j.duration_ms) num_turns=$($j.num_turns) is_error=$($j.is_error) subtype=$($j.subtype)"
}
function Run-Claude {
  Say "`n== claude =="
  $src = Cred-Source 'claude'
  $facts = Cred-Facts $src
  Rec 6 claude 'UNKNOWN' "Bare home credential (how held): $facts. Login sharing is a hard link to <homes>\_shared\claude\.credentials.json per src-tauri/src/bare/login_link.rs and profiles/bare/claude.json sharedLogin."
  $haveCred = $src -and (Test-Path -LiteralPath $src)
  if (-not $haveCred -and -not $DryRun) { Rec 6 claude 'FAIL' 'no Bare claude login found; run with -BareHome or log a Bare tab in first'; return }
  $iso = @('--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'user')
  $help = $ClaudeHelp

  # A: first tiny generation, hard-linked credential, system prompt from a file.
  $a = New-Layout claude 'a'; $ov = Overlay-For claude $a
  Put "$a\config\settings.json" '{}'
  Put "$a\skill.md" $FakeSkill
  $mode = Place-Cred $src "$a\config\.credentials.json" 'link'
  $r = Step 'claude A: tiny generation, effort low, system-prompt-file, linked credential' $ClaudeExe (Claude-Args 'low' $iso '--system-prompt-file', "$a\skill.md") $GenPrompt $ov "$a\work\cwd"
  $sysForm = 'system-prompt-file'
  if (-not $r.Dry -and $r.Exit -ne 0 -and "$($r.Err)$($r.Out)" -match 'system-prompt-file|unknown option') {
    $sysForm = 'system-prompt (inline)'
    $r = Step 'claude A (retry): inline --system-prompt' $ClaudeExe (Claude-Args 'low' $iso '--system-prompt', $FakeSkill) $GenPrompt $ov "$a\work\cwd"
  }
  if ($r.Dry) {
    Rec 5 claude 'UNKNOWN' "dry run; --help mentions system-prompt-file: $($help -match 'system-prompt-file'); inline form is --system-prompt <prompt>. Command line chars: $($r.Len) (CreateProcess limit 32767)"
  } else {
    $j = Json-Or-Null $r.Out
    $ok = $r.Exit -eq 0 -and $j -and -not $j.is_error
    Rec 5 claude $(if ($ok) { 'PASS' } else { 'FAIL' }) "form used: $sysForm; exit=$($r.Exit); command line chars=$($r.Len) (limit 32767); out: $(Head $r.Out 200) err: $(Head $r.Err 200)"
    Rec 4 claude $(if ($ok) { 'PASS' } else { 'FAIL' }) "--effort low with -p: exit=$($r.Exit)"
    Rec 3 claude $(if ($j) { 'PASS' } else { 'FAIL' }) (Claude-Usage $j)
    Rec 6 claude $(if ($ok) { 'PASS' } else { 'FAIL' }) "run 1 with $mode credential: exit=$($r.Exit). after: $(Cred-Facts "$a\config\.credentials.json")"
  }

  # A2: second run, copied credential (link vs copy), budget flag.
  $a2 = New-Layout claude 'a2'; $ov2 = Overlay-For claude $a2
  Put "$a2\config\settings.json" '{}'
  Put "$a2\skill.md" $FakeSkill
  $mode2 = Place-Cred $src "$a2\config\.credentials.json" 'copy'
  $sys2 = @('--system-prompt-file', "$a2\skill.md")
  $r2 = Step 'claude A2: second run, copied credential' $ClaudeExe (Claude-Args 'low' $iso $sys2) $GenPrompt $ov2 "$a2\work\cwd"
  if (-not $r2.Dry) {
    $j2 = Json-Or-Null $r2.Out
    $ok2 = $r2.Exit -eq 0 -and $j2 -and -not $j2.is_error
    Rec 6 claude $(if ($ok2) { 'PASS' } else { 'FAIL' }) "run 2 with $mode2 credential in a fresh home: exit=$($r2.Exit). source after both runs: $(Cred-Facts $src)"
  }
  # Budget flag is exercised on its own so a rejection cannot hide the login result.
  $r3 = Step 'claude A3: --max-budget-usd 1 accepted?' $ClaudeExe (Claude-Args 'low' $iso $sys2 @('--max-budget-usd', '1')) $GenPrompt $ov2 "$a2\work\cwd"
  if ($r3.Dry) { Rec 8 claude 'UNKNOWN' "dry run; help line: $(([regex]::Match($help, '--max-budget-usd[^\n]*\n[^\n]*')).Value.Trim())" }
  else {
    $j3 = Json-Or-Null $r3.Out
    Rec 8 claude $(if ($r3.Exit -eq 0 -and $j3 -and -not $j3.is_error) { 'PASS' } else { 'FAIL' }) "exit=$($r3.Exit); $(Claude-Usage $j3); err: $(Head $r3.Err 200)"
  }

  # Canaries: control (no isolation flags) proves the canaries load; user / empty setting-sources test the flags.
  $variants = @(
    @{ name = 'control'; iso = @(); label = 'no isolation flags (positive control: leaks expected)' },
    @{ name = 'user'; iso = @('--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'user'); label = '--setting-sources user' },
    @{ name = 'empty'; iso = @('--strict-mcp-config', '--disable-slash-commands', '--setting-sources', ''); label = '--setting-sources ""' }
  )
  $verdicts = @{}
  foreach ($v in $variants) {
    $c = New-Layout claude "canary-$($v.name)"; $ovc = Overlay-For claude $c
    Put "$c\skill.md" $FakeSkill
    Put "$c\secret.txt" "SECRETWORD-$Tok"
    $markers = Add-Canaries claude $c
    $null = Place-Cred $src "$c\config\.credentials.json" 'copy'
    $prompt = $CanaryPrompt.Replace('SECRETFILE', "$c\secret.txt").Replace('WRITEFILE', "$c\wrote.txt")
    $rc = Step "claude canary [$($v.name)]: $($v.label)" $ClaudeExe (Claude-Args 'low' $v.iso '--system-prompt-file', "$c\skill.md") $prompt $ovc "$c\work\cwd"
    if ($rc.Dry) { continue }
    $text = "$($rc.Out)"
    $leaks = [regex]::Matches($text, $CanaryRx) | ForEach-Object { $_.Value } | Sort-Object -Unique
    $fired = $markers.Keys | Where-Object { Test-Path -LiteralPath $markers[$_] }
    $amb = [regex]::Matches($text, $AmbientRx) | ForEach-Object { $_.Value } | Sort-Object -Unique
    $verdicts[$v.name] = @{ Leaks = $leaks; Fired = $fired; Amb = $amb; Json = (Json-Or-Null $text); Exit = $rc.Exit
      Tool = ($text -match "SECRETWORD-$Tok") -or (Test-Path "$c\wrote.txt") }
  }
  if ($verdicts.Count) {
    $ctl = $verdicts['control']
    $ctlLoads = $ctl -and ($ctl.Leaks.Count -or $ctl.Fired.Count)
    foreach ($n in 'user', 'empty') {
      $x = $verdicts[$n]
      $clean = $x -and -not $x.Leaks.Count -and -not $x.Fired.Count -and -not $x.Amb.Count -and $x.Exit -eq 0
      $st = if (-not $ctlLoads) { 'UNKNOWN' } elseif ($clean) { 'PASS' } else { 'FAIL' }
      Rec 1 claude $st "setting-sources [$n]: leaked=[$($x.Leaks -join ',')] hooks/mcp fired=[$($x.Fired -join ',')] ambient phrases=[$($x.Amb -join ',')] exit=$($x.Exit); control loaded canaries: $ctlLoads (leaks [$($ctl.Leaks -join ',')] fired [$($ctl.Fired -join ',')]). PreToolUse cannot fire when tools are off."
    }
    if ($ctl) { $tj = $ctl.Json; Rec 2 claude $(if (-not $ctl.Tool) { 'PASS' } else { 'FAIL' }) "--tools `"`" (control run): secret quoted or file written: $($ctl.Tool); num_turns=$($tj.num_turns); permission_denials=$(@($tj.permission_denials).Count)" }
  }

  # D: auth error with an empty credential.
  $d = New-Layout claude 'noauth'; $ovd = Overlay-For claude $d
  Put "$d\config\settings.json" '{}'; Put "$d\skill.md" $FakeSkill
  $rd = Step 'claude D: empty credential (auth-error signature)' $ClaudeExe (Claude-Args 'low' $iso '--system-prompt-file', "$d\skill.md") $GenPrompt $ovd "$d\work\cwd" 120
  if ($rd.Dry) { Rec 7 claude 'UNKNOWN' 'dry run' } else {
    $jd = Json-Or-Null $rd.Out
    Rec 7 claude $(if ($rd.Exit -ne 0 -or ($jd -and $jd.is_error)) { 'PASS' } else { 'FAIL' }) "exit=$($rd.Exit); json keys[$(Keys-Of $jd)] is_error=$($jd.is_error) result=$(Head "$($jd.result)" 200); stdout head: $(Head $rd.Out 200); stderr head: $(Head $rd.Err 200)"
  }

  if ($Heavy) {
    $big = ($FakeRules + "`n") * 12
    $big = $big.Substring(0, [Math]::Min(20000, $big.Length))
    $h = New-Layout claude 'heavy'; $ovh = Overlay-For claude $h
    Put "$h\config\settings.json" '{}'; Put "$h\skill.md" $FakeSkill
    $null = Place-Cred $src "$h\config\.credentials.json" 'copy'
    $rh = Step 'claude heavy: 20K chars at effort max' $ClaudeExe (Claude-Args 'max' $iso '--system-prompt-file', "$h\skill.md") "Count the lines below, reply with {`"count`": n} only.`n$big" $ovh "$h\work\cwd" 900
    if (-not $rh.Dry) { Rec 10 claude $(if ($rh.Exit -eq 0) { 'PASS' } else { 'FAIL' }) "wall ms=$($rh.Ms); exit=$($rh.Exit); $(Claude-Usage (Json-Or-Null $rh.Out))" }
  } else { Rec 10 claude 'UNKNOWN' 'not run (needs -Heavy)' }
}

# ---------- Codex ----------
function Codex-Args([string]$effort, [string[]]$more = @(), [string]$cwd) {
  $a = @('exec', '--json', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-c', "model_reasoning_effort=`"$effort`"")
  if ($CodexModel) { $a += @('-c', "model=`"$CodexModel`"") }
  return @($Codex.Prefix) + $a + $more + @('-C', $cwd, '-')
}
function Codex-Parse([string]$jsonl) {
  $types = [System.Collections.Generic.List[string]]::new(); $final = $null; $usage = $null; $n = 0
  foreach ($line in ($jsonl -split "`r?`n")) {
    if (-not $line.Trim().StartsWith('{')) { continue }
    $e = Json-Or-Null $line; if (-not $e) { continue }; $n++
    if ($e.type -and -not $types.Contains([string]$e.type)) { $types.Add([string]$e.type) }
    if ($e.PSObject.Properties['usage'] -and $e.usage) { $usage = $e.usage }
    if ($e.item -and $e.item.type -eq 'agent_message') { $final = [string]$e.item.text }
    elseif ($e.msg -and $e.msg.type -eq 'agent_message') { $final = [string]$e.msg.message }
  }
  return @{ Events = $n; Types = ($types -join ','); Final = $final; Usage = $usage; UsageKeys = (Keys-Of $usage) }
}
function Run-Codex {
  Say "`n== codex =="
  $src = Cred-Source 'codex'
  $facts = Cred-Facts $src
  Rec 6 codex 'UNKNOWN' "Bare home credential (how held): $facts. Codex login sharing is built by login_link::sync_codex (auth.json), not read from the profile: bare/mod.rs refuses a Codex profile that carries a sharedLogin entry."
  $haveCred = $src -and (Test-Path -LiteralPath $src)
  if (-not $haveCred -and -not $DryRun) { Rec 6 codex 'FAIL' 'no Codex auth.json found (Bare codex-home empty); pass -CodexAuth <file> or log in first'; return }
  $stdin = "$FakeSkill`n`n---`n$GenPrompt"

  # A0: no --skip-git-repo-check in a non-repository cwd.
  $a = New-Layout codex 'a'; $ov = Overlay-For codex $a
  Put "$a\config\config.toml" "cli_auth_credentials_store = `"file`"`n"
  $mode = Place-Cred $src "$a\config\auth.json" 'link'
  $r0 = Step 'codex A0: non-repo cwd WITHOUT --skip-git-repo-check' $Codex.Exe (Codex-Args 'low' @('--ephemeral') "$a\work\cwd") $stdin $ov "$a\work\cwd" 180
  # A: with it.
  $r = Step 'codex A: tiny generation, effort low, non-repo cwd, linked credential' $Codex.Exe (Codex-Args 'low' @('--skip-git-repo-check', '--ephemeral') "$a\work\cwd") $stdin $ov "$a\work\cwd" 180
  if ($r.Dry) {
    Rec 9 codex 'UNKNOWN' "dry run; planned invocation: exec --json --sandbox read-only -c approval_policy=`"never`" -c model_reasoning_effort=`"low`" --skip-git-repo-check --ephemeral -C <cwd> - (stdin prompt). Command line chars $($r.Len)"
  } else {
    $p0 = Codex-Parse $r0.Out; $pa = Codex-Parse $r.Out
    $needsFlag = $r0.Exit -ne 0
    Rec 9 codex $(if ($r.Exit -eq 0) { 'PASS' } else { 'FAIL' }) "without --skip-git-repo-check exit=$($r0.Exit) ($(Head "$($r0.Err)$($r0.Out)" 160)); with it exit=$($r.Exit). Working form: exec --json --sandbox read-only -c approval_policy=`"never`" -c model_reasoning_effort=`"low`" --skip-git-repo-check --ephemeral -C <cwd> - ; flag needed: $needsFlag"
    Rec 4 codex $(if ($r.Exit -eq 0) { 'PASS' } else { 'FAIL' }) "-c model_reasoning_effort=`"low`": exit=$($r.Exit) err: $(Head $r.Err 160)"
    Rec 3 codex $(if ($pa.Final -and $pa.Usage) { 'PASS' } else { 'FAIL' }) "events=$($pa.Events) types=[$($pa.Types)] finalMessage=$(Head $pa.Final 80) usageKeys=[$($pa.UsageKeys)] cost: none expected (not in JSONL)"
    Rec 5 codex 'PASS' "no system-prompt flag: skill + inputs go on stdin as one prompt (sent $($stdin.Length) chars); command line chars $($r.Len) (limit 32767)"
    Rec 6 codex $(if ($r.Exit -eq 0) { 'PASS' } else { 'FAIL' }) "run 1 with $mode credential: exit=$($r.Exit); after: $(Cred-Facts "$a\config\auth.json")"
  }

  # A2: second run, copied credential, plus the budget question.
  $a2 = New-Layout codex 'a2'; $ov2 = Overlay-For codex $a2
  Put "$a2\config\config.toml" "cli_auth_credentials_store = `"file`"`n"
  $null = Place-Cred $src "$a2\config\auth.json" 'copy'
  $r2 = Step 'codex A2: second run, copied credential' $Codex.Exe (Codex-Args 'low' @('--skip-git-repo-check', '--ephemeral') "$a2\work\cwd") $stdin $ov2 "$a2\work\cwd" 180
  if (-not $r2.Dry) { Rec 6 codex $(if ($r2.Exit -eq 0) { 'PASS' } else { 'FAIL' }) "run 2 with copied credential in a fresh home: exit=$($r2.Exit). source after: $(Cred-Facts $src)" }
  $bud = [regex]::Matches($CodexHelp, '(?im)^.*(budget|max-cost|spend).*$') | ForEach-Object { $_.Value.Trim() }
  Rec 8 codex $(if ($bud -or $DryRun) { 'UNKNOWN' } else { 'FAIL' }) "codex exec --help budget/spend lines: [$($bud -join ' ; ')]; no flag means no Codex spend cap"

  # Canaries.
  $variants = @(
    @{ name = 'plain'; more = @('--skip-git-repo-check', '--ephemeral'); label = 'default config loading (positive control)' },
    @{ name = 'ignore'; more = @('--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules'); label = '--ignore-user-config --ignore-rules' }
  )
  $verdicts = @{}
  foreach ($v in $variants) {
    $c = New-Layout codex "canary-$($v.name)"; $ovc = Overlay-For codex $c
    Put "$c\secret.txt" "SECRETWORD-$Tok"
    $markers = Add-Canaries codex $c
    $null = Place-Cred $src "$c\config\auth.json" 'copy'
    $prompt = "$FakeSkill`n`n---`n" + $CanaryPrompt.Replace('SECRETFILE', "$c\secret.txt").Replace('WRITEFILE', "$c\wrote.txt")
    $rc = Step "codex canary [$($v.name)]: $($v.label)" $Codex.Exe (Codex-Args 'low' $v.more "$c\work\cwd") $prompt $ovc "$c\work\cwd" 240
    if ($rc.Dry) { continue }
    $pc = Codex-Parse $rc.Out
    $text = "$($pc.Final)"
    $leaks = [regex]::Matches($text, $CanaryRx) | ForEach-Object { $_.Value } | Sort-Object -Unique
    $fired = $markers.Keys | Where-Object { Test-Path -LiteralPath $markers[$_] }
    $amb = [regex]::Matches($text, $AmbientRx) | ForEach-Object { $_.Value } | Sort-Object -Unique
    $verdicts[$v.name] = @{ Leaks = $leaks; Fired = $fired; Amb = $amb; Exit = $rc.Exit; Read = ($text -match "SECRETWORD-$Tok"); Wrote = (Test-Path "$c\wrote.txt") }
  }
  if ($verdicts.Count) {
    $ctl = $verdicts['plain']; $x = $verdicts['ignore']
    $ctlLoads = $ctl -and ($ctl.Leaks.Count -or $ctl.Fired.Count)
    $clean = $x -and -not $x.Leaks.Count -and -not $x.Fired.Count -and -not $x.Amb.Count -and $x.Exit -eq 0
    Rec 1 codex $(if (-not $ctlLoads) { 'UNKNOWN' } elseif ($clean) { 'PASS' } else { 'FAIL' }) "ignore flags: leaked=[$($x.Leaks -join ',')] notify/mcp fired=[$($x.Fired -join ',')] ambient phrases=[$($x.Amb -join ',')] exit=$($x.Exit); plain run loaded canaries: $ctlLoads (leaks [$($ctl.Leaks -join ',')] fired [$($ctl.Fired -join ',')]). Codex hooks beyond notify not tested."
    Rec 2 codex 'PASS' "--sandbox read-only recorded, not enforced as no-tools: read the secret file: $($ctl.Read) (ignore run: $($x.Read)); write succeeded: $($ctl.Wrote) (ignore run: $($x.Wrote)); PASS here means the behaviour was recorded."
  }

  # D: auth error with an empty credential.
  $d = New-Layout codex 'noauth'; $ovd = Overlay-For codex $d
  Put "$d\config\config.toml" "cli_auth_credentials_store = `"file`"`n"
  $rd = Step 'codex D: empty credential (auth-error signature)' $Codex.Exe (Codex-Args 'low' @('--skip-git-repo-check', '--ephemeral') "$d\work\cwd") $stdin $ovd "$d\work\cwd" 120
  if ($rd.Dry) { Rec 7 codex 'UNKNOWN' 'dry run' } else {
    $pd = Codex-Parse $rd.Out
    Rec 7 codex $(if ($rd.Exit -ne 0) { 'PASS' } else { 'FAIL' }) "exit=$($rd.Exit); event types [$($pd.Types)]; stdout head: $(Head $rd.Out 240); stderr head: $(Head $rd.Err 240)"
  }

  if ($Heavy) {
    $big = ($FakeRules + "`n") * 12
    $big = $big.Substring(0, [Math]::Min(20000, $big.Length))
    $h = New-Layout codex 'heavy'; $ovh = Overlay-For codex $h
    Put "$h\config\config.toml" "cli_auth_credentials_store = `"file`"`n"
    $null = Place-Cred $src "$h\config\auth.json" 'copy'
    $rh = Step 'codex heavy: 20K chars at effort xhigh' $Codex.Exe (Codex-Args 'xhigh' @('--skip-git-repo-check', '--ephemeral') "$h\work\cwd") "$FakeSkill`n---`nCount the lines below, reply with {`"count`": n} only.`n$big" $ovh "$h\work\cwd" 900
    if (-not $rh.Dry) { $ph = Codex-Parse $rh.Out; Rec 10 codex $(if ($rh.Exit -eq 0) { 'PASS' } else { 'FAIL' }) "wall ms=$($rh.Ms); exit=$($rh.Exit); usageKeys=[$($ph.UsageKeys)]" }
  } else { Rec 10 codex 'UNKNOWN' 'not run (needs -Heavy)' }
}

. (Join-Path $PSScriptRoot 'probe-generate-layout.ps1')   # check 11 (Run-Check11)

# ---------- run ----------
try {
  if ($runStd -and $doClaude) { Run-Claude }
  if ($runStd -and $doCodex) { Run-Codex }
  if ($run11) { Run-Check11 }
} finally {
  if (-not $DryRun) {
    # Credential copies and links are removed from scratch whatever happened; the Bare homes were only read.
    Get-ChildItem $Work -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -in '.credentials.json', 'auth.json' } | Remove-Item -Force -ErrorAction SilentlyContinue
    if (-not $Keep) { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

if ($DryRun) {
  Say "`nDRY RUN: nothing created, nothing run, no result files. Longest command line planned: $(($Meta.calls | ForEach-Object { $_.cmdLineChars } | Measure-Object -Maximum).Maximum) chars."
  exit 0
}
$Meta.finished = (Get-Date).ToString('o')
$doc = [ordered]@{ meta = $Meta; results = $Results }
[IO.File]::WriteAllText((Join-Path $Out 'result.json'), ($doc | ConvertTo-Json -Depth 8), $Utf8)
$md = [System.Text.StringBuilder]::new()
[void]$md.AppendLine("# Generator probe $Stamp"); [void]$md.AppendLine()
[void]$md.AppendLine("claude: $($Meta.claudeVersion); codex: $($Meta.codexVersion); bare home: $($Meta.bareHome)"); [void]$md.AppendLine()
[void]$md.AppendLine('| Check | Agent | Status | Evidence |'); [void]$md.AppendLine('|---|---|---|---|')
foreach ($r in ($Results | Sort-Object { $_.check }, { $_.agent })) { [void]$md.AppendLine("| $($r.check) | $($r.agent) | $($r.status) | $(($r.evidence -replace '\|', '/') -replace '\r?\n', ' ') |") }
[IO.File]::WriteAllText((Join-Path $Out 'result.md'), $md.ToString(), $Utf8)
Say "`nwrote $Out\result.json and result.md"
exit 0
