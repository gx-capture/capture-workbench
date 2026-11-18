import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Locator } from '@playwright/test';

import { appRoot } from './stage-runtime.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const NATIVE_SOURCE_DIALOG_CLASSES = ['#32770'] as const;
const NATIVE_SOURCE_BROKER_DIALOG_CLASSES = ['CabinetWClass', 'ApplicationFrameWindow'] as const;

export function windowsPowerShellExecutable(systemRoot = process.env.SystemRoot || 'C:\\Windows'): string {
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Trigger a visible WebView control with a real OS mouse event.
 *
 * Playwright's CDP click can dispatch DOM events without crossing the native
 * WebView2/Tauri input boundary. The packaged acceptance flow must open the
 * real native picker, so this helper translates the locator's client-space
 * box to screen coordinates and sends a Win32 mouse down/up pair.
 */
export function normalizedNativeClickPoint(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { readonly xRatio: number; readonly yRatio: number } {
  if (
    !Number.isFinite(viewport.width) || viewport.width <= 0 ||
    !Number.isFinite(viewport.height) || viewport.height <= 0
  ) {
    throw new Error('Native visible UI click target reported an invalid WebView viewport.');
  }
  const xRatio = (box.x + box.width / 2) / viewport.width;
  const yRatio = (box.y + box.height / 2) / viewport.height;
  if (
    !Number.isFinite(xRatio) || xRatio < 0 || xRatio > 1 ||
    !Number.isFinite(yRatio) || yRatio < 0 || yRatio > 1
  ) {
    throw new Error('Native visible UI click target has invalid viewport coordinates.');
  }
  return { xRatio, yRatio };
}

export async function nativeClickWebViewElement(
  target: Locator,
  appPid: number,
): Promise<void> {
  if (!Number.isSafeInteger(appPid) || appPid <= 0) {
    throw new Error('Native visible UI click requires the packaged Tauri process PID.');
  }
  const box = await target.boundingBox();
  if (box === null || box.width <= 0 || box.height <= 0) {
    throw new Error('Native visible UI click target is not visible.');
  }
  const viewport = await target.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  // Playwright reports CSS viewport coordinates, while the Win32 helper below
  // receives the packaged window's native client rectangle. Pass normalized
  // coordinates and map them after GetClientRect, so Windows scaling does not
  // matter. This is exact only while the layout viewport is the window's real
  // size: a caller that emulates a viewport must emulate that size.
  const { xRatio, yRatio } = normalizedNativeClickPoint(box, viewport);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class CaptureSmokeNativeMouse {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct Point { public int X; public int Y; }

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetClientRect(IntPtr handle, out Rect rect);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ClientToScreen(IntPtr handle, ref Point point);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetForegroundWindow(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  private static extern IntPtr GetAncestor(IntPtr handle, uint flags);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extraInfo);

  private static bool OwnsForeground(IntPtr handle) {
    IntPtr targetRoot = GetAncestor(handle, 2);
    return targetRoot != IntPtr.Zero && GetAncestor(GetForegroundWindow(), 2) == targetRoot;
  }

  public static void Click(IntPtr handle, double xRatio, double yRatio) {
    Rect rect;
    if (!GetClientRect(handle, out rect)) throw new InvalidOperationException("GetClientRect failed.");
    if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
      throw new InvalidOperationException("Normalized client coordinates are outside the target window.");
    }
    int clientX = (int)Math.Round(rect.Right * xRatio);
    int clientY = (int)Math.Round(rect.Bottom * yRatio);
    if (clientX < rect.Left || clientY < rect.Top || clientX >= rect.Right || clientY >= rect.Bottom) {
      throw new InvalidOperationException("Client coordinates are outside the target window.");
    }
    Point point = new Point { X = clientX, Y = clientY };
    if (!ClientToScreen(handle, ref point)) throw new InvalidOperationException("ClientToScreen failed.");
    SetForegroundWindow(handle);
    System.Threading.Thread.Sleep(100);
    // The click goes to whatever window is under the cursor, so refuse it
    // unless the packaged window really owns the foreground.
    if (!OwnsForeground(handle) || !SetCursorPos(point.X, point.Y) || !OwnsForeground(handle)) {
      throw new InvalidOperationException("Native window activation failed.");
    }
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
'@
$process = Get-Process -Id ${appPid}
$handle = $process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'Packaged Tauri process has no native window.' }
[CaptureSmokeNativeMouse]::Click($handle, ${xRatio}, ${yRatio})
`;
  try {
    execFileSync(
      windowsPowerShellExecutable(systemRoot),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      {
        env: {
          SystemRoot: systemRoot,
          Path: process.env.Path || process.env.PATH || '',
          TEMP: process.env.TEMP || '',
          TMP: process.env.TMP || '',
        },
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10_000,
      },
    );
  } catch {
    throw new Error('Native visible UI click failed.');
  }
}

export function nativeDialogUiAutomationDefinitions(): string {
  return `
$ErrorActionPreference = 'Stop'
trap {
  $exceptionType = [System.Text.RegularExpressions.Regex]::Replace($_.Exception.GetType().Name, '[^A-Za-z0-9_.#,:=-]', '_')
  $errorId = [System.Text.RegularExpressions.Regex]::Replace([string]$_.FullyQualifiedErrorId, '[^A-Za-z0-9_.#,:=-]', '_')
  Write-Output ('UIA|stage=unhandled|code=exception|type=' + $exceptionType + '|error=' + $errorId + '|line=' + [string]$_.InvocationInfo.ScriptLineNumber)
  exit 9
}
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CaptureClassicDialogOwner {
  private const uint WM_SETTEXT = 0x000C;
  private const uint WM_COMMAND = 0x0111;
  private const uint SMTO_ABORTIFHUNG = 0x0002;
  private const int IDOK = 1;
  private const int FILENAME_CONTROL_ID = 1148;

  private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

  [DllImport("user32.dll")]
  private static extern int GetDlgCtrlID(IntPtr handle);

  [DllImport("user32.dll")]
  private static extern IntPtr GetParent(IntPtr handle);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr handle, StringBuilder className, int maximumCount);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindow(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowVisible(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowEnabled(IntPtr handle);

  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, string lParam, uint flags, uint timeoutMs, out IntPtr result);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  private static string ClassName(IntPtr handle) {
    var buffer = new StringBuilder(256);
    int length = GetClassName(handle, buffer, buffer.Capacity);
    return length > 0 ? buffer.ToString() : string.Empty;
  }

  private static string SafeToken(string value) {
    if (string.IsNullOrWhiteSpace(value)) return "-";
    var builder = new StringBuilder(Math.Min(value.Length, 80));
    for (int i = 0; i < value.Length && builder.Length < 80; i++) {
      char ch = value[i];
      bool allowed = (ch >= 'A' && ch <= 'Z')
        || (ch >= 'a' && ch <= 'z')
        || (ch >= '0' && ch <= '9')
        || ch == '_' || ch == '.' || ch == '#' || ch == ',' || ch == ':' || ch == '=' || ch == '-';
      builder.Append(allowed ? ch : '_');
    }
    return builder.Length > 0 ? builder.ToString() : "-";
  }

  public static IntPtr FindDialog(uint processId, string[] allowedClasses) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((handle, _) => {
      if (handle == IntPtr.Zero || !IsWindow(handle) || !IsWindowVisible(handle)) return true;
      uint actualProcessId;
      GetWindowThreadProcessId(handle, out actualProcessId);
      if (actualProcessId != processId) return true;
      string cls = ClassName(handle);
      for (int i = 0; i < allowedClasses.Length; i++) {
        if (string.Equals(cls, allowedClasses[i], StringComparison.Ordinal)) {
          found = handle;
          return false;
        }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static IntPtr FindFilenameEdit(IntPtr dialog) {
    if (dialog == IntPtr.Zero || !IsWindow(dialog)) return IntPtr.Zero;
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (handle, _) => {
      if (!string.Equals(ClassName(handle), "Edit", StringComparison.Ordinal)) return true;
      int id = GetDlgCtrlID(handle);
      IntPtr parent = GetParent(handle);
      int parentId = parent != IntPtr.Zero ? GetDlgCtrlID(parent) : 0;
      if (id == FILENAME_CONTROL_ID || parentId == FILENAME_CONTROL_ID) {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    if (found != IntPtr.Zero) return found;

    IntPtr comboBoxEx = IntPtr.Zero;
    EnumChildWindows(dialog, (handle, _) => {
      if (string.Equals(ClassName(handle), "ComboBoxEx32", StringComparison.Ordinal)) {
        comboBoxEx = handle;
        if (GetDlgCtrlID(handle) == FILENAME_CONTROL_ID) return false;
      }
      return true;
    }, IntPtr.Zero);
    if (comboBoxEx == IntPtr.Zero) return IntPtr.Zero;

    EnumChildWindows(comboBoxEx, (handle, _) => {
      if (string.Equals(ClassName(handle), "Edit", StringComparison.Ordinal)) {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  private static IntPtr FindChildButton(IntPtr dialog, int controlId) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (handle, _) => {
      if (GetDlgCtrlID(handle) == controlId && string.Equals(ClassName(handle), "Button", StringComparison.Ordinal)) {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool SetEditText(IntPtr editHandle, string value) {
    if (editHandle == IntPtr.Zero || value == null) return false;
    IntPtr result;
    return SendMessageTimeout(editHandle, WM_SETTEXT, IntPtr.Zero, value, SMTO_ABORTIFHUNG, 5000, out result) != IntPtr.Zero;
  }
  public static bool SubmitDialog(IntPtr dialog) {
    if (dialog == IntPtr.Zero || !IsWindow(dialog)) return false;
    return PostMessage(dialog, WM_COMMAND, (IntPtr)IDOK, FindChildButton(dialog, IDOK));
  }
  public static bool IsDialogOpen(IntPtr dialog) {
    return dialog != IntPtr.Zero && IsWindow(dialog) && IsWindowVisible(dialog);
  }
  public static string[] GetDialogChildDiagnostics(IntPtr dialog) {
    var lines = new List<string>();
    if (dialog == IntPtr.Zero || !IsWindow(dialog)) return lines.ToArray();
    lines.Add("UIA|stage=dialog-info|class=" + SafeToken(ClassName(dialog))
      + "|visible=" + (IsWindowVisible(dialog) ? "true" : "false")
      + "|enabled=" + (IsWindowEnabled(dialog) ? "true" : "false"));
    EnumChildWindows(dialog, (handle, _) => {
      if (lines.Count >= 60) return false;
      lines.Add("UIA|child-id=" + GetDlgCtrlID(handle)
        + "|class=" + SafeToken(ClassName(handle))
        + "|visible=" + (IsWindowVisible(handle) ? "true" : "false")
        + "|enabled=" + (IsWindowEnabled(handle) ? "true" : "false"));
      return true;
    }, IntPtr.Zero);
    return lines.ToArray();
  }
}
'@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CaptureDialogOwner {
  public const uint GW_OWNER = 4;
  private const int SW_RESTORE = 9;
  private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
  private delegate bool EnumChildWindowsProc(IntPtr handle, IntPtr parameter);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern bool EnumChildWindows(IntPtr parent, EnumChildWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr handle, uint command);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

  [DllImport("user32.dll")]
  private static extern int GetDlgCtrlID(IntPtr handle);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr handle, StringBuilder className, int maximumCount);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindow(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowVisible(IntPtr handle);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr handle, uint flags);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindowEnabled(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsIconic(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ShowWindowAsync(IntPtr handle, int command);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool BringWindowToTop(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetForegroundWindow(IntPtr handle);

  [DllImport("user32.dll")]
  private static extern IntPtr SetActiveWindow(IntPtr handle);

  [DllImport("user32.dll")]
  private static extern IntPtr SetFocus(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool AttachThreadInput(uint firstThreadId, uint secondThreadId, bool attach);

  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentThreadId();

  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extraInfo);

  public static bool ClickAt(int x, int y) {
    if (!SetCursorPos(x, y)) return false;
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    return true;
  }

  public static long[] SnapshotTopLevelWindowHandles() {
    var handles = new List<long>();
    EnumWindows((handle, _) => {
      if (handle != IntPtr.Zero) handles.Add(handle.ToInt64());
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }

  public static long[] FindExactTopLevelWindows(uint processId, string expectedClass) {
    var handles = new List<long>();
    EnumWindows((handle, _) => {
      if (HasExactIdentity(handle, processId, expectedClass, true)) handles.Add(handle.ToInt64());
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }

  public static IntPtr FindChildControl(IntPtr parent, int controlId) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, (handle, _) => {
      if (GetDlgCtrlID(handle) == controlId) {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool ActivateWindow(IntPtr handle) {
    if (handle == IntPtr.Zero || !IsWindow(handle)) return false;
    if (IsIconic(handle)) ShowWindowAsync(handle, SW_RESTORE);
    uint targetProcessId;
    var targetThreadId = GetWindowThreadProcessId(handle, out targetProcessId);
    if (targetThreadId == 0) return false;
    var currentThreadId = GetCurrentThreadId();
    var foregroundHandle = GetForegroundWindow();
    uint foregroundProcessId;
    var foregroundThreadId = foregroundHandle == IntPtr.Zero
      ? 0
      : GetWindowThreadProcessId(foregroundHandle, out foregroundProcessId);
    var attachedTarget = false;
    var attachedForeground = false;
    try {
      if (targetThreadId != currentThreadId) {
        attachedTarget = AttachThreadInput(currentThreadId, targetThreadId, true);
      }
      if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId && foregroundThreadId != targetThreadId) {
        attachedForeground = AttachThreadInput(currentThreadId, foregroundThreadId, true);
      }
      BringWindowToTop(handle);
      SetForegroundWindow(handle);
      SetActiveWindow(handle);
      SetFocus(handle);
    } finally {
      if (attachedForeground) AttachThreadInput(currentThreadId, foregroundThreadId, false);
      if (attachedTarget) AttachThreadInput(currentThreadId, targetThreadId, false);
    }
    return GetForegroundWindow() == handle;
  }

  private static bool HasExactIdentity(IntPtr handle, uint processId, string expectedClass, bool requireUsable) {
    if (handle == IntPtr.Zero || !IsWindow(handle)) return false;
    uint actualProcessId;
    GetWindowThreadProcessId(handle, out actualProcessId);
    if (actualProcessId != processId || GetWindow(handle, GW_OWNER) != IntPtr.Zero) return false;
    if (requireUsable && (!IsWindowVisible(handle) || !IsWindowEnabled(handle))) return false;
    var className = new StringBuilder(256);
    return GetClassName(handle, className, className.Capacity) > 0 &&
      string.Equals(className.ToString(), expectedClass, StringComparison.Ordinal);
  }
}
'@

function Get-TargetMainWindowHandles {
  return [CaptureDialogOwner]::FindExactTopLevelWindows([uint32]$targetProcessId, 'Tauri Window')
}

function Get-SafeMetadata($value) {
  if ($null -eq $value) { return '-' }
  $text = [string]$value
  if ($text -match '[\\/]' -or $text -match '^[A-Za-z]:') { return 'redacted' }
  $text = [System.Text.RegularExpressions.Regex]::Replace($text, '[^A-Za-z0-9_.#,:=-]', '_')
  if ($text.Length -gt 80) { $text = $text.Substring(0, 80) }
  if ([string]::IsNullOrWhiteSpace($text)) { return '-' }
  return $text
}

function Get-PatternNames($element) {
  $patterns = @()
  foreach ($candidate in @(
    @{ Name = 'Value'; Pattern = [System.Windows.Automation.ValuePattern]::Pattern },
    @{ Name = 'Invoke'; Pattern = [System.Windows.Automation.InvokePattern]::Pattern }
  )) {
    try {
      [void]$element.GetCurrentPattern($candidate.Pattern)
      $patterns += $candidate.Name
    } catch { }
  }
  try {
    if ($element.Current.IsKeyboardFocusable) { $patterns += 'Focus' }
  } catch { }
  try {
    if ($element.Current.NativeWindowHandle -ne 0) { $patterns += 'Hwnd' }
  } catch { }
  return ($patterns -join ',')
}

function Get-ElementState($element) {
  try {
    $current = $element.Current
    return 'enabled=' + (Get-BoolMetadata ([bool]$current.IsEnabled)) + '|offscreen=' + (Get-BoolMetadata ([bool]$current.IsOffscreen))
  } catch {
    return 'enabled=-|offscreen=-'
  }
}

function Invoke-NativeElementClick($dialog, $element) {
  if ($null -eq $element) { return $false }
  try {
    $point = New-Object System.Windows.Point
    if ($element.TryGetClickablePoint([ref]$point)) {
      return (Invoke-GuardedClick $dialog ([int]$point.X) ([int]$point.Y))
    }
    # Explorer's brokered picker can expose a visible control without a
    # clickable point from its UIA provider. Its screen-space bounding rectangle
    # is still a process-owned, metadata-only native interaction target.
    $rectangle = $element.Current.BoundingRectangle
    if ($rectangle.Width -le 0 -or $rectangle.Height -le 0) { return $false }
    $x = [int][Math]::Round($rectangle.X + ($rectangle.Width / 2))
    $y = [int][Math]::Round($rectangle.Y + ($rectangle.Height / 2))
    return (Invoke-GuardedClick $dialog $x $y)
  } catch {
    return $false
  }
}

function Get-WindowProcessId([IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) { return 0 }
  [uint32]$processId = 0
  [void][CaptureDialogOwner]::GetWindowThreadProcessId($handle, [ref]$processId)
  return [int]$processId
}

function Get-Win32CommitControl([IntPtr]$dialogHandle) {
  if ($dialogHandle -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
  try { return [CaptureDialogOwner]::FindChildControl($dialogHandle, 1) } catch { return [IntPtr]::Zero }
}

function Test-OwnedByTarget([IntPtr]$handle) {
  $current = $handle
  for ($depth = 0; $depth -lt 8 -and $current -ne [IntPtr]::Zero; $depth += 1) {
    $owner = [CaptureDialogOwner]::GetWindow($current, [CaptureDialogOwner]::GW_OWNER)
    if ($owner -eq [IntPtr]::Zero) { return $false }
    if ((Get-WindowProcessId $owner) -eq $targetProcessId) { return $true }
    $current = $owner
  }
  return $false
}

function Get-ElementRelation($element) {
  try {
    $current = $element.Current
    if ([int]$current.ProcessId -eq $targetProcessId) { return 'target' }
    if (Test-OwnedByTarget ([IntPtr]$current.NativeWindowHandle)) { return 'owned' }
  } catch { }
  return 'other'
}

function Get-BrokerCandidateFacts($element) {
  $facts = @{
    ClassAllowed = $false
    DifferentProcess = $false
     BrokerProcess = $false
     PickerControls = $false
     ExplorerProcess = $false
     ForegroundBrokerProcess = $false
    Foreground = $false
    Modal = $false
    NewWindow = $false
    SingleTarget = $false
    TargetStillOwned = $false
    TargetWasEnabled = $false
    TargetDisabled = $false
    Eligible = $false
  }
  try {
    $current = $element.Current
    if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Window) { return $facts }
    $facts.ClassAllowed = $brokerDialogClasses -contains [string]$current.ClassName
    $facts.DifferentProcess = [int]$current.ProcessId -ne $targetProcessId
    $handle = [IntPtr]$current.NativeWindowHandle
    if ($handle -eq [IntPtr]::Zero) { return $facts }
    $facts.NewWindow = -not $baselineWindowHandles.Contains([long]$handle.ToInt64())
     $facts.Foreground = [CaptureDialogOwner]::GetForegroundWindow() -eq $handle
     $foregroundHandle = [CaptureDialogOwner]::GetForegroundWindow()
     $facts.ForegroundBrokerProcess = (Get-WindowProcessId $foregroundHandle) -eq [int]$current.ProcessId
    $facts.SingleTarget = $targetMainWindowHandles.Count -eq 1
    $facts.TargetWasEnabled = $targetMainWindowWasEnabled
    if ($facts.SingleTarget) {
      $targetHandle = [IntPtr]$targetMainWindowHandles[0]
      $facts.TargetStillOwned = (Get-WindowProcessId $targetHandle) -eq $targetProcessId
      if ($facts.TargetStillOwned) {
        $facts.TargetDisabled = -not [CaptureDialogOwner]::IsWindowEnabled($targetHandle)
      }
    }
    try {
      $processName = [System.Diagnostics.Process]::GetProcessById([int]$current.ProcessId).ProcessName
      $facts.ExplorerProcess = $processName -ceq 'explorer'
      # Windows 11 can host the same IFileOpenDialog surface in Explorer or
      # the system picker broker. Keep the process boundary explicit while
      # allowing only the known native broker executables.
      $facts.BrokerProcess = @('explorer', 'ApplicationFrameHost', 'PickerHost') -contains $processName
    } catch { }
    try {
      $windowPattern = $element.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
      $facts.Modal = [bool]$windowPattern.Current.IsModal
    } catch { }
    try {
      $textBoxCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
        'TextBox'
      )
      $facts.PickerControls = $null -ne $element.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $textBoxCondition
      )
    } catch { }
    $facts.Eligible = $facts.ClassAllowed -and
      $facts.DifferentProcess -and
      $facts.BrokerProcess -and
      $facts.PickerControls -and
      $facts.SingleTarget -and
      $facts.TargetStillOwned -and
       $facts.TargetWasEnabled -and
       (
         $facts.TargetDisabled -or $facts.ForegroundBrokerProcess
       ) -and
       (
         ($facts.ForegroundBrokerProcess -and $facts.PickerControls) -or
         # Windows 11 can reuse the existing Explorer shell window for the
        # brokered picker. The target being disabled is the ownership signal
        # in that form; Find-FilenameTarget/Find-OpenTarget still gate the
        # actual interaction on the picker controls.
         ($facts.NewWindow -and $facts.Foreground -and $facts.Modal)
       )
  } catch { }
  return $facts
}

function Test-BrokeredDialog($element) {
  $facts = Get-BrokerCandidateFacts $element
  return [bool]$facts.Eligible
}

function Find-ByAutomationId($element, [string]$automationId) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $automationId
  )
  return $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Get-ValueAction($element) {
  if ($null -eq $element) { return $null }
  try {
    return @{ Kind = 'Value'; Pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) }
  } catch { }
  try {
    if ($element.Current.IsKeyboardFocusable) { return @{ Kind = 'Keyboard'; Pattern = $null } }
  } catch { }
  return $null
}

function Get-InvokeAction($element) {
  if ($null -eq $element) { return $null }
  try {
    return @{ Kind = 'Invoke'; Pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) }
  } catch { }
  try {
    if ($element.Current.IsKeyboardFocusable) { return @{ Kind = 'Keyboard'; Pattern = $null } }
  } catch { }
  return $null
}

function ConvertTo-SendKeysLiteral([string]$value) {
  $builder = New-Object System.Text.StringBuilder
  foreach ($character in $value.ToCharArray()) {
    switch ($character) {
      '+' { [void]$builder.Append('{+}') }
      '^' { [void]$builder.Append('{^}') }
      '%' { [void]$builder.Append('{%}') }
      '~' { [void]$builder.Append('{~}') }
      '(' { [void]$builder.Append('{(}') }
      ')' { [void]$builder.Append('{)}') }
      '{' { [void]$builder.Append('{{}') }
      '}' { [void]$builder.Append('{}}') }
      default { [void]$builder.Append($character) }
    }
  }
  return $builder.ToString()
}

function Invoke-RawKeySend([string]$value) {
  [System.Windows.Forms.SendKeys]::SendWait($value)
}

function Invoke-RawClick([int]$x, [int]$y) {
  return [CaptureDialogOwner]::ClickAt($x, $y)
}

function Get-NativeRoot([IntPtr]$handle) {
  return [CaptureDialogOwner]::GetAncestor($handle, 2)
}

function Get-ForegroundRoot {
  return Get-NativeRoot ([CaptureDialogOwner]::GetForegroundWindow())
}

function Invoke-PickerActivation([IntPtr]$handle) {
  return [CaptureDialogOwner]::ActivateWindow($handle)
}

function Test-TargetEnabled {
  return [CaptureDialogOwner]::IsWindowEnabled($targetHandle)
}

function Test-PickerInputOwnership($dialog) {
  try {
    $handle = [IntPtr]$dialog.Current.NativeWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
      $pickerRoot = Get-NativeRoot $handle
      if ($pickerRoot -ne [IntPtr]::Zero) {
        if ((Get-ForegroundRoot) -eq $pickerRoot) { return $true }
        try { [void](Invoke-PickerActivation $handle) } catch { }
        if ((Get-ForegroundRoot) -eq $pickerRoot) { return $true }
      }
    }
  } catch { }
  $script:pickerInputRefused = $true
  Write-Host 'UIA|stage=input-guard|code=foreground-not-owned'
  return $false
}

function Invoke-GuardedKeys($dialog, [string]$value) {
  if (-not (Test-PickerInputOwnership $dialog)) { return $false }
  Invoke-RawKeySend $value
  return $true
}

function Invoke-GuardedClick($dialog, [int]$x, [int]$y) {
  if (-not (Test-PickerInputOwnership $dialog)) { return $false }
  return Invoke-RawClick $x $y
}

function Get-LegacyInvokeAction($element) {
  if ($null -eq $element) { return $null }
  try {
    return @{ Kind = 'LegacyInvoke'; Pattern = $element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern) }
  } catch { }
  return $null
}

function Get-ElementRectangle($element) {
  if ($null -eq $element) { return $null }
  try {
    $rectangle = $element.Current.BoundingRectangle
    if ($rectangle.Width -le 0 -or $rectangle.Height -le 0) { return $null }
    return [pscustomobject]@{
      X = [double]$rectangle.X
      Y = [double]$rectangle.Y
      Width = [double]$rectangle.Width
      Height = [double]$rectangle.Height
    }
  } catch {
    return $null
  }
}

function Get-SelectionAction($element) {
  if ($null -eq $element) { return $null }
  try {
    return @{ Kind = 'Select'; Pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern) }
  } catch { }
  return $null
}

function Get-SelectionState($element) {
  if ($null -eq $element) { return 'unknown' }
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    return (Get-BoolMetadata ([bool]$pattern.Current.IsSelected))
  } catch {
    return 'unknown'
  }
}

function Find-OpenTarget($dialog) {
  # Classic common dialogs expose the affirmative action as id=1. The Windows
  # 11 brokered picker also exposes an unrelated toolbar AddButton near the
  # top-right corner; do not mistake that toolbar control for the commit.
  foreach ($automationId in @('1')) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $automationId
    )
    $buttons = $dialog.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $condition
    )
    foreach ($button in $buttons) {
      try {
        $current = $button.Current
        if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Button -and $current.ClassName -notmatch 'Button') { continue }
        if (-not [bool]$current.IsEnabled) { continue }
      } catch { continue }
      $action = Get-InvokeAction $button
      if ($null -ne $action) {
        $rectangle = Get-ElementRectangle $button
        if ($null -ne $rectangle) { return @{ Element = $button; Action = $action } }
      }
      try {
        if ($button.Current.NativeWindowHandle -ne 0) {
          return @{ Element = $button; Action = @{ Kind = 'Win32Click'; Handle = [IntPtr]$button.Current.NativeWindowHandle } }
        }
      } catch { }
    }
  }

  $dialogRectangle = Get-ElementRectangle $dialog
  if ($null -eq $dialogRectangle) { return $null }
  $candidates = @()
  $buttons = $dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    )
  )
  foreach ($button in $buttons) {
    try {
      if (-not [bool]$button.Current.IsEnabled) { continue }
    } catch { continue }
    $rectangle = Get-ElementRectangle $button
    if ($null -eq $rectangle) { continue }
    $action = Get-InvokeAction $button
    if ($null -eq $action) { continue }
    if ($rectangle.Y -lt ($dialogRectangle.Y + ($dialogRectangle.Height * 0.65))) { continue }
    if ($rectangle.X -lt ($dialogRectangle.X + ($dialogRectangle.Width * 0.45))) { continue }
    $candidates += [pscustomobject]@{
      Element = $button
      Action = $action
      X = $rectangle.X
      Y = $rectangle.Y
    }
  }
  if ($candidates.Count -eq 0) { return $null }
  $bottomY = ($candidates | Measure-Object -Property Y -Maximum).Maximum
  $bottomRow = @($candidates | Where-Object { $_.Y -ge ($bottomY - 60) } | Sort-Object X)
  if ($bottomRow.Count -gt 0) { return @{ Element = $bottomRow[0].Element; Action = $bottomRow[0].Action } }
  return $null
}

 $script:BrokeredListProbeWritten = $false

function Find-BrokeredFileTarget($dialog) {
  $targetName = [System.IO.Path]::GetFileName($env:CAPTURE_SMOKE_DIALOG_FILE)
  if ([string]::IsNullOrWhiteSpace($targetName)) { return $null }
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $targetName
  )
  $items = $dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
  )
  if (-not $script:BrokeredListProbeWritten) {
    $listCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::ListItem
    )
    $listItems = $dialog.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $listCondition
    )
    # Write-Host: this function's pipeline output is its return value.
    Write-Host ('UIA|stage=brokered-list|code=observed|count=' + [string]$listItems.Count + '|matches=' + [string]$items.Count)
    $script:BrokeredListProbeWritten = $true
  }
  foreach ($item in $items) {
    try {
      if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem) { continue }
    } catch { continue }
    $action = Get-SelectionAction $item
    if ($null -ne $action) { return @{ Element = $item; Action = $action } }
    $action = Get-InvokeAction $item
    if ($null -ne $action) { return @{ Element = $item; Action = $action } }
  }
  return $null
}

