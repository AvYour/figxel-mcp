# Diagnostic: does focus return to the previous app on its own, WITHOUT any
# keystrokes? This decides whether the stray keystroke is caused by the
# keystroke sequence or by the environment defeating SetForegroundWindow.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File spikes/autolaunch/focus-probe.ps1
#
# Sends NO input of any kind. Read-only except for one SetForegroundWindow.

param([int]$SettleMs = 1200)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FpWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@

function Get-Fg {
  $h = [FpWin]::GetForegroundWindow()
  $procId = [uint32]0
  [void][FpWin]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = $null
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
  [pscustomobject]@{ pid = [int]$procId; process = $name }
}

$figma = Get-Process -Name Figma -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $figma) { Write-Output "no Figma window"; exit 1 }

$before = Get-Fg
if ([FpWin]::IsIconic($figma.MainWindowHandle)) { [void][FpWin]::ShowWindow($figma.MainWindowHandle, 9) }
$setOk = [FpWin]::SetForegroundWindow($figma.MainWindowHandle)

$w = [System.Diagnostics.Stopwatch]::StartNew()
$timeline = @()
foreach ($step in 0, 60, 120, 250, 500, 900, 1400) {
  $target = $step
  while ($w.ElapsedMilliseconds -lt $target) { Start-Sleep -Milliseconds 15 }
  $fg = Get-Fg
  $timeline += [ordered]@{
    atMs = $w.ElapsedMilliseconds
    pid = $fg.pid
    process = $fg.process
    isFigma = ($fg.pid -eq $figma.Id)
  }
}

[ordered]@{
  probe = "focus-stability, NO keystrokes sent"
  setForegroundReturned = $setOk
  figmaPid = $figma.Id
  foregroundBefore = $before
  timeline = $timeline
  focusStableWithoutInput = -not ($timeline | Where-Object { -not $_.isFigma })
} | ConvertTo-Json -Depth 5 -Compress
