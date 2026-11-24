// Desktop App check of the capture lifecycle on the installed QA build
// "Capture Workbench QA Fake Data" (fixture runtime, fake data). It proves
// what only the Desktop App can (AGENTS.md, "Verification in two layers"):
//   - reload-during-capture: F5 on the OCR page and Ctrl+R on the ASR page,
//     sent to the window while a capture runs, reload the packaged page; the
//     row is interrupted, nothing is written, the runtime gets one DELETE for
//     the stored capture, and Start again completes.
//   - close-during-capture: the title bar's close message while a capture
//     runs ends the whole app tree within 1 s, and nothing of the run is left
//     by 1 s, 5 s and 15 s; at the next start, recorded from before the
//     page's first script, the row is interrupted, nothing is written, the
//     page asks the host once to delete the stored link and the new runtime
//     answers one DELETE, and Start again completes.
//   - native-drop: real files dropped with native OLE drag and drop on the
//     OCR page, the ASR page and History are imported in drop order and
//     captured one at a time in that order.
// The phases run in this order in one invocation: install, launch, first-run,
// reload-during-capture, close-during-capture, native-drop, close, uninstall.
// A phase that cannot prove a claim fails the run naming that claim; the
// remaining phases are skipped except uninstall, which runs after a failure
// too, reports each cleanup step, and removes the app, its registry keys and
// the run directory only as far as its proofs allow; what it keeps, it names
// with recovery steps.
//
// Run by hand, on Windows, with nothing else using the mouse and keyboard:
//   corepack pnpm nx run capture-workbench-desktop:diagnostic-installed-deterministic-capture-lifecycle
// The target builds the QA installer first. The check refuses to run over an
// existing QA installation. It installs silently into
// tmp/capture-workbench-desktop/installed-capture-lifecycle/run, opens the
// app's window, sends it F5 and Ctrl+R, picks files in the native dialog, drags
// files onto it with the mouse and closes it. Evidence: one
// installed-capture-lifecycle-<time>.json per run in that directory.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Browser, Page, Request } from '@playwright/test';
import { type Observable, firstValueFrom } from 'rxjs';

import { assertStagedRuntime } from './assert-staged-runtime.ts';
import {
  INSTALLED_EXECUTABLE_NAME,
  REGISTRY_VIEWS,
  fixtureSourceBytes,
  registryKeysForProduct,
} from './constants/installed.ts';
import {
  buildInstalledAppEnvironment,
  installedChildEnvironment,
  installerArguments,
} from './contracts/installed.ts';
import { deterministicQaNsis, deterministicQaProductName } from './deterministic-qa.ts';
import {
  assertRealAppDataUnchanged,
  installedAppDataUse,
  realProductAppDataDirectory,
  snapshotRealAppData,
  type AppDataSnapshot,
} from './installed-app-data-guard.ts';
import {
  connectToInstalledWebView,
  installedPage,
  prepareFirstRun,
  reserveLoopbackPort,
} from './installed-browser.ts';
import {
  CLOSE_HELPER_SAMPLES_AFTER_MS,
  CLOSE_SUBJECTS,
  DROP_SUBJECTS,
  RELOAD_SUBJECTS,
  type DroppedFile,
  type FileState,
  type LifecyclePhase,
  type OwnedDirectory,
  type PageRequest,
  type PhaseClaims,
  type AppTreeProcess,
  type ProcessProof,
  type QueueKind,
  type RowView,
  type RuntimeRequest,
  type StoredDocument,
  assertLifecycleEvidence,
  assertNotRedirected,
  captureCreates,
  captureOfDocuments,
  captureRequests,
  captureTurns,
  changedFiles,
  claimOwnedDirectory,
  closeMeasurements,
  completeRequestLogEntries,
  createdCaptures,
  describeRequests,
  displayMs,
  fileTimeOf,
  importedInDropOrder,
  isAllCompleted,
  isCompletedCapture,
  isDeleteOfHeldCapture,
  isDropAccepted,
  isInterruptedRow,
  isMarkerOfRun,
  isNothingLeft,
  isOneCaptureWhileHeld,
  isRunningWithLink,
  isStoredLinkDeleteRequestedAfterRestart,
  isOwnedDirectory,
  isTreeObserved,
  earlierRunTreeRecovery,
  lifecycleCheckPaths,
  lifecycleEvidence,
  mayRemoveRegistryResidue,
  pageCommandsOf,
  parseAppTreeCloseResult,
  processProofHolds,
  recoverySteps,
  removeOwnedDirectory,
  runLifecyclePhases,
  runMarker,
  runTreeDecision,
  runtimeCaptureTurns,
  storedState,
  treeExits,
  uninstallDecision,
  uninstallerState,
} from './installed-capture-lifecycle-checks.ts';
import { nativeClickWebViewElement, nativeOpenDialogUiAutomation } from './installed-native-dialog.ts';
import {
  appTreeCloseArguments,
  appTreeInventoryArguments,
  runWindowHelper,
  windowActivateArguments,
  windowDropArguments,
  windowHelperInvocation,
  windowKeyArguments,
  type AppProcess,
  type WindowHelperScript,
  type WindowKey,
} from './installed-native-window.ts';
import {
  installedSmokeExecutableTimeoutMs,
  stopPostUninstallProcessRoots,
} from './installed-nsis-smoke.ts';
import { acquireInstalledProductLock } from './installed-product-lock.ts';
import { createInstalledProcessCleanup } from './installed-process-cleanup.ts';
import { createInstalledRegistry } from './installed-registry.ts';
import { closeBrowserRendererBoundary, ipcCommand, recordedIpcRequests } from './installed-renderer-boundary.ts';
import {
  assertInstalledIntoOwnedDirectory,
  createInstalledSmokeLifecycle,
  pathExists,
  uninstallOwnedInstallation,
  writeOwnedEvidence,
} from './installed-smoke-lifecycle.ts';
import { invokeTauriCommand } from './real-desktop-ocr-smoke.ts';