function Invoke-BrokeredItemClick($dialog, $itemElement) {
  if ($null -eq $itemElement) { return $false }
  if (Invoke-NativeElementClick $dialog $itemElement) { return $true }
  try {
    $nodes = $itemElement.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($node in $nodes) {
      try {
        if (-not [bool]$node.Current.IsEnabled -or [bool]$node.Current.IsOffscreen) { continue }
        $rectangle = Get-ElementRectangle $node
        if ($null -eq $rectangle) { continue }
        if (Invoke-NativeElementClick $dialog $node) { return $true }
      } catch { }
    }
  } catch { }
  return $false
}

function Invoke-BrokeredPicker($dialog) {
  Write-Output 'UIA|stage=brokered-flow|code=entered'
  $filename = Find-ByAutomationId $dialog 'TextBox'
  if ($null -eq $filename) {
    Write-Output 'UIA|stage=brokered-flow|code=textbox-missing'
    return $false
  }
  $action = Get-ValueAction $filename
  if ($null -eq $action -or $action.Kind -ne 'Value') {
    Write-Output 'UIA|stage=brokered-flow|code=textbox-value-missing'
    return $false
  }
  $directory = [System.IO.Path]::GetDirectoryName($env:CAPTURE_SMOKE_DIALOG_FILE)
  if ([string]::IsNullOrWhiteSpace($directory)) {
    Write-Output 'UIA|stage=brokered-flow|code=directory-missing'
    return $false
  }

  # The brokered Windows 11 picker exposes the current folder breadcrumb as a
  # TextBox. Navigate through the focused picker with SendKeys, then select the
  # exact fixture ListItem and acknowledge the picker commit control. The
  # path/name is used only as an input to UIA and never emitted in diagnostics.
  try { $dialog.SetFocus() } catch { }
  try { $filename.SetFocus() } catch { }
  if (-not (Invoke-GuardedKeys $dialog '^l')) { return $false }
  Start-Sleep -Milliseconds 100
  if (-not (Invoke-GuardedKeys $dialog '^a')) { return $false }
  if (-not (Invoke-GuardedKeys $dialog (ConvertTo-SendKeysLiteral $directory))) { return $false }
  if (-not (Invoke-GuardedKeys $dialog '{ENTER}')) { return $false }
  $itemDeadline = [DateTime]::UtcNow.AddSeconds(10)
  $item = $null
  while ([DateTime]::UtcNow -lt $itemDeadline) {
    $item = Find-BrokeredFileTarget $dialog
    if ($null -ne $item) { break }
    Start-Sleep -Milliseconds 100
  }
  if ($null -eq $item) {
    Write-Output 'UIA|stage=brokered-file|code=missing'
    return $false
  }
  Write-Output 'UIA|stage=brokered-file|code=found'
  # The address TextBox is first used for directory navigation. A full-path
  # commit is attempted only after the exact fixture item is observed; if the
  # provider refreshes, the item is reacquired before any item signal.
  $dialogHandle = [IntPtr]$dialog.Current.NativeWindowHandle
  try {
    $action.Pattern.SetValue($env:CAPTURE_SMOKE_DIALOG_FILE)
    try { $filename.SetFocus() } catch { }
    [void](Invoke-GuardedKeys $dialog '{ENTER}')
    Write-Output 'UIA|stage=brokered-file|code=full-path-commit'
    $fullPathDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $fullPathDeadline) {
      if (Test-TargetEnabled) { exit 0 }
      if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
        Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-full-path'
        exit 0
      }
      Start-Sleep -Milliseconds 100
    }
    $refreshedItem = Find-BrokeredFileTarget $dialog
    if ($null -ne $refreshedItem) { $item = $refreshedItem }
  } catch {
    Write-Output 'UIA|stage=brokered-file|code=full-path-commit-failed'
  }
  if ($item.Action.Kind -eq 'Select') {
    $item.Action.Pattern.Select()
  } elseif ($item.Action.Kind -eq 'Invoke') {
    $item.Action.Pattern.Invoke()
  }
  Write-Output 'UIA|stage=brokered-file|code=selected'
  Write-Output ('UIA|stage=brokered-file|code=selection-state|selected=' + (Get-SelectionState $item.Element))
  $nativeItemClicked = Invoke-BrokeredItemClick $dialog $item.Element
  Write-Output ('UIA|stage=brokered-file|code=native-click|result=' + (Get-BoolMetadata $nativeItemClicked))
  Start-Sleep -Milliseconds 250
  if (Test-TargetEnabled) { exit 0 }
  if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
    Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-item-click'
    exit 0
  }
  try { $item.Element.SetFocus() } catch { }
  [void](Invoke-GuardedKeys $dialog '{ENTER}')
  Write-Output 'UIA|stage=brokered-file|code=keyboard-commit'
  $keyboardCommitDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $keyboardCommitDeadline) {
    if (Test-TargetEnabled) { exit 0 }
    if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
      Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-keyboard-commit'
      exit 0
    }
    Start-Sleep -Milliseconds 100
  }
  # The multiple-file broker can expose the list item without a
  # SelectionItemPattern. Ctrl+A is the non-localized native selection signal
  # for the current folder; with the isolated fixture directory it selects
  # exactly the verified fixture before Enter commits the picker.
  [void](Invoke-GuardedKeys $dialog '^a')
  Start-Sleep -Milliseconds 150
  [void](Invoke-GuardedKeys $dialog '{ENTER}')
  Write-Output 'UIA|stage=brokered-file|code=select-all-commit'
  $selectAllDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $selectAllDeadline) {
    if (Test-TargetEnabled) { exit 0 }
    if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
      Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-select-all'
      exit 0
    }
    Start-Sleep -Milliseconds 100
  }
  $win32CommitControl = Get-Win32CommitControl $dialogHandle
  if ($win32CommitControl -ne [IntPtr]::Zero) {
    Write-Output 'UIA|stage=brokered-win32|code=commit-control-found'
    $messageResult = [IntPtr]::Zero
    $sent = [CaptureDialogOwner]::SendMessageTimeout(
      $win32CommitControl,
      0x00F5,
      [IntPtr]::Zero,
      [IntPtr]::Zero,
      0x0002,
      2000,
      [ref]$messageResult
    )
    Write-Output ('UIA|stage=brokered-win32|code=commit-control-click|result=' + (Get-BoolMetadata ($sent -ne [IntPtr]::Zero)))
    $win32Deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $win32Deadline) {
      if (Test-TargetEnabled) { exit 0 }
      if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
        Write-Output 'UIA|stage=brokered-win32|code=dialog-closed-after-commit-control'
        exit 0
      }
      Start-Sleep -Milliseconds 100
    }
  }
  $itemInvoke = Get-InvokeAction $item.Element
  if ($null -ne $itemInvoke) {
    $itemInvoke.Pattern.Invoke()
    Start-Sleep -Milliseconds 500
    if (Test-TargetEnabled) { exit 0 }
    if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
      Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-item-invoke'
      exit 0
    }
  }
  $itemLegacyInvoke = Get-LegacyInvokeAction $item.Element
  if ($null -ne $itemLegacyInvoke) {
    try {
      $itemLegacyInvoke.Pattern.DoDefaultAction()
      Write-Output 'UIA|stage=brokered-file|code=legacy-default-action'
      Start-Sleep -Milliseconds 500
      if (Test-TargetEnabled) { exit 0 }
      if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
        Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-legacy-action'
        exit 0
      }
    } catch {
      Write-Output 'UIA|stage=brokered-file|code=legacy-default-action-failed'
    }
  }
  Write-Output 'UIA|stage=brokered-controls|code=observed'
  Write-DialogDiagnostics $dialog $relation
  Write-ProcessButtonDiagnostics ([int]$dialog.Current.ProcessId)
  $open = Find-OpenTarget $dialog
  if ($null -eq $open) {
    Write-Output 'UIA|stage=brokered-add|code=missing'
    return $false
  }
  Write-ElementDiagnostics 'UIA' $open.Element 'brokered-add-target'
  $nativeClicked = Invoke-NativeElementClick $dialog $open.Element
  Write-Output ('UIA|stage=brokered-add|code=native-click|result=' + (Get-BoolMetadata $nativeClicked))
  Start-Sleep -Milliseconds 250
  if (Test-TargetEnabled) { exit 0 }
  if ($open.Action.Kind -eq 'Invoke') {
    try { $open.Element.SetFocus() } catch { }
    $open.Action.Pattern.Invoke()
    Start-Sleep -Milliseconds 150
    if (-not (Test-TargetEnabled)) {
      [void](Invoke-GuardedKeys $dialog '{ENTER}')
    }
  } elseif ($open.Action.Kind -eq 'Keyboard') {
    $open.Element.SetFocus()
    [void](Invoke-GuardedKeys $dialog '{ENTER}')
  } else {
    $messageResult = [IntPtr]::Zero
    $sent = [CaptureDialogOwner]::SendMessageTimeout($open.Action.Handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 2000, [ref]$messageResult)
    if ($sent -eq [IntPtr]::Zero) { return $false }
  }
  Write-Output 'UIA|stage=brokered-add|code=invoked'
  $retryClick = $false
  Start-Sleep -Milliseconds 250
  if (-not (Test-TargetEnabled)) {
      $retryClick = Invoke-NativeElementClick $dialog $open.Element
    Write-Output ('UIA|stage=brokered-add|code=native-click-retry|result=' + (Get-BoolMetadata $retryClick))
  }
  $dialogDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $dialogDeadline) {
    if (Test-TargetEnabled) { exit 0 }
    Start-Sleep -Milliseconds 100
  }
  Write-Output 'UIA|stage=brokered-add|code=timeout'
  Write-DialogDiagnostics $dialog $relation
  return $false
}

