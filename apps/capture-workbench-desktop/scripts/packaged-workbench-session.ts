// The packaged Capture Workbench as the real-engine journeys on the Desktop
// App drive it (real-desktop-ocr-smoke.ts, real-desktop-asr-journey.ts), and
// as the installed checks reuse parts of it: launching the owned app,
// attaching over CDP, checkpoint screenshots and their masks, History
// deletion, runtime requirement reads, and the teardown that proves the app,
// its runtime, the CDP port and the run's data are gone. The JS side never
// kills a PID: the native host closes its window or terminates its own root,
// and its Windows Job owns the runtime and the engine workers.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, rmdir, stat } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';

import { chromium, type Page } from '@playwright/test';

import type { CaptureAcceptanceScopeOwner } from './acceptance-scope.ts';
import { isPackagedWorkbenchUrl } from './packaged-workbench-page.ts';

export const realDesktopTeardownTimeoutMs = 15_000;
export type DesktopTeardownMode = 'window-close' | 'terminate-process';

export function resolveDesktopTeardownMode(value: string | undefined): DesktopTeardownMode {
  const mode = value?.trim() || 'window-close';
  if (mode === 'window-close' || mode === 'terminate-process') return mode;
  throw new Error('CAPTURE_REAL_DESKTOP_TEARDOWN must be window-close or terminate-process.');
}

export async function requestDesktopTeardown(
  mode: DesktopTeardownMode,
  invoke: (command: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>,
  timeoutMs = realDesktopTeardownTimeoutMs,
): Promise<'requested' | 'connection-closed'> {
  const command = mode === 'window-close'
    ? 'desktop_close_window'
    : 'desktop_acceptance_terminate_root';
  try {
    await withTimeout(
      invoke(command, {}),
      timeoutMs,
      'Native desktop teardown timed out; cleanup is unproven.',
    );
    return 'requested';
  } catch (error) {
    // Terminating the host invalidates the WebView bridge before it can reply.
    // Only that transport boundary is an expected result; native command
    // errors remain failures so cleanup cannot be reported optimistically.
    if (mode === 'terminate-process' && isTauriBridgeClosedError(error)) {
      return 'connection-closed';
    }
    throw error;
  }
}

export type CdpBrowser = Awaited<ReturnType<typeof chromium.connectOverCDP>>;

export interface PackagedPageAcquisitionOptions {
  readonly initialBrowser?: CdpBrowser;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly connect?: (endpoint: string) => Promise<CdpBrowser>;
}

/** What a launch writes to the acceptance checkpoint journal (tools/acceptance-checkpoint-journal.ts). */
export interface LaunchCheckpointJournal {
  begin(stage: 'launch', checkpointId: 'desktop-process'): Promise<void>;
  complete(stage: 'launch', checkpointId: 'desktop-process'): Promise<void>;
  failActive(): Promise<boolean>;
}

export interface OwnedDesktopLaunchOptions {
  readonly spawnChild: () => ReturnType<typeof spawn>;
  readonly onChildSpawned?: (child: ReturnType<typeof spawn>) => void;
  readonly scopeOwner?: Pick<CaptureAcceptanceScopeOwner, 'recordLaunch'>;
  readonly checkpointJournal?: LaunchCheckpointJournal;
  readonly closeOwnedRoot?: (child: ReturnType<typeof spawn>) => Promise<boolean>;
}
export async function establishOwnedDesktopLaunch(
  options: OwnedDesktopLaunchOptions,
): Promise<ReturnType<typeof spawn>> {
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await options.checkpointJournal?.begin('launch', 'desktop-process');
    child = options.spawnChild();
    options.onChildSpawned?.(child);
    await waitForChildSpawn(child);
    if (!Number.isSafeInteger(child.pid) || Number(child.pid) <= 0) throw new Error('Packaged app spawn did not expose a positive PID.');
    await options.scopeOwner?.recordLaunch(child.pid);
    await options.checkpointJournal?.complete('launch', 'desktop-process');
    return child;
  } catch (error) {
    if (child) {
      const closed = await (options.closeOwnedRoot ?? closeOwnedDesktopRoot)(child);
      if (!closed) {
        // Preserve the launch error; the outer finalizer retries the exact root.
      }
    }
    await options.checkpointJournal?.failActive().catch(() => undefined);
    throw error;
  }
}
export async function finalizeDesktopTeardown(
  page: Page | undefined, child: ReturnType<typeof spawn>, mode: DesktopTeardownMode,
  _report: (message: string) => void,
): Promise<void> {
  if (page) {
    try {
      await requestDesktopTeardown(mode, (command, args) => invokeTauriCommand(page, command, args));
    } catch { void _report; /* cleanup flags are projected by the caller after exact-root probing. */ }
  }
  if (!await closeOwnedDesktopRoot(child)) {
    _report('Exact packaged-app root close was not proven; outer cleanup must retry.');
  }
}
function waitForChildSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const spawned = (): void => {
      child.removeListener('error', failed);
      if (!Number.isSafeInteger(child.pid) || Number(child.pid) <= 0) rejectSpawn(new Error('Packaged app spawn did not expose a positive PID.'));
      else resolveSpawn();
    };
    const failed = (error: Error): void => {
      child.removeListener('spawn', spawned);
      rejectSpawn(error);
    };
    child.once('spawn', spawned);
    child.once('error', failed);
  });
}
export async function closeOwnedDesktopRoot(
  child: ReturnType<typeof spawn>,
  timeoutMs = realDesktopTeardownTimeoutMs,
): Promise<boolean> {
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : realDesktopTeardownTimeoutMs;
  return new Promise<boolean>((resolveClose) => {
    let settled = false;
    const timerState: { handle?: ReturnType<typeof setTimeout> } = {};
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      if (timerState.handle !== undefined) clearTimeout(timerState.handle);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      resolveClose(closed);
    };
    const onClose = (): void => finish(true);
    // Close remains the proof event; an error alone never reports success.
    const onError = (): void => undefined;
    child.once('close', onClose);
    child.once('error', onError);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(true);
      return;
    }
    timerState.handle = setTimeout(() => finish(false), boundedTimeoutMs);
    try {
      const requested = child.killed || child.kill();
      if (!requested && (child.exitCode !== null || child.signalCode !== null)) finish(true);
    } catch {
      finish(false);
    }
  });
}

