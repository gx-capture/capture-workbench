import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  catchError,
  concatMap,
  defer,
  from,
  map,
  of,
  race,
  reduce,
  switchMap,
  tap,
  throwError,
  timer,
  toArray,
} from 'rxjs';

import { assertStagedRuntime } from './assert-staged-runtime.ts';
import {
  CHILD_ENVIRONMENT_ALLOWLIST,
  INSTALLED_EXECUTABLE_NAME,
  PRODUCT_REGISTRY_KEY,
  REGISTRY_VIEWS,
  UNINSTALLER_NAME,
  UNINSTALL_REGISTRY_KEY,
} from './constants/installed.ts';
import { appRoot } from './stage-runtime.ts';
import {
  assertInstalledSmokeEvidence,
  assertInstallationCleanupAllowed,
  assertRegistryOwnership,
  assertStrictDescendant,
  assertTaskkillResult,
  buildInstalledAppEnvironment,
  installerArguments,
  uninstallerArguments,
} from './contracts/installed.ts';
import { assertCaptureDocumentForFixture } from './installed-document-assertions.ts';
import {
  connectToInstalledWebView,
  exerciseInstalledUi,
  installedPage,
  reserveLoopbackPort,
} from './installed-browser.ts';
import { createInstalledProcessCleanup } from './installed-process-cleanup.ts';
import { createInstalledRegistry } from './installed-registry.ts';
import { createInstalledSmokeLifecycle } from './installed-smoke-lifecycle.ts';

export {
  assertInstalledSmokeEvidence,
  assertInstallationCleanupAllowed,
  assertRegistryOwnership,
  assertStrictDescendant,
  assertTaskkillResult,
  buildInstalledAppEnvironment,
  installerArguments,
  uninstallerArguments,
};

export { assertCaptureDocumentForFixture };

const workspaceRoot = resolve(appRoot, '..', '..');
const smokeRoot = join(
  workspaceRoot,
  'tmp',
  'capture-workbench-desktop',
  'installed-smoke',
);
const runRoot = join(smokeRoot, 'run');
const installDirectory = join(runRoot, 'install');
const webViewDataDirectory = join(runRoot, 'webview2');
const appDataDirectory = join(runRoot, 'appdata');
const localAppDataDirectory = join(runRoot, 'localappdata');
const temporaryDirectory = join(runRoot, 'temp');
const evidencePath = join(smokeRoot, 'installed-smoke.json');
const installedSizeEvidencePath = join(smokeRoot, 'installed-size.json');
const smokeLockPath = join(smokeRoot, 'installed-smoke.lock');
const nsisDirectory = join(
  appRoot,
  'src-tauri',
  'target',
  'x86_64-pc-windows-msvc',
  'release',
  'bundle',
  'nsis',
);
const installedExecutableName = INSTALLED_EXECUTABLE_NAME;
const uninstallerName = UNINSTALLER_NAME;
const productRegistryKey = PRODUCT_REGISTRY_KEY;
const uninstallRegistryKey = UNINSTALL_REGISTRY_KEY;
const registryViews = REGISTRY_VIEWS;
const childEnvironmentAllowlist = CHILD_ENVIRONMENT_ALLOWLIST;

function baseChildEnvironment(source, isolatedTemp, ownedRoot = runRoot) {
  const environment = {};
  for (const allowedName of childEnvironmentAllowlist) {
    const sourceEntry = Object.entries(source).find(
      ([name, value]) =>
        name.toUpperCase() === allowedName &&
        typeof value === 'string' &&
        value.length > 0,
    );
    if (sourceEntry) environment[allowedName] = sourceEntry[1];
  }
  const safeTemp = assertStrictDescendant(
    ownedRoot,
    isolatedTemp,
    'Temporary directory',
  );
  environment.TEMP = safeTemp;
  environment.TMP = safeTemp;
  return environment;
}

function pathExists(path) {
  return defer(() => from(stat(path))).pipe(
    map(() => true),
    catchError((error) =>
      error?.code === 'ENOENT' ? of(false) : throwError(() => error),
    ),
  );
}

