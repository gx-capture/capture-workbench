# Native OLE drag and drop of real file paths onto the installed QA app's
# window, used by installed-capture-lifecycle.ts. A drag needs a source window
# that holds the mouse button: this helper shows a small window of its own
# (48 x 48 px, beside the drop point inside the QA app's area), presses the
# left button on it, starts DoDragDrop from it, moves the cursor onto the QA
# app's window and releases the button there. The drop point is the middle of
# the app's client area, 60 % down.
# The QA app is identified by its PID and process creation time (a FILETIME as
# a decimal string). The helper checks that each SetCursorPos succeeded and the
# cursor is where it was put; at the release it also reports whether the cursor
# was at the drop point over the QA app's window (releasedOverApp), which the
# drop claim needs. A person at the machine controls everything outside the
# app, so the helper proves no window ownership before its mouse events.
# The button this helper pressed is always released before it exits: after the
# drop, and on any stop (a step that failed, its own deadline -DeadlineMs, or
# standard input ending or reading "stop"). A stopped drag is first cancelled
# through QueryContinueDrag, so no drop happens.
# Prints one JSON line with the outcome and a short trace of steps and screen
# points; never prints paths.
param(
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$AppCreatedFileTime,
  [Parameter(Mandatory = $true)][int]$DeadlineMs,
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Paths
)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing @'
using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public sealed class CaptureDropOutcome {
  public bool Ok;
  public string Outcome;
  public string Effect;
  public int Count;
  public bool Pressed;
  public bool Released;
  public bool ReleasedOverApp;
  public long At;
  public string[] Trace;
}

public static class CaptureWindowDrop {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Pt { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref Pt p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Pt p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Pt p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint INPUT_MOUSE = 0, MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, QUERY_LIMITED_INFORMATION = 0x1000;
  static readonly List<string> trace = new List<string>();
  static readonly object gate = new object();
  static volatile bool stopped;
  static string stopReason = "";

  static void T(string message) {
    lock (trace) trace.Add(DateTime.UtcNow.ToString("HH:mm:ss.fff") + " " + message);
  }

  // Stops the drag at the next step; the first reason wins.
  public static void Stop(string reason) {
    lock (gate) {
      if (stopped) return;
      stopReason = reason;
      stopped = true;
    }
    T("stop " + reason);
  }

