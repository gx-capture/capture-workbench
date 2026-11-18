import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';

import {
  Observable,
  catchError,
  concatMap,
  defer,
  from,
  fromEvent,
  map,
  of,
  race,
  switchMap,
  take,
  throwError,
  timer,
  toArray,
} from 'rxjs';

import {
  assertStrictDescendant,
  assertTaskkillResult,
} from './contracts/installed.ts';

const ownedProcessObserverAttemptLimit = 2;
const ownedProcessObserverTimeoutMs = 60_000;
const safeDiagnosticToken = /^[A-Za-z0-9_-]+$/u;
const processObserverStages = new Set(['root', 'names', 'query', 'serialize']);
const defaultOwnedProcessExecutableNames = [
  'capture-workbench-desktop.exe',
  'capture-runtime-x86_64-pc-windows-msvc.exe',
  'capture-runtime.exe',
  'capture-engine-ocr.exe',
  'capture-engine-diarization.exe',
  'capture-engine-speech-recognition.exe',
  'capture-engine-speech-recognition-cpu.exe',
  'ollama.exe',
  'runtime.exe',
  'cmd.exe',
];
type OwnedProcessSnapshot = { readonly pid: number };
type SpawnSyncProcessResult = {
  readonly error?: Error & { readonly code?: string };
  readonly signal: string | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
};
type SpawnSyncProcess = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncProcessResult;

function diagnosticToken(value, fallback = 'none') {
  const candidate = value === undefined || value === null ? fallback : String(value);
  return safeDiagnosticToken.test(candidate) ? candidate : fallback;
}

function processObserverError(result, attempt, operation, code, firstAttempt) {
  const errorCode = diagnosticToken(result.error?.code, code);
  const status = Number.isInteger(result.status) ? String(result.status) : 'none';
  const signal = diagnosticToken(result.signal);
  const timedOut = errorCode === 'ETIMEDOUT';
  const stderr = result.stderr?.trim();
  const stage = processObserverStages.has(stderr) ? stderr : 'none';
  const summary = `${errorCode}/${stage}`;
  return {
    summary,
    error: new Error(
      `Owned process observer failed (operation=${operation}; observer=cim-process; attempt=${attempt}/${ownedProcessObserverAttemptLimit}; timeout=${String(timedOut)}; code=${errorCode}; status=${status}; signal=${signal}; stage=${stage}; attempt1=${firstAttempt ?? summary}).`,
    ),
  };
}

export function createTrackedProcessTreeTerminator({
  smokeRoot,
  workspaceRoot,
  baseChildEnvironment,
  windowsSystemExecutable,
  spawnSyncProcess = spawnSync,
}: {
  smokeRoot: string;
  workspaceRoot: string;
  baseChildEnvironment: (
    source: NodeJS.ProcessEnv,
    isolatedTemp: string,
    ownedRoot?: string,
  ) => Record<string, string>;
  windowsSystemExecutable: (...segments: string[]) => string;
  spawnSyncProcess?: SpawnSyncProcess;
}) {
  return function terminateTrackedProcessTree(child, label) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return of(undefined);
    }
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      return throwError(
        () => new Error(`${label} did not expose a valid owned PID.`),
      );
    }
    const exited = race(fromEvent(child, 'exit'), fromEvent(child, 'error')).pipe(
      take(1),
      map(() => undefined),
    );
    const result = spawnSyncProcess(
      windowsSystemExecutable('System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      {
        env: baseChildEnvironment(process.env, smokeRoot, workspaceRoot),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      },
    );
    return race(exited, timer(20_000).pipe(map(() => undefined))).pipe(
      map(() => {
        const stillRunning =
          child.exitCode === null && child.signalCode === null;
        assertTaskkillResult(result, stillRunning);
        if (stillRunning) {
          throw new Error(
            `${label} remained active after exact PID tree cleanup.`,
          );
        }
      }),
    );
  };
}

