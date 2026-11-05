import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { join, resolve } from 'node:path';
import {
  EMPTY,
  Observable,
  catchError,
  concatMap,
  defaultIfEmpty,
  defer,
  finalize,
  tap,
  fromEvent,
  map,
  of,
  range,
  race,
  switchMap,
  take,
  throwError,
  timer,
} from 'rxjs';

import { DETERMINISTIC_MAX_UPLOAD_BYTES } from './constants/deterministic.ts';
import { appRoot } from './stage-runtime.ts';
import { deterministicQaPaths } from './deterministic-qa.ts';
const { stagedExecutable } = deterministicQaPaths;
import { waitForReady } from './deterministic-http.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const runtimeData = join(
  workspaceRoot,
  'tmp',
  'capture-workbench-desktop',
  'smoke',
  'runtime-data',
);
const maxUploadBytes = DETERMINISTIC_MAX_UPLOAD_BYTES;

export function launchReadyRuntime(requestLogPath?: string) {
  const failures: string[] = [];
  return range(1, 3).pipe(
    concatMap((attempt) =>
      launchAttempt(requestLogPath).pipe(
        catchError((error: unknown) => {
          failures.push(
            `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return EMPTY;
        }),
      ),
    ),
    take(1),
    defaultIfEmpty(undefined),
    switchMap((result) =>
      result
        ? of(result)
        : throwError(
            () =>
              new Error(
                `Deterministic runtime failed readiness after 3 owned launch attempts: ${failures.join(' | ')}`,
              ),
          ),
    ),
  );
}

function launchAttempt(requestLogPath?: string) {
  return reservePort().pipe(
    concatMap((runtimePort) =>
      reservePort(runtimePort).pipe(
        map((ollamaPort) => ({ runtimePort, ollamaPort })),
      ),
    ),
    switchMap(({ runtimePort, ollamaPort }) => {
      const token = randomBytes(32).toString('hex');
      const host = `127.0.0.1:${runtimePort}`;
      const origin = 'http://tauri.localhost';
      const child = spawn(
        stagedExecutable,
        ['serve', '--host', '127.0.0.1', '--port', String(runtimePort)],
        {
          cwd: resolve(stagedExecutable, '..'),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            ...(requestLogPath ? { CAPTURE_DETERMINISTIC_REQUEST_LOG: requestLogPath } : {}),
            CAPTURE_HOST: '127.0.0.1',
            CAPTURE_PORT: String(runtimePort),
            CAPTURE_API_TOKEN: token,
            CAPTURE_ALLOWED_HOSTS: host,
            CAPTURE_ALLOWED_ORIGINS: origin,
            CAPTURE_ENABLE_API_DOCS: 'false',
            CAPTURE_APP_DATA_DIR: join(runtimeData, 'capture'),
            CAPTURE_STRUCTURING_PROVIDER: 'fake',
            CAPTURE_RETENTION_HOURS: '24',
            CAPTURE_MAX_UPLOAD_BYTES: String(maxUploadBytes),
            CAPTURE_OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
            CAPTURE_OLLAMA_APP_DATA: join(runtimeData, 'ollama'),
            CAPTURE_OLLAMA_PID_FILE: join(runtimeData, 'ollama', 'ollama.pid'),
            OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
            OLLAMA_MODELS: join(runtimeData, 'ollama', 'models'),
          },
        },
      );
      let spawnError: Error | undefined;
      child.on('error', (error) => { spawnError = error; });
      const output = captureChildOutput(child);
      return waitForReady({ runtimePort, host, origin, token, child }).pipe(
        map((ready) => ({ child, ready, runtimePort, ollamaPort, token, host, origin })),
        catchError((error: unknown) =>
          terminateOwnedTree(child).pipe(
            switchMap(() =>
              throwError(
                () =>
                  new Error(
                    `${spawnError ? 'Deterministic runtime could not start.' : error instanceof Error ? error.message : String(error)}${
                      redactChildOutput(output.text(), token)
                        ? `; child output: ${redactChildOutput(output.text(), token)}`
                        : ''
                    }`,
                  ),
              ),
            ),
          ),
        ),
      );
    }),
  );
}

function redactChildOutput(value: string, token: string): string {
  return value
    .replaceAll(token, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [redacted]');
}

function captureChildOutput(child: ReturnType<typeof spawn>) {
  const chunks: Buffer[] = [];
  const collect = (chunk: Buffer): void => {
    if (chunks.reduce((total, item) => total + item.length, 0) < 8_192) {
      chunks.push(Buffer.from(chunk));
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return {
    text: () => Buffer.concat(chunks).toString('utf8').trim().slice(0, 8_192),
  };
}

function reservePort(excluded?: number): Observable<number> {
  return new Observable<number>((subscriber) => {
    const server = net.createServer();
    let retrySubscription: { unsubscribe(): void } | undefined;
    server.once('error', (error) => subscriber.error(error));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          subscriber.error(error);
        } else if (port === 0 || port === excluded) {
          retrySubscription = reservePort(excluded).subscribe(subscriber);
        } else {
          subscriber.next(port);
          subscriber.complete();
        }
      });
    });
    return () => {
      retrySubscription?.unsubscribe();
      if (server.listening) server.close();
    };
  });
}

export function terminateOwnedTree(child: ReturnType<typeof spawn>): Observable<void> {
  const running = () => child.exitCode === null && child.signalCode === null;
  const waitForExit = () => running() ? race(
    fromEvent(child, 'exit').pipe(take(1), map(() => undefined)),
    timer(2_000).pipe(map(() => undefined)),
  ) : of(undefined);
  return defer(() => {
    if (!child.pid || !running()) return of(undefined);
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 5_000,
      });
      if (result.error || result.status !== 0) child.kill('SIGKILL');
    } else {
      child.kill('SIGTERM');
    }
    return waitForExit().pipe(
      concatMap(() => {
        if (!running()) return of(undefined);
        child.kill('SIGKILL');
        return waitForExit();
      }),
      tap(() => {
        if (running()) throw new Error('Deterministic runtime did not stop after forced termination.');
      }),
    );
  }).pipe(finalize(() => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }));
}
