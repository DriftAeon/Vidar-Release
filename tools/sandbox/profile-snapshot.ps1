#Requires -Version 7
# Supplementary write check, no admin: snapshot the real-profile roots the write gate watches, before
# and after a sandbox run, and diff the two. Who runs it: the user, in a normal terminal, around a
# sandbox launch. The user's live sessions write these roots too, so a diff is triaged against
# write-audit.ps1's trace, never read alone. Read-only on the profile; writes only -Out.
# Usage: pwsh -File tools/sandbox/profile-snapshot.ps1 -Out <before.json> [-RealProfile <dir>]
#        pwsh -File tools/sandbox/profile-snapshot.ps1 -Compare <before.json> <after.json>
# Roots (as write-audit.ps1): <profile>\.claude* (every top-level name starting .claude), \.codex,
#   \.agents, \.gitconfig, \.ssh: path, size, mtime and SHA-256. \AppData\Roaming and \AppData\Local:
#   path, size and mtime only.
# Exclusions (keep a snapshot near 2 minutes): reparse points are not followed; files that cannot be
#   read are listed with sha256 "unreadable"; folders that cannot be listed are skipped and counted.
#   %LOCALAPPDATA%\Temp is excluded: the sandbox itself and every tool's scratch live there, so it
#   is all churn (write-audit.ps1 still sees writes there). -Exclude adds more full paths.
#   Measured 2026-10-13 on the build machine: 213k files, 126 s cold (hashing ~3.2 GB of .claude and
#   .codex from disk), 5 s warm. Per-root timings print, so an overrun names its root.
# -Compare prints added, changed (size, mtime or hash) and removed paths per root and exits 1 when
#   anything differs in a hashed root, 0 otherwise (AppData churn is listed, not failed).
[CmdletBinding(DefaultParameterSetName = "Snap")]
param(
  [Parameter(Mandatory, ParameterSetName = "Snap")][string]$Out,
  [Parameter(ParameterSetName = "Snap")][string]$RealProfile = $env:USERPROFILE,
  [Parameter(ParameterSetName = "Snap")][string[]]$Exclude = @(),
  [Parameter(Mandatory, ParameterSetName = "Cmp", Position = 0)][string]$Compare,
  [Parameter(Mandatory, ParameterSetName = "Cmp", Position = 1)][string]$After
)
$ErrorActionPreference = "Stop"

if (-not ('VidarSandbox.ProfileSnapshot' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
namespace VidarSandbox {
  public static class ProfileSnapshot {
    public static long Skipped;
    public static List<string> Timings = new List<string>();
    static bool Excluded(string p, string[] ex) {
      foreach (var e in ex) {
        var r = e.TrimEnd('\\');
        if (p.Equals(r, StringComparison.OrdinalIgnoreCase) || p.StartsWith(r + "\\", StringComparison.OrdinalIgnoreCase)) return true;
      }
      return false;
    }
    static void Walk(string dir, string[] ex, List<FileInfo> files) {
      var stack = new Stack<string>(); stack.Push(dir);
      while (stack.Count > 0) {
        var d = stack.Pop();
        if (Excluded(d, ex)) continue;
        IEnumerable<FileSystemInfo> items;
        try { items = new DirectoryInfo(d).EnumerateFileSystemInfos("*", new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = 0, RecurseSubdirectories = false }); }
        catch { Skipped++; continue; }
        try {
          foreach (var i in items) {
            if ((i.Attributes & FileAttributes.ReparsePoint) != 0) continue;
            if ((i.Attributes & FileAttributes.Directory) != 0) stack.Push(i.FullName);
            else if (!Excluded(i.FullName, ex)) files.Add((FileInfo)i);
          }
        } catch { Skipped++; }
      }
    }
    static string Hash(string path) {
      try {
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var sha = SHA256.Create()) return Convert.ToHexString(sha.ComputeHash(fs)).ToLowerInvariant();
      } catch { return "unreadable"; }
    }
    // roots: label -> path; hashed: labels to hash. Writes JSON {profile, created, roots:{label:{path, hashed, files:{path:[size, mtimeUtc, sha]}}}}.
    public static long Snap(string outPath, string profile, string[] labels, string[] paths, bool[] hashed, string[] ex) {
      long n = 0;
      using (var fs = File.Create(outPath))
      using (var w = new Utf8JsonWriter(fs, new JsonWriterOptions { Indented = false })) {
        w.WriteStartObject();
        w.WriteString("profile", profile);
        w.WriteString("created", DateTime.UtcNow.ToString("o"));
        w.WriteStartArray("exclude"); foreach (var e in ex) w.WriteStringValue(e); w.WriteEndArray();
        w.WriteStartObject("roots");
        for (int k = 0; k < labels.Length; k++) {
          var sw = System.Diagnostics.Stopwatch.StartNew();
          var files = new List<FileInfo>();
          var p = paths[k];
          if (File.Exists(p)) files.Add(new FileInfo(p));
          else if (Directory.Exists(p)) Walk(p, ex, files);
          w.WriteStartObject(labels[k]);
          w.WriteString("path", p);
          w.WriteBoolean("hashed", hashed[k]);
          w.WriteBoolean("exists", File.Exists(p) || Directory.Exists(p));
          w.WriteStartObject("files");
          foreach (var f in files) {
            long len; string mt;
            try { len = f.Length; mt = f.LastWriteTimeUtc.ToString("o"); } catch { continue; }
            w.WriteStartArray(f.FullName);
            w.WriteNumberValue(len); w.WriteStringValue(mt);
            if (hashed[k]) w.WriteStringValue(Hash(f.FullName));
            w.WriteEndArray();
            n++;
          }
          w.WriteEndObject(); w.WriteEndObject();
          Timings.Add(string.Format("{0} {1} files {2:0.0} s", labels[k], files.Count, sw.Elapsed.TotalSeconds));
        }
        w.WriteEndObject(); w.WriteEndObject();
      }
      return n;
    }
  }
}
'@
}

