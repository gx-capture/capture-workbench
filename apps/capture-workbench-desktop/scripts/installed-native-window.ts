// Runs the Windows helpers next to this file that act on the installed QA
// app's window and process tree (installed-window-input.ps1,
// installed-window-drop.ps1, installed-app-tree.ps1). Each helper is called by
// path with its arguments; no script text is built here. Each prints one JSON
// line and never prints paths.
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

import { Observable } from 'rxjs';

import { assertStrictDescendant } from './contracts/installed.ts';
import { fileTimeOf } from './installed-capture-lifecycle-checks.ts';
import { windowsPowerShellExecutable } from './installed-native-dialog.ts';
import { appRoot } from './stage-runtime.ts';

const helperDirectory = join(appRoot, 'scripts');
const outputLimit = 65_536;
/** After a timeout, how long a helper has to stop by itself (releasing a pressed button) before it is killed. */
export const HELPER_STOP_GRACE_MS = 5_000;
/** The drop helper's own deadline: well before the caller's timeout, so it stops and releases the button itself. */
export const DROP_HELPER_DEADLINE_MS = 20_000;

export type WindowHelperScript =
  | 'installed-window-input.ps1'
  | 'installed-window-drop.ps1'
  | 'installed-app-tree.ps1';

export type WindowKey = 'F5' | 'CtrlR';

export interface WindowHelperInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stopGraceMs: number;
  /** The helper presses the left mouse button: if it has to be killed, the button may stay pressed. */
  readonly pressesMouseButton: boolean;
}

/** The QA app's process: its PID and creation time, never a window title. */
export interface AppProcess {
  readonly pid: number;
  readonly createdFileTime: string;
}

function appIdentity(app: AppProcess): string[] {
  return ['-AppPid', assertAppPid(app.pid), '-AppCreatedFileTime', fileTimeOf(app.createdFileTime)];
}

function assertAppPid(appPid: number): string {
  if (!Number.isSafeInteger(appPid) || appPid <= 0) {
    throw new Error('A window helper needs the installed app\'s positive PID.');
  }
  return String(appPid);
}

function assertPlainAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path) || /[\0\r\n]/u.test(path)) {
    throw new Error(`${label} must be an absolute path without control characters.`);
  }
  return path;
}

/**
 * The PowerShell command line for one helper. TEMP, where PowerShell compiles
 * the helper's C#, must lie in the check's own root, so nothing is left in the
 * user's temporary directory.
 */
export function windowHelperInvocation(
  script: WindowHelperScript,
  scriptArguments: readonly string[],
  environment: { readonly systemRoot: string; readonly path: string; readonly temporary: string; readonly ownedRoot: string },
  timeoutMs: number,
): WindowHelperInvocation {
  const scriptPath = assertStrictDescendant(helperDirectory, join(helperDirectory, script), 'Window helper script');
  const temporary = assertStrictDescendant(environment.ownedRoot, environment.temporary, 'Window helper temporary directory');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('A window helper needs a positive timeout.');
  }
  return {
    command: windowsPowerShellExecutable(environment.systemRoot),
    // STA: the drop helper's OLE drag needs a single-threaded apartment.
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', scriptPath, ...scriptArguments],
    env: { SystemRoot: environment.systemRoot, Path: environment.path, TEMP: temporary, TMP: temporary },
    timeoutMs,
    stopGraceMs: HELPER_STOP_GRACE_MS,
    pressesMouseButton: script === 'installed-window-drop.ps1',
  };
}

export function windowActivateArguments(app: AppProcess): string[] {
  return [...appIdentity(app), '-Action', 'activate'];
}

export function windowKeyArguments(app: AppProcess, key: WindowKey): string[] {
  if (key !== 'F5' && key !== 'CtrlR') throw new Error('Only F5 and Ctrl+R are sent to the window.');
  return [...appIdentity(app), '-Action', 'key', '-Key', key];
}

/**
 * The drop takes only files this check wrote into its own sources directory,
 * and the helper's deadline must leave time for it to stop by itself before
 * the caller's timeout.
 */
export function windowDropArguments(
  app: AppProcess,
  paths: readonly string[],
  sourcesDirectory: string,
  callerTimeoutMs: number,
  deadlineMs = DROP_HELPER_DEADLINE_MS,
): string[] {
  if (paths.length === 0) throw new Error('A drop needs at least one file.');
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    throw new Error('A drop names each file once.');
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs + HELPER_STOP_GRACE_MS >= callerTimeoutMs) {
    throw new Error('The drop helper\'s deadline must end well before the caller\'s timeout.');
  }
  const safePaths = paths.map((path) =>
    assertStrictDescendant(sourcesDirectory, assertPlainAbsolutePath(path, 'Dropped file'), 'Dropped file'));
  return [...appIdentity(app), '-DeadlineMs', String(deadlineMs), ...safePaths];
}

function appTreeScope(runRoot: string, webViewDataDirectory: string): string[] {
  const root = assertPlainAbsolutePath(runRoot, 'Run root');
  const webView = assertStrictDescendant(root, webViewDataDirectory, 'WebView2 user-data directory');
  return ['-RunRoot', root, '-WebViewDataDirectory', webView];
}

