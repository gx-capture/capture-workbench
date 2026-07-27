import { lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

import {
  concatMap,
  defer,
  from,
  map,
  of,
  switchMap,
  throwError,
  timer,
  toArray,
} from 'rxjs';

import {
  assertRegistryOwnership,
  assertStrictDescendant,
} from './contracts/installed.ts';

export function createInstalledRegistry({
  smokeRoot,
  workspaceRoot,
  registryViews,
  productRegistryKey,
  uninstallRegistryKey,
  baseChildEnvironment,
  pathExists,
}) {
  function waitUntil(check, timeout, message, deadline = Date.now() + timeout) {
    return defer(() => check()).pipe(
      switchMap((done) => {
        if (done) return of(undefined);
        if (Date.now() >= deadline) return throwError(() => new Error(message));
        return timer(100).pipe(concatMap(() => waitUntil(check, timeout, message, deadline)));
      }),
    );
  }

  function registryKeyExists(key, view = '64') {
    return defer(() => of(registryCommand(['query', key, `/reg:${view}`]))).pipe(
      map((result) => {
        if (result.status === 0) return true;
        if (result.status === 1) return false;
        throw new Error('Windows registry query failed.');
      }),
    );
  }

  function registryValue(key, name, view) {
    return defer(() => of(registryCommand(['query', key, '/v', name, `/reg:${view}`]))).pipe(
      map((result) => {
        if (result.status === 1) return undefined;
        if (result.status !== 0) throw new Error('Windows registry value query failed.');
        const line = result.stdout
          .split(/\r?\n/u)
          .find((candidate) => candidate.trimStart().startsWith(name));
        const match = line?.match(/^\s*\S+\s+REG_\S+\s+(.*?)\s*$/u);
        if (!match) throw new Error('Windows registry value response was malformed.');
        return match[1];
      }),
    );
  }

  function registryDefaultValue(key, view) {
    return defer(() => of(registryCommand(['query', key, '/ve', `/reg:${view}`]))).pipe(
      map((result) => {
        if (result.status === 1) return undefined;
        if (result.status !== 0) throw new Error('Windows registry value query failed.');
        const line = result.stdout
          .split(/\r?\n/u)
          .find((candidate) => /\sREG_\S+\s/u.test(candidate));
        const match = line?.match(/^\s*.+?\s+REG_\S+\s+(.*?)\s*$/u);
        if (!match) throw new Error('Windows registry default value response was malformed.');
        return match[1];
      }),
    );
  }

  function waitForInstalledDirectoryRemoval(directory) {
    return waitUntil(
      () => pathExists(directory).pipe(map((exists) => !exists)),
      30_000,
      'Installed NSIS uninstaller did not remove its exact install directory.',
    ).pipe(
      concatMap(() => registryKeyExists(uninstallRegistryKey)),
      concatMap((exists) =>
        exists
          ? throwError(() => new Error('Installed NSIS uninstaller left its uninstall registry key.'))
          : of(undefined),
      ),
    );
  }

  function assertNoPreExistingInstallation() {
    return from([uninstallRegistryKey, productRegistryKey]).pipe(
      concatMap((key) =>
        from(registryViews).pipe(
          concatMap((view) => registryKeyExists(key, view).pipe(map((exists) => (exists ? `${key} (${view})` : undefined)))),
        ),
      ),
      toArray(),
      concatMap((existing) => {
        const found = existing.filter(Boolean);
        return found.length > 0
          ? throwError(() => new Error('A pre-existing Capture Workbench Verification installation was found; refusing to modify it.'))
          : of(undefined);
      }),
    );
  }

  function assertInstalledRegistryPointsToOwnedDirectory(directory) {
    const ownedValues = [
      {
        key: uninstallRegistryKey,
        label: 'Installed NSIS uninstall registry key',
        read: (view) => registryValue(uninstallRegistryKey, 'InstallLocation', view),
      },
      {
        key: productRegistryKey,
        label: 'Installed NSIS product registry key',
        read: (view) => registryDefaultValue(productRegistryKey, view),
      },
    ];
    return from(ownedValues).pipe(
      concatMap((ownedValue) =>
        from(registryViews).pipe(
          concatMap((view) =>
            registryKeyExists(ownedValue.key, view).pipe(
              concatMap((exists) =>
                exists
                  ? ownedValue.read(view).pipe(
                      map((value) => {
                        assertRegistryOwnership(value, directory, `${ownedValue.label} (${view}-bit view)`);
                        return 1;
                      }),
                    )
                  : of(0),
              ),
            ),
          ),
          toArray(),
          map((presentViews) => ({ ownedValue, count: presentViews.reduce((sum, value) => sum + value, 0) })),
        ),
      ),
      concatMap(({ ownedValue, count }) =>
        count === 0
          ? throwError(() => new Error(`${ownedValue.label} is absent; refusing destructive cleanup.`))
          : of(undefined),
      ),
      toArray(),
      map(() => undefined),
    );
  }

  function removeOwnedRegistryResidue(expectedDirectory) {
    return from([uninstallRegistryKey, productRegistryKey]).pipe(
      concatMap((key) =>
        from(registryViews).pipe(
          concatMap((view) => registryKeyExists(key, view).pipe(
            concatMap((exists) => {
              if (!exists) return of(undefined);
              const ownership$ = key === uninstallRegistryKey
                ? registryValue(key, 'InstallLocation', view)
                : registryDefaultValue(key, view);
              return ownership$.pipe(
                map((value) => {
                  assertRegistryOwnership(value, expectedDirectory, `${key} (${view}-bit view)`);
                  const result = registryCommand(['delete', key, '/f', `/reg:${view}`]);
                  if (result.status !== 0) throw new Error('Owned NSIS registry residue could not be removed.');
                }),
              );
            }),
          )),
        ),
      ),
      toArray(),
      concatMap(() => from([uninstallRegistryKey, productRegistryKey])),
      concatMap((key) => from(registryViews).pipe(
        concatMap((view) => registryKeyExists(key, view)),
      )),
      toArray(),
      concatMap((remaining) => remaining.some(Boolean)
        ? throwError(() => new Error('Owned NSIS registry residue remained after cleanup.'))
        : of(undefined)),
    );
  }

  function registryCommand(arguments_) {
    return spawnSync(windowsSystemExecutable('System32', 'reg.exe'), arguments_, {
      env: baseChildEnvironment(process.env, smokeRoot, workspaceRoot),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
  }

  function windowsSystemExecutable(...segments) {
    if (process.platform !== 'win32') {
      throw new Error('Windows system executable resolution requires Windows.');
    }
    const systemRootEntry = Object.entries(process.env).find(
      ([name, value]) =>
        (name.toUpperCase() === 'SYSTEMROOT' || name.toUpperCase() === 'WINDIR') &&
        typeof value === 'string' && value.length > 0,
    );
    const configuredRoot = systemRootEntry?.[1];
    if (!configuredRoot || !isAbsolute(configuredRoot) || /[\0\r\n]/u.test(configuredRoot)) {
      throw new Error('Windows system root is unavailable or unsafe.');
    }
    const systemRoot = realpathSync(resolve(configuredRoot));
    const candidate = realpathSync(join(systemRoot, ...segments));
    assertStrictDescendant(systemRoot, candidate, 'Windows system executable');
    const metadata = lstatSync(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('Windows system executable must be a regular file.');
    }
    return candidate;
  }

  return {
    waitForInstalledDirectoryRemoval,
    assertNoPreExistingInstallation,
    assertInstalledRegistryPointsToOwnedDirectory,
    removeOwnedRegistryResidue,
    windowsSystemExecutable,
  };
}
