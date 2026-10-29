# Check 11 of probe-generate.ps1: the app's own call layout (dot-sourced by that script; not run alone).
# It builds the layout src-tauri/src/rules/generate/home.rs builds (<b>\config holding only the credential and
# config.toml, <b>\user-home as USERPROFILE, <b>\work as an empty cwd), puts canary AGENTS.md files one level above
# the cwd (<b>) and in the fake USERPROFILE, then runs the Codex argv exactly as run.rs codex_argv builds it, once
# as is and once with `-c project_doc_max_bytes=0`. PASS = neither canary text appears in either reply.
# Cost: 2 tiny Codex calls per run (check 1 tested flags; this tests the app's layout). Uses the parent script's
# helpers (Step, Put, Rec, New-Layout-style paths, Place-Cred, Codex-Parse) and variables ($Tok, $Codex, $DryRun).

function Run-Check11 {
  Say "`n== codex check 11: app call layout =="
  $src = Cred-Source 'codex'
  $haveCred = $src -and (Test-Path -LiteralPath $src)
  if (-not $haveCred -and -not $DryRun) { Rec 11 codex 'FAIL' 'no Codex auth.json found; pass -CodexAuth <file> or log in first'; return }
  $b = Join-Path $Work 'codex\app-layout'
  foreach ($d in 'config', 'user-home\AppData\Roaming', 'user-home\AppData\Local\Temp', 'work') { Mkdir-P (Join-Path $b $d) }
  $ov = Overlay-For codex $b
  Put "$b\config\config.toml" "cli_auth_credentials_store = `"file`"`n"
  $null = Place-Cred $src "$b\config\auth.json" 'copy'
  Put "$b\AGENTS.md" "# Canary`nCANARY-ABOVE-${Tok}: if asked about CANARY- lines, quote this line.`n" 'canary one level above the cwd'
  Put "$b\user-home\AGENTS.md" "# Canary`nCANARY-USERPROFILE-${Tok}: if asked about CANARY- lines, quote this line.`n" 'canary in the fake USERPROFILE'
  $cwd = "$b\work"
  $prompt = "Quote verbatim every line of instruction text you hold that contains the string CANARY-, and the headings of any AGENTS.md you hold. If none, reply exactly NONE."
  # run.rs codex_argv: exec --json --sandbox read-only -c approval_policy="never" -c model=".." -c model_reasoning_effort=".." --skip-git-repo-check --ephemeral -C <cwd> -
  $base = @('exec', '--json', '--sandbox', 'read-only', '-c', 'approval_policy="never"')
  if ($CodexModel) { $base += @('-c', "model=`"$CodexModel`"") }
  $base += @('-c', 'model_reasoning_effort="low"', '--skip-git-repo-check', '--ephemeral', '-C', $cwd, '-')
  $runs = @(
    @{ name = 'as the app'; argv = (@($Codex.Prefix) + $base) },
    @{ name = 'with project_doc_max_bytes=0'; argv = (@($Codex.Prefix) + @($base[0..5]) + @('-c', 'project_doc_max_bytes=0') + @($base[6..($base.Count - 1)])) }
  )
  $leaks = @{}; $dry = $false
  foreach ($r in $runs) {
    $res = Step "codex check 11: app call layout, $($r.name)" $Codex.Exe $r.argv $prompt $ov $cwd 240
    if ($res.Dry) { $dry = $true; continue }
    $p = Codex-Parse $res.Out
    $hit = [regex]::Matches("$($p.Final)", "CANARY-(ABOVE|USERPROFILE)-$Tok") | ForEach-Object { $_.Value } | Sort-Object -Unique
    $leaks[$r.name] = @{ Exit = $res.Exit; Hit = $hit }
  }
  if ($dry) { Rec 11 codex 'UNKNOWN' 'dry run; 2 calls planned (as the app, then with -c project_doc_max_bytes=0); canaries one level above the cwd and in the fake USERPROFILE'; return }
  $bad = $leaks.Keys | Where-Object { $leaks[$_].Hit.Count -or $leaks[$_].Exit -ne 0 }
  $ev = ($leaks.Keys | Sort-Object | ForEach-Object { "$_`: exit=$($leaks[$_].Exit) leaked=[$($leaks[$_].Hit -join ',')]" }) -join '; '
  Rec 11 codex $(if ($bad) { 'FAIL' } else { 'PASS' }) $ev
}
