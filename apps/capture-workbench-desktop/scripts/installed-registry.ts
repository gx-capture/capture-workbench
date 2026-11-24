import { lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

import {
  catchError,
  concatMap,
  defer,
  from,
  forkJoin,
  map,
  type Observable,
  of,
  switchMap,
  throwError,
  timer,
  toArray,
} from 'rxjs';

import {
  WEBVIEW2_RUNTIME_VERSION_KEYS,
  assertRegistryOwnership,
  assertStrictDescendant,
  assertWebViewRuntimeInstalled,
} from './contracts/installed.ts';

export function createInstalledRegistry({
  smokeRoot,
  workspaceRoot,
  registryViews,
  productRegistryKey,
  uninstallRegistryKey,
  baseChildEnvironment,
  pathExists,
}: {
  smokeRoot: string;
  workspaceRoot: string;
  registryViews: readonly string[];
  productRegistryKey: string;
  uninstallRegistryKey: string;
  baseChildEnvironment: (
    source: NodeJS.ProcessEnv,
    isolatedTemp: string,
    ownedRoot?: string,
  ) => Record<string, string>;
  pathExists: (path: string) => Observable<boolean>;
}) {
  function waitUntil(
    check: () => Observable<boolean>,
    timeout: number,
    message: string,
    deadline = Date.now() + timeout,
  ): Observable<undefined> {
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

  function registryKeyExistsInAnyView(key) {
    return from(registryViews).pipe(
      concatMap((view) => registryKeyExists(key, view)),
      toArray(),
      map((presentViews) => presentViews.some(Boolean)),
    );
  }

  function waitForInstalledDirectoryRemoval(directory) {
    return waitUntil(
      () =>
        forkJoin({
          directoryExists: pathExists(directory),
          uninstallKeyPresent:
            registryKeyExistsInAnyView(uninstallRegistryKey),
        }).pipe(
          map(
            ({ directoryExists, uninstallKeyPresent }) =>
              !directoryExists && !uninstallKeyPresent,
          ),
        ),
      30_000,
      'Installed NSIS uninstaller did not remove its exact install directory and uninstall registry key.',
    ).pipe(
      concatMap(() =>
        forkJoin({
          uninstallKeyPresent:
            registryKeyExistsInAnyView(uninstallRegistryKey),
          productKeyPresent: registryKeyExistsInAnyView(productRegistryKey),
        }),
      ),
      map(({ uninstallKeyPresent, productKeyPresent }) => ({
        uninstallKeyRemoved: !uninstallKeyPresent,
        productKeyRetained: productKeyPresent,
      })),
    );
  }

  /** The product's uninstall and product keys that exist in any registry view. */
  function existingProductKeys() {
    return from([uninstallRegistryKey, productRegistryKey]).pipe(
      concatMap((key) => registryKeyExistsInAnyView(key).pipe(map((exists) => (exists ? [key] : [])))),
      toArray(),
      map((found): string[] => found.flat()),
    );
  }

  /** Where a key of the product says the installation is: the uninstall key's InstallLocation, the product key's default value. */
  function installLocation(key, view) {
    return key === uninstallRegistryKey
      ? registryValue(key, 'InstallLocation', view)
      : registryDefaultValue(key, view);
  }

  /**
   * Each uninstall or product key of the product in each view it exists in,
   * and whether its install location is `expectedDirectory` (null when it
   * could not be read). Recovery names a key to delete only by its view and
   * only when the location is the expected one.
   */
  function productKeysByView(expectedDirectory: string): Observable<{ key: string; view: string; installLocationOurs: boolean | null }[]> {
    return from([uninstallRegistryKey, productRegistryKey]).pipe(
      concatMap((key) => from(registryViews).pipe(
        concatMap((view) => registryKeyExists(key, view).pipe(
          concatMap((exists) => !exists ? of([]) : installLocation(key, view).pipe(
            map((value) => {
              try {
                assertRegistryOwnership(value, expectedDirectory, key);
                return [{ key, view, installLocationOurs: true }];
              } catch {
                return [{ key, view, installLocationOurs: false }];
              }
            }),
            catchError(() => of([{ key, view, installLocationOurs: null }])),
          )),
        )),
      )),
      toArray(),
      map((found) => found.flat()),
    );
  }

  function assertNoPreExistingInstallation() {
    return existingProductKeys().pipe(
      concatMap((found) =>
        found.length > 0
          ? throwError(() => new Error('A pre-existing Capture Workbench installation was found; refusing to modify it.'))
          : of(undefined)),
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
              return installLocation(key, view).pipe(
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

  /** Refuses unless a WebView2 Runtime is installed; answers its scope and version. */
  function requireWebViewRuntime() {
    return from(WEBVIEW2_RUNTIME_VERSION_KEYS).pipe(
      concatMap(({ scope, key }) =>
        registryValue(key, 'pv', '64').pipe(map((version) => ({ scope, version }))),
      ),
      toArray(),
      map((found) => assertWebViewRuntimeInstalled(found)),
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
    productKeysByView,
    assertNoPreExistingInstallation,
    assertInstalledRegistryPointsToOwnedDirectory,
    removeOwnedRegistryResidue,
    requireWebViewRuntime,
    windowsSystemExecutable,
  };
}
