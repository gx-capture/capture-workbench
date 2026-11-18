// eslint-disable-next-line @nx/enforce-module-boundaries -- shared test temp-root guard.
import '../../../tools/test-temp-root.ts';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  nativeDialogUiAutomationDefinitions,
  nativeDialogUiAutomationScript,
  normalizedNativeClickPoint,
  safeUiAutomationDiagnostics,
  windowsPowerShellExecutable,
} from './installed-native-dialog.ts';

test('native dialog helper resolves PowerShell without relying on PATH', () => {
  assert.equal(
    windowsPowerShellExecutable('C:\\Windows'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
});

test('native click maps emulated CSS viewport coordinates to the real client rectangle', () => {
  assert.deepEqual(
    normalizedNativeClickPoint(
      { x: 360, y: 290, width: 48, height: 46 },
      { width: 1440, height: 900 },
    ),
    { xRatio: 0.26666666666666666, yRatio: 0.3477777777777778 },
  );
  assert.throws(
    () => normalizedNativeClickPoint(
      { x: 1_400, y: 0, width: 100, height: 20 },
      { width: 1_440, height: 900 },
    ),
    /invalid viewport coordinates/u,
  );
});

test('native dialog diagnostics reject values and private paths', () => {
  const safe = 'TOP|pid=42|relation=target|aid=FileNameControlHost|type=ControlType.ComboBox|class=ComboBox|patterns=Value';
  assert.equal(safeUiAutomationDiagnostics(`${safe}\n`), safe);
  assert.equal(
    safeUiAutomationDiagnostics('UIA|stage=timeout|value=C:\\private\\fixture.pdf'),
    'none',
  );
  assert.equal(safeUiAutomationDiagnostics('PowerShell error containing private data'), 'none');
});

test('native dialog UIA script parses in Windows PowerShell', { skip: process.platform !== 'win32' }, () => {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const parser = `
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput(
  [Console]::In.ReadToEnd(),
  [ref]$tokens,
  [ref]$errors
)
if ($errors.Count -ne 0) {
  $errors | ForEach-Object {
    Write-Output ([string]$_.Extent.StartLineNumber + ':' + $_.Extent.Text)
  }
  exit 1
}
`;
  const result = spawnSync(
    windowsPowerShellExecutable(systemRoot),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parser],
    {
      encoding: 'utf8',
      input: nativeDialogUiAutomationScript(),
      env: {
        SystemRoot: systemRoot,
        Path: process.env.Path || process.env.PATH || '',
      },
      windowsHide: true,
    },
  );
  assert.equal(
    result.status,
    0,
    `The generated UIA helper must be valid Windows PowerShell syntax. ${result.stdout}${result.stderr}`,
  );
});

function runPickerStubCase(body: string): { keys: string[]; clicks: number; result: boolean; diagnostics: string[] } {
  const script = nativeDialogUiAutomationDefinitions() + `
$script:keys = New-Object 'System.Collections.Generic.List[string]'
$script:clicks = 0
$script:foregroundCalls = 0
function Invoke-RawKeySend([string]$value) { $script:keys.Add($value) }
function Invoke-RawClick([int]$x, [int]$y) { $script:clicks++; return $true }
function Get-NativeRoot([IntPtr]$handle) { return $handle }
function Get-ForegroundRoot { return [IntPtr]42 }
function Invoke-PickerActivation([IntPtr]$handle) { return $false }
function Test-TargetEnabled { return $false }
function Start-Sleep { param($Milliseconds) }
$dialog = [pscustomobject]@{ Current = [pscustomobject]@{ NativeWindowHandle = 42 } }
$env:CAPTURE_SMOKE_DIALOG_FILE = 'C:\\fixture.txt'
$diagnostics = @(& {
${body}
} 6>&1 | ForEach-Object {
  if ($_ -is [bool]) { $script:result = $_ } else { [string]$_ }
})
@{ keys = @($script:keys.ToArray()); clicks = $script:clicks; result = $script:result; diagnostics = $diagnostics } | ConvertTo-Json -Compress
`;
  const result = spawnSync(windowsPowerShellExecutable(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', '& ([scriptblock]::Create([Console]::In.ReadToEnd()))'],
    { input: script, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, String(result.error || result.stderr));
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout.trim());
}

const powershellSkip = process.platform !== 'win32' ? 'Requires Windows PowerShell' : false;
const refusedDiagnostic = 'UIA|stage=input-guard|code=foreground-not-owned';

test('brokered fallback refuses input when activation fails', { skip: powershellSkip }, () => {
  const result = runPickerStubCase(`
function Get-ForegroundRoot { return [IntPtr]99 }
Invoke-BrokeredPickerKeyboardFallback $dialog`);
  assert.equal(result.result, false);
  assert.deepEqual(result.keys, []);
  assert.deepEqual(result.diagnostics, [refusedDiagnostic]);
});

test('brokered fallback sends the fixture when the picker owns the foreground', { skip: powershellSkip }, () => {
  const result = runPickerStubCase('Invoke-BrokeredPickerKeyboardFallback $dialog');
  assert.equal(result.result, true);
  assert.ok(result.keys.length > 0);
  assert.ok(result.keys.includes('C:\\fixture.txt'));
});

test('brokered fallback stops immediately when foreground ownership is lost', { skip: powershellSkip }, () => {
  const result = runPickerStubCase(`
function Get-ForegroundRoot {
  $script:foregroundCalls++
  if ($script:foregroundCalls -eq 1) { return [IntPtr]42 }
  return [IntPtr]99
}
Invoke-BrokeredPickerKeyboardFallback $dialog`);
  assert.equal(result.result, false);
  assert.deepEqual(result.keys, ['%n']);
  assert.deepEqual(result.diagnostics, [refusedDiagnostic]);
});

test('brokered fallback refuses a dialog without a native handle', { skip: powershellSkip }, () => {
  const result = runPickerStubCase(`
$dialog.Current.NativeWindowHandle = 0
Invoke-BrokeredPickerKeyboardFallback $dialog`);
  assert.equal(result.result, false);
  assert.deepEqual(result.keys, []);
  assert.deepEqual(result.diagnostics, [refusedDiagnostic]);
});

test('guarded click refuses another foreground window', { skip: powershellSkip }, () => {
  const result = runPickerStubCase(`
function Get-ForegroundRoot { return [IntPtr]99 }
Invoke-GuardedClick $dialog 10 20`);
  assert.equal(result.result, false);
  assert.equal(result.clicks, 0);
  assert.deepEqual(result.diagnostics, [refusedDiagnostic]);
});

test('classic dialog selects a fixture without keyboard input', {
  skip: process.platform !== 'win32' || process.env.CAPTURE_SMOKE_REAL_DIALOG_TEST !== '1'
    ? 'Opens a window; requires Windows and CAPTURE_SMOKE_REAL_DIALOG_TEST=1' : false,
  timeout: 45_000,
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'capture-picker-uia-'));
  const fixture = join(temporary, 'picker-probe.txt');
  const readySignal = join(temporary, 'open-dialog.signal');
  await writeFile(fixture, 'picker probe\n', 'utf8');
  const hostScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Tauri Window'
$form.Add_Shown({
  [Console]::WriteLine('HWND=' + $form.Handle.ToInt64())
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 25
  $timer.Add_Tick({
    if (-not (Test-Path -LiteralPath $env:CAPTURE_SMOKE_DIALOG_SIGNAL)) { return }
    $timer.Stop()
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    try {
      if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::WriteLine($dialog.FileName)
      }
    } finally { $dialog.Dispose(); $form.Close() }
  }.GetNewClosure())
  $timer.Start()
}.GetNewClosure())
[System.Windows.Forms.Application]::Run($form)
$form.Dispose()
`;
  const host = spawn(windowsPowerShellExecutable(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', hostScript], {
      env: { ...process.env, CAPTURE_SMOKE_DIALOG_SIGNAL: readySignal },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  let hostOutput = '';
  host.stdout.on('data', (chunk: Buffer) => { hostOutput += chunk.toString(); });
  const hostExit = new Promise<number | null>((resolvePromise, reject) => {
    host.once('error', reject);
    host.once('close', resolvePromise);
  });
  try {
    assert.ok(host.pid);
    // The host starts hidden (windowsHide), so it has no main window handle to
    // look up; it reports its form's handle instead.
    const hostHandleDeadline = Date.now() + 15_000;
    let hostHandle: string | undefined;
    while (hostHandle === undefined && Date.now() < hostHandleDeadline) {
      hostHandle = /^HWND=(\d+)\r?$/mu.exec(hostOutput)?.[1];
      if (hostHandle === undefined) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.ok(hostHandle, 'The dialog host did not report its window handle.');
    const definitions = nativeDialogUiAutomationDefinitions();
    // A WinForms host has a generated class name; production Tauri uses its fixed class.
    const script = definitions + `
function Get-TargetMainWindowHandles { return @([long]${hostHandle}) }
$script:keyCount = 0
function Invoke-RawKeySend([string]$value) { $script:keyCount++; throw 'Unexpected keyboard input' }
try { & {
` + nativeDialogUiAutomationScript().slice(definitions.length) + `
} } finally { [Console]::WriteLine('KEYCOUNT=' + $script:keyCount) }
`;
    const automation = spawn(windowsPowerShellExecutable(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', '& ([scriptblock]::Create([Console]::In.ReadToEnd()))'], {
        env: { ...process.env, CAPTURE_SMOKE_APP_PID: String(host.pid), CAPTURE_SMOKE_DIALOG_FILE: fixture },
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    let output = '';
    const automationExit = new Promise<number | null>((resolvePromise, reject) => {
      automation.once('error', reject);
      automation.once('close', resolvePromise);
    });
    let signaled = false;
    automation.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (!signaled && output.includes('UIA|stage=ready|code=listening')) {
        signaled = true;
        void writeFile(readySignal, 'ready\n', 'utf8');
      }
    });
    const watchdog = setTimeout(() => { automation.kill(); host.kill(); }, 35_000);
    try {
      automation.stdin.end(script);
      assert.equal(await automationExit, 0, output);
      assert.match(output, /KEYCOUNT=0/u);
      assert.equal(await hostExit, 0);
      assert.equal(hostOutput.trim().split(/\r?\n/u).at(-1), fixture);
    } finally { clearTimeout(watchdog); automation.kill(); }
  } finally {
    host.kill();
    await rm(temporary, { recursive: true, force: true });
  }
});
