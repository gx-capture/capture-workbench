import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { chromium, type Browser, type Page } from '@playwright/test';
import { firstValueFrom, from } from 'rxjs';

import { REGISTRY_VIEWS } from './constants/installed.ts';
import { installerArguments, uninstallerArguments } from './contracts/installed.ts';
import { createTrackedProcessTreeTerminator } from './installed-process-cleanup.ts';
import { createInstalledRegistry } from './installed-registry.ts';
import { createInstalledSmokeLifecycle } from './installed-smoke-lifecycle.ts';
import {
  ORIGINAL_IDENTITY,
  PRACTICAL_CHILD_ENVIRONMENT_ALLOWLIST,
  assertAbsent,
  assertPracticalEvidence,
  assertPracticalProvenance,
  assertRuntimeReleaseMatchesMode,
  installedExecutableName,
  ownedProcessImages,
  parseRunArguments,
  practicalChildEnvironment,
  practicalKnownFolderRoots,
  practicalRegistryKeys,
  practicalSourceKind,
  readVerifiedWorker,
  sha256Hex,
  verifyRuntimeReleaseDirectory,
  type PracticalCleanupEvidence,
  type PracticalInstallerProvenance,
  type PracticalOcrEvidence,
  type PracticalRunArguments,
  type ProcessImageRecord,
} from './practical-installed.ts';
import {
  assertDurableOcrCheckpoint,
  closePackagedBrowser,
  collectVisibleOcrSegments,
  connectToPackagedPage,
  exactDocumentCard,
  invokeTauriCommand,
  isLoopbackPortOpen,
  parseAuthenticatedOcrPreflight,
  queryPackagedUiState,
  reattachToPackagedPage,
  readDurableLibraryDetail,
  readDurableOcrProvenance,
  readImportedSourceSha256,
  requestDesktopTeardown,
  reservePort,
  runtimeSetupDiagnostics,
  visibleRuntimeError,
  waitForDesktopOcrCompletion,
  waitForPackagedRuntimeReadySignal,
  waitUntil,
} from './real-desktop-ocr-smoke.ts';
import { nativeClickWebViewElement, nativeOpenDialogUiAutomation } from './real-media-model-smoke.ts';
import { appRoot } from './stage-runtime.ts';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(appRoot, '..', '..');
const installerTimeoutMs = 600_000;
const runtimeSetupTimeoutMs = 20 * 60_000;
const ocrTimeoutMs = 10 * 60_000;
const processExitTimeoutMs = 60_000;

function systemExecutable(...segments: string[]): string {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  return win32.join(root, ...segments);
}