/**
 * Hides private text from every frame while a run records video or takes
 * screenshots: the elements the checkpoint masks cover for privacy (file
 * names, recognized text, transcripts, speaker names and the player).
 */
export async function injectCheckpointPrivacyStyle(page: Page, enabled: boolean): Promise<void> {
  if (!enabled) return;
  await page.addStyleTag({
    content: `
      [data-testid="result-source-pane"] > *,
      [data-testid="result-player"] {
        visibility: hidden !important;
        opacity: 0 !important;
      }
      [data-testid="result-page-text"],
      [data-testid="diagnostics-document-filename"],
      [data-testid="result-detail-filename"],
      [data-testid="result-title"],
      [data-testid="ocr-queue-row"] td:first-child,
      [data-testid="ocr-queue-row"] td:first-child *,
      [data-testid="asr-queue-row"] td:first-child,
      [data-testid="asr-queue-row"] td:first-child *,
      [data-testid="history-row"] td:nth-child(2),
      [data-testid="history-row"] td:nth-child(2) *,
      [data-testid="history-delete-filename"],
      [data-testid="asr-live-card"] h2,
      [data-testid="asr-live-line"],
      [data-testid="asr-live-line"] *,
      [data-testid="result-transcript-table"],
      [data-testid="result-transcript-table"] *,
      [data-testid="result-speaker-name"],
      [data-testid="result-speaker-input"] {
        color: transparent !important;
        text-shadow: none !important;
        caret-color: transparent !important;
      }
    `,
  });
}

/**
 * Saves one checkpoint screenshot, masked, into the run's artifact root and
 * then hands the page to the caller's checkpoint, which may compare it with
 * its approved baseline. Without an artifact root (the local smoke) nothing
 * is taken.
 */
export async function checkpointScreenshot(
  page: Page,
  artifactRoot: string | undefined,
  screenshots: string[],
  name: string,
  checkpoint?: (page: Page, name: string) => Promise<void>,
): Promise<void> {
  if (artifactRoot === undefined) return;
  const file = join(artifactRoot, `${name}.png`);
  await page.screenshot({
    path: file,
    animations: 'disabled',
    fullPage: false,
    mask: checkpointScreenshotMasks(page),
    maskColor: '#000000',
  });
  screenshots.push(file);
  await checkpoint?.(page, name);
}

/**
 * What a checkpoint screenshot must neither show nor compare: private file
 * names, recognized text, transcripts, speaker names and the player, and
 * values that differ between runs or inputs (times, recording durations, the
 * History "updated" column). The OCR and ASR journeys share one list; a mask
 * whose element is absent changes nothing.
 */
