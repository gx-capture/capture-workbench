# Native input for the installed QA app's own window, used by
# installed-capture-lifecycle.ts. `activate` brings the app's main window to
# the foreground; `key` sends F5 or Ctrl+R to it.
# The QA app is identified by its PID and process creation time (a FILETIME
# as a decimal string), never by a window title. Input is sent only when the
# foreground window belongs to that process: the process identity is checked
# first, and the foreground window's owner is read as the last operation
# before the keys go out. Each key's down and up events go out in one
# SendInput batch, and the foreground owner is read again right after; if it
# changed, the input may have reached another window and the helper fails so
# that nothing further is sent. Activation itself sends no input.
# Prints one JSON line; never prints paths or command lines.
param(
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$AppCreatedFileTime,
  [Parameter(Mandatory = $true)][ValidateSet('activate', 'key')][string]$Action,
  [ValidateSet('F5', 'CtrlR')][string]$Key = ''
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class CaptureWindowInput {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x0002, QUERY_LIMITED_INFORMATION = 0x1000;
  // A creation time read through CIM is exact to the microsecond; allow one millisecond.
  const long CREATION_TOLERANCE = 10000;

  // Whether the PID is the process created at the given FILETIME.
  public static bool IsProcess(uint pid, long creation) {
    IntPtr h = OpenProcess(QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return false;
    try {
      long created, exit, kernel, user;
      return GetProcessTimes(h, out created, out exit, out kernel, out user) && Math.Abs(created - creation) <= CREATION_TOLERANCE;
    } finally {
      CloseHandle(h);
    }
  }

  // Whether the foreground window's owner is the PID; reads nothing else.
  static bool ForegroundOwner(uint appPid) {
    IntPtr foreground = GetForegroundWindow();
    if (foreground == IntPtr.Zero) return false;
    uint owner;
    GetWindowThreadProcessId(foreground, out owner);
    return owner == appPid;
  }

  // Whether the foreground window belongs to the QA app's process: the
  // process identity first, the foreground owner last.
  public static bool ForegroundOwnedBy(uint appPid, long appCreation) {
    return IsProcess(appPid, appCreation) && ForegroundOwner(appPid);
  }

  // Asks Windows to bring the window to the foreground; sends no input.
  public static void Activate(IntPtr h) {
    if (IsIconic(h)) ShowWindowAsync(h, 9);
    uint pid;
    uint target = GetWindowThreadProcessId(h, out pid);
    uint current = GetCurrentThreadId();
    IntPtr foreground = GetForegroundWindow();
    uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out pid);
    bool attachedTarget = false, attachedForeground = false;
    try {
      if (target != current) attachedTarget = AttachThreadInput(current, target, true);
      if (foregroundThread != 0 && foregroundThread != current && foregroundThread != target) {
        attachedForeground = AttachThreadInput(current, foregroundThread, true);
      }
      BringWindowToTop(h);
      SetForegroundWindow(h);
    } finally {
      if (attachedForeground) AttachThreadInput(current, foregroundThread, false);
      if (attachedTarget) AttachThreadInput(current, target, false);
    }
    System.Threading.Thread.Sleep(150);
  }

  static INPUT Key(ushort virtualKey, bool up) {
    var input = new INPUT { type = INPUT_KEYBOARD };
    input.u.ki = new KEYBDINPUT { wVk = virtualKey, dwFlags = up ? KEYEVENTF_KEYUP : 0 };
    return input;
  }

  // Presses the keys in order and releases them in reverse, in one batch.
  // 0: sent while the app owned the foreground before and after;
  // 1: the app did not own the foreground, nothing was sent;
  // 2: Windows did not insert every event;
  // 3: the foreground owner changed while the keys were sent.
  public static int SendKeys(uint appPid, long appCreation, ushort[] keys) {
    var inputs = new INPUT[keys.Length * 2];
    for (int i = 0; i < keys.Length; i++) {
      inputs[i] = Key(keys[i], false);
      inputs[inputs.Length - 1 - i] = Key(keys[i], true);
    }
    int size = Marshal.SizeOf(typeof(INPUT));
    if (!IsProcess(appPid, appCreation)) return 1;
    // The last operation before the keys go out, and the first after.
    if (!ForegroundOwner(appPid)) return 1;
    uint inserted = SendInput((uint)inputs.Length, inputs, size);
    bool stillOwned = ForegroundOwner(appPid);
    if (inserted != inputs.Length) return 2;
    return stillOwned && IsProcess(appPid, appCreation) ? 0 : 3;
  }
}
'@

function Write-Result($value) { $value | ConvertTo-Json -Compress }

$created = [long]::Parse($AppCreatedFileTime, [Globalization.CultureInfo]::InvariantCulture)
if (-not [CaptureWindowInput]::IsProcess([uint32]$AppPid, $created)) {
  Write-Result @{ ok = $false; reason = 'app-process-changed' }; exit 3
}
$handle = (Get-Process -Id $AppPid).MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { Write-Result @{ ok = $false; reason = 'no-main-window' }; exit 2 }
if (-not [CaptureWindowInput]::ForegroundOwnedBy([uint32]$AppPid, $created)) { [CaptureWindowInput]::Activate($handle) }
if (-not [CaptureWindowInput]::ForegroundOwnedBy([uint32]$AppPid, $created)) {
  Write-Result @{ ok = $false; reason = 'foreground-not-owned' }; exit 3
}
if ($Action -eq 'activate') { Write-Result @{ ok = $true; action = 'activate' }; exit 0 }

if (-not $Key) { Write-Result @{ ok = $false; reason = 'key-missing' }; exit 2 }
# F5 alone; Ctrl down, R down, R up, Ctrl up.
$keys = if ($Key -eq 'F5') { [uint16[]]@(0x74) } else { [uint16[]]@(0x11, 0x52) }
$outcome = [CaptureWindowInput]::SendKeys([uint32]$AppPid, $created, $keys)
switch ($outcome) {
  0 { Write-Result @{ ok = $true; action = 'key'; key = $Key; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }; exit 0 }
  1 { Write-Result @{ ok = $false; reason = 'foreground-not-owned' }; exit 3 }
  2 { Write-Result @{ ok = $false; reason = 'input-not-inserted' }; exit 4 }
  default { Write-Result @{ ok = $false; reason = 'foreground-changed-during-input' }; exit 4 }
}
