import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  Observable,
  catchError,
  concatMap,
  defer,
  forkJoin,
  from,
  map,
  of,
  race,
  switchMap,
  take,
  tap,
  throwError,
  timer,
} from 'rxjs';

import { sha256File } from './stage-runtime.ts';
import { assertStrictDescendant } from './contracts/installed.ts';

export function createInstalledSmokeLifecycle({
  workspaceRoot,
  smokeRoot,
  nsisDirectory,
  terminateTrackedProcessTree,
}) {
  function prepareSmokeDirectories() {
    return defer(() => from(mkdir(smokeRoot, { recursive: true }))).pipe(
      concatMap(() =>
        forkJoin({
          workspaceRealPath: defer(() => from(realpath(workspaceRoot))),
          smokeRealPath: defer(() => from(realpath(smokeRoot))),
        }),
      ),
      tap(({ workspaceRealPath, smokeRealPath }) =>
        assertStrictDescendant(
          workspaceRealPath,
          smokeRealPath,
          'Installed smoke output directory',
        ),
      ),
      map(() => undefined),
    );
  }

  function safeRemoveTree(root, target) {
    const safeTarget = assertStrictDescendant(
      root,
      target,
      'Recursive removal target',
    );
    return defer(() => from(lstat(safeTarget))).pipe(
      catchError((error) =>
        error?.code === 'ENOENT' ? of(undefined) : throwError(() => error),
      ),
      concatMap((metadata) => {
        if (!metadata) return of(undefined);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          return throwError(
            () => new Error('Recursive removal target must be an owned real directory.'),
          );
        }
        return defer(() =>
          from(
            rm(safeTarget, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 250,
            }),
          ),
        ).pipe(map(() => undefined));
      }),
    );
  }

  function findDeterministicInstaller() {
    return forkJoin({
      workspaceRealPath: defer(() => from(realpath(workspaceRoot))),
      directoryRealPath: defer(() => from(realpath(nsisDirectory))),
    }).pipe(
      tap(({ workspaceRealPath, directoryRealPath }) =>
        assertStrictDescendant(
          workspaceRealPath,
          directoryRealPath,
          'NSIS artifact directory',
        ),
      ),
      switchMap(({ directoryRealPath }) =>
        defer(() => from(readdir(directoryRealPath, { withFileTypes: true }))).pipe(
          map((entries) =>
            entries.filter(
              (entry) => entry.isFile() && /^Capture Workbench_\d+\.\d+\.\d+_x64-setup\.exe$/u.test(entry.name),
            ),
          ),
          concatMap((installers) => {
            if (installers.length !== 1) {
              return throwError(
                () =>
                  new Error(
                    `Expected exactly one deterministic x64 NSIS installer, found ${installers.length}.`,
                  ),
              );
            }
            const path = join(directoryRealPath, installers[0].name);
            return forkJoin({
              metadata: defer(() => from(lstat(path))),
              actualPath: defer(() => from(realpath(path))),
            }).pipe(
              concatMap(({ metadata, actualPath }) => {
                if (!metadata.isFile() || metadata.isSymbolicLink()) {
                  return throwError(
                    () => new Error('Deterministic NSIS installer must be a regular file.'),
                  );
                }
                if (dirname(actualPath).toLowerCase() !== directoryRealPath.toLowerCase()) {
                  return throwError(
                    () => new Error('Deterministic NSIS installer escaped its artifact directory.'),
                  );
                }
                return sha256File(actualPath).pipe(
                  map((sha256) => ({
                    path: actualPath,
                    fileName: basename(actualPath),
                    bytes: metadata.size,
                    sha256,
                  })),
                );
              }),
            );
          }),
        ),
      ),
    );
  }

  function assertOwnedRegularFile(root, candidate, label) {
    const safeCandidate = assertStrictDescendant(root, candidate, label);
    return forkJoin({
      metadata: defer(() => from(lstat(safeCandidate))),
      actual: defer(() => from(realpath(safeCandidate))),
    }).pipe(
      concatMap(({ metadata, actual }) => {
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          return throwError(() => new Error(`${label} must be a regular file.`));
        }
        assertStrictDescendant(root, actual, label);
        return of(actual);
      }),
    );
  }

  function childOutcome(child) {
    return new Observable((subscriber) => {
      const onError = (error) => subscriber.next({ kind: 'error', error });
      const onExit = (code, signal) => subscriber.next({ kind: 'exit', code, signal });
      child.once('error', onError);
      child.once('exit', onExit);
      return () => {
        child.off('error', onError);
        child.off('exit', onExit);
      };
    }).pipe(take(1));
  }

  function runCheckedExecutable(path, arguments_, label, environment, timeout) {
    return defer(() => {
      const child = spawn(path, arguments_, {
        env: environment,
        stdio: 'ignore',
        windowsHide: true,
      });
      return race(
        childOutcome(child),
        timer(timeout).pipe(map(() => ({ kind: 'timeout' }))),
      ).pipe(
        concatMap((outcome) => {
          if (outcome.kind === 'timeout') {
            return terminateTrackedProcessTree(child, label).pipe(
              concatMap(() =>
                throwError(() => new Error(`${label} timed out after ${timeout} ms.`)),
              ),
            );
          }
          if (outcome.kind === 'error') {
            return throwError(() => new Error(`${label} could not run: ${outcome.error.message}`));
          }
          if (outcome.code !== 0) {
            return throwError(
              () =>
                new Error(
                  `${label} exited with status ${String(outcome.code)}${outcome.signal ? ` (${outcome.signal})` : ''}.`,
                ),
            );
          }
          return of(undefined);
        }),
      );
    });
  }

  return {
    prepareSmokeDirectories,
    safeRemoveTree,
    findDeterministicInstaller,
    assertOwnedRegularFile,
    runCheckedExecutable,
  };
}