export function checkpointScreenshotMasks(page: Page) {
  return [
    page.locator('time'),
    page.locator('.dynamic-id'),
    page.getByTestId('result-title'),
    page.getByTestId('result-detail-filename'),
    page.getByTestId('diagnostics-document-filename'),
    page.locator('[data-testid="ocr-queue-row"] td:first-child'),
    page.locator('[data-testid="history-row"] td:nth-child(2)'),
    page.locator('[data-testid="history-row"] td:nth-child(5)'),
    // Mask privacy-sensitive result panes as whole containers.
    page.getByTestId('result-source-pane'),
    page.getByTestId('result-text-pane'),
    page.locator('[data-testid="asr-queue-row"] td:first-child'),
    page.getByTestId('asr-row-duration'),
    page.locator('[data-testid="asr-live-card"] h2'),
    page.getByTestId('asr-live-heard'),
    page.getByTestId('streaming-partial'),
    page.getByTestId('asr-live-line'),
    page.getByTestId('result-player'),
    page.getByTestId('result-transcript-table'),
    page.getByTestId('result-speaker-name'),
    page.getByTestId('result-speaker-input'),
  ];
}

export async function navigateToHistoryPage(page: Page): Promise<void> {
  if (!(await page.getByTestId('page-history').isVisible().catch(() => false))) {
    await page.getByTestId('nav-history').click();
    await page.getByTestId('page-history').waitFor({ state: 'visible', timeout: 30_000 });
  }
  await waitUntil(
    async () => (
      (await page.getByTestId('history-table').isVisible().catch(() => false))
      || (await page.getByTestId('history-empty').isVisible().catch(() => false))
    ) || undefined,
    15_000,
    'History page did not finish loading documents.',
  );
}

export async function deleteCompletedDocument(
  page: Page,
  fileName: string,
  documentId?: string,
  allowedUserStatuses: readonly string[] = ['done'],
): Promise<boolean> {
  await navigateToHistoryPage(page);
  const exactFileLink = page.locator('td:nth-child(2) a').getByText(fileName, { exact: true });
  const row = documentId !== undefined
    ? page.locator(`[data-testid="history-row"][data-document-id="${documentId}"]`)
    : page.getByTestId('history-row').filter({ has: exactFileLink });
  if ((await row.count()) === 0) return false;
  assert.equal(
    await row.count(),
    1,
    'Standalone desktop cleanup must identify exactly one document.',
  );
  const observedDocumentId = (await row.getAttribute('data-document-id'))?.trim() || undefined;
  if (documentId !== undefined) {
    assert.equal(
      observedDocumentId,
      documentId,
      'Standalone desktop cleanup must verify the exact selected document identity.',
    );
  }
  const targetDocumentId = documentId ?? observedDocumentId;
  if (!targetDocumentId) {
    throw new Error('Standalone desktop cleanup could not determine the target document identity.');
  }
  const selectedFileName = await row.locator('td:nth-child(2) a').textContent();
  assert.ok(
    selectedFileName?.trim() === fileName,
    'Standalone desktop cleanup must verify the exact selected filename.',
  );
  const status = await row.getAttribute('data-user-status');
  if (!allowedUserStatuses.includes(status ?? '')) return false;
  const deleteButton = row.getByTestId('history-row-delete');
  await waitUntil(
    () => deleteButton.isEnabled().then((enabled) => enabled || undefined),
    30_000,
    'Standalone desktop smoke cleanup delete action remained disabled.',
  );
  await deleteButton.click();
  await page.getByTestId('history-delete-dialog').waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByTestId('history-delete-confirm').click();
  await row.waitFor({ state: 'hidden', timeout: 30_000 });
  await waitUntil(
    async () => {
      const result = await invokeTauriCommand(page, 'library_list', { request: { query: '', status: '' } });
      const records = Array.isArray(result) ? result : [];
      const stillPresent = records.some((record) => (
        record !== null
        && typeof record === 'object'
        && !Array.isArray(record)
        && (record as { readonly documentId?: unknown }).documentId === targetDocumentId
      ));
      return !stillPresent || undefined;
    },
    15_000,
    'Standalone desktop cleanup did not remove the document from library_list.',
  );
  return true;
}

/** A document as the host's `library_get` returns it. */
export interface DurableLibraryDetailRecord {
  readonly [key: string]: unknown;
}