/** How long a page step may take before its claim fails. */
const STEP_TIMEOUT_MS = 15_000;
/** How long a released capture may take to finish. */
const FINISH_TIMEOUT_MS = 30_000;
/**
 * After a reload or a start, the untracked runtime delete and any library
 * write arrive within this window; a write that has not come by its end
 * counts as not written.
 */
const QUIET_WINDOW_MS = 3_000;
/** While the first dropped file is held, a wrongly started second capture would show up within this window. */
const HELD_QUIET_WINDOW_MS = 1_500;
const HELPER_TIMEOUT_MS = 60_000;
const RELOAD_MARKER = '__installedCaptureLifecycleMarker';

type CapturePage = 'ocr' | 'asr' | 'history';
type CaptureControl = { readonly holdCaptures?: boolean };

interface CommandRecorder {
  /** The library writes, capture deletes and command names the page sent since the recorder was attached. */
  readonly commands: () => ReturnType<typeof pageCommandsOf>;
  readonly stop: () => void;
}

interface RunState {
  runtimeVersion?: string;
  installer?: { readonly path: string; readonly fileName: string; readonly bytes: number; readonly sha256: string };
  installationAttempted: boolean;
  privateProcessRootsRegistered: boolean;
  /** The run tree this run made and wrote its marker into; only then may cleanup remove it. */
  runTree?: OwnedDirectory;
  /** Cleanup kept the run tree for recovery. */
  keptRunTree: boolean;
  /** The recovery steps for the kept run tree: workspace-relative paths only. */
  recovery: string[];
  app?: ChildProcess;
  /**
   * The current or last app root: its PID and creation time identify the QA
   * app for every input, and find its descendants after it exited.
   */
  lastApp?: AppProcess;
  browsers: Browser[];
  cdpPorts: number[];
  realAppDataDirectory?: string;
  realAppDataBefore?: AppDataSnapshot;
}