async function powershellJson(script: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    systemExecutable('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim() || 'null');
}

async function knownFolders(): Promise<{ roaming: string; local: string }> {
  const value = await powershellJson(
    "[pscustomobject]@{ roaming = [Environment]::GetFolderPath('ApplicationData'); local = [Environment]::GetFolderPath('LocalApplicationData') } | ConvertTo-Json -Compress",
  ) as { roaming?: unknown; local?: unknown } | null;
  if (typeof value?.roaming !== 'string' || typeof value.local !== 'string') {
    throw new Error('Windows known folders could not be resolved.');
  }
  return { roaming: value.roaming, local: value.local };
}

async function processImages(): Promise<ProcessImageRecord[]> {
  const value = await powershellJson(
    '@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; executablePath = [string]$_.ExecutablePath } }) | ConvertTo-Json -Compress',
  );
  const records = Array.isArray(value) ? value : value ? [value] : [];
  return records.flatMap((record) =>
    record && typeof record === 'object' && Number.isSafeInteger((record as { pid?: unknown }).pid)
      ? [{ pid: Number((record as { pid: number }).pid), executablePath: String((record as { executablePath?: unknown }).executablePath ?? '') }]
      : [],
  );
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function isLoopbackListening(port: number): Promise<boolean> {
  return isLoopbackPortOpen(port);
}

/** Records hashes of every process image that runs from a run-owned root. */
class OwnedProcessSampler {
  private readonly hashes = new Map<string, string>();
  private readonly observed = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private sampling: Promise<void> = Promise.resolve();

  constructor(private readonly roots: readonly string[]) {}

  async sample(): Promise<ProcessImageRecord[]> {
    const owned = ownedProcessImages(await processImages(), this.roots);
    for (const record of owned) {
      const key = win32.resolve(record.executablePath).toLowerCase();
      this.observed.add(key);
      if (!this.hashes.has(key)) {
        const sha = await fileSha256(record.executablePath).catch(() => undefined);
        if (sha) this.hashes.set(key, sha);
      }
    }
    return owned;
  }

  start(intervalMs = 2_000): void {
    this.timer = setInterval(() => {
      this.sampling = this.sampling.then(() => this.sample().then(() => undefined)).catch(() => undefined);
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.sampling;
  }

  imageHashes(fileName: string): string[] {
    return [...new Set(
      [...this.observed]
        .filter((path) => win32.basename(path) === fileName.toLowerCase())
        .map((path) => this.hashes.get(path))
        .filter((sha): sha is string => sha !== undefined),
    )].sort();
  }
}

async function startWorkerMirror(fileName: string, bytes: Buffer): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== `/${fileName}`) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) });
    response.end(bytes);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Worker mirror did not bind a loopback port.');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function ordinaryInstallationSnapshot(roaming: string): Promise<string> {
  const query = (view: string) =>
    spawnSync(systemExecutable('System32', 'reg.exe'), [
      'query',
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${ORIGINAL_IDENTITY.productName}`,
      '/v',
      'InstallLocation',
      `/reg:${view}`,
    ], { encoding: 'utf8', windowsHide: true });
  const registry = REGISTRY_VIEWS.map((view) => {
    const result = query(view);
    return result.status === 0 ? String(result.stdout).trim() : 'absent';
  });
  const dataRoot = win32.join(roaming, ORIGINAL_IDENTITY.identifier);
  const dataPresent = (await lstat(dataRoot).catch(() => undefined))?.isDirectory() === true;
  return createHash('sha256').update(JSON.stringify({ registry, dataPresent })).digest('hex');
}

async function removeVariantRoot(root: string, knownFolder: string, identifier: string): Promise<boolean> {
  if (win32.dirname(root).toLowerCase() !== win32.resolve(knownFolder).toLowerCase() || win32.basename(root) !== identifier) {
    throw new Error('Refusing to remove a path that is not the variant known-folder root.');
  }
  const metadata = await lstat(root).catch(() => undefined);
  if (!metadata) return true;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Variant known-folder root must be a real directory.');
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  return !(await lstat(root).catch(() => undefined));
}

export async function runPracticalInstalledOcr(args: PracticalRunArguments): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Practical installed OCR requires Windows x64.');
  const provenance: unknown = JSON.parse(await readFile(args.provenance, 'utf8'));
  assertPracticalProvenance(provenance);
  const installerProvenance: PracticalInstallerProvenance = provenance;
  const { variant, mode } = installerProvenance;
  assertRuntimeReleaseMatchesMode(mode, args.runtimeRelease);

  const evidenceRoot = dirname(args.provenance);
  const installerPath = join(evidenceRoot, installerProvenance.installer.fileName);
  if (sha256Hex(await readFile(installerPath)) !== installerProvenance.installer.sha256) {
    throw new Error('Practical installer differs from its recorded provenance.');
  }
  const sourceBytes = await readFile(args.input);
  const sourceKind = practicalSourceKind(args.input);
  if (sourceBytes.length === 0 || sha256Hex(sourceBytes) !== args.inputSha256) {
    throw new Error('Practical OCR input differs from --input-sha256.');
  }

  let workerMirror: { server: Server; origin: string } | undefined;
  const ocrWorker = installerProvenance.runtime.workers.find((worker) => worker.requirementId === 'windowsml-ocr');
  if (!ocrWorker) throw new Error('Installer provenance omits the OCR worker identity.');
  if (args.runtimeRelease) {
    const release = await verifyRuntimeReleaseDirectory(
      args.runtimeRelease,
      installerProvenance.runtime.executable.sha256,
      installerProvenance.releaseVersion,
    );
    if (release.catalog.sha256 !== installerProvenance.runtime.catalog.sha256) {
      throw new Error('Runtime release catalog differs from the installer provenance.');
    }
    const releaseWorker = release.workers.find((worker) => worker.fileName === ocrWorker.fileName);
    if (!releaseWorker || releaseWorker.sha256 !== ocrWorker.sha256) {
      throw new Error('Runtime release OCR worker differs from the installer provenance.');
    }
    workerMirror = await startWorkerMirror(ocrWorker.fileName, await readVerifiedWorker(release, releaseWorker));
  }

  const folders = await knownFolders();
  const variantRoots = practicalKnownFolderRoots(folders, variant);
  await assertAbsent(variantRoots, 'Practical variant application data');
  const ordinaryBefore = await ordinaryInstallationSnapshot(folders.roaming);

  const runRoot = join(evidenceRoot, 'run');
  const privateRoot = join(evidenceRoot, 'private');
  await assertAbsent([runRoot, privateRoot, join(evidenceRoot, 'practical-ocr-evidence.json')], 'Practical run output');
  const installDirectory = join(runRoot, 'install');
  const webViewData = join(runRoot, 'webview2');
  const temporary = join(runRoot, 'temp');
  for (const directory of [installDirectory, webViewData, temporary, privateRoot]) {
    await mkdir(directory, { recursive: true });
  }

  const baseChildEnvironment = (source: NodeJS.ProcessEnv, isolatedTemp: string) => {
    const environment: Record<string, string> = {};
    for (const allowed of PRACTICAL_CHILD_ENVIRONMENT_ALLOWLIST) {
      const entry = Object.entries(source).find(([name, value]) => name.toUpperCase() === allowed && value);
      if (entry?.[1]) environment[allowed] = entry[1];
    }
    environment.TEMP = isolatedTemp;
    environment.TMP = isolatedTemp;
    return environment;
  };
  const keys = practicalRegistryKeys(variant);
  const registry = createInstalledRegistry({
    smokeRoot: runRoot,
    workspaceRoot,
    registryViews: REGISTRY_VIEWS,
    productRegistryKey: keys.productRegistryKey,
    uninstallRegistryKey: keys.uninstallRegistryKey,
    baseChildEnvironment,
    pathExists: (path: string) => from(lstat(path).then(() => true, () => false)),
  });
  const lifecycle = createInstalledSmokeLifecycle({
    workspaceRoot,
    smokeRoot: runRoot,
    nsisDirectory: evidenceRoot,
    terminateTrackedProcessTree: createTrackedProcessTreeTerminator({
      smokeRoot: runRoot,
      workspaceRoot,
      baseChildEnvironment,
      windowsSystemExecutable: registry.windowsSystemExecutable,
    }),
  });

  const ownedRoots = [installDirectory, ...variantRoots];
  const runtimeImageName = installerProvenance.runtime.executable.fileName.toLowerCase();
  const sampler = new OwnedProcessSampler(ownedRoots);
  const browsers: Browser[] = [];
  const cleanup: { -readonly [K in keyof PracticalCleanupEvidence]: PracticalCleanupEvidence[K] } = {
    normalWindowClose: false,
    forcedTerminationCount: 0,
    ownedProcessesStopped: false,
    cdpPortReleased: false,
    uninstallerCompleted: false,
    installDirectoryRemoved: false,
    uninstallKeyRemoved: false,
    registryResidueRemoved: false,
    variantDataRemoved: false,
    runDirectoryRemoved: false,
    ordinaryInstallationPreserved: false,
  };
  const failures: unknown[] = [];
  let installed = false;
  let cdpPort: number | undefined;
  let app: ReturnType<typeof spawn> | undefined;
  let page: Page | undefined;
  let journey: Omit<PracticalOcrEvidence, 'cleanup' | 'observedProcessImages'> | undefined;

  const activePage = (): Page => {
    if (!page) throw new Error('Practical installed WebView2 page is not attached.');
    return page;
  };
  const attach = async (attached: { browser: Browser; page: Page }) => {
    browsers.push(attached.browser);
    page = attached.page;
    return attached;
  };

  try {
    await firstValueFrom(registry.assertNoPreExistingInstallation());
    const installStarted = Date.now();
    installed = true;
    await firstValueFrom(lifecycle.runCheckedExecutable(
      installerPath,
      installerArguments(runRoot, installDirectory),
      'Practical NSIS installer',
      baseChildEnvironment(process.env, temporary),
      installerTimeoutMs,
    ));
    const executable = await firstValueFrom(lifecycle.assertOwnedRegularFile(
      installDirectory,
      join(installDirectory, installedExecutableName(variant)),
      'Installed practical executable',
    ));
    await firstValueFrom(registry.assertInstalledRegistryPointsToOwnedDirectory(installDirectory));
    const installedRuntime = join(installDirectory, 'binaries', installerProvenance.runtime.executable.fileName);
    if ((await fileSha256(installedRuntime)) !== installerProvenance.runtime.executable.sha256) {
      throw new Error('Installed runtime executable differs from the installer provenance.');
    }
    const installMs = Date.now() - installStarted;

    cdpPort = await reservePort();
    const runtimeStarted = Date.now();
    app = spawn(executable, [], {
      cwd: installDirectory,
      env: practicalChildEnvironment(process.env, {
        temporary,
        webViewData,
        cdpPort,
        ...(workerMirror ? { workerMirrorOrigin: workerMirror.origin } : {}),
      }),
      stdio: 'ignore',
      windowsHide: false,
    });
    app.on('error', () => undefined);
    sampler.start();
    const port = cdpPort;
    const initialBrowser = await waitUntil(
      () => chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1_500 }).catch(() => undefined),
      90_000,
      'Practical installed WebView2 CDP was not ready.',
    );
    await attach(await connectToPackagedPage(port, { initialBrowser, timeoutMs: 30_000 }));
    await activePage().waitForLoadState('domcontentloaded');
    await activePage().setViewportSize({ width: 1440, height: 900 });

    const setup = activePage().getByTestId('runtime-setup');
    const initialState = await waitUntil<'ready' | 'setup'>(async () => {
      const runtimeError = await visibleRuntimeError(activePage());
      if (runtimeError) throw new Error(runtimeError);
      if (await activePage().getByTestId('source-import').isEnabled()) return 'ready';
      if (await setup.isVisible()) return 'setup';
      return undefined;
    }, 3 * 60_000, 'Practical installed app did not reach ready or setup state.');
    if (initialState === 'ready') {
      throw new Error('A fresh practical installation unexpectedly reused an installed runtime.');
    }
    const install = setup.getByTestId('runtime-install');
    await install.waitFor({ state: 'visible', timeout: 30_000 });
    await activePage().screenshot({ path: join(privateRoot, '01-first-run-setup.png') });
    await install.click();
    await waitUntil(async () => {
      const runtimeError = await visibleRuntimeError(activePage());
      if (runtimeError) throw new Error(runtimeError);
      const progress = activePage().getByTestId('runtime-install-progress');
      if (await progress.isVisible().catch(() => false)) {
        const status = await progress.getAttribute('data-status');
        if (status === 'failed' || status === 'cancelled' || status === 'manual_action_required') {
          throw new Error(`First-run runtime setup ended as ${status}. ${await runtimeSetupDiagnostics(activePage())}`);
        }
      }
      const runtimeState = await activePage().getByTestId('workbench-root').getAttribute('data-runtime-state').catch(() => undefined);
      if (runtimeState === 'error') {
        throw new Error(`First-run runtime setup entered an error state. ${await runtimeSetupDiagnostics(activePage())}`);
      }
      return (await waitForPackagedRuntimeReadySignal(port)) || undefined;
    }, runtimeSetupTimeoutMs, 'First-run runtime setup did not reach readiness.');
    await attach(await reattachToPackagedPage(port));
    const preflight = parseAuthenticatedOcrPreflight(await invokeTauriCommand(activePage(), 'runtime_ready', {}));
    const uiState = await queryPackagedUiState(port);
    if (!uiState?.sourceImportEnabled || uiState.ocrComputeMode !== preflight.mode || !uiState.ocrComputeVisible) {
      throw new Error('The installed UI did not expose the authenticated OCR compute state before import.');
    }
    const runtimeReadyMs = Date.now() - runtimeStarted;
    await activePage().screenshot({ path: join(privateRoot, '02-runtime-ready.png') });

    // Import a run-owned copy so the user's original file is never touched;
    // the durable import digest proves the bytes are identical.
    const sourceName = `practical-ocr-${variant.runId}${extname(args.input).toLowerCase()}`;
    const pickerSource = join(temporary, sourceName);
    await copyFile(args.input, pickerSource);
    const ocrStarted = Date.now();
    const appPid = app.pid ?? 0;
    await nativeOpenDialogUiAutomation(pickerSource, appPid, () =>
      nativeClickWebViewElement(activePage().getByTestId('source-import'), appPid),
    );
    await attach(await reattachToPackagedPage(port));
    const card = exactDocumentCard(activePage(), sourceName);
    await card.waitFor({ state: 'visible', timeout: 60_000 });
    const documentId = await card.getAttribute('data-document-id');
    if (!documentId) throw new Error('Imported practical document omitted its identity.');
    const completed = await waitForDesktopOcrCompletion(activePage(), card, ocrTimeoutMs, {
      fileName: sourceName,
      documentId,
      stopAtOcrCheckpoint: true,
      observeLiveness: async () => ({
        appAlive: app?.exitCode === null && app?.signalCode === null,
        runtimeAlive: (await sampler.sample()).some(
          (record) => win32.basename(record.executablePath).toLowerCase() === runtimeImageName,
        ),
        cdpOpen: await isLoopbackListening(port),
        teardownRequested: false,
        appExitCode: app?.exitCode ?? null,
        appSignal: app?.signalCode ?? null,
      }),
      reattach: async () => attach(await reattachToPackagedPage(port)),
      exactDocumentCard,
    });
    page = completed.page;
    await completed.card.click();
    const raw = page.locator('.review-block').filter({ hasText: 'OCR 原始結果' }).locator('pre');
    await raw.waitFor({ state: 'visible', timeout: 30_000 });
    const rawText = (await raw.textContent()) ?? '';
    const segments = await collectVisibleOcrSegments(page);
    const ocrMs = Date.now() - ocrStarted;
    await page.screenshot({ path: join(privateRoot, '03-ocr-result.png'), fullPage: true });
    // Raw OCR text and unmasked screenshots stay private for the human
    // usability review; evidence records only counts and identities.
    await writeFile(join(privateRoot, 'ocr-raw-text.txt'), rawText, { encoding: 'utf8', flag: 'wx' });

    const detail = await readDurableLibraryDetail(page, documentId);
    const importedSourceSha256 = readImportedSourceSha256(detail);
    assertDurableOcrCheckpoint(detail, { sourceKind, sourceSha256: args.inputSha256, rawSegments: segments });
    const durable = readDurableOcrProvenance(detail);
    if ((durable.device === 'windowsml-dml') !== (preflight.mode === 'gpu-dml')) {
      throw new Error('Durable OCR device differs from the authenticated compute preflight.');
    }
    journey = {
      schemaVersion: '1',
      evidenceKind: 'capture-practical-installed-ocr',
      mode,
      releaseGateSatisfied: false,
      usabilityReview: 'pending-private-human-review',
      accuracy: 'CER not evaluated',
      runId: variant.runId,
      sourceCommit: installerProvenance.sourceCommit,
      releaseVersion: installerProvenance.releaseVersion,
      installerSha256: installerProvenance.installer.sha256,
      runtimeExecutableSha256: installerProvenance.runtime.executable.sha256,
      workerSource: workerMirror ? 'loopback-mirror-of-verified-release-directory' : 'github-release',
      workerArchiveSha256: ocrWorker.sha256,
      fixture: { kind: sourceKind, sha256: args.inputSha256, bytes: sourceBytes.length },
      importedSourceSha256,
      runtime: {
        contractSetSha256: preflight.contractSha256,
        workerExecutableSha256: preflight.workerSha256,
        computeMode: preflight.mode,
      },
      ocr: {
        ...durable,
        segmentCount: segments.length,
        characterCount: segments.reduce((total, segment) => total + segment.text.length, 0),
      },
      durationsMs: { install: installMs, runtimeReady: runtimeReadyMs, ocr: ocrMs },
    };
  } catch (error) {
    failures.push(error);
    if (page) await page.screenshot({ path: join(privateRoot, '99-failure.png') }).catch(() => undefined);
  }

  // Teardown always runs and is proven independently of the journey result.
  await sampler.stop();
  if (app && page) {
    try {
      await requestDesktopTeardown('window-close', (command, commandArgs) =>
        invokeTauriCommand(activePage(), command, commandArgs),
      );
      cleanup.normalWindowClose = true;
    } catch (error) {
      failures.push(error);
    }
  }
  for (const browser of browsers) await closePackagedBrowser(browser);
  try {
    await waitUntil(async () => ((await sampler.sample()).length === 0 ? true : undefined), processExitTimeoutMs,
      'Owned practical processes did not exit after window close.');
  } catch (error) {
    failures.push(error);
    const remaining = ownedProcessImages(await processImages(), ownedRoots);
    for (const record of remaining) {
      spawnSync(systemExecutable('System32', 'taskkill.exe'), ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true });
      cleanup.forcedTerminationCount += 1;
    }
  }
  cleanup.ownedProcessesStopped = ownedProcessImages(await processImages(), ownedRoots).length === 0;
  cleanup.cdpPortReleased = cdpPort === undefined || !(await isLoopbackListening(cdpPort));
  workerMirror?.server.close();

  if (installed && cleanup.ownedProcessesStopped) {
    try {
      const uninstaller = await firstValueFrom(lifecycle.assertOwnedRegularFile(
        installDirectory,
        join(installDirectory, 'uninstall.exe'),
        'Installed practical uninstaller',
      ));
      await firstValueFrom(registry.assertInstalledRegistryPointsToOwnedDirectory(installDirectory));
      await firstValueFrom(lifecycle.runCheckedExecutable(
        uninstaller,
        uninstallerArguments(runRoot, installDirectory),
        'Practical NSIS uninstaller',
        baseChildEnvironment(process.env, temporary),
        installerTimeoutMs,
      ));
      cleanup.uninstallerCompleted = true;
      const state = await firstValueFrom(registry.waitForInstalledDirectoryRemoval(installDirectory));
      cleanup.installDirectoryRemoved = true;
      cleanup.uninstallKeyRemoved = state.uninstallKeyRemoved;
      await firstValueFrom(registry.removeOwnedRegistryResidue(installDirectory));
      cleanup.registryResidueRemoved = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (cleanup.ownedProcessesStopped) {
    try {
      const removed = await Promise.all([
        removeVariantRoot(variantRoots[0], folders.roaming, variant.identifier),
        removeVariantRoot(variantRoots[1], folders.local, variant.identifier),
      ]);
      cleanup.variantDataRemoved = removed.every(Boolean);
      await firstValueFrom(lifecycle.safeRemoveTree(evidenceRoot, runRoot));
      cleanup.runDirectoryRemoved = !(await lstat(runRoot).catch(() => undefined));
    } catch (error) {
      failures.push(error);
    }
  }
  cleanup.ordinaryInstallationPreserved = (await ordinaryInstallationSnapshot(folders.roaming)) === ordinaryBefore;

  if (failures.length > 0 || !journey) {
    throw new AggregateError(failures, 'Practical installed OCR failed or could not prove cleanup.');
  }
  const evidence: PracticalOcrEvidence = {
    ...journey,
    observedProcessImages: {
      runtimeExecutableSha256: sampler.imageHashes(installerProvenance.runtime.executable.fileName),
      workerExecutableSha256: sampler.imageHashes('capture-engine-ocr.exe'),
    },
    cleanup,
  };
  assertPracticalEvidence(evidence);
  const evidencePath = join(evidenceRoot, 'practical-ocr-evidence.json');
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return evidencePath;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runPracticalInstalledOcr(parseRunArguments(process.argv.slice(2))).then(
    (evidencePath) => {
      process.stdout.write(`Practical installed OCR evidence: ${evidencePath}\n`);
      process.stdout.write('Review the private OCR text and screenshots next to it before judging usability.\n');
    },
    (error: unknown) => {
      const errors = error instanceof AggregateError ? [error, ...error.errors] : [error];
      for (const item of errors) process.stderr.write(`${item instanceof Error ? item.message : String(item)}\n`);
      process.exitCode = 1;
    },
  );
}