export function appTreeCloseArguments({
  appPid,
  runRoot,
  webViewDataDirectory,
  sampleAfterMs,
}: {
  readonly appPid: number;
  readonly runRoot: string;
  readonly webViewDataDirectory: string;
  readonly sampleAfterMs: readonly number[];
}): string[] {
  if (
    sampleAfterMs.length === 0 ||
    sampleAfterMs.some((value, index) =>
      !Number.isSafeInteger(value) || value <= 0 || value > 60_000 || (index > 0 && value <= sampleAfterMs[index - 1]))
  ) {
    throw new Error('Samples after the close message must be rising whole milliseconds up to 60 s.');
  }
  return [
    '-Action', 'close',
    ...appTreeScope(runRoot, webViewDataDirectory),
    '-AppPid', assertAppPid(appPid),
    '-SampleAfterMs', sampleAfterMs.join(','),
  ];
}

export function appTreeInventoryArguments({
  runRoot,
  webViewDataDirectory,
  app,
}: {
  readonly runRoot: string;
  readonly webViewDataDirectory: string;
  /**
   * The app root: with its creation time its descendants count even after it
   * exited; without it the helper reads the running root's creation time.
   */
  readonly app?: { readonly pid: number; readonly createdFileTime?: string };
}): string[] {
  const appArguments = app
    ? [
        '-AppPid', assertAppPid(app.pid),
        ...(app.createdFileTime === undefined ? [] : ['-AppCreatedFileTime', fileTimeOf(app.createdFileTime)]),
      ]
    : [];
  return ['-Action', 'inventory', ...appTreeScope(runRoot, webViewDataDirectory), ...appArguments];
}

/**
 * The helper's result: its last output line, a JSON object with `ok: true`.
 * A refusal names only the helper's reason token.
 */
export function parseWindowHelperOutput(stdout: string, exitCode: number | null): Record<string, unknown> {
  const line = stdout.split(/\r?\n/u).map((candidate) => candidate.trim()).filter(Boolean).at(-1);
  let result: unknown;
  try {
    result = line?.startsWith('{') ? JSON.parse(line) : undefined;
  } catch {
    result = undefined;
  }
  if (typeof result !== 'object' || result === null || typeof (result as { ok?: unknown }).ok !== 'boolean') {
    throw new Error(`Window helper ended with status ${String(exitCode)} without a result.`);
  }
  const value = result as Record<string, unknown>;
  if (value.ok !== true) {
    const reason = typeof value.reason === 'string' && /^[a-z-]{1,64}$/u.test(value.reason) ? value.reason : 'unknown';
    throw new Error(windowHelperRefusal(reason));
  }
  if (exitCode !== 0) throw new Error(`Window helper reported success but ended with status ${String(exitCode)}.`);
  return value;
}

const RELEASE_BY_HAND = 'The left mouse button may need to be released by hand: click it once.';

/** What a refusal means for the run, by the helper's reason. */
export function windowHelperRefusal(reason: string): string {
  switch (reason) {
    case 'foreground-changed-during-input':
      return 'The foreground window changed while the keys were sent: input may have reached another window. No further input is sent.';
    case 'input-not-inserted':
      return 'Windows did not insert every key event: input may have reached another window, and a key may be left pressed (press and release Ctrl once). No further input is sent.';
    case 'foreground-not-owned':
      return 'The QA app does not own the foreground window; no input was sent.';
    case 'app-process-changed':
      return 'The QA app\'s PID no longer belongs to the process the check started; no input was sent.';
    case 'button-not-released':
      return `The drop helper could not release the mouse button it pressed. ${RELEASE_BY_HAND}`;
    default:
      return `Window helper refused: ${reason}.`;
  }
}

/** What a helper that stopped on request said about its own stop, if it failed to release the button. */
function stoppedHelperRefusal(stdout: string): string {
  try {
    parseWindowHelperOutput(stdout, null);
  } catch (error) {
    if (error instanceof Error && error.message.includes(RELEASE_BY_HAND)) return ` ${error.message}`;
  }
  return '';
}

export function runWindowHelper(invocation: WindowHelperInvocation): Observable<Record<string, unknown>> {
  return new Observable<Record<string, unknown>>((subscriber) => {
    let stdout = '';
    let settled = false;
    let stopRequested = false;
    // Standard input stays open while the helper runs; ending it asks the
    // helper to stop, so it can release a pressed button before it exits.
    const child = spawn(invocation.command, [...invocation.args], {
      env: { ...invocation.env },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    child.stdin?.on('error', () => undefined);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const requestStop = () => {
      if (stopRequested) return;
      stopRequested = true;
      child.stdin?.end('stop\n');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, invocation.stopGraceMs);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      requestStop();
    }, invocation.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < outputLimit) stdout += chunk.toString('utf8').slice(0, outputLimit - stdout.length);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscriber.error(new Error(`Window helper could not start: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (stopRequested) {
        // A helper that stopped by itself released the button it pressed;
        // only a killed one may have left it pressed.
        subscriber.error(new Error(signal
          ? `Window helper timed out after ${invocation.timeoutMs} ms and was killed after it did not stop within ${invocation.stopGraceMs} ms.${invocation.pressesMouseButton ? ` ${RELEASE_BY_HAND}` : ''}`
          : `Window helper timed out after ${invocation.timeoutMs} ms; it stopped after the stop request.${stoppedHelperRefusal(stdout)}`));
        return;
      }
      try {
        subscriber.next(parseWindowHelperOutput(stdout, code));
        subscriber.complete();
      } catch (error) {
        subscriber.error(error);
      }
    });
    return () => {
      clearTimeout(timer);
      if (!settled) requestStop();
    };
  });
}
