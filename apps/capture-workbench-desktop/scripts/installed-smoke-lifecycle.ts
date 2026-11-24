import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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
import { INSTALLED_EXECUTABLE_NAME, UNINSTALLER_NAME } from './constants/installed.ts';
import { assertStrictDescendant, uninstallerArguments } from './contracts/installed.ts';
import type { createInstalledRegistry } from './installed-registry.ts';

type InstalledRegistry = ReturnType<typeof createInstalledRegistry>;
type InstalledSmokeLifecycle = ReturnType<typeof createInstalledSmokeLifecycle>;

export function pathExists(path: string): Observable<boolean> {
  return defer(() => from(stat(path))).pipe(
    map(() => true),
    catchError((error) =>
      error?.code === 'ENOENT' ? of(false) : throwError(() => error),
    ),
  );
}

/** Replaces an evidence file below the check's own root in one rename. */
export function writeOwnedEvidence(root: string, destination: string, report: unknown): Observable<undefined> {
  const safePath = assertStrictDescendant(root, destination, 'Evidence path');
  const temporary = `${safePath}.tmp`;
  return defer(() => from(rm(temporary, { force: true }))).pipe(
    concatMap(() =>
      from(
        writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        }),
      ),
    ),
    concatMap(() => from(rm(safePath, { force: true }))),
    concatMap(() => from(rename(temporary, safePath))),
    map(() => undefined),
  );
}

/** The installer put the app into the owned directory, and the registry says so. */
export function assertInstalledIntoOwnedDirectory(
  lifecycle: Pick<InstalledSmokeLifecycle, 'assertOwnedRegularFile'>,
  registry: Pick<InstalledRegistry, 'assertInstalledRegistryPointsToOwnedDirectory'>,
  installDirectory: string,
): Observable<undefined> {
  return lifecycle.assertOwnedRegularFile(
    installDirectory,
    join(installDirectory, INSTALLED_EXECUTABLE_NAME),
    'Installed Tauri executable',
  ).pipe(
    concatMap(() => registry.assertInstalledRegistryPointsToOwnedDirectory(installDirectory)),
    map(() => undefined),
  );
}

/**
 * Runs the owned installation's own uninstaller and waits until its directory
 * and uninstall key are gone. When the uninstaller is already missing, the
 * installation counts as removed only if the executable is gone too.
 */
export function uninstallOwnedInstallation({
  lifecycle,
  registry,
  smokeRoot,
  installDirectory,
  environment,
  timeoutMs,
}: {
  lifecycle: Pick<InstalledSmokeLifecycle, 'assertOwnedRegularFile' | 'runCheckedExecutable'>;
  registry: Pick<InstalledRegistry, 'assertInstalledRegistryPointsToOwnedDirectory' | 'waitForInstalledDirectoryRemoval'>;
  smokeRoot: string;
  installDirectory: string;
  environment: Record<string, string>;
  timeoutMs: number;
}): Observable<{ uninstallKeyRemoved: boolean; productKeyRetained: boolean }> {
  const uninstallerPath = join(installDirectory, UNINSTALLER_NAME);
  return pathExists(uninstallerPath).pipe(
    switchMap((exists) => {
      if (!exists) {
        return pathExists(join(installDirectory, INSTALLED_EXECUTABLE_NAME)).pipe(
          concatMap((executableExists) =>
            executableExists
              ? throwError(
                  () =>
                    new Error(
                      'Installed uninstaller is missing from the owned install directory.',
                    ),
                )
              : registry.waitForInstalledDirectoryRemoval(installDirectory),
          ),
        );
      }
      return lifecycle
        .assertOwnedRegularFile(installDirectory, uninstallerPath, 'Installed uninstaller')
        .pipe(
          concatMap((uninstaller) =>
            registry.assertInstalledRegistryPointsToOwnedDirectory(installDirectory).pipe(
              concatMap(() =>
                lifecycle.runCheckedExecutable(
                  uninstaller,
                  uninstallerArguments(smokeRoot, installDirectory),
                  'Installed NSIS uninstaller',
                  environment,
                  timeoutMs,
                ),
              ),
            ),
          ),
          concatMap(() => registry.waitForInstalledDirectoryRemoval(installDirectory)),
        );
    }),
  );
}

export function expectedInstallerName(version, productName = 'Capture Workbench') {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('Expected installer version must be semantic x.y.z.');
  }
  return `${productName}_${version}_x64-setup.exe`;
}

export function createInstalledSmokeLifecycle({
  workspaceRoot,
  smokeRoot,
  nsisDirectory,
  productName = 'Capture Workbench',
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
            () =>
              new Error(
                'Recursive removal target must be an owned real directory.',
              ),
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

  function findExpectedInstaller(expectedVersion) {
    const expectedName = expectedVersion
      ? expectedInstallerName(expectedVersion, productName)
      : undefined;
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
        defer(() =>
          from(readdir(directoryRealPath, { withFileTypes: true })),
        ).pipe(
          map((entries) =>
            entries.filter(
              (entry) =>
                entry.isFile() &&
                (expectedName
                  ? entry.name === expectedName
                  : /^Capture Workbench_\d+\.\d+\.\d+_x64-setup\.exe$/u.test(
                      entry.name,
                    )),
            ),
          ),
          concatMap((installers) => {
            if (installers.length !== 1) {
              return throwError(
                () =>
                  new Error(
                    `Expected exactly one matching x64 NSIS installer, found ${installers.length}.`,
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
                    () =>
                      new Error(
                        'NSIS installer must be a regular file.',
                      ),
                  );
                }
                if (
                  dirname(actualPath).toLowerCase() !==
                  directoryRealPath.toLowerCase()
                ) {
                  return throwError(
                    () =>
                      new Error(
                        'NSIS installer escaped its artifact directory.',
                      ),
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
          return throwError(
            () => new Error(`${label} must be a regular file.`),
          );
        }
        assertStrictDescendant(root, actual, label);
        return of(actual);
      }),
    );
  }

  function childOutcome(child) {
    return new Observable<{
      kind: 'error' | 'exit';
      error?: Error;
      code?: number | null;
      signal?: NodeJS.Signals | null;
    }>((subscriber) => {
      const onError = (error) => subscriber.next({ kind: 'error', error });
      const onExit = (code, signal) =>
        subscriber.next({ kind: 'exit', code, signal });
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
        timer(timeout).pipe(map(() => ({ kind: 'timeout' as const }))),
      ).pipe(
        concatMap((outcome) => {
          if (outcome.kind === 'timeout') {
            return terminateTrackedProcessTree(child, label).pipe(
              concatMap(() =>
                throwError(
                  () => new Error(`${label} timed out after ${timeout} ms.`),
                ),
              ),
            );
          }
          if (outcome.kind === 'error') {
            return throwError(
              () =>
                new Error(`${label} could not run: ${outcome.error.message}`),
            );
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
    findExpectedInstaller,
    assertOwnedRegularFile,
    runCheckedExecutable,
  };
}