export async function readDurableLibraryDetail(
  page: Page,
  documentId: string,
): Promise<DurableLibraryDetailRecord> {
  const detail = await invokeTauriCommand(page, 'library_get', {
    request: { documentId },
  });
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new Error('Packaged durable library detail was invalid.');
  }
  return detail as DurableLibraryDetailRecord;
}

export function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : port ? resolvePort(port) : reject(new Error('A WebView2 CDP port was unavailable.')));
    });
  });
}

export async function waitUntil<T>(check: () => Promise<T | undefined>, timeoutMs: number, message: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probeBudget = Math.min(5_000, Math.max(1, deadline - Date.now()));
    const value = await withTimeout(check(), probeBudget, `${message} (single UI probe timed out)`);
    if (value !== undefined) {
      return value;
    }
    await delay(250);
  }
  throw new Error(message);
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fixes the layout viewport at the size the native window really has.
 * Emulating another size moves the layout but not the window, and a native
 * click mapped from page coordinates then lands beside its target (measured:
 * 1440x900 on the 1280x860 window put the click on the page-number field
 * instead of the file button). Emulating the real size keeps the mapping exact
 * and still gives screenshots at device scale 1 on every display.
 */
export async function pinViewportToWindow(page: Page): Promise<{ readonly width: number; readonly height: number }> {
  const size = await page.evaluate(() => ({
    width: Math.round(window.innerWidth),
    height: Math.round(window.innerHeight),
  }));
  if (!Number.isSafeInteger(size.width) || size.width < 1 || !Number.isSafeInteger(size.height) || size.height < 1) {
    throw new Error('Packaged desktop window reported an invalid viewport size.');
  }
  await page.setViewportSize(size);
  return size;
}

export async function invokeTauriCommand(
  page: Page,
  command: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return page.evaluate(async ({ commandName, commandArgs }) => {
    const internals = (globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: {
        invoke?: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    }).__TAURI_INTERNALS__;
    if (typeof internals?.invoke !== 'function') {
      throw new Error('Packaged Tauri command bridge is unavailable.');
    }
    return internals.invoke(commandName, commandArgs);
  }, { commandName: command, commandArgs: args });
}

export function isTauriBridgeClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:target page|page|browser|websocket|connection|execution context).*(?:closed|destroyed|disconnected)|(?:closed|destroyed|disconnected).*(?:target page|page|browser|websocket|connection|execution context)/iu.test(message);
}

/** Attaches to the packaged app's shell without changing the active route. */
export async function connectToPackagedPage(
  cdpPort: number,
  options: PackagedPageAcquisitionOptions = {},
): Promise<{ browser: CdpBrowser; page: Page }> {
  const attached = await acquirePackagedPage(cdpPort, options);
  await attached.page.getByTestId('app-shell').waitFor({ state: 'attached', timeout: 30_000 });
  return attached;
}

async function acquirePackagedPage(
  cdpPort: number,
  options: PackagedPageAcquisitionOptions,
): Promise<{ browser: CdpBrowser; page: Page }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const connect = options.connect ?? ((endpoint: string) => chromium.connectOverCDP(endpoint, { timeout: 1_500 }));
  let browser = options.initialBrowser;

  while (Date.now() < deadline) {
    if (browser) {
      try {
        const page = findPackagedPage(browser);
        if (page) return { browser, page };
      } catch {
        // A connection can close between the target listing and page lookup.
      }
      await closePackagedBrowser(browser);
      browser = undefined;
    }

    let candidate: CdpBrowser | undefined;
    try {
      candidate = await connect(`http://127.0.0.1:${cdpPort}`);
      const page = findPackagedPage(candidate);
      if (page) return { browser: candidate, page };
    } catch {
      // CDP can be reachable before a page target is published.
    }
    if (candidate) await closePackagedBrowser(candidate);
    browser = undefined;

    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(pollIntervalMs, remaining));
  }

  throw new Error('Standalone desktop application page was unavailable.');
}

function findPackagedPage(browser: CdpBrowser): Page | undefined {
  return browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => isPackagedWorkbenchUrl(candidate.url()));
}

export async function closePackagedBrowser(browser: CdpBrowser): Promise<void> {
  await withTimeout(
    browser.close(),
    2_000,
    'Packaged WebView2 CDP stale connection close timed out.',
  ).catch(() => undefined);
}