function Read-Snapshot([string]$path) {
  $text = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
  [Text.Json.JsonDocument]::Parse($text, [Text.Json.JsonDocumentOptions]::new())
}

if ($PSCmdlet.ParameterSetName -eq "Cmp") {
  $a = Read-Snapshot $Compare; $b = Read-Snapshot $After
  "compare: $Compare -> $After"
  $hashedDiff = 0
  $rootsA = [ordered]@{}; $rootsB = [ordered]@{}
  foreach ($r in $a.RootElement.GetProperty("roots").EnumerateObject()) { $rootsA[$r.Name] = $r.Value }
  foreach ($r in $b.RootElement.GetProperty("roots").EnumerateObject()) { $rootsB[$r.Name] = $r.Value }
  $labels = [Collections.Generic.List[string]]::new()
  foreach ($k in @($rootsA.Keys) + @($rootsB.Keys)) { if (-not $labels.Contains($k)) { $labels.Add($k) } }
  foreach ($label in $labels) {
    $maps = foreach ($roots in @($rootsA, $rootsB)) {
      $m = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
      if ($roots.Contains($label)) {
        foreach ($f in $roots[$label].GetProperty("files").EnumerateObject()) {
          $m[$f.Name] = (@($f.Value.EnumerateArray() | ForEach-Object { $_.ToString() }) -join "|")
        }
      }
      , $m
    }
    $hashed = $false
    foreach ($roots in @($rootsA, $rootsB)) { if ($roots.Contains($label) -and $roots[$label].GetProperty("hashed").GetBoolean()) { $hashed = $true } }
    $added = @($maps[1].Keys | Where-Object { -not $maps[0].ContainsKey($_) } | Sort-Object)
    $removed = @($maps[0].Keys | Where-Object { -not $maps[1].ContainsKey($_) } | Sort-Object)
    $changed = @($maps[1].Keys | Where-Object { $maps[0].ContainsKey($_) -and $maps[0][$_] -ne $maps[1][$_] } | Sort-Object)
    "{0}: {1} added, {2} changed, {3} removed{4}" -f $label, $added.Count, $changed.Count, $removed.Count, $(if ($hashed) { "" } else { " (size/mtime only)" })
    $limit = if ($hashed) { 200 } else { 30 }
    foreach ($set in @(@("+", $added), @("~", $changed), @("-", $removed))) {
      $set[1] | Select-Object -First $limit | ForEach-Object { "  $($set[0]) $_" }
      if ($set[1].Count -gt $limit) { "  $($set[0]) ... $($set[1].Count - $limit) more" }
    }
    if ($hashed) { $hashedDiff += $added.Count + $changed.Count + $removed.Count }
  }
  if ($hashedDiff) { "profile-snapshot: $hashedDiff differences in hashed roots (triage against write-audit.ps1)"; exit 1 }
  "profile-snapshot: hashed roots unchanged"
  exit 0
}

$prof = [IO.Path]::GetFullPath($RealProfile).TrimEnd('\')
$labels = [Collections.Generic.List[string]]::new(); $paths = [Collections.Generic.List[string]]::new(); $hashed = [Collections.Generic.List[bool]]::new()
foreach ($i in @(Get-ChildItem -LiteralPath $prof -Force -Filter ".claude*" -ErrorAction SilentlyContinue)) {
  $labels.Add("~\" + $i.Name); $paths.Add($i.FullName); $hashed.Add($true)
}
foreach ($n in @(".codex", ".agents", ".gitconfig", ".ssh")) { $labels.Add("~\" + $n); $paths.Add((Join-Path $prof $n)); $hashed.Add($true) }
$labels.Add("%APPDATA%"); $paths.Add((Join-Path $prof "AppData\Roaming")); $hashed.Add($false)
$labels.Add("%LOCALAPPDATA%"); $paths.Add((Join-Path $prof "AppData\Local")); $hashed.Add($false)
$ex = @((Join-Path $prof "AppData\Local\Temp")) + @($Exclude | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') })

$OutFull = [IO.Path]::GetFullPath($Out)
$sw = [Diagnostics.Stopwatch]::StartNew()
$count = [VidarSandbox.ProfileSnapshot]::Snap($OutFull, $prof, $labels.ToArray(), $paths.ToArray(), $hashed.ToArray(), [string[]]$ex)
$sw.Stop()
"snapshot: $OutFull"
"roots: $($labels -join ', ')"
"excluded: $($ex -join ', ')"
[VidarSandbox.ProfileSnapshot]::Timings | ForEach-Object { "  $_" }
"files: $count; folders skipped (unlistable): $([VidarSandbox.ProfileSnapshot]::Skipped); time: $([math]::Round($sw.Elapsed.TotalSeconds, 1)) s"
if ($sw.Elapsed.TotalSeconds -gt 150) { "WARNING: over the ~2 minute budget; add -Exclude for the heaviest AppData folders." }
exit 0
