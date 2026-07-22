import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from '@playwright/test';

import { assertStagedRuntime } from './assert-staged-runtime.mjs';
import { assertRedactedEvidence } from './package-qa.mjs';
import { appRoot, sha256File } from './stage-runtime.mjs';

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
const installedExecutableName = 'capture-workbench-desktop.exe';
const uninstallerName = 'uninstall.exe';
const productRegistryKey =
  'HKCU\\Software\\github\\Capture Workbench Verification';
const uninstallRegistryKey =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Capture Workbench Verification';
const registryViews = ['64', '32'];
const expectedRequirementIds = [
  'windowsml-ocr',
  'whisper-primary',
  'ollama-runtime',
  'capture-ollama-model',
];
const captureBlockTypes = new Set([
  'heading',
  'paragraph',
  'list-item',
  'table',
  'quote',
  'transcript',
]);
const childEnvironmentAllowlist = [
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PROGRAMDATA',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'USERPROFILE',
  'WINDIR',
];

const fixtures = [
  {
    sourceKind: 'pdf',
    fileName: 'installed-fixture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(
      '%PDF-1.7\nCAPTURE_TEXT:Installed PDF page one\fInstalled PDF page two',
      'utf8',
    ),
    locatorKind: 'page',
    expectedSegments: 2,
    expectedTexts: ['Installed PDF page one', 'Installed PDF page two'],
  },
  {
    sourceKind: 'image',
    fileName: 'installed-fixture.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('CAPTURE_TEXT:Installed image words', 'utf8'),
    ]),
    locatorKind: 'page',
    expectedSegments: 1,
    expectedTexts: ['Installed image words'],
  },
  {
    sourceKind: 'audio',
    fileName: 'installed-fixture.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'ascii'),
      Buffer.from(
        'CAPTURE_TEXT:Installed audio one|Installed audio two',
        'utf8',
      ),
    ]),
    locatorKind: 'time',
    expectedSegments: 2,
    expectedTexts: ['Installed audio one', 'Installed audio two'],
  },
];

export function assertStrictDescendant(root, candidate, label = 'Path') {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativePath) ||
    resolvedCandidate.includes('\0') ||
    /[\r\n]/u.test(resolvedCandidate)
  ) {
    throw new Error(
      `${label} must be a strict descendant of the installed-smoke root.`,
    );
  }
  return resolvedCandidate;
}

export function installerArguments(root, target) {
  const safeTarget = assertStrictDescendant(root, target, 'Install directory');
  // Tauri's /NS switch suppresses Start Menu/Desktop shortcut creation, keeping
  // this verification install inside the explicitly owned filesystem/registry scope.
  return ['/S', '/NS', `/D=${safeTarget}`];
}

export function uninstallerArguments(root, target) {
  assertStrictDescendant(root, target, 'Uninstall directory');
  return ['/S'];
}

export function assertRegistryOwnership(value, expectedDirectory, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} does not contain an owned install path.`);
  }
  const candidate = stripOuterQuotes(value);
  if (!isAbsolute(candidate)) {
    throw new Error(`${label} does not contain an absolute install path.`);
  }
  if (
    resolve(candidate).toLowerCase() !==
    resolve(expectedDirectory).toLowerCase()
  ) {
    throw new Error(`${label} no longer belongs to the installed-smoke run.`);
  }
}

export function assertTaskkillResult(result, stillOwned) {
  if (result.error) {
    throw new Error(
      `Owned process cleanup could not run: ${result.error.message}`,
    );
  }
  if (result.status !== 0 && stillOwned) {
    throw new Error(
      `Owned process cleanup exited with status ${String(result.status)} while the PID remained owned.`,
    );
  }
}

export function assertInstallationCleanupAllowed(ownedProcessesStopped) {
  if (ownedProcessesStopped !== true) {
    throw new Error(
      'Refusing to uninstall or remove installed-smoke data without proving all owned processes stopped.',
    );
  }
}

export function buildInstalledAppEnvironment(source, directories, cdpPort) {
  if (!Number.isSafeInteger(cdpPort) || cdpPort < 1 || cdpPort > 65_535) {
    throw new Error('WebView2 CDP port must be from 1 through 65535.');
  }
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

  const isolatedRoot = resolve(directories.root);
  const appData = assertStrictDescendant(
    isolatedRoot,
    directories.appData,
    'APPDATA directory',
  );
  const localAppData = assertStrictDescendant(
    isolatedRoot,
    directories.localAppData,
    'LOCALAPPDATA directory',
  );
  const temporary = assertStrictDescendant(
    isolatedRoot,
    directories.temporary,
    'Temporary directory',
  );
  const webViewData = assertStrictDescendant(
    isolatedRoot,
    directories.webViewData,
    'WebView2 user-data directory',
  );
  return {
    ...environment,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temporary,
    TMP: temporary,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort} --remote-allow-origins=*`,
    WEBVIEW2_USER_DATA_FOLDER: webViewData,
  };
}