export async function reattachToPackagedPage(cdpPort: number): Promise<{ browser: CdpBrowser; page: Page }> {
  return connectToPackagedPage(cdpPort, {
    timeoutMs: 10_000,
  });
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForOwnedTreeGone(observe: () => boolean): Promise<void> {
  // A later inventory after CDP and data cleanup supplies the final verdict.
  await waitUntil(async () => observe() || undefined, 30_000,
    'Owned Capture Workbench process tree did not settle after native teardown.').catch(() => undefined);
}

/** A requirement's status as the host's `runtime_requirements` reports it. */
export async function readRequirementStatus(page: Page, requirementId: string): Promise<string | null> {
  const response = await invokeTauriCommand(page, 'runtime_requirements', {});
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    return null;
  }
  const items = (response as { readonly items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const item = items.find((entry): entry is { readonly requirementId?: unknown; readonly status?: unknown } => (
    entry !== null
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && (entry as { readonly requirementId?: unknown }).requirementId === requirementId
  ));
  return typeof item?.status === 'string' ? item.status : null;
}

export interface RuntimeInstallationSummary {
  readonly status: string;
  readonly errorCode: string | null;
}

/** The newest installation of one requirement and its error code, if any. */
export async function readLatestInstallation(
  page: Page,
  requirementId: string,
): Promise<RuntimeInstallationSummary | undefined> {
  const response = await invokeTauriCommand(page, 'runtime_list_installations', {});
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    return undefined;
  }
  const items = (response as { readonly items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;
  const latest = items.find((item): item is {
    readonly requirementId?: unknown;
    readonly status?: unknown;
    readonly error?: unknown;
  } => (
    item !== null
    && typeof item === 'object'
    && !Array.isArray(item)
    && (item as { readonly requirementId?: unknown }).requirementId === requirementId
  ));
  if (!latest || typeof latest.status !== 'string') return undefined;
  const errorObject = latest.error !== null && typeof latest.error === 'object' && !Array.isArray(latest.error)
    ? latest.error as { readonly code?: unknown }
    : undefined;
  const errorCode = typeof errorObject?.code === 'string' && errorObject.code.trim()
    ? errorObject.code.trim()
    : null;
  return {
    status: latest.status,
    errorCode,
  };
}

/**
 * How long reading a diagnostic text may wait for its element. textContent
 * waits until the element exists, and the journeys run under Playwright Test,
 * which sets no action timeout: an absent element would wait forever.
 */
export const diagnosticsTextTimeoutMs = 1_000;

export async function visibleRuntimeError(page: Page): Promise<string | undefined> {
  try {
    const diagnosticsError = page.getByTestId('diagnostics-runtime-error');
    if (await diagnosticsError.isVisible().catch(() => false)) {
      const message = await diagnosticsError.textContent({ timeout: diagnosticsTextTimeoutMs }).catch(() => undefined);
      return `Capture Workbench runtime entered an error state: ${message?.trim() || 'no detail was rendered.'}`;
    }
    const statusState = await page.getByTestId('runtime-status').getAttribute('data-state').catch(() => undefined);
    if (statusState !== 'error') return undefined;
    await page.getByTestId('runtime-status').click().catch(() => undefined);
    await diagnosticsError.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
    const message = await diagnosticsError.textContent({ timeout: diagnosticsTextTimeoutMs }).catch(() => undefined);
    return `Capture Workbench runtime entered an error state: ${message?.trim() || 'no detail was rendered.'}`;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  // tasklist's localized "no tasks" line is emitted in the host code page,
  // while CSV process rows remain structurally stable. Match the exact PID
  // field instead of decoding or comparing localized text.
  return result.status === 0 && new RegExp(`^"[^"]+","${pid}",`, 'mu').test(String(result.stdout || ''));
}

export interface OwnedChildProcess {
  readonly pid: number;
  readonly name: string;
  readonly commandLine: string;
}

export interface OwnedProcessInventory {
  readonly livePids: readonly number[];
  readonly descendants: readonly OwnedChildProcess[];
}

export function readOwnedProcessInventory(rootPids: readonly number[]): OwnedProcessInventory | undefined {
  if (rootPids.length === 0 || process.platform !== 'win32') return undefined;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$roots = @(${rootPids.join(',')})`,
    '$all = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, Name, CommandLine)',
    'if ($PID -notin $all.ProcessId -or @($all | Where-Object { $null -eq $_.ProcessId -or $null -eq $_.ParentProcessId }).Count -gt 0) { throw "Incomplete process inventory." }',
    '$pending = [System.Collections.Generic.Queue[int]]::new()',
    'foreach ($root in $roots) { $pending.Enqueue($root) }',
    '$found = [System.Collections.Generic.List[object]]::new()',
    '$seen = [System.Collections.Generic.HashSet[int]]::new()',
    'foreach ($root in $roots) { [void]$seen.Add($root) }',
    'while ($pending.Count -gt 0) {',
    '  $parent = $pending.Dequeue()',
    '  foreach ($child in @($all | Where-Object { $_.ParentProcessId -eq $parent })) {',
    '    $childPid = [int]$child.ProcessId',
    '    if ($seen.Add($childPid)) { $found.Add($child); $pending.Enqueue($childPid) }',
    '  }',
    '}',
    '@{ livePids = @($all.ProcessId); descendants = @($found | Select-Object ProcessId, Name, CommandLine) } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ');
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || result.stderr?.trim()) continue;
    try {
      const parsed = JSON.parse(String(result.stdout)) as { livePids?: unknown; descendants?: unknown };
      if (!Array.isArray(parsed?.livePids) || parsed.livePids.length === 0 || !Array.isArray(parsed.descendants)) continue;
      const livePids = parsed.livePids as unknown[];
      if (!livePids.every((pid): pid is number => typeof pid === 'number' && Number.isSafeInteger(pid) && pid >= 0)) continue;
      const live = new Set(livePids);
      if (live.size !== livePids.length) continue;
      const descendants: OwnedChildProcess[] = [];
      for (const record of parsed.descendants as unknown[]) {
        const child = record as { ProcessId?: unknown; Name?: unknown; CommandLine?: unknown } | null;
        const commandLine = child?.CommandLine;
        if (typeof child?.ProcessId !== 'number' || !live.has(child.ProcessId) || typeof child.Name !== 'string'
          || (commandLine !== null && typeof commandLine !== 'string')) break;
        descendants.push({ pid: child.ProcessId, name: child.Name, commandLine: typeof commandLine === 'string' ? commandLine : '' });
      }
      if (descendants.length === parsed.descendants.length) return { livePids, descendants };
    } catch {
      // Try the alternate PowerShell host below.
    }
  }
  return undefined;
}

export function ownedProcessCleanupFailure(
  observedPids: ReadonlySet<number>,
  finalInventory: OwnedProcessInventory | undefined,
  inventoryFailed: boolean,
): string | undefined {
  if (inventoryFailed || !finalInventory || observedPids.size === 0) {
    return 'Owned Capture Workbench process inventory was incomplete.';
  }
  if (finalInventory.descendants.length > 0 || finalInventory.livePids.some((pid) => observedPids.has(pid))) {
    return 'Owned Capture Workbench processes remained after teardown.';
  }
  return undefined;
}

export function isCaptureSidecarProcess(process_: OwnedChildProcess): boolean {
  const name = process_.name.toLowerCase();
  const commandLine = process_.commandLine.toLowerCase();
  return name.includes('capture-runtime') ||
    name === 'ollama.exe' ||
    name === 'ollama_llama_server.exe' ||
    commandLine.includes('capture-runtime');
}

export async function waitForPortClosed(port: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const closed = await new Promise<boolean>((resolveClosed) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolveClosed(false); });
      socket.once('error', () => resolveClosed(true));
      socket.setTimeout(250, () => { socket.destroy(); resolveClosed(true); });
    });
    if (closed) return true;
    await delay(100);
  }
  return false;
}

export async function isLoopbackPortOpen(port: number): Promise<boolean> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return false;
  return await new Promise<boolean>((resolveOpen) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolveOpen(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

/** The local OCR model override never reaches an app unless a run sets it on purpose. */
const localModelEnvironmentKeys = [
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN',
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT',
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256',
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_IDENTITY',
] as const;

export function scrubLocalModelEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const scrubbed = { ...environment };
  for (const key of localModelEnvironmentKeys) delete scrubbed[key];
  return scrubbed;
}

/** The WebView2 arguments that open the CDP endpoint on loopback only. */
export function desktopCdpArguments(cdpPort: number): string {
  return `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort} --remote-allow-origins=*`;
}

/** First attach after launch: waits for WebView2's CDP endpoint, then for the app's page. */
export async function attachToLaunchedDesktop(cdpPort: number): Promise<{ browser: CdpBrowser; page: Page }> {
  const initialBrowser = await waitUntil(
    () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 1_500 }).catch(() => undefined),
    60_000,
    'Standalone desktop WebView2 CDP was not ready.',
  );
  return connectToPackagedPage(cdpPort, {
    initialBrowser,
    timeoutMs: 30_000,
  });
}

/** The runtime sidecar's PID as the acceptance build reports it, when it does. */
export async function readRuntimeSidecarPid(page: Page): Promise<number | undefined> {
  const probe = await invokeTauriCommand(page, 'desktop_acceptance_runtime_process_probe', {});
  if (probe === null || typeof probe !== 'object' || Array.isArray(probe)) return undefined;
  const processId = (probe as { processId?: unknown }).processId;
  return Number.isSafeInteger(processId) && Number(processId) > 0 ? Number(processId) : undefined;
}

/**
 * The run's own data: the packaged app's app data (library and runtime data,
 * engines included) and its local app data (the runtime's engine cache).
 * The root must be short: an engine worker's native libraries load only from
 * paths shorter than Windows MAX_PATH, and the runtime installs a worker's
 * files about 90 characters below the app data directory
 * (`runtime\engines\<requirement>\versions\.<version>.<id>\worker\`), with
 * worker-internal paths of up to about 110 characters.
 */
export interface RunDataRoot {
  readonly root: string;
  readonly appData: string;
  readonly localAppData: string;
}

export const runDataRootMaxCharacters = 40;
const runDirectoryPrefix = 'r';
const runDirectorySuffixLength = 6;

export function requireRunDataParent(value: string | undefined, variable: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${variable} must name a short directory such as C:\\cwr: engine workers load only from paths shorter than Windows MAX_PATH.`);
  }
  return trimmed;
}

/** Creates a privately owned run directory under the configured short parent. */
export async function prepareRunDataRoot(
  value: string | undefined,
  variable: string,
  maxCharacters = runDataRootMaxCharacters,
  createDataDirectory: (path: string) => Promise<void> = mkdir,
): Promise<RunDataRoot> {
  const parent = resolve(requireRunDataParent(value, variable));
  const prefix = join(parent, runDirectoryPrefix);
  if (prefix.length + runDirectorySuffixLength > maxCharacters) {
    throw new Error(
      `${variable} must leave room for a run directory of at most ${maxCharacters} characters: engine workers load only from paths shorter than Windows MAX_PATH.`,
    );
  }
  const firstCreatedParent = await mkdir(parent, { recursive: true });
  let root: string | undefined;
  try {
    root = await mkdtemp(prefix);
    const run = {
      root,
      appData: join(root, 'app-data'),
      localAppData: join(root, 'local-app-data'),
    };
    await createDataDirectory(run.appData);
    await createDataDirectory(run.localAppData);
    return run;
  } catch (error) {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    // Only the parents this call created, deepest first; never one above them.
    for (const directory of createdParents(parent, firstCreatedParent)) {
      if (!(await rmdir(directory).then(() => true, () => false))) break;
    }
    throw error;
  }
}

/**
 * The directories `mkdir(parent, { recursive: true })` created, deepest first,
 * given the first one it reported. On Windows Node reports that one with a
 * `\\?\` prefix, so paths are compared normalized; when the reported one is not
 * an ancestor of `parent`, nothing is claimed.
 */
export function createdParents(parent: string, firstCreated: string | undefined): string[] {
  if (!firstCreated) return [];
  const comparable = (path: string): string => {
    const plain = resolve(
      path.startsWith('\\\\?\\UNC\\') ? `\\\\${path.slice(8)}`
        : path.startsWith('\\\\?\\') ? path.slice(4)
          : path,
    );
    return process.platform === 'win32' ? plain.toLowerCase() : plain;
  };
  const first = comparable(firstCreated);
  const created: string[] = [];
  for (let directory = resolve(parent); ; directory = dirname(directory)) {
    created.push(directory);
    if (comparable(directory) === first) return created;
    if (dirname(directory) === directory) return [];
  }
}

/** The packaged app's environment for a run whose data stays below the run's data root. */
export function runDataEnvironment(run: RunDataRoot): Readonly<Record<string, string>> {
  return {
    APPDATA: run.appData,
    LOCALAPPDATA: run.localAppData,
    CAPTURE_ACCEPTANCE_APP_DATA_ROOT: run.appData,
    // The acceptance build accepts app data only strictly below this root.
    E2E_ARTIFACT_ROOT: run.root,
  };
}

/** Removes the run's data root; true only when nothing of it is left. */
export async function removeRunDataRoot(run: RunDataRoot): Promise<boolean> {
  let removed = true;
  for (const directory of [run.appData, run.localAppData]) {
    await rm(directory, { recursive: true, force: true }).catch(() => {
      removed = false;
    });
  }
  // The root goes only when the run's directories were all it held.
  await rmdir(run.root).catch(() => {
    removed = false;
  });
  const left = await stat(run.root).then(() => true).catch(() => false);
  return removed && !left;
}

export interface OwnedDesktopSessionTeardown {
  readonly page: Page | undefined;
  readonly app: ReturnType<typeof spawn>;
  readonly teardownMode: DesktopTeardownMode;
  readonly runtimeSidecarPid: number | undefined;
  readonly sidecarObserved: boolean;
  readonly earlierInventories?: readonly (OwnedProcessInventory | undefined)[];
  readonly browserClients: readonly CdpBrowser[];
  readonly cdpPort: number;
  readonly webViewData: string;
  readonly workerMirror?: { close(): Promise<void> };
  /** Removes what the run created besides the WebView2 data; false when anything is left. */
  readonly removeRunData: () => Promise<boolean>;
  readonly report: (message: string) => void;
}

export interface OwnedDesktopSessionCleanup {
  /** The app's root process and every process observed below it are gone. */
  readonly app: boolean;
  /** A runtime sidecar was observed and it is gone. */
  readonly sidecar: boolean;
  readonly sidecarObserved: boolean;
  readonly cdpPort: boolean;
  /** The WebView2 data and the run's own data were removed. */
  readonly runData: boolean;
  readonly workerMirrorReleased: boolean;
}

/**
 * Ends an owned packaged-app session and proves what is gone. The native host
 * closes its window (or terminates its root); the JS side never kills a PID,
 * because the runtime and model descendants belong to the native sidecar
 * session and its Job.
 */
export async function finishOwnedDesktopSession(
  options: OwnedDesktopSessionTeardown,
): Promise<OwnedDesktopSessionCleanup> {
  const { app, runtimeSidecarPid } = options;
  const observedPids = new Set<number>();
  if (app.pid !== undefined) observedPids.add(app.pid);
  if (runtimeSidecarPid !== undefined) observedPids.add(runtimeSidecarPid);
  let sidecarObserved = options.sidecarObserved || runtimeSidecarPid !== undefined;
  let inventoryFailed = app.pid === undefined;
  const recordInventory = (inventory: OwnedProcessInventory | undefined): void => {
    if (!inventory) {
      inventoryFailed = true;
      return;
    }
    for (const child of inventory.descendants) {
      observedPids.add(child.pid);
      if (isCaptureSidecarProcess(child)) sidecarObserved = true;
    }
  };
  for (const inventory of options.earlierInventories ?? []) recordInventory(inventory);
  const inventory = (): OwnedProcessInventory | undefined => {
    const snapshot = readOwnedProcessInventory([...observedPids]);
    recordInventory(snapshot);
    return snapshot;
  };
  const processesGone = (): boolean => {
    const snapshot = inventory();
    return ownedProcessCleanupFailure(observedPids, snapshot, false) === undefined;
  };
  inventory();
  await finalizeDesktopTeardown(options.page, app, options.teardownMode, options.report);
  await waitForOwnedTreeGone(processesGone);
  for (const browserClient of [...options.browserClients].reverse()) {
    await withTimeout(browserClient.close(), 5_000, 'Playwright CDP disconnect timed out.').catch(() => undefined);
  }
  // WebView2 can keep the packaged host alive until the CDP transport has
  // detached. Wait for the native close/Job transition once more before
  // taking final liveness evidence; there is deliberately no JS PID kill
  // fallback when that proof cannot be obtained.
  await waitForOwnedTreeGone(processesGone);
  let workerMirrorReleased = options.workerMirror === undefined;
  if (options.workerMirror) {
    try {
      await options.workerMirror.close();
      workerMirrorReleased = true;
    } catch { /* cleanup is represented by the returned flag. */ }
  }
  const cdpPort = await waitForPortClosed(options.cdpPort);
  let runData = true;
  await rm(options.webViewData, { recursive: true, force: true }).catch(() => {
    runData = false;
  });
  if (!(await options.removeRunData())) runData = false;
  // Windows can finish the native Job transition while the final artifact
  // cleanup is still running. Take one final inventory at this point so the
  // evidence describes the final state.
  await delay(250);
  const finalInventory = inventory();
  const processFailure = ownedProcessCleanupFailure(observedPids, finalInventory, inventoryFailed);
  if (processFailure) options.report(processFailure);
  return {
    app: processFailure === undefined,
    sidecar: sidecarObserved && processFailure === undefined,
    sidecarObserved,
    cdpPort,
    runData,
    workerMirrorReleased,
  };
}