function Invoke-BrokeredPickerKeyboardFallback($dialog) {
  if (Test-TargetEnabled) { return $false }
  # The Windows 11 broker can expose only the existing Explorer shell window
  # through UIA. Alt+N reaches the file-name field in the common dialog, while
  # the second Enter also covers the brokered picker after it resolves the
  # selected path. No text is logged by this fallback.
  if (-not (Invoke-GuardedKeys $dialog '%n')) { return $false }
  Start-Sleep -Milliseconds 100
  if (-not (Invoke-GuardedKeys $dialog (ConvertTo-SendKeysLiteral $env:CAPTURE_SMOKE_DIALOG_FILE))) { return $false }
  if (-not (Invoke-GuardedKeys $dialog '{ENTER}')) { return $false }
  Start-Sleep -Milliseconds 250
  if (-not (Test-TargetEnabled)) {
    if (-not (Invoke-GuardedKeys $dialog '^l')) { return $false }
    Start-Sleep -Milliseconds 100
    if (-not (Invoke-GuardedKeys $dialog (ConvertTo-SendKeysLiteral $env:CAPTURE_SMOKE_DIALOG_FILE))) { return $false }
    if (-not (Invoke-GuardedKeys $dialog '{ENTER}')) { return $false }
    Start-Sleep -Milliseconds 250
    if (-not (Invoke-GuardedKeys $dialog '{ENTER}')) { return $false }
  }
  Write-Host 'UIA|stage=keyboard-fallback|code=sent'
  return $true
}