export function assertInstalledSmokeEvidence(report) {
  if (
    report?.evidenceKind !== 'deterministic-installed-tauri-smoke' ||
    report?.releaseGateSatisfied !== false ||
    report?.realEnginesExercised !== false
  ) {
    throw new Error(
      'Installed smoke evidence must remain deterministic and non-releaseable.',
    );
  }
  if (
    typeof report.disclaimer !== 'string' ||
    !/deterministic/iu.test(report.disclaimer) ||
    !/does not/iu.test(report.disclaimer)
  ) {
    throw new Error(
      'Installed smoke evidence requires an explicit deterministic disclaimer.',
    );
  }
  const serialized = JSON.stringify(report);
  if (/[A-Za-z]:[\\/]/u.test(serialized)) {
    throw new Error(
      'Installed smoke evidence must not contain absolute Windows paths.',
    );
  }
  assertRedactedEvidence(report);
}

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

async function prepareSmokeDirectories() {
  await mkdir(smokeRoot, { recursive: true });
  const [workspaceRealPath, smokeRealPath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(smokeRoot),
  ]);
  assertStrictDescendant(
    workspaceRealPath,
    smokeRealPath,
    'Installed smoke output directory',
  );
}

async function safeRemoveTree(root, target) {
  const safeTarget = assertStrictDescendant(
    root,
    target,
    'Recursive removal target',
  );
  let metadata;
  try {
    metadata = await lstat(safeTarget);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      'Recursive removal target must be an owned real directory.',
    );
  }
  await rm(safeTarget, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  });
}

async function findDeterministicInstaller() {
  const [workspaceRealPath, directoryRealPath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(nsisDirectory),
  ]);
  assertStrictDescendant(
    workspaceRealPath,
    directoryRealPath,
    'NSIS artifact directory',
  );
  const entries = await readdir(directoryRealPath, { withFileTypes: true });
  const installers = entries.filter(
    (entry) => entry.isFile() && /_x64-setup\.exe$/iu.test(entry.name),
  );
  if (installers.length !== 1) {
    throw new Error(
      `Expected exactly one deterministic x64 NSIS installer, found ${installers.length}.`,
    );
  }
  const path = join(directoryRealPath, installers[0].name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Deterministic NSIS installer must be a regular file.');
  }
  const actualPath = await realpath(path);
  if (dirname(actualPath).toLowerCase() !== directoryRealPath.toLowerCase()) {
    throw new Error(
      'Deterministic NSIS installer escaped its artifact directory.',
    );
  }
  return {
    path: actualPath,
    fileName: basename(actualPath),
    bytes: metadata.size,
    sha256: await sha256File(actualPath),
  };
}