  public static bool IsProcess(uint pid, long creation) {
    IntPtr h = OpenProcess(QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return false;
    try {
      long created, exit, kernel, user;
      return GetProcessTimes(h, out created, out exit, out kernel, out user) && Math.Abs(created - creation) <= 10000;
    } finally {
      CloseHandle(h);
    }
  }

  static bool Mouse(uint flags) {
    var inputs = new INPUT[1];
    inputs[0].type = INPUT_MOUSE;
    inputs[0].u.mi = new MOUSEINPUT { dwFlags = flags };
    return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  // Moves the cursor and checks that it is at the point.
  static bool PlaceCursor(string step, Pt p) {
    if (!SetCursorPos(p.X, p.Y)) { T(step + " SetCursorPos failed"); return false; }
    Pt actual;
    bool placed = GetCursorPos(out actual) && actual.X == p.X && actual.Y == p.Y;
    T(step + " " + actual.X + "," + actual.Y + " placed=" + placed);
    return placed;
  }

  // Whether the cursor is at the point and the window under it is the app's.
  static bool CursorOverApp(Pt p, IntPtr appRoot) {
    Pt actual;
    if (!GetCursorPos(out actual) || actual.X != p.X || actual.Y != p.Y) return false;
    IntPtr under = WindowFromPoint(actual);
    return under != IntPtr.Zero && GetAncestor(under, 2) == appRoot;
  }

  static CaptureDropOutcome Result(bool ok, string outcome, DragDropEffects effect, int count, bool pressed, bool released, bool overApp) {
    string[] lines;
    lock (trace) lines = trace.ToArray();
    return new CaptureDropOutcome {
      Ok = ok, Outcome = outcome, Effect = effect.ToString(), Count = count, Pressed = pressed, Released = released,
      ReleasedOverApp = overApp, At = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Trace = lines,
    };
  }

  public static CaptureDropOutcome Run(IntPtr app, uint appPid, long appCreation, string[] files, int deadlineMs) {
    if (!IsProcess(appPid, appCreation)) return Result(false, "app-process-changed", DragDropEffects.None, files.Length, false, false, false);
    if (!IsWindowVisible(app) || IsIconic(app)) return Result(false, "app-window-not-visible", DragDropEffects.None, files.Length, false, false, false);
    IntPtr appRoot = GetAncestor(app, 2);
    Rect r;
    if (!GetClientRect(app, out r)) return Result(false, "client-rect", DragDropEffects.None, files.Length, false, false, false);
    Pt target = new Pt { X = (int)(r.Right * 0.5), Y = (int)(r.Bottom * 0.6) };
    ClientToScreen(app, ref target);
    Pt origin = new Pt { X = target.X - 120, Y = target.Y };
    T("target " + target.X + "," + target.Y + " client " + r.Right + "x" + r.Bottom);
    Pt probe = target;
    if (GetAncestor(WindowFromPoint(probe), 2) != appRoot) return Result(false, "target-not-app-window-before", DragDropEffects.None, files.Length, false, false, false);
    var data = new DataObject();
    var list = new StringCollection();
    list.AddRange(files);
    data.SetFileDropList(list);

    string outcome = "not-started";
    DragDropEffects effect = DragDropEffects.None;
    bool dragStarted = false, dragReturned = false, pressed = false, released = false, releasedOverApp = false;
    var form = new Form {
      FormBorderStyle = FormBorderStyle.None, ShowInTaskbar = false, TopMost = true,
      StartPosition = FormStartPosition.Manual, BackColor = Color.SteelBlue,
      Location = new Point(origin.X - 24, origin.Y - 24), Size = new Size(48, 48),
    };
    Thread driverThread = null;
    // A stopped drag is cancelled here, before the button goes up, so nothing is dropped.
    form.QueryContinueDrag += (s, e) => { if (stopped) e.Action = DragAction.Cancel; };
    form.MouseDown += (s, e) => {
      if (e.Button != MouseButtons.Left || dragStarted || stopped) return;
      dragStarted = true;
      T("drag-start");
      effect = form.DoDragDrop(data, DragDropEffects.Copy);
      dragReturned = true;
      T("drag-returned " + effect);
    };
    form.Shown += (s, e) => {
      var driver = driverThread = new Thread(() => {
        try {
          Thread.Sleep(300);
          if (stopped) { outcome = stopReason; return; }
          if (!PlaceCursor("origin", origin)) { outcome = "cursor-not-placed"; return; }
          if (stopped) { outcome = stopReason; return; }
          if (!Mouse(LEFTDOWN)) { outcome = "press-not-inserted"; return; }
          pressed = true;
          T("button-down");
          var until = DateTime.UtcNow.AddSeconds(3);
          while (!dragStarted && !stopped && DateTime.UtcNow < until) Thread.Sleep(20);
          if (stopped) { outcome = stopReason; return; }
          if (!dragStarted) { outcome = "drag-did-not-start"; return; }
          // Move in steps onto the app's window; OLE tracks each move.
          for (int i = 1; i <= 12; i++) {
            if (stopped) { outcome = stopReason; return; }
            var step = new Pt { X = origin.X + (target.X - origin.X) * i / 12, Y = target.Y };
            if (!PlaceCursor("move " + i, step)) { outcome = "cursor-not-placed"; return; }
            if (!Mouse(MOVE)) { outcome = "move-not-inserted"; return; }
            Thread.Sleep(40);
          }
          for (int i = 0; i < 6; i++) {
            if (stopped) { outcome = stopReason; return; }
            var wiggle = new Pt { X = target.X + (i % 2 == 0 ? 1 : 0), Y = target.Y };
            if (!PlaceCursor("settle " + i, wiggle)) { outcome = "cursor-not-placed"; return; }
            if (!Mouse(MOVE)) { outcome = "move-not-inserted"; return; }
            Thread.Sleep(40);
          }
          if (stopped) { outcome = stopReason; return; }
          // The drop claim needs the release at the drop point over the app's window.
          if (!PlaceCursor("release", target) || !CursorOverApp(target, appRoot)) { outcome = "cursor-not-over-app"; return; }
          releasedOverApp = true;
          if (!Mouse(LEFTUP)) { releasedOverApp = false; outcome = "release-not-inserted"; return; }
          released = true;
          T("button-up over app");
          until = DateTime.UtcNow.AddSeconds(5);
          while (!dragReturned && DateTime.UtcNow < until) Thread.Sleep(20);
          outcome = dragReturned ? "returned" : "drop-did-not-return";
        } finally {
          if (pressed && !released) {
            // Always release the button this helper pressed. Cancel first:
            // QueryContinueDrag answers Cancel on OLE's next poll, which the
            // move causes, so the release drops nothing.
            Stop(outcome);
            PlaceCursor("abort", origin);
            Mouse(MOVE);
            Thread.Sleep(150);
            released = Mouse(LEFTUP);
            T("button-up (abort) inserted=" + released);
          }
          try { form.BeginInvoke(new Action(form.Close)); } catch {}
        }
      });
      driver.IsBackground = true;
      driver.Start();
    };
    using (var deadline = new System.Threading.Timer(_ => Stop("helper-deadline"), null, deadlineMs, Timeout.Infinite)) {
      // A last resort if the driver never closes the window.
      var watchdog = new System.Windows.Forms.Timer { Interval = deadlineMs + 5000 };
      watchdog.Tick += (s, e) => { watchdog.Stop(); form.Close(); };
      watchdog.Start();
      Application.Run(form);
      if (driverThread != null) driverThread.Join(8000);
    }
    bool ok = outcome == "returned" && effect != DragDropEffects.None && !stopped && released && releasedOverApp;
    if (pressed && !released) outcome = "button-not-released";
    return Result(ok, outcome, effect, files.Length, pressed, released, releasedOverApp);
  }

  // Standard input stays open while the caller waits; its end, or "stop", stops the drag.
  public static void WatchStandardInput() {
    var reader = new Thread(() => {
      try {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
          if (line.Trim() == "stop") break;
        }
      } catch {}
      Stop("stop-requested");
    });
    reader.IsBackground = true;
    reader.Start();
  }
}
'@

$created = [long]::Parse($AppCreatedFileTime, [Globalization.CultureInfo]::InvariantCulture)
if (-not [CaptureWindowDrop]::IsProcess([uint32]$AppPid, $created)) { '{"ok":false,"reason":"app-process-changed"}'; exit 3 }
$handle = (Get-Process -Id $AppPid).MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { '{"ok":false,"reason":"no-main-window"}'; exit 2 }
[CaptureWindowDrop]::WatchStandardInput()
$result = [CaptureWindowDrop]::Run($handle, [uint32]$AppPid, $created, [string[]]$Paths, $DeadlineMs)
[pscustomobject]@{
  ok = $result.Ok
  action = 'drop'
  reason = $(if ($result.Ok) { 'none' } else { $result.Outcome })
  outcome = $result.Outcome
  effect = $result.Effect
  count = $result.Count
  pressed = $result.Pressed
  released = $result.Released
  releasedOverApp = $result.ReleasedOverApp
  at = $result.At
  trace = @($result.Trace)
} | ConvertTo-Json -Compress
if (-not $result.Ok) { exit 3 }
