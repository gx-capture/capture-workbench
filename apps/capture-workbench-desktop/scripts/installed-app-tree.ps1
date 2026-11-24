# The installed QA app's process tree, used by installed-capture-lifecycle.ts:
# the app root and its descendants, every process whose executable lies under
# the run root, and the WebView2 processes that use the run's own user-data
# directory.
#   inventory: one snapshot of that tree. With -AppPid alone, the running app
#     root's creation time is read from the snapshot and returned.
#   close: opens a handle to every process of the tree, sends the app's main
#     window the message its title bar's close button sends (WM_SYSCOMMAND /
#     SC_CLOSE), starts one snapshot at each of -SampleAfterMs after the message,
#     and then reads each process's exit time from the handle it opened before
#     the message. The kernel records that time (GetProcessTimes), so it is
#     exact and does not depend on when it is read. A process whose handle
#     could not be opened is reported without an exit time; only the snapshots
#     cover it. Each snapshot reports when its inventory started and returned;
#     a snapshot shows a process gone only from the time its inventory
#     returned, so the caller schedules each one ahead of the time it is for.
#     Every time is reported in milliseconds as measured, not rounded.
# A creation time is a Windows FILETIME (100 ns since 1601), above
# JavaScript's safe integers, so it travels as a decimal string both ways.
# Prints one JSON line; never prints paths or command lines.
param(
  [Parameter(Mandatory = $true)][ValidateSet('inventory', 'close')][string]$Action,
  [Parameter(Mandatory = $true)][string]$RunRoot,
  [Parameter(Mandatory = $true)][string]$WebViewDataDirectory,
  [int]$AppPid = 0,
  [string]$AppCreatedFileTime = '',
  [string]$SampleAfterMs = '500,4500,14500'
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class CaptureProcessHandles {
  const uint SYNCHRONIZE = 0x00100000, QUERY_LIMITED_INFORMATION = 0x1000;
  // A CIM creation time is exact to the microsecond; allow one millisecond.
  const long CREATION_TOLERANCE = 10000;
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long fileTime);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);

  public static long Now() { long now; GetSystemTimePreciseAsFileTime(out now); return now; }

  // A handle to the process, or zero when it cannot be opened or its PID now
  // belongs to a process created at another time.
  public static IntPtr Open(int pid, long expectedCreation) {
    IntPtr h = OpenProcess(SYNCHRONIZE | QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return IntPtr.Zero;
    long creation, exit, kernel, user;
    if (!GetProcessTimes(h, out creation, out exit, out kernel, out user) || Math.Abs(creation - expectedCreation) > CREATION_TOLERANCE) {
      CloseHandle(h);
      return IntPtr.Zero;
    }
    return h;
  }

  // The exit time as a FILETIME, or zero while the process still runs.
  public static long ExitTime(IntPtr h) {
    if (WaitForSingleObject(h, 0) != 0) return 0;
    long creation, exit, kernel, user;
    return GetProcessTimes(h, out creation, out exit, out kernel, out user) ? exit : 0;
  }

  public static void Close(IntPtr h) { CloseHandle(h); }
}
'@