export function createInstalledProcessCleanup({
  smokeRoot,
  workspaceRoot,
  baseChildEnvironment,
  windowsSystemExecutable,
  spawnSyncProcess = spawnSync,
}: {
  smokeRoot: string;
  workspaceRoot: string;
  baseChildEnvironment: (
    source: NodeJS.ProcessEnv,
    isolatedTemp: string,
    ownedRoot?: string,
  ) => Record<string, string>;
  windowsSystemExecutable: (...segments: string[]) => string;
  spawnSyncProcess?: SpawnSyncProcess;
}) {
  const privateProcessRoots = new Set();
  const ownedProcessExecutableNames = new Set(defaultOwnedProcessExecutableNames);
  const terminateTrackedProcessTree = createTrackedProcessTreeTerminator({
    smokeRoot,
    workspaceRoot,
    baseChildEnvironment,
    windowsSystemExecutable,
    spawnSyncProcess,
  });

  function rootKey(root) {
    const resolvedRoot = resolve(root);
    return process.platform === 'win32'
      ? resolvedRoot.toLowerCase()
      : resolvedRoot;
  }

  function registerPrivateProcessRoots(roots, processExecutableNames = []) {
    const safeRoots = roots.map((root) =>
      assertStrictDescendant(smokeRoot, root, 'Private process root'),
    );
    for (const safeRoot of safeRoots) {
      const metadata = lstatSync(safeRoot);
      const actualRoot = realpathSync(safeRoot);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        rootKey(actualRoot) !== rootKey(safeRoot) ||
        readdirSync(safeRoot).length !== 0
      ) {
        throw new Error(
          'A current-run private process root must be a real empty directory.',
        );
      }
    }
    for (const name of processExecutableNames) {
      if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+\.exe$/iu.test(name)) {
        throw new Error('Owned process executable names must be bare Windows executable names.');
      }
      ownedProcessExecutableNames.add(name);
    }
    for (const safeRoot of safeRoots) {
      privateProcessRoots.add(rootKey(safeRoot));
    }
  }

  function assertCurrentRunPrivateProcessRoot(root) {
    const safeRoot = assertStrictDescendant(
      smokeRoot,
      root,
      'Private process root',
    );
    if (!privateProcessRoots.has(rootKey(safeRoot))) {
      throw new Error(
        'Private process root is not registered for the current installed-smoke run.',
      );
    }
    return safeRoot;
  }

  function waitUntil(check, timeout, message, deadline = Date.now() + timeout) {
    return defer(() => check()).pipe(
      switchMap((done) => {
        if (done) return of(undefined);
        if (Date.now() >= deadline) return throwError(() => new Error(message));
        return timer(100).pipe(
          concatMap(() => waitUntil(check, timeout, message, deadline)),
        );
      }),
    );
  }

  function observeExecutableProcessesUnder(root, allowMissingRoot = false) {
    const safeRoot = assertStrictDescendant(
      smokeRoot,
      root,
      'Executable process root',
    );
    if (!existsSync(safeRoot)) {
      if (allowMissingRoot) return of([]);
      return throwError(
        () => new Error('Owned process executable inventory could not be read.'),
      );
    }
    const names = [...ownedProcessExecutableNames];
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$stage = 'root'
try {
  $root = [IO.Path]::GetFullPath($env:CAPTURE_SMOKE_PROCESS_ROOT).TrimEnd('\') + '\'
  if (-not (Test-Path -LiteralPath $env:CAPTURE_SMOKE_PROCESS_ROOT)) {
    if ($env:CAPTURE_SMOKE_ALLOW_MISSING_ROOT -eq '1') {
      $stage = 'serialize'
      Write-Output '[]'
      exit 0
    }
    throw 'Owned process root is missing.'
  }
  if (-not (Test-Path -LiteralPath $env:CAPTURE_SMOKE_PROCESS_ROOT -PathType Container)) {
    throw 'Owned process root is not a directory.'
  }
  $stage = 'names'
  $decodedNames = ConvertFrom-Json -InputObject $env:CAPTURE_SMOKE_PROCESS_NAMES
  $names = @($decodedNames | Where-Object { $null -ne $_ })
  $items = @()
  if ($names.Count -gt 0) {
    $stage = 'query'
    $snapshot = Get-CimInstance -ClassName Win32_Process -Property Name, ExecutablePath, ProcessId
    $items = @(foreach ($process in $snapshot) {
      if ($process.Name -notin $names) { continue }
      $path = $process.ExecutablePath
      if ([string]::IsNullOrWhiteSpace($path)) { continue }
      $fullPath = [IO.Path]::GetFullPath($path)
      if ($fullPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        [pscustomobject]@{ pid = [int]$process.ProcessId }
      }
    })
  }
  $stage = 'serialize'
  ConvertTo-Json -Compress -InputObject $items
} catch {
  [Console]::Error.WriteLine($stage)
  exit 1
}
`;
    const environment = {
      ...baseChildEnvironment(process.env, smokeRoot, workspaceRoot),
      CAPTURE_SMOKE_PROCESS_ROOT: safeRoot,
      ...(allowMissingRoot
        ? { CAPTURE_SMOKE_ALLOW_MISSING_ROOT: '1' }
        : {}),
      CAPTURE_SMOKE_PROCESS_NAMES: JSON.stringify(names),
    };
    return defer(() => {
      let lastFailure;
      for (
        let attempt = 1;
        attempt <= ownedProcessObserverAttemptLimit;
        attempt += 1
      ) {
        const firstAttempt = lastFailure?.summary;
        const result = spawnSyncProcess(
          windowsSystemExecutable(
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
          {
            env: environment,
            encoding: 'utf8',
            windowsHide: true,
            timeout: ownedProcessObserverTimeoutMs,
          },
        );
        if (result.error || result.status !== 0) {
          lastFailure = processObserverError(
            result,
            attempt,
            'query',
            'NONZERO',
            firstAttempt,
          );
          continue;
        }
        const output = String(result.stdout ?? '').trim();
        if (!output) {
          lastFailure = processObserverError(
            result,
            attempt,
            'validate',
            'EMPTY_OUTPUT',
            firstAttempt,
          );
          continue;
        }
        let value;
        try {
          value = JSON.parse(output);
        } catch {
          lastFailure = processObserverError(
            result,
            attempt,
            'parse',
            'INVALID_JSON',
            firstAttempt,
          );
          continue;
        }
        const processes = Array.isArray(value) ? value : [value];
        if (
          processes.some(
            (candidate) =>
              typeof candidate !== 'object' ||
              candidate === null ||
              !Number.isSafeInteger(candidate.pid) ||
              candidate.pid < 1,
          )
        ) {
          lastFailure = processObserverError(
            result,
            attempt,
            'validate',
            'INVALID_OUTPUT',
            firstAttempt,
          );
          continue;
        }
        return of(processes.map((candidate) => ({ pid: candidate.pid })));
      }
      return throwError(
        () =>
          lastFailure?.error ??
          new Error(
            'Owned process observer failed (operation=query; observer=cim-process; attempt=none; timeout=false; code=UNKNOWN; status=none; signal=none; stage=none; attempt1=none).',
          ),
      );
    });
  }

  // Process ownership in this harness is path-scoped: an observed PID is owned
  // only when its executable is located below an exact registered private root.
  function processesRunningUnder(root) {
    const safeRoot = assertCurrentRunPrivateProcessRoot(root);
    return observeExecutableProcessesUnder(safeRoot) as Observable<readonly OwnedProcessSnapshot[]>;
  }

  function taskkillOwnedPid(pid, ownedRoot, observeProcesses) {
    return defer(() => {
      const result = spawnSyncProcess(
        windowsSystemExecutable('System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        {
          env: baseChildEnvironment(process.env, smokeRoot, workspaceRoot),
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30_000,
        },
      );
      return of(result);
    }).pipe(
      concatMap((result) =>
        observeProcesses(ownedRoot).pipe(
          map((processes) => {
            const stillOwned = (processes as readonly OwnedProcessSnapshot[]).some((candidate) => candidate.pid === pid);
            assertTaskkillResult(result, stillOwned);
          }),
        ),
      ),
    );
  }

  function stopAndProveProcesses(pid, ownedRoot, observeProcesses) {
    if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) {
      return throwError(() => new Error('Owned Tauri PID is invalid.'));
    }
    return observeProcesses(ownedRoot).pipe(
      concatMap((before) =>
        pid !== undefined && (before as readonly OwnedProcessSnapshot[]).some((process_) => process_.pid === pid)
          ? taskkillOwnedPid(pid, ownedRoot, observeProcesses)
          : of(undefined),
      ),
      concatMap(() => timer(250)),
      concatMap(() => observeProcesses(ownedRoot)),
      concatMap((processes) =>
        from(processes as readonly OwnedProcessSnapshot[]).pipe(
          concatMap((process_) =>
            observeProcesses(ownedRoot).pipe(
              concatMap((current) =>
                (current as readonly OwnedProcessSnapshot[]).some((candidate) => candidate.pid === process_.pid)
                  ? taskkillOwnedPid(
                      process_.pid,
                      ownedRoot,
                      observeProcesses,
                    )
                  : of(undefined),
              ),
            ),
          ),
          toArray(),
        ),
      ),
      concatMap(() =>
        waitUntil(
          () =>
            observeProcesses(ownedRoot).pipe(
              map((processes) => (processes as readonly OwnedProcessSnapshot[]).length === 0),
            ),
          20_000,
          'Owned installed app/runtime processes remained after tree cleanup.',
        ),
      ),
    );
  }

  function stopAndProveOwnedProcesses(pid, ownedRoot) {
    return stopAndProveProcesses(pid, ownedRoot, processesRunningUnder);
  }

  function stopAndProveResidualProcesses(pid, residualRoot) {
    return stopAndProveProcesses(
      pid,
      residualRoot,
      (root) => observeExecutableProcessesUnder(root, true),
    );
  }

  function stopAndProveProcessRoots(processRoots, stopAndProve) {
    return from(processRoots).pipe(
      concatMap((processRoot) =>
        stopAndProve(undefined, processRoot).pipe(
          catchError((error) => throwError(() => error)),
        ),
      ),
      toArray(),
      map(() => undefined),
      catchError((error) =>
        throwError(
          () =>
            new AggregateError(
              [error],
              'One or more installed-smoke process roots could not be cleaned safely.',
            ),
        ),
      ),
    );
  }

  function stopAndProveOwnedProcessRoots(ownedRoots) {
    return stopAndProveProcessRoots(
      ownedRoots,
      stopAndProveOwnedProcesses,
    );
  }

  function stopAndProveResidualProcessRoots(residualRoots) {
    return stopAndProveProcessRoots(
      residualRoots,
      stopAndProveResidualProcesses,
    );
  }

  function canBindLoopbackPort(port) {
    return new Observable((subscriber) => {
      const server = net.createServer();
      server.unref();
      const onError = () => {
        subscriber.next(false);
        subscriber.complete();
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () =>
        server.close((error) => {
          server.off('error', onError);
          if (error) subscriber.error(error);
          else {
            subscriber.next(true);
            subscriber.complete();
          }
        }),
      );
      return () => {
        server.off('error', onError);
        server.close();
      };
    });
  }

  function waitForLoopbackPortRelease(port) {
    return waitUntil(
      () => canBindLoopbackPort(port),
      20_000,
      'WebView2 CDP port remained bound after owned process cleanup.',
    );
  }

  return {
    registerPrivateProcessRoots,
    terminateTrackedProcessTree,
    stopAndProveOwnedProcesses,
    stopAndProveOwnedProcessRoots,
    stopAndProveResidualProcessRoots,
    processesRunningUnder,
    waitForLoopbackPortRelease,
  };
}
