import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

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

const {
  waitForInstalledDirectoryRemoval,
  assertNoPreExistingInstallation,
  assertInstalledRegistryPointsToOwnedDirectory,
  removeOwnedRegistryResidue,
  windowsSystemExecutable,
} = createInstalledRegistry({
  smokeRoot,
  workspaceRoot,
  registryViews,
  productRegistryKey,
  uninstallRegistryKey,
  baseChildEnvironment,
  pathExists,
});
const {
  terminateTrackedProcessTree,
  stopAndProveOwnedProcessRoots,
  processesRunningUnder,
  waitForLoopbackPortRelease,
} = createInstalledProcessCleanup({
  smokeRoot,
  workspaceRoot,
  baseChildEnvironment,
  windowsSystemExecutable,
});
const {
  prepareSmokeDirectories,
  safeRemoveTree,
  findDeterministicInstaller,
  assertOwnedRegularFile,
  runCheckedExecutable,
} = createInstalledSmokeLifecycle({
  workspaceRoot,
  smokeRoot,
  runRoot,
  nsisDirectory,
  childEnvironmentAllowlist,
  terminateTrackedProcessTree,
});


export async function runInstalledDeterministicSmoke() {
  if (process.platform !== 'win32') {
    throw new Error(
      'Installed deterministic Tauri smoke requires Windows x64.',
    );
  }

  await assertStagedRuntime('deterministic');
  await prepareSmokeDirectories();
  const smokeLock = await acquireExclusiveSmokeLock(smokeRoot, smokeLockPath);
  try {
    await rm(evidencePath, { force: true });
    const installer = await findDeterministicInstaller();
    await assertNoPreExistingInstallation();

    let appProcess;
    let browser;
    let installationAttempted = false;
    let exerciseResult;
    let exerciseError;
    const cleanupErrors = [];
    const cleanup = {
      ownedProcessCount: 0,
      ownedProcessesStopped: false,
      cdpPortReleased: false,
      uninstallerCompleted: false,
      installDirectoryRemoved: false,
      registryResidueRemoved: false,
      isolatedRunDataRemoved: false,
    };
    let cdpPort;

    try {
      await stopAndProveOwnedProcessRoots([
        installDirectory,
        temporaryDirectory,
      ]);
      await safeRemoveTree(smokeRoot, runRoot);
      await Promise.all(
        [
          installDirectory,
          webViewDataDirectory,
          appDataDirectory,
          localAppDataDirectory,
          temporaryDirectory,
        ].map((path) => mkdir(path, { recursive: true })),
      );

      installationAttempted = true;
      await runCheckedExecutable(
        installer.path,
        installerArguments(smokeRoot, installDirectory),
        'Deterministic NSIS installer',
        baseChildEnvironment(process.env, temporaryDirectory),
        180_000,
      );
      const installedExecutable = await assertOwnedRegularFile(
        installDirectory,
        join(installDirectory, installedExecutableName),
        'Installed Tauri executable',
      );
      await assertInstalledRegistryPointsToOwnedDirectory(installDirectory);

      cdpPort = await reserveLoopbackPort();
      const appEnvironment = buildInstalledAppEnvironment(
        process.env,
        {
          root: runRoot,
          appData: appDataDirectory,
          localAppData: localAppDataDirectory,
          temporary: temporaryDirectory,
          webViewData: webViewDataDirectory,
        },
        cdpPort,
      );
      appProcess = spawn(installedExecutable, [], {
        cwd: installDirectory,
        env: appEnvironment,
        stdio: 'ignore',
        windowsHide: true,
      });
      appProcess.on('error', () => undefined);

      browser = await connectToInstalledWebView(cdpPort, appProcess);
      const page = await installedPage(browser, appProcess);
      exerciseResult = await exerciseInstalledUi(page);
      cleanup.ownedProcessCount = (
        await processesRunningUnder(installDirectory)
      ).length;
      if (cleanup.ownedProcessCount < 2) {
        throw new Error(
          'Installed smoke did not observe both the owned Tauri app and runtime process.',
        );
      }
    } catch (error) {
      exerciseError = error;
    } finally {
      try {
        if (appProcess) {
          await terminateTrackedProcessTree(
            appProcess,
            'Owned Tauri application',
          );
        }
        await stopAndProveOwnedProcessRoots([
          installDirectory,
          temporaryDirectory,
        ]);
        cleanup.ownedProcessesStopped = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (browser) {
        try {
          await Promise.race([
            browser.close(),
            delay(5_000).then(() => {
              throw new Error('Playwright CDP disconnect timed out.');
            }),
          ]);
        } catch {
          // The owned process tree normally closes the CDP connection first.
        }
      }
      if (cdpPort !== undefined) {
        try {
          await waitForLoopbackPortRelease(cdpPort);
          cleanup.cdpPortReleased = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
      } else {
        cleanup.cdpPortReleased = true;
      }

      if (installationAttempted && cleanup.ownedProcessesStopped) {
        try {
          const uninstallerPath = join(installDirectory, uninstallerName);
          if (await pathExists(uninstallerPath)) {
            const uninstaller = await assertOwnedRegularFile(
              installDirectory,
              uninstallerPath,
              'Installed uninstaller',
            );
            await assertInstalledRegistryPointsToOwnedDirectory(
              installDirectory,
            );
            await runCheckedExecutable(
              uninstaller,
              uninstallerArguments(smokeRoot, installDirectory),
              'Installed NSIS uninstaller',
              baseChildEnvironment(process.env, temporaryDirectory),
              180_000,
            );
            await waitForInstalledDirectoryRemoval(installDirectory);
            cleanup.uninstallerCompleted = true;
            cleanup.installDirectoryRemoved = true;
          } else if (
            await pathExists(join(installDirectory, installedExecutableName))
          ) {
            cleanupErrors.push(
              new Error(
                'Installed uninstaller is missing from the owned install directory.',
              ),
            );
          } else {
            cleanup.uninstallerCompleted = true;
            cleanup.installDirectoryRemoved = true;
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await stopAndProveOwnedProcessRoots([
            installDirectory,
            temporaryDirectory,
          ]);
        } catch (error) {
          cleanup.ownedProcessesStopped = false;
          cleanupErrors.push(error);
        }
        if (cleanup.ownedProcessesStopped) {
          try {
            await removeOwnedRegistryResidue(installDirectory);
            cleanup.registryResidueRemoved = true;
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      } else if (!installationAttempted) {
        cleanup.uninstallerCompleted = true;
        cleanup.installDirectoryRemoved = true;
        cleanup.registryResidueRemoved = true;
      } else {
        try {
          assertInstallationCleanupAllowed(cleanup.ownedProcessesStopped);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      if (cleanup.ownedProcessesStopped) {
        try {
          await safeRemoveTree(smokeRoot, runRoot);
          cleanup.isolatedRunDataRemoved = !(await pathExists(runRoot));
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }

    if (exerciseError || cleanupErrors.length > 0) {
      throw new AggregateError(
        [exerciseError, ...cleanupErrors].filter(Boolean),
        'Installed deterministic Tauri smoke failed or could not clean up safely.',
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
        fileName: installer.fileName,
        bytes: installer.bytes,
        sha256: installer.sha256,
      },
      installedApplication: {
        fileName: installedExecutableName,
        clientMode: exerciseResult.clientMode,
        isolatedRuntimeMode: exerciseResult.isolatedRuntimeMode,
        hostProviderButtonVisible: exerciseResult.hostProviderButtonVisible,
      },
      requirements: exerciseResult.requirements,
      captures: exerciseResult.captures,
      cleanup,
      disclaimer:
        'Deterministic packaged verification only; it does not exercise or satisfy real WindowsML, Whisper, Ollama, licensed-fixture, clean-install release, or publication gates.',
    };
    assertInstalledSmokeEvidence(report);
    await writeEvidence(report);
    return { report, reportPath: evidencePath };
  } finally {
    await releaseExclusiveSmokeLock(smokeLock);
  }
}

export async function acquireExclusiveSmokeLock(root, candidate) {
  const safePath = assertStrictDescendant(
    root,
    candidate,
    'Installed smoke lock',
  );
  const token = randomUUID();
  let handle;
  try {
    handle = await open(safePath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        'Another installed smoke is active or left a stale lock; refusing concurrent product mutation.',
      );
    }
    throw error;
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, token })}\n`,
      'utf8',
    );
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(safePath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { handle, path: safePath, token };
}

export async function releaseExclusiveSmokeLock(lock) {
  let verificationError;
  try {
    assertSmokeLockOwnership(await readFile(lock.path, 'utf8'), lock.token);
  } catch (error) {
    verificationError = error;
  }
  let closeError;
  try {
    await lock.handle.close();
  } catch (error) {
    closeError = error;
  }
  if (verificationError || closeError) {
    throw new AggregateError(
      [verificationError, closeError].filter(Boolean),
      'Installed smoke lock could not be released safely.',
    );
  }
  assertSmokeLockOwnership(await readFile(lock.path, 'utf8'), lock.token);
  await rm(lock.path);
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




async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeEvidence(report) {
  const safePath = assertStrictDescendant(
    smokeRoot,
    evidencePath,
    'Evidence path',
  );
  const temporary = `${safePath}.tmp`;
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rm(safePath, { force: true });
  await rename(temporary, safePath);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runInstalledDeterministicSmoke()
    .then(({ reportPath }) => {
      process.stdout.write(
        `Installed deterministic smoke evidence: ${reportPath}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${errorMessage(error)}\n`);
      if (error instanceof AggregateError) {
        for (const cause of error.errors) {
          process.stderr.write(`- ${errorMessage(cause)}\n`);
        }
      }
      process.exitCode = 1;
    });
}