function Write-ElementDiagnostics($prefix, $element, $relation) {
  try {
    $current = $element.Current
    $controlType = Get-SafeMetadata $current.ControlType.ProgrammaticName
    $automationId = Get-SafeMetadata $current.AutomationId
    $className = Get-SafeMetadata $current.ClassName
    $patterns = Get-SafeMetadata (Get-PatternNames $element)
    $controlName = '-'
    $bounds = '-'
    if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
      try {
        $controlName = Get-SafeMetadata $element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
      } catch { }
      try {
        $rectangle = $current.BoundingRectangle
        if ($rectangle.Width -gt 0 -and $rectangle.Height -gt 0) {
          $bounds = ([string]([int][Math]::Round($rectangle.X)) + ',' + [string]([int][Math]::Round($rectangle.Y)) + ',' + [string]([int][Math]::Round($rectangle.Width)) + ',' + [string]([int][Math]::Round($rectangle.Height)))
        }
      } catch { }
    }
    Write-Output ($prefix + '|pid=' + [string]$current.ProcessId + '|relation=' + (Get-SafeMetadata $relation) + '|aid=' + $automationId + '|type=' + $controlType + '|class=' + $className + '|patterns=' + $patterns + '|' + (Get-ElementState $element) + '|name=' + $controlName + '|bounds=' + $bounds)
  } catch { }
}