async function assertOwnedRegularFile(root, candidate, label) {
  const safeCandidate = assertStrictDescendant(root, candidate, label);
  const metadata = await lstat(safeCandidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
  const actual = await realpath(safeCandidate);
  assertStrictDescendant(root, actual, label);
  return actual;
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

async function runCheckedExecutable(
  path,
  arguments_,
  label,
  environment,
  timeout,
) {
  const child = spawn(path, arguments_, {
    env: environment,
    stdio: 'ignore',
    windowsHide: true,
  });
  const completion = new Promise((resolveCompletion) => {
    child.once('error', (error) => resolveCompletion({ kind: 'error', error }));
    child.once('exit', (code, signal) =>
      resolveCompletion({ kind: 'exit', code, signal }),
    );
  });
  let timeoutHandle;
  const timedOut = new Promise((resolveTimeout) => {
    timeoutHandle = globalThis.setTimeout(
      () => resolveTimeout({ kind: 'timeout' }),
      timeout,
    );
    timeoutHandle.unref?.();
  });
  const outcome = await Promise.race([completion, timedOut]);
  globalThis.clearTimeout(timeoutHandle);

  if (outcome.kind === 'timeout') {
    await terminateTrackedProcessTree(child, label);
    await completion;
    throw new Error(`${label} timed out after ${timeout} ms.`);
  }
  if (outcome.kind === 'error') {
    throw new Error(`${label} could not run: ${outcome.error.message}`);
  }
  if (outcome.code !== 0) {
    throw new Error(
      `${label} exited with status ${String(outcome.code)}${outcome.signal ? ` (${outcome.signal})` : ''}.`,
    );
  }
}

async function terminateTrackedProcessTree(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
    throw new Error(`${label} did not expose a valid owned PID.`);
  }
  const exited = new Promise((resolveExit) => {
    child.once('exit', resolveExit);
    child.once('error', resolveExit);
  });
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
  await Promise.race([exited, delay(20_000)]);
  const stillRunning = child.exitCode === null && child.signalCode === null;
  assertTaskkillResult(result, stillRunning);
  if (stillRunning) {
    throw new Error(`${label} remained active after exact PID tree cleanup.`);
  }
}

async function reserveLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Dynamic CDP port was unavailable.'));
        else resolvePort(port);
      });
    });
  });
}

async function connectToInstalledWebView(port, appProcess) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) {
      throw new Error(
        `Installed Tauri app exited before WebView2 CDP readiness (${appProcess.exitCode}).`,
      );
    }
    try {
      return await chromium.connectOverCDP(endpoint, { timeout: 2_000 });
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(
    `Installed WebView2 CDP endpoint was not ready: ${errorMessage(lastError)}.`,
  );
}

async function installedPage(browser, appProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) {
      throw new Error(
        'Installed Tauri app exited before its page was available.',
      );
    }
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find(
      (candidate) => candidate.url() === 'http://tauri.localhost/',
    );
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    await delay(100);
  }
  throw new Error(
    'Installed Tauri WebView did not expose an application page.',
  );
}

async function exerciseInstalledUi(page) {
  const mode = page.locator('.client-mode');
  await mode.waitFor({ state: 'visible', timeout: 30_000 });
  const clientMode = await mode.getAttribute('data-client-mode');
  assert.equal(clientMode, 'tauri-http');
  assert.equal(
    await page.getByRole('button', { name: 'Host provider interface' }).count(),
    0,
  );
  await page
    .getByRole('button', { name: 'Isolated runtime provider' })
    .waitFor({ state: 'visible' });
  await page.getByText('Runtime is ready').waitFor({
    state: 'visible',
    timeout: 45_000,
  });

  const requirements = page
    .getByLabel('Runtime requirements')
    .getByRole('listitem');
  await waitUntil(
    async () => (await requirements.count()) === 4,
    20_000,
    'Installed runtime did not render exactly four requirements.',
  );
  const readyRequirements = page.locator(
    '.requirements .requirement-status[data-status="ready"]',
  );
  assert.equal(await readyRequirements.count(), 4);
  const requirementIds = await requirements.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-requirement-id')),
  );
  assert.deepEqual(
    [...requirementIds].sort(),
    [...expectedRequirementIds].sort(),
  );
  const displayNames = await requirements.locator('strong').allTextContents();

  const captures = [];
  const filePicker = page.getByLabel('Choose files');
  for (const fixture of fixtures) {
    await filePicker.setInputFiles({
      name: fixture.fileName,
      mimeType: fixture.mimeType,
      buffer: fixture.buffer,
    });
    const task = page
      .locator('.task-list > li')
      .filter({ hasText: fixture.fileName });
    await task.waitFor({ state: 'visible', timeout: 15_000 });
    await waitUntil(
      async () => (await task.getAttribute('data-task-status')) === 'completed',
      45_000,
      `Installed ${fixture.sourceKind} capture did not complete.`,
    );
    const preview = task.locator('pre.result-preview');
    await preview.waitFor({ state: 'visible', timeout: 15_000 });
    const document = JSON.parse((await preview.textContent()) ?? '');
    assertCaptureDocumentForFixture(document, fixture);
    captures.push({
      sourceKind: fixture.sourceKind,
      fileName: fixture.fileName,
      locatorKind: fixture.locatorKind,
      segments: fixture.expectedSegments,
      jsonReparsed: true,
      textProjection: true,
    });
  }

  return {
    clientMode,
    isolatedRuntimeMode: true,
    hostProviderButtonVisible: false,
    requirements: {
      requirementIds,
      displayNames,
      allReady: true,
    },
    captures,
  };
}

