# Phase 0 spike 2 — one auto-launch attempt (spec §5.7.3), rebuilt around
# SendInput with a per-batch focus check and an operator-idle gate.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File autolaunch.ps1 [-PluginName "figma-mcp bridge"]
#                [-Probe] [-DryRun] [-Force] [-RequireIdleMs 2000] [-Chord ctrl+/|ctrl+k]
#
# Prints one JSON object as the last line of stdout and exits. measure.mjs
# parses that line; keep the contract.
#
# WHY SENDINPUT, NOT SENDKEYS
# The first real attempt (SendKeys) ended with strayRisk = true: the plugin name
# was typed into whichever window had focus by then — on this machine the chat
# app, which is how two stray keystrokes became visible text. The spec's target
# is 0 strays over 50 attempts (§5.7.5). SendKeys re-resolves its target for
# every character and offers no point at which to check; SendInput sends one
# atomic batch, so this script can verify the foreground between batches and
# abort before the damaging part (the name) is ever typed.
#
# WHY AN IDLE GATE — the operator does not have to sit in Figma
# Raising a window and typing while someone is working is exactly how keystrokes
# land in the wrong app. So the decision is made before anything moves:
#   Figma already in front        -> send, raise nothing (zero focus steal)
#   Operator idle, Figma behind   -> raise, verify, send
#   Operator active               -> decline, touch nothing, stage "user-active"
# Declining is a correct outcome, not a failure: the caller retries later.
#
# SAFEGUARDS, IN ORDER
#   1. Never type unless the foreground pid is Figma — checked before EVERY
#      batch, aborting on the first mismatch.
#   2. If focus is lost after we raised Figma, restore the previous foreground so
#      the operator is not left staring at a window they did not pick.
#   3. -Probe sends only the chord: no text, no Enter. The safe way to ask "does
#      the chord even open the surface?".
#   4. -DryRun sends nothing and reports what it would decide.

param(
  [string]$PluginName = "figma-mcp bridge",
  [switch]$DryRun,
  [switch]$Probe,
  [switch]$Force,
  # Raised from 2000 to 15000. The old default was the real bug behind "why does
  # it keep opening Figma": a two-second pause is not "the operator is away", it
  # is someone reading a page. At 2000 every short pause looked like an opening.
  # Note the honest limit this does not remove: idle time cannot tell "away" from
  # "thinking". The stronger guard belongs upstream — only ask for a launch when
  # the bridge reports no live plugin session — and until that exists this
  # feature must stay opt-in and off by default (ADR 20).
  [int]$RequireIdleMs = 15000,
  [int]$SettleMs = 150,
  [int]$StepGapMs = 200,
  [ValidateSet("ctrl+/", "ctrl+k")]
  [string]$Chord = "ctrl+/"
)

$ErrorActionPreference = "Stop"

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class FmcpWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();

  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
}

public static class FmcpInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

  public const uint INPUT_KEYBOARD    = 1;
  public const uint KEYEVENTF_KEYUP   = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public static INPUT Vk(ushort vk, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.U.ki = new KEYBDINPUT();
    i.U.ki.wVk = vk;
    i.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    return i;
  }

  // Unicode delivery for the plugin name: independent of the active keyboard
  // layout, so a Japanese IME or a non-US layout cannot mangle it.
  public static INPUT Text(char c) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.U.ki = new KEYBDINPUT();
    i.U.ki.wVk = 0;
    i.U.ki.wScan = c;
    i.U.ki.dwFlags = KEYEVENTF_UNICODE;
    return i;
  }

  public static uint Send(INPUT[] inputs) {
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@

function Get-ForegroundInfo {
  $h = [FmcpWin]::GetForegroundWindow()
  $procId = [uint32]0
  [void][FmcpWin]::GetWindowThreadProcessId($h, [ref]$procId)
  $sb = New-Object System.Text.StringBuilder 256
  [void][FmcpWin]::GetWindowText($h, $sb, 256)
  $name = $null
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
  [ordered]@{ hwnd = $h.ToInt64(); pid = [int]$procId; process = $name; title = $sb.ToString() }
}

function Get-IdleMs {
  $lii = New-Object FmcpWin+LASTINPUTINFO
  $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
  if (-not [FmcpWin]::GetLastInputInfo([ref]$lii)) { return -1 }
  return [int]([FmcpWin]::GetTickCount() - $lii.dwTime)
}

function Out-Result($obj) {
  $obj | ConvertTo-Json -Compress -Depth 5
  exit 0
}

# ── find Figma ───────────────────────────────────────────────────────────────
$figma = Get-Process -Name Figma -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $figma) {
  Out-Result ([ordered]@{ ok = $false; stage = "find"; error = "No Figma window found"; keystrokesSent = 0 })
}
$figmaHwnd = $figma.MainWindowHandle

$foreground0 = Get-ForegroundInfo
$idleMs0 = Get-IdleMs
$figmaInFront = ($foreground0.pid -eq $figma.Id)

if ($DryRun) {
  Out-Result ([ordered]@{
    ok = $true; dryRun = $true; figmaPid = $figma.Id; chord = $Chord
    minimized = [FmcpWin]::IsIconic($figmaHwnd)
    foregroundBefore = $foreground0
    idleMs = $idleMs0; requireIdleMs = $RequireIdleMs; figmaInFront = $figmaInFront
    would = if ($figmaInFront) { "send (no raise needed)" }
            elseif ($Force) { "raise then send (-Force)" }
            elseif ($idleMs0 -ge $RequireIdleMs) { "raise then send (operator idle)" }
            else { "decline: user-active" }
  })
}