$unixEpochFileTime = 116444736000000000
$root = [IO.Path]::GetFullPath($RunRoot).TrimEnd('\') + '\'
$webView = [IO.Path]::GetFullPath($WebViewDataDirectory).TrimEnd('\')

function Get-CreatedFileTime($process) {
  if ($null -eq $process.CreationDate) { return [long]0 }
  return [long]$process.CreationDate.ToFileTimeUtc()
}

function Test-UnderRunRoot($process) {
  $path = $process.ExecutablePath
  return -not [string]::IsNullOrWhiteSpace($path) -and ([IO.Path]::GetFullPath($path)).StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
}

# The run's processes in one CIM snapshot. Descendants are found from the app
# root's PID and creation time, so they are still found after the root exits;
# a child created before the root is a reused PID, not a descendant.
function Get-RunProcesses([int]$rootPid, [long]$rootCreated) {
  $all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate)
  $byParent = @{}
  foreach ($p in $all) {
    $key = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($key)) { $byParent[$key] = New-Object System.Collections.ArrayList }
    [void]$byParent[$key].Add($p)
  }
  $reasons = @{}
  if ($rootPid -gt 0 -and $rootCreated -gt 0) {
    $rootProcess = $all | Where-Object { [int]$_.ProcessId -eq $rootPid -and [Math]::Abs((Get-CreatedFileTime $_) - $rootCreated) -le 10000 }
    if ($rootProcess) { $reasons[$rootPid] = 'app-root' }
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($rootPid)
    while ($queue.Count -gt 0) {
      $parent = [int]$queue.Dequeue()
      if (-not $byParent.ContainsKey($parent)) { continue }
      foreach ($child in $byParent[$parent]) {
        $id = [int]$child.ProcessId
        if ((Get-CreatedFileTime $child) -lt $rootCreated) { continue }
        if (-not $reasons.ContainsKey($id)) { $reasons[$id] = 'descendant'; $queue.Enqueue($id) }
      }
    }
  }
  foreach ($p in $all) {
    $id = [int]$p.ProcessId
    if ($reasons.ContainsKey($id)) { continue }
    if (Test-UnderRunRoot $p) { $reasons[$id] = 'under-run-root'; continue }
    if ($p.Name -eq 'msedgewebview2.exe' -and $p.CommandLine -and $p.CommandLine.IndexOf($webView, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $reasons[$id] = 'run-webview2'
    }
  }
  return @(foreach ($p in $all) {
    $id = [int]$p.ProcessId
    if (-not $reasons.ContainsKey($id)) { continue }
    [pscustomobject]@{
      pid = $id
      ppid = [int]$p.ParentProcessId
      name = [string]$p.Name
      reason = $reasons[$id]
      created = Get-CreatedFileTime $p
    }
  })
}

# A function that returns an empty array returns $null; `foreach` over $null
# runs zero times, where piping $null would run once.
function Get-Summary($processes) {
  return @(foreach ($p in $processes) { [pscustomobject]@{ pid = $p.pid; name = $p.name; reason = $p.reason } })
}

if ($Action -eq 'inventory') {
  $rootCreated = [long]0
  if ($AppCreatedFileTime) {
    $rootCreated = [long]::Parse($AppCreatedFileTime, [Globalization.CultureInfo]::InvariantCulture)
  } elseif ($AppPid -gt 0) {
    $running = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$AppPid"
    if ($running) { $rootCreated = Get-CreatedFileTime $running }
  }
  [pscustomobject]@{
    ok = $true
    action = 'inventory'
    appCreatedFileTime = $(if ($rootCreated -gt 0) { [string]$rootCreated } else { $null })
    processes = @(Get-Summary (Get-RunProcesses $AppPid $rootCreated))
  } | ConvertTo-Json -Compress -Depth 5
  exit 0
}

if ($AppPid -le 0) { '{"ok":false,"reason":"app-pid-missing"}'; exit 2 }
$samples = @($SampleAfterMs -split ',' | ForEach-Object { [int]$_ } | Sort-Object)
$appProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$AppPid"
if (-not $appProcess) { '{"ok":false,"reason":"app-not-running"}'; exit 3 }
$appCreated = Get-CreatedFileTime $appProcess
$before = @(Get-RunProcesses $AppPid $appCreated)
$handles = @{}
foreach ($p in $before) { $handles[$p.pid] = [CaptureProcessHandles]::Open($p.pid, $p.created) }
try {
  $window = (Get-Process -Id $AppPid).MainWindowHandle
  if ($window -eq [IntPtr]::Zero) { '{"ok":false,"reason":"no-main-window"}'; exit 3 }
  $sent = [CaptureProcessHandles]::Now()
  # WM_SYSCOMMAND / SC_CLOSE: what the title bar's close button sends.
  if (-not [CaptureProcessHandles]::PostMessage($window, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero)) {
    '{"ok":false,"reason":"close-message-not-posted"}'; exit 3
  }
  $snapshots = @(foreach ($afterMs in $samples) {
    $waitMs = [int][Math]::Ceiling((($sent + [long]$afterMs * 10000) - [CaptureProcessHandles]::Now()) / 10000)
    if ($waitMs -gt 0) { Start-Sleep -Milliseconds $waitMs }
    $started = [CaptureProcessHandles]::Now()
    $processes = @(Get-Summary (Get-RunProcesses $AppPid $appCreated))
    # The snapshot is good only for the time its inventory returned.
    $completed = [CaptureProcessHandles]::Now()
    [pscustomobject]@{
      afterCloseMs = $afterMs
      startedAfterCloseMs = ($started - $sent) / 10000
      completedAfterCloseMs = ($completed - $sent) / 10000
      processes = $processes
    }
  })
  $observed = @(foreach ($p in $before) {
    $handle = $handles[$p.pid]
    $exit = if ($handle -ne [IntPtr]::Zero) { [CaptureProcessHandles]::ExitTime($handle) } else { [long]0 }
    [pscustomobject]@{
      pid = $p.pid
      name = $p.name
      reason = $p.reason
      handleOpened = $handle -ne [IntPtr]::Zero
      exitedAfterCloseMs = $(if ($exit -gt 0) { ($exit - $sent) / 10000 } else { $null })
    }
  })
  [pscustomobject]@{
    ok = $true
    action = 'close'
    closeSentAtUnixMs = [long](($sent - $unixEpochFileTime) / 10000)
    appCreatedFileTime = [string]$appCreated
    beforeClose = $observed
    samples = $snapshots
  } | ConvertTo-Json -Compress -Depth 5
} finally {
  foreach ($handle in $handles.Values) { if ($handle -ne [IntPtr]::Zero) { [CaptureProcessHandles]::Close($handle) } }
}