function Get-BoolMetadata([bool]$value) {
  if ($value) { return 'true' }
  return 'false'
}

function Write-BrokerCandidateDiagnostics($element) {
  $facts = Get-BrokerCandidateFacts $element
  Write-Output ('UIA|stage=broker-candidate|class-allowed=' + (Get-BoolMetadata $facts.ClassAllowed) +
    '|different-process=' + (Get-BoolMetadata $facts.DifferentProcess) +
    '|broker-process=' + (Get-BoolMetadata $facts.BrokerProcess) +
    '|picker-controls=' + (Get-BoolMetadata $facts.PickerControls) +
    '|foreground-broker-process=' + (Get-BoolMetadata $facts.ForegroundBrokerProcess) +
    '|explorer-process=' + (Get-BoolMetadata $facts.ExplorerProcess) +
    '|foreground=' + (Get-BoolMetadata $facts.Foreground) +
    '|modal=' + (Get-BoolMetadata $facts.Modal) +
    '|new-window=' + (Get-BoolMetadata $facts.NewWindow) +
    '|single-target=' + (Get-BoolMetadata $facts.SingleTarget) +
    '|target-still-owned=' + (Get-BoolMetadata $facts.TargetStillOwned) +
    '|target-was-enabled=' + (Get-BoolMetadata $facts.TargetWasEnabled) +
    '|target-disabled=' + (Get-BoolMetadata $facts.TargetDisabled) +
    '|eligible=' + (Get-BoolMetadata $facts.Eligible))
}