export function assertCaptureDocumentForFixture(document, fixture) {
  assertRecord(document, 'CaptureDocumentV1');
  assertExactKeys(
    document,
    [
      'blocks',
      'completedAt',
      'createdAt',
      'extractionEngine',
      'rawSegments',
      'schemaVersion',
      'source',
      'sourceText',
      'structuringEngine',
      'targetText',
      'warnings',
    ],
    'CaptureDocumentV1',
  );
  assert.equal(document.schemaVersion, '1');

  assertRecord(document.source, 'CaptureDocumentV1.source');
  assertExactKeys(
    document.source,
    ['bytes', 'fileName', 'mediaType', 'sha256'],
    'CaptureDocumentV1.source',
  );
  assert.equal(document.source.fileName, fixture.fileName);
  assert.equal(document.source.mediaType, fixture.mimeType);
  assert.equal(document.source.bytes, fixture.buffer.length);
  assert.equal(
    document.source.sha256,
    createHash('sha256').update(fixture.buffer).digest('hex'),
  );
  assert.match(document.source.sha256, /^[0-9a-f]{64}$/u);

  assertEngine(document.extractionEngine, 'CaptureDocumentV1.extractionEngine');
  assertEngine(
    document.structuringEngine,
    'CaptureDocumentV1.structuringEngine',
  );
  assert.ok(Array.isArray(document.warnings));
  assert.ok(
    document.warnings.every(
      (warning) => typeof warning === 'string' && warning.length <= 500,
    ),
  );

  assert.ok(Array.isArray(document.rawSegments));
  assert.equal(document.rawSegments.length, fixture.expectedSegments);
  const segmentIds = new Set();
  document.rawSegments.forEach((segment, index) => {
    assertRecord(segment, `rawSegments[${index}]`);
    assertExactKeys(
      segment,
      ['locator', 'order', 'segmentId', 'text'],
      `rawSegments[${index}]`,
    );
    assertNonEmptyString(segment.segmentId, `rawSegments[${index}].segmentId`);
    assert.equal(segmentIds.has(segment.segmentId), false);
    segmentIds.add(segment.segmentId);
    assert.equal(segment.order, index);
    assert.equal(segment.text, fixture.expectedTexts[index]);
    assertLocator(
      segment.locator,
      fixture,
      index,
      `rawSegments[${index}].locator`,
    );
  });
  assert.equal(
    document.sourceText,
    document.rawSegments.map((segment) => segment.text).join('\n'),
  );
  assertNonEmptyString(document.sourceText, 'CaptureDocumentV1.sourceText');

  assert.ok(Array.isArray(document.blocks));
  assert.equal(document.blocks.length, fixture.expectedSegments);
  const blockIds = new Set();
  document.blocks.forEach((block, index) => {
    const segment = document.rawSegments[index];
    assertRecord(block, `blocks[${index}]`);
    assertExactKeys(
      block,
      [
        'blockId',
        'locator',
        'order',
        'sourceSegmentId',
        'sourceText',
        'targetText',
        'type',
      ],
      `blocks[${index}]`,
    );
    assertNonEmptyString(block.blockId, `blocks[${index}].blockId`);
    assert.equal(blockIds.has(block.blockId), false);
    blockIds.add(block.blockId);
    assert.equal(block.order, index);
    assert.equal(block.sourceSegmentId, segment.segmentId);
    assert.equal(captureBlockTypes.has(block.type), true);
    assert.equal(
      block.type,
      fixture.locatorKind === 'time' ? 'transcript' : 'paragraph',
    );
    assert.deepEqual(block.locator, segment.locator);
    assert.equal(block.sourceText, segment.text);
    assertNonEmptyString(block.targetText, `blocks[${index}].targetText`);
  });
  assert.equal(
    document.targetText,
    document.blocks.map((block) => block.targetText).join('\n'),
  );
  assertNonEmptyString(document.targetText, 'CaptureDocumentV1.targetText');

  const createdAt = assertDateTime(
    document.createdAt,
    'CaptureDocumentV1.createdAt',
  );
  const completedAt = assertDateTime(
    document.completedAt,
    'CaptureDocumentV1.completedAt',
  );
  assert.ok(completedAt >= createdAt, 'completedAt must not precede createdAt');
}