# ── the decision that keeps the operator out of it ───────────────────────────
$raised = $false
$previousHwnd = $foreground0.hwnd
$setOk = $null

# Figma already in front: send without raising. This branch is the ONLY zero-cost
# case, and it is not reached when the operator is working elsewhere.
if ($figmaInFront) {
  # no raise, no restore needed
} else {
  $allowed = $Force -or ($idleMs0 -ge $RequireIdleMs)
  if (-not $allowed) {
    Out-Result ([ordered]@{
      ok = $false; stage = "user-active"; keystrokesSent = 0; raised = $false
      idleMs = $idleMs0; requireIdleMs = $RequireIdleMs; foregroundBefore = $foreground0
      note = "Operator is active. Nothing was raised and no keystroke was sent; retry later, or pass -Force deliberately."
    })
  }
  if ([FmcpWin]::IsIconic($figmaHwnd)) { [void][FmcpWin]::ShowWindow($figmaHwnd, 9) }  # SW_RESTORE
  $raised = $true
  $setOk = [FmcpWin]::SetForegroundWindow($figmaHwnd)
  Start-Sleep -Milliseconds $SettleMs
  $fg = Get-ForegroundInfo
  if ($fg.pid -ne $figma.Id) {
    [void][FmcpWin]::SetForegroundWindow([IntPtr]$previousHwnd)
    Out-Result ([ordered]@{
      ok = $false; stage = "raise-failed"; raised = $true; keystrokesSent = 0
      setForegroundReturned = $setOk; foregroundAtCheck = $fg; foregroundBefore = $foreground0
      restored = $true; idleMs = $idleMs0
    })
  }
}

# ── guards ───────────────────────────────────────────────────────────────────
$timeline = @()
function Test-Focus([string]$step) {
  $fg = Get-ForegroundInfo
  $script:timeline += [ordered]@{ step = $step; pid = $fg.pid; process = $fg.process; ok = ($fg.pid -eq $figma.Id) }
  return ($fg.pid -eq $figma.Id)
}
function Restore-Previous {
  if ($script:raised) { [void][FmcpWin]::SetForegroundWindow([IntPtr]$script:previousHwnd) }
}

if (-not (Test-Focus "before-chord")) {
  Restore-Previous
  Out-Result ([ordered]@{ ok = $false; stage = "focus-lost"; keystrokesSent = 0; raised = $raised; timeline = $timeline; restored = $raised })
}

# ── batch 1: the quick-action chord ─────────────────────────────────────────
$VK_CONTROL = 0x11
$VK_OEM_2   = 0xBF   # "/" — US and JIS layouts both place it here
$VK_K       = 0x4B
$VK_RETURN  = 0x0D

$second = if ($Chord -eq "ctrl+k") { $VK_K } else { $VK_OEM_2 }
$chordInputs = @(
  [FmcpInput]::Vk($VK_CONTROL, $false),
  [FmcpInput]::Vk($second,     $false),
  [FmcpInput]::Vk($second,     $true),
  [FmcpInput]::Vk($VK_CONTROL, $true)
)
$sent1 = [FmcpInput]::Send($chordInputs)
Start-Sleep -Milliseconds $StepGapMs

if (-not (Test-Focus "after-chord")) {
  Restore-Previous
  Out-Result ([ordered]@{
    ok = $false; stage = "focus-lost-after-chord"; keystrokesSent = 1; raised = $raised
    chordDelivered = ($sent1 -eq $chordInputs.Count); timeline = $timeline
    strayRisk = $false; noTextSent = $true; restored = $raised
    note = "The chord went out; the plugin name did NOT. This is the abort path SendKeys could not offer."
  })
}

if ($Probe) {
  Out-Result ([ordered]@{
    ok = $true; stage = "probe-sent"; probe = $true; chord = $Chord; raised = $raised
    keystrokesSent = 1; noTextSent = $true; strayRisk = $false
    foregroundAfter = (Get-ForegroundInfo); timeline = $timeline; idleMs = $idleMs0
  })
}

# ── batch 2: the plugin name, then Enter ────────────────────────────────────
$nameBytes = @()
foreach ($ch in $PluginName.ToCharArray()) { $nameBytes += [FmcpInput]::Text($ch) }
$sent2 = [FmcpInput]::Send($nameBytes)
Start-Sleep -Milliseconds 120

if (-not (Test-Focus "after-name")) {
  Restore-Previous
  Out-Result ([ordered]@{
    ok = $false; stage = "focus-lost-after-name"; keystrokesSent = 2; raised = $raised
    timeline = $timeline; strayRisk = $false; restored = $raised
    note = "Enter was withheld — the name cannot submit itself."
  })
}

$enterInputs = @([FmcpInput]::Vk($VK_RETURN, $false), [FmcpInput]::Vk($VK_RETURN, $true))
$sent3 = [FmcpInput]::Send($enterInputs)

$fgEnd = Get-ForegroundInfo
Out-Result ([ordered]@{
  ok = $true; stage = "sent"; chord = $Chord; raised = $raised
  setForegroundReturned = $setOk
  foregroundBefore = $foreground0
  foregroundAfter = $fgEnd
  idleMsAtStart = $idleMs0
  keystrokesSent = 3
  batchesDelivered = @(($sent1 -eq 4), ($sent2 -eq $PluginName.Length), ($sent3 -eq 2))
  timeline = $timeline
  # The name was verified to be going to Figma immediately before it was sent.
  # If focus moved in that window, this flags it — measure.mjs counts a stray.
  strayRisk = ($fgEnd.pid -ne $figma.Id)
})