function Write-DialogDiagnostics($dialog, $relation) {
  Write-ElementDiagnostics 'UIA' $dialog $relation
  $nodes = $dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $written = 0
  foreach ($node in $nodes) {
    if ($written -ge 100) { break }
    try {
      $current = $node.Current
      $controlType = $current.ControlType.ProgrammaticName
      if ($current.AutomationId -notmatch '^System\\.' -and ($controlType -match 'Edit|ComboBox|Button|SplitButton' -or $current.ClassName -match 'Edit|ComboBox|Button' -or $current.AutomationId -match '^(?:FileNameControlHost|1148|1001|1)$')) {
        Write-ElementDiagnostics 'UIA' $node $relation
        $written += 1
      }
    } catch { }
  }
}

function Write-ProcessButtonDiagnostics([int]$processId) {
  $buttons = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    )
  )
  $written = 0
  foreach ($button in $buttons) {
    if ($written -ge 80) { break }
    try {
      if ([int]$button.Current.ProcessId -ne $processId) { continue }
      Write-ElementDiagnostics 'UIA' $button 'brokered-process-button'
      $written += 1
    } catch { }
  }
}

function Write-TopLevelDiagnostics {
  $nodes = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $written = 0
  foreach ($node in $nodes) {
    if ($written -ge 80) { break }
    $relation = Get-ElementRelation $node
    Write-ElementDiagnostics 'TOP' $node $relation
    try {
      if ($relation -ne 'other' -and $commonDialogClasses -contains [string]$node.Current.ClassName) {
        Write-DialogDiagnostics $node $relation
      } elseif ($brokerDialogClasses -contains [string]$node.Current.ClassName) {
        Write-BrokerCandidateDiagnostics $node
        if (Test-BrokeredDialog $node) { Write-DialogDiagnostics $node 'brokered' }
      }
    } catch { }
    $written += 1
  }
}