function assertRecord(value, label) {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function assertExactKeys(value, keys, label) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label} keys`,
  );
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must not be empty`);
}

function assertEngine(engine, label) {
  assertRecord(engine, label);
  const keys = Object.keys(engine);
  assert.ok(
    keys.every((key) => ['device', 'digest', 'engine', 'model'].includes(key)),
  );
  assert.ok(['digest', 'engine', 'model'].every((key) => keys.includes(key)));
  assertNonEmptyString(engine.engine, `${label}.engine`);
  assertNonEmptyString(engine.model, `${label}.model`);
  assert.match(engine.digest, /^sha256:[0-9a-f]{64}$/u);
  if (engine.device !== undefined && engine.device !== null) {
    assertNonEmptyString(engine.device, `${label}.device`);
  }
}

function assertLocator(locator, fixture, index, label) {
  assertRecord(locator, label);
  assert.equal(locator.kind, fixture.locatorKind);
  if (fixture.locatorKind === 'page') {
    assert.ok(
      Object.keys(locator).every((key) =>
        ['boundingBox', 'kind', 'page'].includes(key),
      ),
      `${label} has unexpected keys`,
    );
    assert.equal(locator.page, index + 1);
    if (locator.boundingBox !== undefined && locator.boundingBox !== null) {
      assert.equal(locator.boundingBox.length, 4);
      assert.ok(locator.boundingBox.every(Number.isFinite));
    }
    return;
  }
  assertExactKeys(locator, ['endMs', 'kind', 'startMs'], label);
  assert.equal(locator.startMs, index * 1000);
  assert.equal(locator.endMs, (index + 1) * 1000);
  assert.ok(locator.startMs >= 0 && locator.endMs > locator.startMs);
}

function assertDateTime(value, label) {
  assertNonEmptyString(value, label);
  assert.match(
    value,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
  );
  const timestamp = Date.parse(value);
  assert.ok(Number.isFinite(timestamp), `${label} must be a valid date-time`);
  return timestamp;
}

async function waitUntil(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

async function stopAndProveOwnedProcesses(pid, ownedRoot) {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) {
    throw new Error('Owned Tauri PID is invalid.');
  }
  const before = await processesRunningUnder(ownedRoot);
  if (pid !== undefined && before.some((process_) => process_.pid === pid)) {
    await taskkillOwnedPid(pid, ownedRoot);
  }
  await delay(250);
  for (const process_ of await processesRunningUnder(ownedRoot)) {
    const stillOwned = (await processesRunningUnder(ownedRoot)).some(
      (candidate) => candidate.pid === process_.pid,
    );
    if (stillOwned) await taskkillOwnedPid(process_.pid, ownedRoot);
  }
  await waitUntil(
    async () => (await processesRunningUnder(ownedRoot)).length === 0,
    20_000,
    'Owned installed app/runtime processes remained after tree cleanup.',
  );
}

async function stopAndProveOwnedProcessRoots(ownedRoots) {
  const failures = [];
  for (const ownedRoot of ownedRoots) {
    try {
      await stopAndProveOwnedProcesses(undefined, ownedRoot);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'One or more installed-smoke process roots could not be cleaned safely.',
    );
  }
}

async function taskkillOwnedPid(pid, ownedRoot) {
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
  const stillOwned = (await processesRunningUnder(ownedRoot)).some(
    (candidate) => candidate.pid === pid,
  );
  assertTaskkillResult(result, stillOwned);
}

async function processesRunningUnder(root) {
  const safeRoot = assertStrictDescendant(
    smokeRoot,
    root,
    'Owned process root',
  );
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
  const result = spawnSync(
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
  );
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
}

async function waitForLoopbackPortRelease(port) {
  await waitUntil(
    async () => canBindLoopbackPort(port),
    20_000,
    'WebView2 CDP port remained bound after owned process cleanup.',
  );
}

async function canBindLoopbackPort(port) {
  return new Promise((resolveAvailability) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolveAvailability(false));
    server.listen(port, '127.0.0.1', () =>
      server.close(() => resolveAvailability(true)),
    );
  });
}