function writeEvidence(report, destination = evidencePath) {
  const safePath = assertStrictDescendant(
    smokeRoot,
    destination,
    'Evidence path',
  );
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

function acquireLock(root, candidate) {
  const safePath = assertStrictDescendant(
    root,
    candidate,
    'Installed smoke lock',
  );
  const token = randomUUID();
  return defer(() => from(open(safePath, 'wx', 0o600))).pipe(
    catchError((error) =>
      error?.code === 'EEXIST'
        ? throwError(
            () =>
              new Error(
                'Another installed smoke is active or left a stale lock; refusing concurrent product mutation.',
              ),
          )
        : throwError(() => error),
    ),
    concatMap((handle) =>
      defer(() =>
        from(
          handle.writeFile(
            `${JSON.stringify({ pid: process.pid, token })}\n`,
            'utf8',
          ),
        ),
      ).pipe(
        concatMap(() => from(handle.sync())),
        map(() => ({ handle, path: safePath, token })),
        catchError((error) =>
          defer(() => from(handle.close())).pipe(
            catchError(() => of(undefined)),
            concatMap(() => from(rm(safePath, { force: true }))),
            concatMap(() => throwError(() => error)),
          ),
        ),
      ),
    ),
  );
}

function assertSmokeLockOwnership(serialized, expectedToken) {
  let lock;
  try {
    lock = JSON.parse(serialized);
  } catch {
    throw new Error(
      'Installed smoke lock metadata is malformed; refusing removal.',
    );
  }
  if (
    lock?.pid !== process.pid ||
    typeof lock.token !== 'string' ||
    lock.token !== expectedToken
  ) {
    throw new Error(
      'Installed smoke lock ownership changed; refusing removal.',
    );
  }
}

function releaseLock(lock) {
  return defer(() => from(readFile(lock.path, 'utf8'))).pipe(
    map((serialized) => {
      assertSmokeLockOwnership(serialized, lock.token);
      return undefined;
    }),
    concatMap(() => from(lock.handle.close())),
    concatMap(() => defer(() => from(readFile(lock.path, 'utf8')))),
    tap((serialized) => assertSmokeLockOwnership(serialized, lock.token)),
    concatMap(() => from(rm(lock.path))),
    map(() => undefined),
  );
}

function directoryBytes(directory) {
  return defer(() => from(readdir(directory, { withFileTypes: true }))).pipe(
    switchMap((entries) => from(entries)),
    concatMap((entry) => {
      const candidate = join(directory, entry.name);
      return defer(() => from(lstat(candidate))).pipe(
        concatMap((metadata) => {
          if (metadata.isSymbolicLink()) {
            return throwError(
              () =>
                new Error('Installed size evidence refuses symbolic links.'),
            );
          }
          if (metadata.isDirectory()) {
            return directoryBytes(candidate);
          }
          if (metadata.isFile()) {
            return of(metadata.size);
          }
          return throwError(
            () =>
              new Error(
                'Installed size evidence accepts only regular files and directories.',
              ),
          );
        }),
      );
    }),
    reduce((total, bytes) => total + bytes, 0),
  );
}

export function runInstalledDeterministicSmoke({
  expectedSource = 'deterministic',
  measureOnly = false,
} = {}) {
  if (process.platform !== 'win32') {
    return throwError(
      () =>
        new Error('Installed deterministic Tauri smoke requires Windows x64.'),
    );
  }

  const processCleanup = createInstalledProcessCleanup({
    smokeRoot,
    workspaceRoot,
    baseChildEnvironment,
    windowsSystemExecutable: (...segments) => {
      const registry = createInstalledRegistry({
        smokeRoot,
        workspaceRoot,
        registryViews,
        productRegistryKey,
        uninstallRegistryKey,
        baseChildEnvironment,
        pathExists,
      });
      return registry.windowsSystemExecutable(...segments);
    },
  });
  const registry = createInstalledRegistry({
    smokeRoot,
    workspaceRoot,
    registryViews,
    productRegistryKey,
    uninstallRegistryKey,
    baseChildEnvironment,
    pathExists,
  });
  const lifecycle = createInstalledSmokeLifecycle({
    workspaceRoot,
    smokeRoot,
    runRoot,
    nsisDirectory,
    childEnvironmentAllowlist,
    terminateTrackedProcessTree: processCleanup.terminateTrackedProcessTree,
  });

  if (!['deterministic', 'release'].includes(expectedSource)) {
    return throwError(
      () =>
        new Error('Installed smoke source must be deterministic or release.'),
    );
  }
  if (measureOnly && expectedSource !== 'release') {
    return throwError(
      () =>
        new Error('Installed size-only evidence requires the release stage.'),
    );
  }

  return assertStagedRuntime(expectedSource).pipe(
    concatMap(({ manifest }) =>
      lifecycle
        .prepareSmokeDirectories()
        .pipe(map(() => manifest.runtimeVersion)),
    ),
    concatMap((runtimeVersion) =>
      acquireLock(smokeRoot, smokeLockPath).pipe(
        map((smokeLock) => ({ runtimeVersion, smokeLock })),
      ),
    ),
    switchMap(({ runtimeVersion, smokeLock }) => {
      const state = {
        appProcess: undefined,
        browser: undefined,
        cdpPort: undefined,
        installer: undefined,
        installationAttempted: false,
        privateProcessRootsRegistered: false,
        exerciseResult: undefined,
        exerciseError: undefined,
        cleanupErrors: [],
        cleanup: {
          ownedProcessCount: 0,
          ownedProcessesStopped: false,
          cdpPortReleased: false,
          uninstallerCompleted: false,
          installDirectoryRemoved: false,
          nativeUninstallKeyRemoved: false,
          productRegistryKeyRetainedAfterNativeUninstall: false,
          registryResidueRemoved: false,
          isolatedRunDataRemoved: false,
        },
        installedBytes: undefined,
      };

      const attempt = (operation, onSuccess = () => undefined) =>
        operation.pipe(
          tap(onSuccess),
          catchError((error) => {
            state.cleanupErrors.push(error);
            return of(undefined);
          }),
        );

      const installAndExercise = defer(() =>
        from(rm(evidencePath, { force: true })),
      ).pipe(
        concatMap(() => lifecycle.findDeterministicInstaller(runtimeVersion)),
        tap((installer) => (state.installer = installer)),
        concatMap(() => registry.assertNoPreExistingInstallation()),
        concatMap(() =>
          processCleanup.stopAndProveResidualProcessRoots([
            installDirectory,
            temporaryDirectory,
          ]),
        ),
        concatMap(() => lifecycle.safeRemoveTree(smokeRoot, runRoot)),
        concatMap(() =>
          from([
            installDirectory,
            webViewDataDirectory,
            appDataDirectory,
            localAppDataDirectory,
            temporaryDirectory,
          ]).pipe(
            concatMap((path) =>
              defer(() => from(mkdir(path, { recursive: true }))),
            ),
            toArray(),
          ),
        ),
        tap(() => {
          processCleanup.registerPrivateProcessRoots([
            installDirectory,
            temporaryDirectory,
          ]);
          state.privateProcessRootsRegistered = true;
        }),
        tap(() => (state.installationAttempted = true)),
        concatMap(() =>
          lifecycle.runCheckedExecutable(
            state.installer.path,
            installerArguments(smokeRoot, installDirectory),
            'Deterministic NSIS installer',
            baseChildEnvironment(process.env, temporaryDirectory),
            180_000,
          ),
        ),
        concatMap(() =>
          lifecycle.assertOwnedRegularFile(
            installDirectory,
            join(installDirectory, installedExecutableName),
            'Installed Tauri executable',
          ),
        ),
        concatMap(() =>
          registry.assertInstalledRegistryPointsToOwnedDirectory(
            installDirectory,
          ),
        ),
        concatMap(() =>
          measureOnly
            ? directoryBytes(installDirectory).pipe(
                tap((bytes) => {
                  if (!Number.isSafeInteger(bytes) || bytes < 1) {
                    throw new Error(
                      'Installed size measurement must be a positive safe integer.',
                    );
                  }
                  state.installedBytes = bytes;
                }),
              )
            : reserveLoopbackPort().pipe(
                tap((port) => {
                  state.cdpPort = port;
                  const appEnvironment = buildInstalledAppEnvironment(
                    process.env,
                    {
                      root: runRoot,
                      appData: appDataDirectory,
                      localAppData: localAppDataDirectory,
                      temporary: temporaryDirectory,
                      webViewData: webViewDataDirectory,
                    },
                    port,
                  );
                  state.appProcess = spawn(
                    join(installDirectory, installedExecutableName),
                    [],
                    {
                      cwd: installDirectory,
                      env: appEnvironment,
                      stdio: 'ignore',
                      windowsHide: true,
                    },
                  );
                  state.appProcess.on('error', () => undefined);
                }),
                concatMap(() =>
                  connectToInstalledWebView(state.cdpPort, state.appProcess),
                ),
                tap((browser) => (state.browser = browser)),
                concatMap(() => installedPage(state.browser, state.appProcess)),
                concatMap((page) => exerciseInstalledUi(page)),
                tap(
                  (exerciseResult) => (state.exerciseResult = exerciseResult),
                ),
                concatMap(() =>
                  processCleanup.processesRunningUnder(installDirectory),
                ),
                tap((processes) => {
                  state.cleanup.ownedProcessCount = processes.length;
                  if (state.cleanup.ownedProcessCount < 2) {
                    throw new Error(
                      'Installed smoke did not observe both the owned Tauri app and runtime process.',
                    );
                  }
                }),
              ),
        ),
        map(() => undefined),
        catchError((error) => {
          state.exerciseError = error;
          return of(undefined);
        }),
      );

      const cleanupRun = installAndExercise.pipe(
        concatMap(() =>
          attempt(
            state.appProcess
              ? processCleanup.terminateTrackedProcessTree(
                  state.appProcess,
                  'Owned Tauri application',
                )
              : of(undefined),
          ),
        ),
        concatMap(() =>
          attempt(
            state.privateProcessRootsRegistered
              ? processCleanup.stopAndProveOwnedProcessRoots([
                  installDirectory,
                  temporaryDirectory,
                ])
              : processCleanup.stopAndProveResidualProcessRoots([
                  installDirectory,
                  temporaryDirectory,
                ]),
            () => (state.cleanup.ownedProcessesStopped = true),
          ),
        ),
        concatMap(() => {
          if (!state.browser) return of(undefined);
          return race(
            defer(() => from(state.browser.close())),
            timer(5_000).pipe(
              concatMap(() =>
                throwError(
                  () => new Error('Playwright CDP disconnect timed out.'),
                ),
              ),
            ),
          ).pipe(catchError(() => of(undefined)));
        }),
        concatMap(() => {
          if (state.cdpPort === undefined) {
            state.cleanup.cdpPortReleased = true;
            return of(undefined);
          }
          return attempt(
            processCleanup.waitForLoopbackPortRelease(state.cdpPort),
            () => (state.cleanup.cdpPortReleased = true),
          );
        }),
        concatMap(() => {
          if (!state.installationAttempted) {
            state.cleanup.uninstallerCompleted = true;
            state.cleanup.installDirectoryRemoved = true;
            state.cleanup.nativeUninstallKeyRemoved = true;
            state.cleanup.registryResidueRemoved = true;
            return of(undefined);
          }
          if (!state.cleanup.ownedProcessesStopped) {
            return attempt(
              defer(() => {
                assertInstallationCleanupAllowed(
                  state.cleanup.ownedProcessesStopped,
                );
                return of(undefined);
              }),
            );
          }
          const uninstallerPath = join(installDirectory, uninstallerName);
          return attempt(
            pathExists(uninstallerPath).pipe(
              switchMap((exists) => {
                if (!exists) {
                  return pathExists(
                    join(installDirectory, installedExecutableName),
                  ).pipe(
                    concatMap((executableExists) =>
                      executableExists
                        ? throwError(
                            () =>
                              new Error(
                                'Installed uninstaller is missing from the owned install directory.',
                              ),
                          )
                        : registry.waitForInstalledDirectoryRemoval(
                            installDirectory,
                          ),
                    ),
                  );
                }
                return lifecycle
                  .assertOwnedRegularFile(
                    installDirectory,
                    uninstallerPath,
                    'Installed uninstaller',
                  )
                  .pipe(
                    concatMap((uninstaller) =>
                      registry
                        .assertInstalledRegistryPointsToOwnedDirectory(
                          installDirectory,
                        )
                        .pipe(
                          concatMap(() =>
                            lifecycle.runCheckedExecutable(
                              uninstaller,
                              uninstallerArguments(smokeRoot, installDirectory),
                              'Installed NSIS uninstaller',
                              baseChildEnvironment(
                                process.env,
                                temporaryDirectory,
                              ),
                              180_000,
                            ),
                          ),
                        ),
                    ),
                    concatMap(() =>
                      registry.waitForInstalledDirectoryRemoval(
                        installDirectory,
                      ),
                    ),
                  );
              }),
              tap((nativeRegistryState) => {
                state.cleanup.uninstallerCompleted = true;
                state.cleanup.installDirectoryRemoved = true;
                state.cleanup.nativeUninstallKeyRemoved =
                  nativeRegistryState.uninstallKeyRemoved;
                state.cleanup.productRegistryKeyRetainedAfterNativeUninstall =
                  nativeRegistryState.productKeyRetained;
              }),
            ),
          ).pipe(
            concatMap(() =>
              attempt(
                state.privateProcessRootsRegistered
                  ? processCleanup.stopAndProveOwnedProcessRoots([
                      installDirectory,
                      temporaryDirectory,
                    ])
                  : processCleanup.stopAndProveResidualProcessRoots([
                      installDirectory,
                      temporaryDirectory,
                    ]),
                () => (state.cleanup.ownedProcessesStopped = true),
              ),
            ),
            concatMap(() =>
              state.cleanup.ownedProcessesStopped
                ? attempt(
                    registry.removeOwnedRegistryResidue(installDirectory),
                    () => (state.cleanup.registryResidueRemoved = true),
                  )
                : of(undefined),
            ),
          );
        }),
        concatMap(() =>
          state.cleanup.ownedProcessesStopped
            ? attempt(
                lifecycle.safeRemoveTree(smokeRoot, runRoot).pipe(
                  concatMap(() => pathExists(runRoot)),
                  tap(
                    (exists) =>
                      (state.cleanup.isolatedRunDataRemoved = !exists),
                  ),
                ),
              )
            : of(undefined),
        ),
        concatMap(() => {
          if (state.exerciseError || state.cleanupErrors.length > 0) {
            return throwError(
              () =>
                new AggregateError(
                  [state.exerciseError, ...state.cleanupErrors].filter(Boolean),
                  'Installed deterministic Tauri smoke failed or could not clean up safely.',
                ),
            );
          }
          if (measureOnly) {
            const report = {
              evidenceKind: 'release-installed-size',
              releaseGateSatisfied: false,
              platform: 'windows',
              arch: 'x86_64',
              bundle: 'nsis',
              installer: {
                fileName: state.installer.fileName,
                bytes: state.installer.bytes,
                sha256: state.installer.sha256,
              },
              installedBytes: state.installedBytes,
              cleanup: state.cleanup,
              disclaimer:
                'Scoped release install-size measurement only; no real engine behavior was exercised.',
            };
            return writeEvidence(report, installedSizeEvidencePath).pipe(
              map(() => ({ report, reportPath: installedSizeEvidencePath })),
            );
          }
          const report = {
            evidenceKind: 'deterministic-installed-tauri-smoke',
            releaseGateSatisfied: false,
            realEnginesExercised: false,
            platform: 'windows',
            arch: 'x86_64',
            bundle: 'nsis',
            installer: {
              fileName: state.installer.fileName,
              bytes: state.installer.bytes,
              sha256: state.installer.sha256,
            },
            installedApplication: {
              fileName: installedExecutableName,
              productTitle: state.exerciseResult.productTitle,
              model: state.exerciseResult.model,
            },
            captures: state.exerciseResult.captures,
            cleanup: state.cleanup,
            disclaimer:
              'Deterministic packaged verification only; it does not certify real WindowsML, Whisper, Ollama, or licensed-fixture behavior.',
          };
          assertInstalledSmokeEvidence(report);
          return writeEvidence(report).pipe(
            map(() => ({ report, reportPath: evidencePath })),
          );
        }),
      );

      return cleanupRun.pipe(
        catchError((error) =>
          releaseLock(smokeLock).pipe(concatMap(() => throwError(() => error))),
        ),
        concatMap((result) => releaseLock(smokeLock).pipe(map(() => result))),
      );
    }),
  );
}

export function acquireExclusiveSmokeLock(root, candidate) {
  return acquireLock(root, candidate);
}

export function releaseExclusiveSmokeLock(lock) {
  return releaseLock(lock);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export const installedSmokeDiagnosticRedactionMarker =
  '[redacted unsafe diagnostic]';
export const installedSmokeDiagnosticMessageLimit = 512;
const installedSmokeDiagnosticCountLimit = 32;
const sensitiveDiagnosticFragments = [
  'authorization',
  'bearer',
  'secret',
  'token',
];

function containsSensitiveDiagnosticLabel(value) {
  const compactOriginal = value.toLowerCase().replace(/[^a-z\d]+/gu, '');
  return sensitiveDiagnosticFragments.some((fragment) =>
    compactOriginal.includes(fragment),
  );
}

function containsAbsoluteWindowsPath(value) {
  const substringCandidates = [
    ...value.matchAll(/[A-Za-z]:[\\/]/gu),
    ...value.matchAll(/[\\/]{2}[^\\/\s]+[\\/][^\\/\s]+/gu),
    ...value.matchAll(
      /(?:^|[\s"'`()[\]{}<>,;=:])(?<rooted>[\\/](?![\\/])[^\\/\s]+)/gu,
    ),
  ];
  return substringCandidates.some((match) =>
    win32.isAbsolute(match.groups?.['rooted'] ?? value.slice(match.index)),
  );
}

function sanitizedDiagnosticMessage(error) {
  const raw = errorMessage(error);
  if (
    containsSensitiveDiagnosticLabel(raw) ||
    containsAbsoluteWindowsPath(raw)
  ) {
    return installedSmokeDiagnosticRedactionMarker;
  }
  const normalized = raw.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= installedSmokeDiagnosticMessageLimit) {
    return normalized;
  }
  return `${normalized.slice(0, installedSmokeDiagnosticMessageLimit - 3)}...`;
}

export function nestedErrorMessages(error) {
  const messages = [];
  const visited = new Set();
  const visit = (candidate) => {
    if (messages.length >= installedSmokeDiagnosticCountLimit) return;
    if (visited.has(candidate)) return;
    if (
      (typeof candidate === 'object' && candidate !== null) ||
      typeof candidate === 'function'
    ) {
      visited.add(candidate);
    }
    messages.push(sanitizedDiagnosticMessage(candidate));
    if (candidate instanceof AggregateError) {
      for (const cause of candidate.errors) visit(cause);
    }
  };
  visit(error);
  return messages;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const measureReleaseSize =
    process.argv.length === 3 && process.argv[2] === '--measure-release-size';
  if (process.argv.length > (measureReleaseSize ? 3 : 2)) {
    process.stderr.write(
      'Use no arguments or exactly --measure-release-size.\n',
    );
    process.exitCode = 1;
  } else {
    runInstalledDeterministicSmoke(
      measureReleaseSize
        ? { expectedSource: 'release', measureOnly: true }
        : undefined,
    ).subscribe({
      next: ({ reportPath }) =>
        process.stdout.write(`Installed smoke evidence: ${reportPath}\n`),
      error: (error) => {
        const [summary, ...causes] = nestedErrorMessages(error);
        process.stderr.write(`${summary}\n`);
        for (const cause of causes) process.stderr.write(`- ${cause}\n`);
        process.exitCode = 1;
      },
    });
  }
}