function sourceRevision(workspaceRoot: string): { sourceCommit: string; sourceTreeClean: boolean } {
  const git = (args: string[]) => execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true }).trim();
  return {
    sourceCommit: git(['rev-parse', 'HEAD']),
    sourceTreeClean: git(['status', '--porcelain', '--untracked-files=no']).length === 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs: number, failure: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${failure} within ${timeoutMs} ms${lastError ? ` (${errorMessage(lastError)})` : ''}.`);
    }
    await delay(100);
  }
}

/** Outcome of one cleanup step: it never throws, so every step runs and reports. */
async function attempt<T>(step: () => Promise<T>): Promise<{ ok: boolean; value: T | undefined; error: string }> {
  try {
    return { ok: true, value: await step(), error: '' };
  } catch (error) {
    return { ok: false, value: undefined, error: errorMessage(error) };
  }
}

export async function runInstalledCaptureLifecycle({
  workspaceRoot,
  checkTemporary,
  originalTemporary,
}: {
  readonly workspaceRoot: string;
  /** The directory the command line made for this process's TEMP; the cleanup phase removes it. */
  readonly checkTemporary: OwnedDirectory;
  /** TEMP and TMP as they were before the command line replaced them. */
  readonly originalTemporary: { readonly TEMP: string | undefined; readonly TMP: string | undefined };
}) {
  const paths = lifecycleCheckPaths(workspaceRoot);
  assertNotRedirected(workspaceRoot, paths.run);
  assertNotRedirected(workspaceRoot, checkTemporary.path);
  const revision = sourceRevision(workspaceRoot);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const relativeRun = relative(workspaceRoot, paths.run).replaceAll('\\', '/');
  const requestLogPath = join(paths.appTemporary, 'deterministic-requests.jsonl');
  const captureControlPath = join(paths.appTemporary, 'capture-deterministic-capture-control.json');
  const childEnvironment = (source: NodeJS.ProcessEnv, isolatedTemp: string, ownedRoot = paths.run) =>
    installedChildEnvironment(source, isolatedTemp, ownedRoot);
  const { productRegistryKey, uninstallRegistryKey } = registryKeysForProduct(deterministicQaProductName);
  const registry = createInstalledRegistry({
    smokeRoot: paths.root,
    workspaceRoot,
    registryViews: REGISTRY_VIEWS,
    productRegistryKey,
    uninstallRegistryKey,
    baseChildEnvironment: childEnvironment,
    pathExists,
  });
  const processCleanup = createInstalledProcessCleanup({
    smokeRoot: paths.root,
    workspaceRoot,
    baseChildEnvironment: childEnvironment,
    windowsSystemExecutable: registry.windowsSystemExecutable,
  });
  const lifecycle = createInstalledSmokeLifecycle({
    workspaceRoot,
    smokeRoot: paths.root,
    nsisDirectory: deterministicQaNsis,
    productName: deterministicQaProductName,
    terminateTrackedProcessTree: processCleanup.terminateTrackedProcessTree,
  });
  const state: RunState = {
    installationAttempted: false,
    privateProcessRootsRegistered: false,
    keptRunTree: false,
    recovery: [],
    browsers: [],
    cdpPorts: [],
  };

  // ---------- window helpers and the fixture runtime ----------

  const helper = (script: WindowHelperScript, args: string[]) => {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    const temporary = process.env.TEMP;
    if (!systemRoot || !temporary) throw new Error('The window helpers need SystemRoot and the check\'s TEMP.');
    return firstValueFrom(runWindowHelper(windowHelperInvocation(script, args, {
      systemRoot,
      path: process.env.Path ?? process.env.PATH ?? '',
      temporary,
      ownedRoot: paths.root,
    }, HELPER_TIMEOUT_MS)));
  };

  const appPid = (): number => {
    const pid = state.app?.pid;
    if (!state.app || pid === undefined || state.app.exitCode !== null) throw new Error('The installed app is not running.');
    return pid;
  };

  /** The running QA app as every input identifies it: PID and process creation time. */
  const appProcess = (): AppProcess => {
    const pid = appPid();
    if (state.lastApp?.pid !== pid) throw new Error('The installed app\'s process creation time is not known.');
    return state.lastApp;
  };

  const controlCaptures = async (control: CaptureControl) => {
    await writeFile(`${captureControlPath}.next`, JSON.stringify(control), 'utf8');
    await rename(`${captureControlPath}.next`, captureControlPath);
  };

  const runtimeLog = async (): Promise<RuntimeRequest[]> => {
    try {
      return completeRequestLogEntries(await readFile(requestLogPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };

  const writeSource = async (name: string, kind: 'pdf' | 'image' | 'recording', texts: string[]) => {
    const path = join(paths.sources, name);
    await writeFile(path, fixtureSourceBytes(kind, texts), { flag: 'wx' });
    return path;
  };

  const libraryFiles = async (): Promise<Record<string, FileState>> => {
    const files: Record<string, FileState> = {};
    for (const name of await readdir(paths.library, { recursive: true })) {
      const metadata = await stat(join(paths.library, name));
      if (metadata.isFile()) files[name.replaceAll('\\', '/')] = { bytes: metadata.size, mtimeMs: metadata.mtimeMs };
    }
    return files;
  };

  // ---------- the app and its page ----------

  /**
   * Starts the app and connects to its page. At every start WebView2 waits
   * for the script debugger, and the connection attaches its IPC recorder
   * before it lets the page's first script run, so no host command the page
   * sends while starting can be missed; `startupCommands` reads that record.
   */
  const launchApp = async (): Promise<{ page: Page; browser: Browser }> => {
    const cdpPort = await firstValueFrom(reserveLoopbackPort());
    const environment = buildInstalledAppEnvironment(process.env, {
      root: paths.run,
      appData: paths.appData,
      localAppData: paths.localAppData,
      temporary: paths.appTemporary,
      webViewData: paths.webViewData,
      requestLog: requestLogPath,
    }, cdpPort);
    environment.WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER = '1';
    // The window must show: the check sends it keys and drops files on it.
    const app = spawn(join(paths.install, INSTALLED_EXECUTABLE_NAME), [], {
      cwd: paths.install,
      env: environment,
      stdio: 'ignore',
      windowsHide: false,
    });
    state.app = app;
    const { browser, port } = await firstValueFrom(connectToInstalledWebView(cdpPort, app, paths.webViewData, true));
    state.browsers.push(browser);
    state.cdpPorts.push(port);
    // The app's identity for every input: its PID with its creation time.
    const identity = await helper('installed-app-tree.ps1', appTreeInventoryArguments({
      runRoot: paths.run,
      webViewDataDirectory: paths.webViewData,
      app: { pid: app.pid },
    }));
    state.lastApp = { pid: app.pid, createdFileTime: fileTimeOf(identity.appCreatedFileTime) };
    return { page: await firstValueFrom(installedPage(browser, app)), browser };
  };

  /** The host commands the page sent since before its first script ran. */
  const startupCommands = (startedPage: Page) => pageCommandsOf(recordedIpcRequests(startedPage));

  const disconnectBrowsers = async () => {
    // Closing a CDP connection also removes Playwright's temporary folder.
    for (const browser of state.browsers.splice(0)) {
      await Promise.race([browser.close().catch(() => undefined), delay(5_000)]);
    }
  };

  const library = async (page: Page): Promise<StoredDocument[]> => {
    const documents = await invokeTauriCommand(page, 'library_list', { request: { query: '', status: '' } });
    if (!Array.isArray(documents)) throw new Error('library_list did not answer with a list.');
    return documents as StoredDocument[];
  };

  const stored = async (page: Page, fileName: string) =>
    (await library(page)).find((document) => document.fileName === fileName);

  const brief = (document: StoredDocument | undefined) => document && {
    fileName: document.fileName,
    status: document.status,
    stage: document.stage ?? null,
    captureLinked: Boolean(document.captureId),
    hasRaw: document.hasRaw,
  };

  const rowLocator = (page: Page, view: CapturePage, fileName: string) =>
    page.getByTestId(view === 'history' ? 'history-row' : `${view}-queue-row`).filter({ hasText: fileName });

  const rowView = async (page: Page, view: CapturePage, fileName: string): Promise<RowView> => {
    const row = rowLocator(page, view, fileName);
    return {
      userStatus: await row.getAttribute('data-user-status', { timeout: 2_000 }),
      restart: await row.getByTestId(`${view}-row-restart`).count(),
      cancel: await row.getByTestId(`${view}-row-cancel`).count(),
    };
  };

  const waitForRow = (page: Page, view: CapturePage, fileName: string, userStatus: string, timeoutMs = STEP_TIMEOUT_MS) =>
    waitUntil(
      async () => (await rowView(page, view, fileName)).userStatus === userStatus,
      timeoutMs,
      `The ${view} row of ${fileName} did not show ${userStatus}`,
    );

  const gotoPage = async (page: Page, view: CapturePage) => {
    await page.getByTestId(`nav-${view}`).click();
    await page.getByTestId(`page-${view}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };

  const runtimeReady = (page: Page) => waitUntil(
    async () => (await page.getByTestId('runtime-status').getAttribute('data-state')) === 'ready',
    60_000,
    'The runtime did not report ready',
  );

  const pick = async (page: Page, kind: QueueKind, path: string) => {
    await gotoPage(page, kind);
    const button = page.getByTestId(`${kind}-choose-files`);
    await waitUntil(async () => (await button.isVisible()) && (await button.isEnabled()), STEP_TIMEOUT_MS, `The ${kind} file button was not ready`);
    const pid = appPid();
    await nativeOpenDialogUiAutomation(path, pid, () => nativeClickWebViewElement(button, pid));
  };

  const waitForLink = (page: Page, fileName: string) => waitUntil(
    async () => Boolean((await stored(page, fileName))?.captureId),
    STEP_TIMEOUT_MS,
    `${fileName} got no capture link`,
  );

  /** Records the host commands the page sends from now on. */
  const recordPageCommands = (target: Page): CommandRecorder => {
    const requests: PageRequest[] = [];
    const onRequest = (request: Request) => {
      const command = ipcCommand(request.url());
      if (command !== null) requests.push({ command, body: request.postData() ?? '' });
    };
    target.on('request', onRequest);
    return { commands: () => pageCommandsOf(requests), stop: () => target.off('request', onRequest) };
  };

  /** Starts the row again with the fixture releasing captures, and proves it completes. */
  const startAgain = async (claims: PhaseClaims, page: Page, kind: QueueKind, fileName: string, subject: string) => {
    claims.begin('start-again.completes', subject);
    await controlCaptures({});
    const offset = (await runtimeLog()).length;
    await rowLocator(page, kind, fileName).getByTestId(`${kind}-row-restart`).click();
    await waitForRow(page, kind, fileName, 'done', FINISH_TIMEOUT_MS);
    const requests = (await runtimeLog()).slice(offset);
    const row = await rowView(page, kind, fileName);
    const document = await stored(page, fileName);
    claims.prove(
      'start-again.completes',
      isCompletedCapture(kind, row, document, requests),
      `Row ${row.userStatus}; stored ${JSON.stringify(brief(document))}; ${captureCreates(requests)} capture(s) created.`,
      subject,
    );
    return { row, stored: brief(document), runtimeRequests: describeRequests(captureRequests(requests)) };
  };

  /** Sends the close message and proves the whole app tree ended. */
  const closeApp = async (claims: PhaseClaims, subject: string) => {
    claims.begin('close.tree-observed', subject);
    const pid = appPid();
    const result = parseAppTreeCloseResult(await helper('installed-app-tree.ps1', appTreeCloseArguments({
      appPid: pid,
      runRoot: paths.run,
      webViewDataDirectory: paths.webViewData,
      sampleAfterMs: CLOSE_HELPER_SAMPLES_AFTER_MS,
    })));
    state.lastApp = { pid, createdFileTime: result.appCreatedFileTime };
    const measurements = closeMeasurements(result);
    claims.observe(`${subject}: measurements`, measurements);
    claims.prove(
      'close.tree-observed',
      isTreeObserved(result),
      `Before the message: ${result.beforeClose.map((process) => `${process.name} (${process.reason})`).join(', ')}.`,
      subject,
    );
    const exits = treeExits(result);
    claims.prove(
      'close.tree-exited',
      exits.holds,
      `App root exited after ${displayMs(measurements.appRootExitedAfterCloseMs)} ms; last process after ${displayMs(measurements.lastTreeProcessExitedAfterCloseMs)} ms; ${measurements.processesWithoutHandle} without a handle.`,
      subject,
    );
    claims.prove(
      'close.nothing-left',
      isNothingLeft(result),
      `Processes of the run at each snapshot: ${JSON.stringify(measurements.runProcessesAtSample)}; inventories returned after: ${result.samples.map((sample) => displayMs(sample.completedAfterCloseMs)).join(', ')} ms.`,
      subject,
    );
    await disconnectBrowsers();
  };

  /** Both process inventories and the CDP ports, as one proof; never throws. */
  const proveProcessesStopped = async (
    ownedRoots: () => Observable<unknown>,
  ): Promise<{ proof: ProcessProof; detail: string; processes: AppTreeProcess[] }> => {
    const owned = await attempt(() => firstValueFrom(ownedRoots()));
    const tree = await attempt(async () => (await helper('installed-app-tree.ps1', appTreeInventoryArguments({
      runRoot: paths.run,
      webViewDataDirectory: paths.webViewData,
      app: state.lastApp,
    }))).processes as AppTreeProcess[]);
    const ports: string[] = [];
    for (const port of state.cdpPorts) {
      const released = await attempt(() => firstValueFrom(processCleanup.waitForLoopbackPortRelease(port)));
      if (!released.ok) ports.push(released.error);
    }
    const proof: ProcessProof = {
      ownedRootsEmpty: owned.ok,
      runTreeEmpty: tree.ok && tree.value.length === 0,
      cdpPortsReleased: ports.length === 0,
    };
    return {
      proof,
      processes: tree.ok ? tree.value : [],
      detail: [
        owned.ok ? 'Install and temporary directories: no process.' : `Install and temporary directories: ${owned.error}`,
        tree.ok ? `Processes of the run's tree: ${tree.value.length}.` : `Process tree: ${tree.error}`,
        ports.length === 0 ? 'CDP ports released.' : `CDP ports: ${ports.join('; ')}`,
      ].join(' '),
    };
  };

  // ---------- journeys ----------

  const reloadDuringCapture = async (claims: PhaseClaims, page: Page, kind: QueueKind, key: WindowKey) => {
    const subject = RELOAD_SUBJECTS[key];
    const fileName = key === 'F5' ? 'reload-f5-scan.pdf' : 'reload-ctrl-r-talk.wav';
    const observation: Record<string, unknown> = {};
    claims.observe(subject, observation);

    claims.begin('reload.capture-running', subject);
    await controlCaptures({ holdCaptures: true });
    const path = kind === 'ocr'
      ? await writeSource(fileName, 'pdf', [`${fileName} page one`, `${fileName} page two`])
      : await writeSource(fileName, 'recording', [`${fileName} first words`, `${fileName} second words`]);
    await pick(page, kind, path);
    await waitForRow(page, kind, fileName, 'processing');
    await waitForLink(page, fileName);
    const rowBefore = await rowView(page, kind, fileName);
    const storedBefore = await stored(page, fileName);
    observation.beforeReload = { row: rowBefore, stored: brief(storedBefore) };
    claims.prove(
      'reload.capture-running',
      isRunningWithLink(rowBefore, storedBefore),
      `Row ${rowBefore.userStatus}; stored ${JSON.stringify(brief(storedBefore))}.`,
      subject,
    );

    claims.begin('reload.window-reloaded', subject);
    const offset = (await runtimeLog()).length;
    const recorder = recordPageCommands(page);
    try {
      await page.evaluate((marker) => { (globalThis as Record<string, unknown>)[marker] = true; }, RELOAD_MARKER);
      observation.key = await helper('installed-window-input.ps1', windowKeyArguments(appProcess(), key));
      const reloaded = await waitUntil(
        async () => (await page.evaluate((marker) => (globalThis as Record<string, unknown>)[marker] ?? null, RELOAD_MARKER)) === null,
        10_000,
        'The page kept its marker',
      ).then(() => true, () => false);
      claims.prove('reload.window-reloaded', reloaded, reloaded ? 'The page lost its marker.' : `The page kept its marker for 10 s after ${key}.`, subject);

      claims.begin('reload.row-interrupted', subject);
      await page.getByTestId('nav-ocr').waitFor({ state: 'visible', timeout: 30_000 });
      await runtimeReady(page);
      await gotoPage(page, kind);
      await waitForRow(page, kind, fileName, 'needs-attention');
      await delay(QUIET_WINDOW_MS);
      const row = await rowView(page, kind, fileName);
      const liveCards = kind === 'asr' ? await page.getByTestId('asr-live-card').count() : 0;
      claims.prove(
        'reload.row-interrupted',
        isInterruptedRow(row) && liveCards === 0,
        `Row ${row.userStatus}; Start again ${row.restart}; Cancel ${row.cancel}; live transcripts ${liveCards}.`,
        subject,
      );

      const storedAfter = await stored(page, fileName);
      const sent = recorder.commands();
      const writes = sent.writes;
      observation.afterReload = {
        row,
        stored: brief(storedAfter),
        libraryWrites: writes,
        hostCommands: sent.commands,
      };
      claims.prove(
        'reload.nothing-written',
        storedState(storedBefore) === storedState(storedAfter) && writes.length === 0,
        `Stored ${JSON.stringify(brief(storedAfter))}; ${writes.length} library write(s).`,
        subject,
      );
      const requests = (await runtimeLog()).slice(offset);
      observation.runtimeRequestsAfterReload = describeRequests(captureRequests(requests));
      observation.hostDeletesAfterReload = sent.deletes;
      claims.prove(
        'reload.one-runtime-delete',
        isDeleteOfHeldCapture(requests, storedBefore?.captureId, sent.deletes),
        `Stored link ${storedBefore?.captureId ?? 'none'}; host deletes ${JSON.stringify(sent.deletes)}; capture requests: ${describeRequests(captureRequests(requests)).join('; ') || 'none'}.`,
        subject,
      );
    } finally {
      recorder.stop();
    }
    observation.afterStartAgain = await startAgain(claims, page, kind, fileName, subject);
  };

  const closeDuringCapture = async (claims: PhaseClaims, page: Page) => {
    const subject = CLOSE_SUBJECTS.duringCapture;
    const fileName = 'close-during-scan.pdf';
    const observation: Record<string, unknown> = {};
    claims.observe(subject, observation);

    claims.begin('close.capture-running', subject);
    await controlCaptures({ holdCaptures: true });
    await pick(page, 'ocr', await writeSource(fileName, 'pdf', ['close page one', 'close page two']));
    await waitForRow(page, 'ocr', fileName, 'processing');
    await waitForLink(page, fileName);
    const rowBefore = await rowView(page, 'ocr', fileName);
    const storedBefore = await stored(page, fileName);
    observation.beforeClose = { row: rowBefore, stored: brief(storedBefore) };
    claims.prove(
      'close.capture-running',
      isRunningWithLink(rowBefore, storedBefore),
      `Row ${rowBefore.userStatus}; stored ${JSON.stringify(brief(storedBefore))}.`,
      subject,
    );

    await closeApp(claims, subject);
    const filesAfterExit = await libraryFiles();
    const offset = (await runtimeLog()).length;

    claims.begin('next-start.row-interrupted', subject);
    const launched = await launchApp();
    const nextPage = launched.page;
    try {
      await runtimeReady(nextPage);
      await gotoPage(nextPage, 'ocr');
      await waitForRow(nextPage, 'ocr', fileName, 'needs-attention');
      await delay(QUIET_WINDOW_MS);
      const row = await rowView(nextPage, 'ocr', fileName);
      claims.prove(
        'next-start.row-interrupted',
        isInterruptedRow(row),
        `Row ${row.userStatus}; Start again ${row.restart}; Cancel ${row.cancel}.`,
        subject,
      );
      claims.begin('next-start.nothing-written', subject);
      const changed = changedFiles(filesAfterExit, await libraryFiles());
      const storedAfter = await stored(nextPage, fileName);
      // Recorded from before the page's first script: the stored link's
      // delete and any write the page sent while starting.
      const sent = startupCommands(nextPage);
      const writes = sent.writes;
      observation.afterNextStart = {
        row,
        stored: brief(storedAfter),
        libraryFilesChangedByStart: changed,
        libraryWrites: writes,
        hostCommands: sent.commands,
      };
      claims.prove(
        'next-start.nothing-written',
        changed.length === 0 && writes.length === 0 && storedState(storedBefore) === storedState(storedAfter),
        `${changed.length} library file(s) changed; ${writes.length} library write(s); stored ${JSON.stringify(brief(storedAfter))}.`,
        subject,
      );
      const requests = (await runtimeLog()).slice(offset);
      observation.runtimeRequestsAtNextStart = describeRequests(captureRequests(requests));
      observation.hostDeletesAtNextStart = sent.deletes;
      claims.prove(
        'next-start.stored-link-delete-requested',
        isStoredLinkDeleteRequestedAfterRestart(requests, storedBefore?.captureId, sent.deletes),
        `Stored link ${storedBefore?.captureId ?? 'none'}; host deletes ${JSON.stringify(sent.deletes)}; capture requests: ${describeRequests(captureRequests(requests)).join('; ') || 'none'}.`,
        subject,
      );
    } finally {
      // The startup record is read; the rest of the run records per step.
      closeBrowserRendererBoundary(launched.browser);
    }
    observation.afterStartAgain = await startAgain(claims, nextPage, 'ocr', fileName, subject);
    return nextPage;
  };

  const dropOnPage = async (claims: PhaseClaims, page: Page, view: CapturePage, files: (DroppedFile & { source: () => Promise<string> })[]) => {
    const subject = DROP_SUBJECTS[view];
    const observation: Record<string, unknown> = { files: files.map((file) => file.name) };
    claims.observe(subject, observation);
    const sourcePaths: string[] = [];
    for (const file of files) sourcePaths.push(await file.source());
    await gotoPage(page, view);
    await controlCaptures({ holdCaptures: true });
    const offset = (await runtimeLog()).length;
    const known = new Set((await library(page)).map((document) => document.documentId));
    const recorder = recordPageCommands(page);
    try {
      claims.begin('drop.accepted', subject);
      const app = appProcess();
      await helper('installed-window-input.ps1', windowActivateArguments(app));
      const drop = await helper('installed-window-drop.ps1', windowDropArguments(app, sourcePaths, paths.sources, HELPER_TIMEOUT_MS));
      observation.drop = {
        outcome: drop.outcome, effect: drop.effect, count: drop.count,
        pressed: drop.pressed, released: drop.released, releasedOverApp: drop.releasedOverApp, trace: drop.trace,
      };
      claims.prove(
        'drop.accepted',
        isDropAccepted(drop, files.length),
        `Effect ${String(drop.effect)}; ${String(drop.count)} file(s); released over the app's window: ${String(drop.releasedOverApp)}.`,
        subject,
      );

      claims.begin('drop.imported-in-order', subject);
      let added: StoredDocument[] = [];
      await waitUntil(async () => {
        added = (await library(page)).filter((document) => !known.has(document.documentId));
        return added.length >= files.length;
      }, STEP_TIMEOUT_MS, 'The dropped files were not all imported');
      const imported = importedInDropOrder(added, files);
      observation.importOrder = imported.importOrder;
      claims.prove('drop.imported-in-order', imported.holds, `Import order: ${imported.importOrder.join(', ')}.`, subject);

      claims.begin('drop.one-capture-while-held', subject);
      await waitForLink(page, files[0].name);
      await delay(HELD_QUIET_WINDOW_MS);
      const held = await library(page);
      const rows: RowView[] = [];
      for (const file of files) rows.push(await rowView(page, view, file.name));
      const createdWhileHeld = createdCaptures((await runtimeLog()).slice(offset));
      observation.whileHeld = {
        stored: files.map((file) => brief(held.find((document) => document.fileName === file.name))),
        rows,
        capturesCreated: createdWhileHeld,
      };
      claims.prove(
        'drop.one-capture-while-held',
        isOneCaptureWhileHeld(files, held, rows, createdWhileHeld),
        `Captures created: ${createdWhileHeld.join(', ') || 'none'}; rows ${rows.map((row) => row.userStatus).join(', ')}.`,
        subject,
      );

      claims.begin('drop.one-at-a-time', subject);
      await controlCaptures({});
      await waitUntil(async () => {
        const documents = await library(page);
        return files.every((file) => {
          const status = documents.find((document) => document.fileName === file.name)?.status;
          return status === 'completed' || status === 'awaiting_confirmation' || status === 'failed' || status === 'canceled';
        });
      }, FINISH_TIMEOUT_MS, 'The dropped files did not all finish');
      const ids = files.map((file) => added.find((document) => document.fileName === file.name)?.documentId ?? '');
      const sent = recorder.commands();
      const turns = captureTurns(sent.writes, ids);
      const requests = (await runtimeLog()).slice(offset);
      // Each document's capture, from the link the page wrote, and its turn
      // in the fixture runtime's own log.
      const captureIds = captureOfDocuments(sent.writes, ids);
      const runtimeTurns = runtimeCaptureTurns(requests, captureIds);
      observation.captureTurns = files.map((file, index) => ({
        file: file.name,
        hostWrites: turns.turns[index],
        runtimeRequests: runtimeTurns.turns[index],
      }));
      claims.prove(
        'drop.one-at-a-time',
        turns.holds && runtimeTurns.holds,
        `Write indexes (start, terminal): ${turns.turns.map((turn) => `${turn.startWrite}-${turn.terminalWrite}`).join(', ')}; runtime log indexes (created, outcome read): ${runtimeTurns.turns.map((turn) => `${turn.captureId}:${turn.created}-${turn.finished}`).join(', ')}.`,
        subject,
      );

      const finished = await library(page);
      const finalRows: RowView[] = [];
      for (const file of files) finalRows.push(await rowView(page, view, file.name));
      observation.final = files.map((file) => brief(finished.find((document) => document.fileName === file.name)));
      observation.finalRows = finalRows;
      observation.runtimeRequests = describeRequests(captureRequests(requests));
      claims.prove(
        'drop.all-completed',
        isAllCompleted(files, finished, requests, finalRows, captureIds),
        `Stored ${JSON.stringify(observation.final)}; rows ${finalRows.map((row) => row.userStatus).join(', ')}; ${captureCreates(requests)} capture(s) created.`,
        subject,
      );
    } finally {
      recorder.stop();
    }
  };

  // ---------- phases ----------

  let page: Page | undefined;
  const currentPage = (): Page => {
    if (!page) throw new Error('No page of the installed app is connected.');
    return page;
  };

  const phases: Record<LifecyclePhase, (claims: PhaseClaims) => Promise<void>> = {
    install: async (claims) => {
      claims.begin('install.scoped');
      const { manifest } = await firstValueFrom(assertStagedRuntime('deterministic'));
      state.runtimeVersion = manifest.runtimeVersion;
      state.installer = await firstValueFrom(lifecycle.findExpectedInstaller(manifest.runtimeVersion));
      claims.observe('installer', {
        fileName: state.installer.fileName,
        bytes: state.installer.bytes,
        sha256: state.installer.sha256,
      });
      await firstValueFrom(registry.assertNoPreExistingInstallation());
      // The QA installer would install a missing WebView2 Runtime and leave it behind.
      claims.observe('webViewRuntime', await firstValueFrom(registry.requireWebViewRuntime()));
      await firstValueFrom(processCleanup.stopAndProveResidualProcessRoots([paths.install, paths.appTemporary]));
      // A run tree that is still there was kept by an earlier run for
      // recovery, or belongs to a run that never got to clean up: never reuse
      // or remove it.
      assertNotRedirected(workspaceRoot, paths.run);
      if (await firstValueFrom(pathExists(paths.run))) {
        throw new Error(`A run tree of an earlier run is still there. ${earlierRunTreeRecovery(relativeRun)}`);
      }
      await mkdir(paths.run);
      const runTree = claimOwnedDirectory(paths.run);
      await writeFile(paths.marker, runMarker(runId, process.pid, startedAt), { encoding: 'utf8', flag: 'wx' });
      state.runTree = runTree;
      assertNotRedirected(workspaceRoot, paths.run);
      for (const directory of [paths.install, paths.webViewData, paths.appData, paths.localAppData, paths.appTemporary, paths.library, paths.sources]) {
        await mkdir(directory, { recursive: true });
      }
      processCleanup.registerPrivateProcessRoots([paths.install, paths.appTemporary]);
      state.privateProcessRootsRegistered = true;
      state.realAppDataDirectory = realProductAppDataDirectory();
      state.realAppDataBefore = snapshotRealAppData(state.realAppDataDirectory);
      state.installationAttempted = true;
      const started = Date.now();
      await firstValueFrom(lifecycle.runCheckedExecutable(
        state.installer.path,
        installerArguments(paths.root, paths.install),
        'NSIS installer',
        childEnvironment(process.env, paths.appTemporary),
        installedSmokeExecutableTimeoutMs,
      ));
      await firstValueFrom(assertInstalledIntoOwnedDirectory(lifecycle, registry, paths.install));
      claims.observe('installerRunMs', Date.now() - started);
      claims.prove('install.scoped', true, 'Installed into run/install; the registry points there.');
    },
    launch: async (claims) => {
      claims.begin('launch.connected');
      await writeFile(
        join(paths.appTemporary, 'capture-deterministic-request-log.json'),
        JSON.stringify({ CAPTURE_DETERMINISTIC_REQUEST_LOG: requestLogPath }),
        { encoding: 'utf8', flag: 'wx' },
      );
      const launched = await launchApp();
      // Nothing is claimed about this start's host commands.
      closeBrowserRendererBoundary(launched.browser);
      page = launched.page;
      const owned = await firstValueFrom(processCleanup.processesRunningUnder(paths.install));
      claims.prove('launch.connected', owned.length >= 2, `${owned.length} process(es) run from the install directory.`);
    },
    'first-run': async (claims) => {
      claims.begin('first-run.ready');
      await firstValueFrom(prepareFirstRun(currentPage()));
      claims.observe('documents', (await library(currentPage())).length);
      claims.prove('first-run.ready', true, 'Text recognition and speech recognition report ready.');
    },
    'reload-during-capture': async (claims) => {
      await runtimeReady(currentPage());
      await reloadDuringCapture(claims, currentPage(), 'ocr', 'F5');
      await reloadDuringCapture(claims, currentPage(), 'asr', 'CtrlR');
    },
    'close-during-capture': async (claims) => {
      await runtimeReady(currentPage());
      page = await closeDuringCapture(claims, currentPage());
    },
    'native-drop': async (claims) => {
      await runtimeReady(currentPage());
      const pdf = (name: string, pages: string[]) => ({ name, kind: 'ocr' as const, source: () => writeSource(name, 'pdf', pages) });
      const image = (name: string, text: string) => ({ name, kind: 'ocr' as const, source: () => writeSource(name, 'image', [text]) });
      const recording = (name: string, lines: string[]) => ({ name, kind: 'asr' as const, source: () => writeSource(name, 'recording', lines) });
      await dropOnPage(claims, currentPage(), 'ocr', [
        pdf('drop-a-scan.pdf', ['drop a one', 'drop a two']),
        image('drop-b-photo.png', 'drop b words'),
        pdf('drop-c-scan.pdf', ['drop c one']),
      ]);
      await dropOnPage(claims, currentPage(), 'asr', [
        recording('drop-d-talk.wav', ['drop d one', 'drop d two']),
        recording('drop-e-talk.wav', ['drop e one']),
      ]);
      await dropOnPage(claims, currentPage(), 'history', [
        recording('drop-f-talk.wav', ['drop f one']),
        pdf('drop-g-scan.pdf', ['drop g one']),
      ]);
    },
    close: async (claims) => {
      await closeApp(claims, CLOSE_SUBJECTS.final);
      page = undefined;
    },
    uninstall: async (claims) => {
      claims.observe('installationAttempted', state.installationAttempted);
      if (state.app && state.app.exitCode === null && state.app.signalCode === null) {
        // Only after a failure: the app is still running.
        const terminated = await attempt(() => firstValueFrom(
          processCleanup.terminateTrackedProcessTree(state.app, 'Owned Tauri application'),
        ));
        claims.observe('appTerminatedByCleanup', terminated.ok ? true : terminated.error);
      }
      await disconnectBrowsers();
      page = undefined;

      // Every destructive step below waits for this proof: both inventories
      // (the install and temporary directories, and the app tree with the
      // run's WebView2 processes) and the CDP ports.
      const proofBefore = await proveProcessesStopped(() => state.privateProcessRootsRegistered
        ? processCleanup.stopAndProveOwnedProcessRoots([paths.install, paths.appTemporary])
        : processCleanup.stopAndProveResidualProcessRoots([paths.install, paths.appTemporary]));
      claims.check('uninstall.processes-stopped', processProofHolds(proofBefore.proof), proofBefore.detail);

      let uninstalled = false;
      let proofAfter: ProcessProof | null = null;
      let lastProof = proofBefore;
      let registryClean = false;
      const uninstall = uninstallDecision(state.installationAttempted, proofBefore.proof);
      if (uninstall === 'refused') {
        claims.check('uninstall.uninstalled', false, 'Refused: the processes of the run were not proven stopped, so the installation is kept.');
        claims.check('uninstall.registry-clean', false, 'Kept: the installation was not uninstalled.');
      } else if (uninstall === 'run') {
        const removed = await attempt(() => firstValueFrom(uninstallOwnedInstallation({
          lifecycle,
          registry,
          smokeRoot: paths.root,
          installDirectory: paths.install,
          environment: childEnvironment(process.env, paths.appTemporary),
          timeoutMs: installedSmokeExecutableTimeoutMs,
        })));
        const after = await proveProcessesStopped(() => stopPostUninstallProcessRoots(
          processCleanup, state.privateProcessRootsRegistered, paths.install, paths.appTemporary,
        ));
        proofAfter = after.proof;
        lastProof = after;
        uninstalled = removed.ok && removed.value.uninstallKeyRemoved;
        claims.check(
          'uninstall.uninstalled',
          uninstalled && processProofHolds(proofAfter),
          `${removed.ok
            ? `Uninstall key removed: ${removed.value.uninstallKeyRemoved}; product key kept by the uninstaller: ${removed.value.productKeyRetained}.`
            : removed.error} After the uninstall: ${after.detail}`,
        );
        if (mayRemoveRegistryResidue(uninstalled, proofAfter)) {
          const cleaned = await attempt(async () => {
            await firstValueFrom(registry.removeOwnedRegistryResidue(paths.install));
            await firstValueFrom(registry.assertNoPreExistingInstallation());
          });
          registryClean = cleaned.ok;
          claims.check('uninstall.registry-clean', cleaned.ok, cleaned.ok ? 'No key of the QA build remains.' : cleaned.error);
        } else {
          claims.check('uninstall.registry-clean', false, 'Kept for recovery: the uninstall or the process proof after it failed.');
        }
      }

      let realAppDataUnchanged: boolean | null = null;
      if (state.realAppDataBefore && state.realAppDataDirectory) {
        const directory = state.realAppDataDirectory;
        const before = state.realAppDataBefore;
        const unchanged = await attempt(async () => {
          assertRealAppDataUnchanged(before, snapshotRealAppData(directory), installedAppDataUse('deterministic'));
        });
        realAppDataUnchanged = unchanged.ok;
        claims.check('uninstall.real-app-data-unchanged', unchanged.ok, unchanged.ok ? 'Directory, library and index metadata as before.' : unchanged.error);
      }

      if (state.runTree) {
        const runTree = state.runTree;
        const marker = await readFile(paths.marker, 'utf8').catch(() => null);
        // Decided last, over every check after the uninstall: the tree is
        // the recovery material and the record of what the run wrote.
        const decision = runTreeDecision({
          runTreeCreated: true,
          markerOfThisRun: isMarkerOfRun(marker, runId),
          proofBefore: proofBefore.proof,
          installationAttempted: state.installationAttempted,
          uninstalled,
          proofAfter,
          registryClean,
          realAppDataUnchanged,
        });
        const removed = decision.remove
          ? removeOwnedDirectory(workspaceRoot, paths.root, runTree)
          : { removed: false, detail: decision.reason };
        if (removed.removed) {
          claims.check('uninstall.run-tree-removed', true, removed.detail);
        } else {
          // The steps name exactly what is still there now, and run or
          // delete only what this run verified as its own.
          const keys = state.installationAttempted
            ? await attempt(() => firstValueFrom(registry.productKeysByView(paths.install)))
            : { ok: true, value: [], error: '' };
          state.keptRunTree = true;
          state.recovery = recoverySteps(relativeRun, {
            processes: lastProof.processes.map(({ pid, name }) => ({ pid, name })),
            processProofFailure: processProofHolds(lastProof.proof) ? null : lastProof.detail,
            runTreeOwned: isMarkerOfRun(marker, runId) && isOwnedDirectory(workspaceRoot, paths.root, runTree),
            uninstaller: uninstallerState(workspaceRoot, paths.install),
            registryKeys: keys.ok ? keys.value ?? [] : null,
            productKeys: [uninstallRegistryKey, productRegistryKey],
            realAppDataChanged: realAppDataUnchanged === false,
            removalFailure: decision.remove ? removed.detail : null,
          });
          claims.check('uninstall.run-tree-removed', false, `${removed.detail} Kept ${relativeRun}. ${state.recovery.join(' ')}`);
        }
      }

      // Last: nothing below needs a temporary directory.
      process.env.TEMP = originalTemporary.TEMP;
      process.env.TMP = originalTemporary.TMP;
      // The same removal as the command line's exit hook, with the same checks.
      const temporaryRemoved = removeOwnedDirectory(workspaceRoot, paths.root, checkTemporary);
      claims.check('uninstall.check-temp-removed', temporaryRemoved.removed, temporaryRemoved.detail);
      claims.requireAll();
    },
  };

  await firstValueFrom(lifecycle.prepareSmokeDirectories());
  // Shared with smoke-installed-deterministic in every worktree; held from
  // the install preflight through cleanup.
  const lock = await firstValueFrom(acquireInstalledProductLock(
    deterministicQaProductName,
    'diagnostic-installed-deterministic-capture-lifecycle',
  ));
  try {
    const phaseRecords = await firstValueFrom(runLifecyclePhases((phase, claims) => phases[phase](claims)));
    const finishedAt = new Date().toISOString();
    const evidence = lifecycleEvidence({
      ...revision,
      build: {
        productName: deterministicQaProductName,
        runtimeVersion: state.runtimeVersion ?? 'unknown',
        installer: state.installer
          ? { fileName: state.installer.fileName, bytes: state.installer.bytes, sha256: state.installer.sha256 }
          : null,
      },
      startedAt,
      finishedAt,
      phases: phaseRecords,
      keptRunTree: state.keptRunTree ? relativeRun : null,
      recovery: state.recovery,
    });
    assertLifecycleEvidence(evidence);
    const evidencePath = join(paths.root, `installed-capture-lifecycle-${startedAt.replace(/[:.]/gu, '-')}.json`);
    await firstValueFrom(writeOwnedEvidence(paths.root, evidencePath, evidence));
    return { evidencePath, evidence };
  } finally {
    await firstValueFrom(lock.release());
  }
}
