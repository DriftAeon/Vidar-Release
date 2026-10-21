# Capture only the Vidar window to a PNG. Works even if partially occluded
# (PrintWindow with PW_RENDERFULLCONTENT, needed for WebView2 content).
param(
    [string]$OutPath
)
. "$PSScriptRoot\..\lib\Paths.ps1"
if (-not $OutPath) { $OutPath = Join-Path (Resolve-VidarPath -Id shots) "vidar-$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()).png" }

$proc = Get-Process vidar -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error "Vidar is not running (no window found)"; exit 1 }

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VidarCapture {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$rect = New-Object VidarCapture+RECT
[VidarCapture]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Error "window has no size (minimized?)"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 0x2 = PW_RENDERFULLCONTENT (composited/WebView2 surfaces)
$ok = [VidarCapture]::PrintWindow($proc.MainWindowHandle, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) { $bmp.Dispose(); Write-Error "PrintWindow failed"; exit 1 }

New-Item -ItemType Directory -Force (Split-Path $OutPath) | Out-Null
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output $OutPath