function Test-DialogStillOpen($dialog, [IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) {
    try {
      [void]$dialog.Current.ProcessId
      return $true
    } catch {
      return $false
    }
  }
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($window in $windows) {
    try {
      if ([IntPtr]$window.Current.NativeWindowHandle -eq $handle) { return $true }
    } catch { }
  }
  return $false
}

`;
}

export function nativeDialogUiAutomationScript(): string {
  const commonDialogClasses = NATIVE_SOURCE_DIALOG_CLASSES.map((value) => `'${value}'`).join(', ');
  const brokerDialogClasses = NATIVE_SOURCE_BROKER_DIALOG_CLASSES.map((value) => `'${value}'`).join(', ');
  return nativeDialogUiAutomationDefinitions() + `
try {
  [void][CaptureClassicDialogOwner]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
} catch { }
$dialogFile = [string]$env:CAPTURE_SMOKE_DIALOG_FILE
if ([string]::IsNullOrWhiteSpace($dialogFile)) {
  Write-Output 'UIA|stage=input|code=missing'
  exit 8
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$targetProcessId = [int]$env:CAPTURE_SMOKE_APP_PID
$commonDialogClasses = @(${commonDialogClasses})
$brokerDialogClasses = @(${brokerDialogClasses})

$targetMainWindowHandles = @(Get-TargetMainWindowHandles)
if ($targetMainWindowHandles.Count -ne 1) {
  Write-Output ('UIA|stage=target-window|code=count-invalid|count=' + [string]$targetMainWindowHandles.Count)
  exit 6
}
$targetHandle = [IntPtr][long]$targetMainWindowHandles[0]
$baselineWindowHandles = New-Object 'System.Collections.Generic.HashSet[long]'
foreach ($handle in [CaptureDialogOwner]::SnapshotTopLevelWindowHandles()) {
  [void]$baselineWindowHandles.Add([long]$handle)
}
$targetMainWindowWasEnabled = [CaptureDialogOwner]::IsWindowEnabled($targetHandle)
Write-Output 'UIA|stage=ready|code=listening'
if ($env:E2E_ACCEPTANCE_DIAGNOSTICS -eq '1') {
  Write-TopLevelDiagnostics
}

$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $deadline) {
  # Classic dialog: native window messages only, without foreground changes.
  $dialogHandle = [CaptureClassicDialogOwner]::FindDialog([uint32]$targetProcessId, $commonDialogClasses)
  if ($dialogHandle -ne [IntPtr]::Zero) {
    $editDeadline = [DateTime]::UtcNow.AddSeconds(2)
    $editHandle = [IntPtr]::Zero
    while ([DateTime]::UtcNow -lt $editDeadline) {
      $editHandle = [CaptureClassicDialogOwner]::FindFilenameEdit($dialogHandle)
      if ($editHandle -ne [IntPtr]::Zero) { break }
      Start-Sleep -Milliseconds 50
    }
    if ($editHandle -eq [IntPtr]::Zero) {
      Write-Output 'UIA|stage=find-edit|code=missing'
      [CaptureClassicDialogOwner]::GetDialogChildDiagnostics($dialogHandle) | Write-Output
      exit 2
    }
    if (-not [CaptureClassicDialogOwner]::SetEditText($editHandle, $dialogFile)) {
      Write-Output 'UIA|stage=set-value|code=failed'
      [CaptureClassicDialogOwner]::GetDialogChildDiagnostics($dialogHandle) | Write-Output
      exit 3
    }
    if (-not [CaptureClassicDialogOwner]::SubmitDialog($dialogHandle)) {
      Write-Output 'UIA|stage=invoke-open|code=failed'
      [CaptureClassicDialogOwner]::GetDialogChildDiagnostics($dialogHandle) | Write-Output
      exit 4
    }
    $closeDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $closeDeadline) {
      if (-not [CaptureClassicDialogOwner]::IsDialogOpen($dialogHandle)) { exit 0 }
      Start-Sleep -Milliseconds 100
    }
    Write-Output 'UIA|stage=close-dialog|code=timeout'
    [CaptureClassicDialogOwner]::GetDialogChildDiagnostics($dialogHandle) | Write-Output
    exit 5
  }
  # Brokered picker: validated UI Automation and keyboard fallback.
  $windows = @($root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  ))
  # Some WebView2/Tauri dialog implementations expose the Win32 dialog as a
  # descendant of the shell broker rather than as a desktop top-level window.
  # Include owned Window descendants so the same control-level validation is
  # applied without relying on localized titles.
  try {
    $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Window
    )
    $windows += @($root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $windowCondition
    ))
  } catch { }
  $windows = @($windows | Sort-Object -Property @{
    Expression = {
      try {
        if ([string]$_.Current.ClassName -eq 'ApplicationFrameWindow') { return 0 }
      } catch { }
      return 1
    }
  })
  foreach ($dialog in $windows) {
    $relation = Get-ElementRelation $dialog
    $dialogKind = ''
    try {
      $current = $dialog.Current
      if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Window) { continue }
      if (Test-BrokeredDialog $dialog) {
        $dialogKind = 'brokered'
        $relation = 'brokered'
        Write-Output 'UIA|stage=brokered-flow|code=dialog-found'
      }
    } catch { continue }
    if ([string]::IsNullOrEmpty($dialogKind)) { continue }

    if ($dialogKind -eq 'brokered') {
      $brokeredSucceeded = $false
      Invoke-BrokeredPicker $dialog | ForEach-Object {
        if ($_ -is [bool]) {
          $brokeredSucceeded = $brokeredSucceeded -or $_
        } elseif ($_ -is [string] -and $_.StartsWith('UIA|', [System.StringComparison]::Ordinal)) {
          Write-Output $_
        }
      }
      if ($brokeredSucceeded) { exit 0 }
      $script:pickerInputRefused = $false
      if (Invoke-BrokeredPickerKeyboardFallback $dialog) {
        $fallbackDeadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $fallbackDeadline) {
          if ([CaptureDialogOwner]::IsWindowEnabled($targetHandle)) { exit 0 }
          Start-Sleep -Milliseconds 100
        }
        Write-Output 'UIA|stage=keyboard-fallback|code=timeout'
        Write-TopLevelDiagnostics
        exit 5
      }
      if ($script:pickerInputRefused) { exit 10 }
      Write-Output 'UIA|stage=brokered-flow|code=commit-unacknowledged'
      Write-DialogDiagnostics $dialog $relation
      exit 5
    }

  }
  Start-Sleep -Milliseconds 100
}
Write-Output 'UIA|stage=find-dialog|code=timeout'
Write-TopLevelDiagnostics
exit 1
`;
}

export function safeUiAutomationDiagnostics(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length <= 500 && /^(?:UIA|TOP)\|[A-Za-z0-9_.#,:;=|-]+$/u.test(line))
    .slice(0, 120);
  const prioritized = lines.filter(
    (line) => line.startsWith('UIA|stage=') || !line.includes('|relation=other|'),
  );
  const diagnostics = [...new Set([...prioritized, ...lines])]
    .slice(0, 120)
    .join(' ');
  return diagnostics || 'none';
}

class NativePickerAutomationError extends Error {
  readonly diagnostics: string;

  constructor(diagnostics: string, inputRefused = false) {
    super(`Native source picker automation failed.${inputRefused ? ' Picker input refused because the foreground is not owned by the picker.' : ''}${diagnostics === 'none' ? '' : ` diagnostics=${diagnostics}`}`);
    this.name = 'NativePickerAutomationError';
    this.diagnostics = diagnostics;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function nativeOpenDialogUiAutomation(
  filePath: string,
  appPid: number,
  onReady?: () => void | Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(appPid) || appPid <= 0) {
    throw new Error('Native source picker automation requires the packaged Tauri process PID.');
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const scriptDirectory = process.env.TEMP?.trim() || process.env.TMP?.trim() || workspaceRoot;
  const scriptPath = join(scriptDirectory, `capture-workbench-uia-${randomUUID()}.ps1`);
  await writeFile(scriptPath, nativeDialogUiAutomationScript(), { encoding: 'utf8', flag: 'wx' });
  const removeScript = async (): Promise<void> => {
    await rm(scriptPath, { force: true }).catch(() => undefined);
  };
  const child = spawn(windowsPowerShellExecutable(systemRoot), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', scriptPath], {
    env: {
      SystemRoot: systemRoot,
      Path: process.env.Path || process.env.PATH || '',
      TEMP: process.env.TEMP || '',
      TMP: process.env.TMP || '',
      CAPTURE_SMOKE_APP_PID: String(appPid),
      CAPTURE_SMOKE_DIALOG_FILE: filePath,
      ...(process.env.E2E_ACCEPTANCE_DIAGNOSTICS === '1'
        ? { E2E_ACCEPTANCE_DIAGNOSTICS: '1' }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const readyMarker = 'UIA|stage=ready|code=listening';
  let stdout = '';
  let stderr = '';
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const settleReady = (): void => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };
  const failReady = (): void => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new NativePickerAutomationError(safeUiAutomationDiagnostics(stdout)));
  };
  let resultSettled = false;
  let resolveResult!: (result: { code: number | null; stdout: string; stderr: string }) => void;
  const settleResult = (result: { code: number | null; stdout: string; stderr: string }): void => {
    if (resultSettled) return;
    resultSettled = true;
    resolveResult(result);
  };
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
    resolveResult = resolvePromise;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 65_536) stdout += chunk.toString().slice(0, 65_536 - stdout.length);
      if (stdout.includes(readyMarker)) settleReady();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk.toString().slice(0, 65_536 - stderr.length);
    });
    child.once('error', () => {
      failReady();
      settleResult({ code: null, stdout, stderr });
    });
    child.once('close', (code) => {
      failReady();
      settleResult({ code, stdout, stderr });
    });
  });
  const childTimeout = setTimeout(() => {
    if (resultSettled) return;
    stdout += '\nUIA|stage=node-timeout|code=timeout';
    child.kill();
    settleResult({ code: null, stdout, stderr });
  }, 60_000);
  if (resultSettled) clearTimeout(childTimeout);
  const readyTimeout = setTimeout(failReady, 15_000);
  try {
    await ready;
  } catch (error) {
    child.kill();
    await result;
    clearTimeout(childTimeout);
    await removeScript();
    throw error;
  } finally {
    clearTimeout(readyTimeout);
  }
  try {
    await withTimeout(
      Promise.resolve(onReady?.()),
      15_000,
      'Native source picker click callback timed out.',
    );
  } catch (error) {
    child.kill();
    await result;
    clearTimeout(childTimeout);
    await removeScript();
    throw error;
  }
  const completed = await result;
  clearTimeout(childTimeout);
  if (completed.code !== 0) {
    const diagnostics = safeUiAutomationDiagnostics(completed.stdout);
    await removeScript();
    throw new NativePickerAutomationError(diagnostics, completed.code === 10);
  }
  if (process.env.E2E_ACCEPTANCE_DIAGNOSTICS === '1') {
    const diagnostics = safeUiAutomationDiagnostics(completed.stdout);
    if (diagnostics !== 'none') process.stderr.write(`Native picker UIA: ${diagnostics}\n`);
  }
  await removeScript();
}