async function waitForInstalledDirectoryRemoval(directory) {
  await waitUntil(
    async () => !(await pathExists(directory)),
    30_000,
    'Installed NSIS uninstaller did not remove its exact install directory.',
  );
  if (await registryKeyExists(uninstallRegistryKey)) {
    throw new Error(
      'Installed NSIS uninstaller left its uninstall registry key.',
    );
  }
}

async function assertNoPreExistingInstallation() {
  const existing = [];
  for (const key of [uninstallRegistryKey, productRegistryKey]) {
    for (const view of registryViews) {
      if (await registryKeyExists(key, view)) existing.push(`${key} (${view})`);
    }
  }
  if (existing.length > 0) {
    throw new Error(
      'A pre-existing Capture Workbench Verification installation was found; refusing to modify it.',
    );
  }
}

async function assertInstalledRegistryPointsToOwnedDirectory(directory) {
  const ownedValues = [
    {
      key: uninstallRegistryKey,
      label: 'Installed NSIS uninstall registry key',
      read: (view) =>
        registryValue(uninstallRegistryKey, 'InstallLocation', view),
    },
    {
      key: productRegistryKey,
      label: 'Installed NSIS product registry key',
      read: (view) => registryDefaultValue(productRegistryKey, view),
    },
  ];
  for (const ownedValue of ownedValues) {
    let presentViews = 0;
    for (const view of registryViews) {
      if (!(await registryKeyExists(ownedValue.key, view))) continue;
      presentViews += 1;
      const value = await ownedValue.read(view);
      assertRegistryOwnership(
        value,
        directory,
        `${ownedValue.label} (${view}-bit view)`,
      );
    }
    if (presentViews === 0) {
      throw new Error(
        `${ownedValue.label} is absent; refusing destructive cleanup.`,
      );
    }
  }
}

async function removeOwnedRegistryResidue(expectedDirectory) {
  for (const key of [uninstallRegistryKey, productRegistryKey]) {
    for (const view of registryViews) {
      if (await registryKeyExists(key, view)) {
        const ownershipValue =
          key === uninstallRegistryKey
            ? await registryValue(key, 'InstallLocation', view)
            : await registryDefaultValue(key, view);
        assertRegistryOwnership(
          ownershipValue,
          expectedDirectory,
          `${key} (${view}-bit view)`,
        );
        const result = registryCommand(['delete', key, '/f', `/reg:${view}`]);
        if (result.status !== 0) {
          throw new Error('Owned NSIS registry residue could not be removed.');
        }
      }
    }
  }
  for (const key of [uninstallRegistryKey, productRegistryKey]) {
    for (const view of registryViews) {
      if (await registryKeyExists(key, view)) {
        throw new Error('Owned NSIS registry residue remained after cleanup.');
      }
    }
  }
}

async function registryKeyExists(key, view = '64') {
  const result = registryCommand(['query', key, `/reg:${view}`]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error('Windows registry query failed.');
}

async function registryValue(key, name, view) {
  const result = registryCommand(['query', key, '/v', name, `/reg:${view}`]);
  if (result.status === 1) return undefined;
  if (result.status !== 0)
    throw new Error('Windows registry value query failed.');
  const line = result.stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimStart().startsWith(name));
  const match = line?.match(/^\s*\S+\s+REG_\S+\s+(.*?)\s*$/u);
  if (!match) throw new Error('Windows registry value response was malformed.');
  return match[1];
}

async function registryDefaultValue(key, view) {
  const result = registryCommand(['query', key, '/ve', `/reg:${view}`]);
  if (result.status === 1) return undefined;
  if (result.status !== 0)
    throw new Error('Windows registry value query failed.');
  const line = result.stdout
    .split(/\r?\n/u)
    .find((candidate) => /\sREG_\S+\s/u.test(candidate));
  const match = line?.match(/^\s*.+?\s+REG_\S+\s+(.*?)\s*$/u);
  if (!match)
    throw new Error('Windows registry default value response was malformed.');
  return match[1];
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
      (name.toUpperCase() === 'SYSTEMROOT' ||
        name.toUpperCase() === 'WINDIR') &&
      typeof value === 'string' &&
      value.length > 0,
  );
  const configuredRoot = systemRootEntry?.[1];
  if (
    !configuredRoot ||
    !isAbsolute(configuredRoot) ||
    /[\0\r\n]/u.test(configuredRoot)
  ) {
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

function stripOuterQuotes(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
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
