import { spawnSync } from 'node:child_process';
import net from 'node:net';

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

export function createInstalledProcessCleanup({
  smokeRoot,
  workspaceRoot,
  baseChildEnvironment,
  windowsSystemExecutable,
}) {
  function terminateTrackedProcessTree(child, label) {
    if (child.exitCode !== null || child.signalCode !== null) return of(undefined);
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      return throwError(() => new Error(`${label} did not expose a valid owned PID.`));
    }
    const exited = race(
      fromEvent(child, 'exit'),
      fromEvent(child, 'error'),
    ).pipe(take(1), map(() => undefined));
    const result = spawnSync(
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
        const stillRunning = child.exitCode === null && child.signalCode === null;
        assertTaskkillResult(result, stillRunning);
        if (stillRunning) {
          throw new Error(`${label} remained active after exact PID tree cleanup.`);
        }
      }),
    );
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

  function processesRunningUnder(root) {
    const safeRoot = assertStrictDescendant(smokeRoot, root, 'Owned process root');
    const script = `
$root = [IO.Path]::GetFullPath($env:CAPTURE_SMOKE_PROCESS_ROOT).TrimEnd('\\') + '\\'
$items = @(Get-CimInstance Win32_Process | ForEach-Object {
  try {
    if ($_.ExecutablePath) {
      $path = [IO.Path]::GetFullPath($_.ExecutablePath)
      if ($path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        [pscustomobject]@{ pid = [int]$_.ProcessId }
      }
    }
  } catch {}
})
ConvertTo-Json -Compress -InputObject $items
`;
    const environment = {
      ...baseChildEnvironment(process.env, smokeRoot, workspaceRoot),
      CAPTURE_SMOKE_PROCESS_ROOT: safeRoot,
    };
    return defer(() =>
      of(
        spawnSync(
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
            timeout: 30_000,
          },
        ),
      ),
    ).pipe(
      map((result) => {
        if (result.error || result.status !== 0) {
          const detail = (result.error?.message ?? result.stderr ?? '')
            .trim()
            .slice(0, 500);
          throw new Error(
            `Owned installed process query failed${detail ? `: ${detail}` : '.'}`,
          );
        }
        const output = result.stdout.trim();
        if (!output) return [];
        const value = JSON.parse(output);
        return Array.isArray(value) ? value : [value];
      }),
    );
  }

  function taskkillOwnedPid(pid, ownedRoot) {
    return defer(() => {
      const result = spawnSync(
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
        processesRunningUnder(ownedRoot).pipe(
          map((processes) => {
            const stillOwned = processes.some((candidate) => candidate.pid === pid);
            assertTaskkillResult(result, stillOwned);
          }),
        ),
      ),
    );
  }

  function stopAndProveOwnedProcesses(pid, ownedRoot) {
    if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) {
      return throwError(() => new Error('Owned Tauri PID is invalid.'));
    }
    return processesRunningUnder(ownedRoot).pipe(
      concatMap((before) =>
        pid !== undefined && before.some((process_) => process_.pid === pid)
          ? taskkillOwnedPid(pid, ownedRoot)
          : of(undefined),
      ),
      concatMap(() => timer(250)),
      concatMap(() => processesRunningUnder(ownedRoot)),
      concatMap((processes) =>
        from(processes).pipe(
          concatMap((process_) =>
            processesRunningUnder(ownedRoot).pipe(
              concatMap((current) =>
                current.some((candidate) => candidate.pid === process_.pid)
                  ? taskkillOwnedPid(process_.pid, ownedRoot)
                  : of(undefined),
              ),
            ),
          ),
          toArray(),
        ),
      ),
      concatMap(() =>
        waitUntil(
          () => processesRunningUnder(ownedRoot).pipe(map((processes) => processes.length === 0)),
          20_000,
          'Owned installed app/runtime processes remained after tree cleanup.',
        ),
      ),
    );
  }

  function stopAndProveOwnedProcessRoots(ownedRoots) {
    return from(ownedRoots).pipe(
      concatMap((ownedRoot) =>
        stopAndProveOwnedProcesses(undefined, ownedRoot).pipe(
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
    terminateTrackedProcessTree,
    stopAndProveOwnedProcesses,
    stopAndProveOwnedProcessRoots,
    processesRunningUnder,
    waitForLoopbackPortRelease,
  };
}
