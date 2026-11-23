/**
 * Stage 08-capture-lifecycle of the real-engine execution journey: the rules
 * of .agents/DECISIONS/workbench-capture-ownership.md with the product runtime
 * and real engines, where the dev-host journeys
 * (capture-lifecycle.dev-host.spec.ts) use the fixture runtime.
 *
 * With the short recording and the PDF it proves:
 *   - one capture at a time: imported together, one runs and the other waits;
 *     each start comes after the predecessor's outcome was stored, and after
 *     its row showed that outcome whenever the page showed the row;
 *   - a reload while a real recording runs leaves its row 已中斷 with
 *     重新開始, deletes the earlier page's capture once at the runtime, and
 *     重新開始 captures the recording again;
 *   - Cancel of a running real recording shows 取消中 while the runtime's
 *     delete is pending, then 已取消; from the Cancel on, the page sends that
 *     delete and no other command for the capture; the row is stored
 *     cancelled without link or raw text, the runtime no longer has the
 *     capture, and the waiting document starts;
 *   - every capture that ends is stored as the checkpoint rule says.
 * The PDF holds its raw text after its first capture and is never captured in
 * place again, so the waiting document behind the cancelled recording is the
 * PDF imported once more. How long a PDF runs is not assumed: a Start again
 * behind a running PDF is given at once and may find the PDF already ended;
 * the command log proves the order either way. The journey's own reads go to
 * the host directly (`page.request`), so the recorded page commands are only
 * the page's. Recorded rows carry their document ID, status and flags, never
 * their text.
 *
 * At its end, also when it failed, the stage removes every document it
 * imported the way a user ends them (removeDocumentsAsUser): what still runs
 * or waits is cancelled, then everything is deleted in History. The journey
 * removes the same way what an earlier run left waiting or in progress
 * (removeUnfinishedDocuments) before its first capture.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { expect, type Frame, type Locator, type Page, type Request } from '@playwright/test';
import {
  cancellingWhileDeletePendingProblem,
  capturesCreatedFor,
  commandsNamingCapture,
  libraryWriteOf,
  predecessorShownAtStart,
  terminalWritesOf,
  turnProblem,
  type CancelTiming,
  type CaptureWindow,
  type PageCommandRecord,
  type RowChangeRecord,
  type ShownRowRecord,
  type Turn,
} from './real-engines-lifecycle-observation.ts';
import type {
  DesktopLibraryDetailRecord,
  DesktopLibrarySummaryRecord,
  ProvenanceSummary,
} from './real-engines-journey.ts';

const previewHeaders = { 'x-capture-preview': '1' };
/** The request header that carries the rows the page showed when it sent a host command. */
const shownRowsHeader = 'x-journey-shown-rows';
const rowChangedBinding = '__journeyRowChanged';
/** A UI change that follows a stored state or a page load. */
const SETTLE_TIMEOUT_MS = 30_000;
/** From an import or a Start again to the capture's link at the runtime. */
const START_TIMEOUT_MS = 2 * 60_000;
/** From a capture's link to its engine worker at work. */
const WORKER_AT_WORK_TIMEOUT_MS = 5 * 60_000;
/**
 * When a speech worker counts as at work on its device rather than starting
 * (the runtime reports no progress of a recording before its transcription
 * ends). With the cuda pack: the worker holds this much dedicated GPU memory
 * (its model is on the GPU; measured 1.5 to 4.6 GB while transcribing, none
 * while it loads on the CPU for its first 10 to 15 CPU seconds).
 */
const WORKER_AT_WORK_GPU_MEMORY_MIB = 1024;
/**
 * With the cpu pack: the worker has used this much CPU time. On the machine
 * these numbers were measured on, a worker spends its first 10 to 15 CPU
 * seconds loading its model, so 12 CPU seconds cannot be told from model
 * loading there: a cpu-pack run may reload or cancel a worker that is still
 * loading, and then does not prove that it interrupted transcription. No
 * cpu-pack run has calibrated this. The evidence records which criterion a
 * run used (`workerAtWorkCriterion`).
 */
const WORKER_AT_WORK_CPU_SECONDS = 12;
/** From the runtime's answer to a delete to the capture's worker process ending. */
const WORKER_STOP_TIMEOUT_MS = 30_000;
/** One worker query that fails is asked again at once, this many times in all, each failure logged. */
const WORKER_QUERY_ATTEMPTS = 3;
/** The host bounds the runtime delete; the row shows 已取消 after it answers. */
const CANCEL_TIMEOUT_MS = 2 * 60_000;
const ACTION_TIMEOUT_MS = 15_000;

export interface CaptureLifecycleInput {
  readonly baseUrl: string;
  /** The app data the runtime runs on; its engine workers run from `runtime/engines`. */
  readonly appDataDir: string;
  /** The installed speech pack transcribes on the GPU (`cuda`), not on the CPU. */
  readonly speechOnGpu: boolean;
  readonly pdfPath: string;
  readonly audioPath: string;
  readonly documentTimeoutMs: number;
  readonly recordingTimeoutMs: number;
  readonly waitForRuntimeReady: (page: Page) => Promise<void>;
  readonly log: (event: string) => void;
  readonly recordWindow: (window: CaptureWindow) => void;
  /** The checkpoint rule for a stored document; returns its recognition provenance. */
  readonly checkStoredDocument: (detail: DesktopLibraryDetailRecord, label: string) => ProvenanceSummary;
  /** The completed recording; returns its recognition and structuring provenance. */
  readonly checkStoredRecording: (detail: DesktopLibraryDetailRecord) => {
    readonly extraction: ProvenanceSummary;
    readonly structuring: ProvenanceSummary;
  };
}

/** The speech worker processes of the app data: how many, their CPU seconds and their dedicated GPU memory. */
interface WorkerUse {
  readonly processes: number;
  readonly cpuSeconds: number;
  readonly gpuMemoryMiB: number;
}

/** A worker query's answer: the use, and which processes it was (to see those, and only those, end). */
interface WorkerSample extends WorkerUse {
  readonly processIds: readonly number[];
}

/** What made the stage count a speech worker as at work. */
interface WorkerAtWorkCriterion {
  readonly measure: 'dedicated-gpu-memory' | 'cpu-time';
  readonly minimum: number;
  readonly unit: 'MiB' | 's';
}

/** What a Start again behind a running document found: the restarted row waited, or the document had already ended. */
type StartAgainBehindRunning = 'waited' | 'document-ended-first';

/** Documents removed the way a user ends them. */
export interface RemovedDocuments {
  /** Waiting or running documents cancelled first. */
  readonly cancelled: number;
  readonly deleted: number;
}

/** Digest-only evidence of the stage: counts, statuses, durations and provenance. */
export interface CaptureLifecycleEvidence {
  readonly workerAtWorkCriterion: WorkerAtWorkCriterion;
  /** Times the stage saw one capture run while another document waited, stored queued without link. */
  readonly waitingWhileRunning: number;
  /** Each Start again given behind a running PDF, in order. */
  readonly startAgainBehindRunning: readonly StartAgainBehindRunning[];
  /** Starts that came after the predecessor's outcome was stored. */
  readonly turnsAfterOutcome: number;
  /** Of those, the starts sent while the page showed the predecessor's row with its outcome. */
  readonly turnsWithOutcomeShown: number;
  readonly reload: {
    readonly interruptedShown: boolean;
    readonly restartOffered: boolean;
    readonly runtimeDeletes: number;
    readonly runtimeDeleteMs: number;
    readonly otherCommandsForCapture: number;
    /** The one delete the Start again sends for the capture the old link names. */
    readonly startAgainDeletes: number;
    /** The recording's speech worker when the reload was sent. */
    readonly workerAtReload: WorkerUse;
    /** From the runtime's answer to the delete until that worker's process was seen ended. */
    readonly workerStoppedMsAfterDelete: number;
    readonly storedLinkKept: boolean;
    readonly runtimeGone: boolean;
  };
  readonly cancel: {
    /** The recording's speech worker when Cancel was clicked. */
    readonly workerAtCancel: WorkerUse;
    /** From the runtime's answer to the delete until that worker's process was seen ended. */
    readonly workerStoppedMsAfterDelete: number;
    readonly cancellingShownWhileDeletePending: boolean;
    readonly cancelledShownAfterDelete: boolean;
    readonly runtimeDeletes: number;
    /** Page commands other than its one delete that named the capture from the Cancel on. */
    readonly otherCommandsForCapture: number;
    readonly runtimeDeleteMs: number;
    /** The tolerance the 取消中/已取消 checks allowed between the page's clock and Node's. */
    readonly clockToleranceMs: number;
    readonly terminalWrites: number;
    readonly storedStatus: string;
    readonly storedLinked: boolean;
    readonly storedHasRaw: boolean;
    readonly runtimeGone: boolean;
    readonly nextStartedAfterOutcome: boolean;
  };
  readonly outcomes: readonly {
    readonly label: string;
    readonly status: string;
    readonly stage: string | null;
    readonly linked: boolean;
    readonly hasRaw: boolean;
    readonly ocrEvidenceStatus: string | null;
    readonly runtimeGone: boolean;
    readonly extraction: ProvenanceSummary;
    readonly structuring?: ProvenanceSummary;
  }[];
  /** The stage's documents, removed at its end. */
  readonly removed: RemovedDocuments;
}

interface StoredState {
  readonly status: string | undefined;
  readonly captureId: string | null;
  readonly hasRaw: boolean;
}

/** The page's host commands with their timing, its row changes and its main-frame navigations. */
interface PageObservation {
  readonly commands: PageCommandRecord[];
  readonly changes: RowChangeRecord[];
  /** `commands.length` at each main-frame navigation. */
  readonly navigations: number[];
  stop(): void;
}

type QueueRowKind = 'ocr-queue-row' | 'asr-queue-row' | 'history-row';

/** The host's commands as the journey sends them itself (not as the page's commands). */
interface Host {
  invoke<T>(command: string, args: object): Promise<T>;
  documents(): Promise<readonly DesktopLibrarySummaryRecord[]>;
  detail(documentId: string): Promise<DesktopLibraryDetailRecord>;
}

function hostOf(page: Page, baseUrl: string): Host {
  const invoke = async <T>(command: string, args: object): Promise<T> => {
    const response = await page.request.post(`${baseUrl}/__host/invoke/${command}`, {
      headers: previewHeaders,
      data: args,
    });
    const text = await response.text();
    if (response.ok()) return (text.length > 0 ? JSON.parse(text) : null) as T;
    let message = text;
    try {
      const parsed = JSON.parse(text) as { readonly error?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // The host answered with plain text.
    }
    throw new Error(message);
  };
  return {
    invoke,
    documents: () => invoke('library_list', { request: { query: '', status: '' } }),
    detail: (documentId) => invoke('library_get', { request: { documentId } }),
  };
}

function rowOf(page: Page, kind: QueueRowKind, documentId: string): Locator {
  return page.locator(`[data-testid="${kind}"][data-document-id="${documentId}"]`);
}

/** Moves to a page through the Workbench's own navigation, as a user does: no page load. */
async function navigateTo(page: Page, to: 'ocr' | 'asr' | 'history'): Promise<void> {
  await page.getByTestId(`nav-${to}`).click({ timeout: ACTION_TIMEOUT_MS });
}

function firstLineOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split(/\r?\n/u)[0] ?? '';
}

/**
 * Removes the documents from the library the way a user ends them. On their
 * queue page every one still waiting is cancelled first (so that no other of
 * them starts), then the one running; a row interrupted by an earlier page
 * (已中斷) has no Cancel and stays as it is. Then each is deleted in History
 * (Delete, then the dialog's confirm). Documents no longer in the library
 * are skipped. A page that is not the Workbench's is loaded again first.
 */
export async function removeDocumentsAsUser(
  page: Page,
  input: {
    readonly baseUrl: string;
    readonly documentIds: readonly string[];
    readonly waitForRuntimeReady: (page: Page) => Promise<void>;
  },
): Promise<RemovedDocuments> {
  const host = hostOf(page, input.baseUrl);
  const wanted = new Set(input.documentIds);
  const present = async (): Promise<readonly DesktopLibrarySummaryRecord[]> =>
    (await host.documents()).filter((document) => wanted.has(document.documentId));
  const documents = await present();
  if (documents.length === 0) return { cancelled: 0, deleted: 0 };
  assert.ok(!page.isClosed(), 'The page is closed: its documents cannot be removed as a user would.');
  if (!page.url().startsWith(input.baseUrl)) await page.goto(`${input.baseUrl}/history`);
  await input.waitForRuntimeReady(page);

  let cancelled = 0;
  for (const phase of ['waiting', 'processing'] as const) {
    for (const document of documents) {
      const kind = document.mediaType.startsWith('audio/') ? 'asr' : 'ocr';
      await navigateTo(page, kind);
      const queueRow = rowOf(page, `${kind}-queue-row`, document.documentId);
      await expect(queueRow).toHaveCount(1, { timeout: SETTLE_TIMEOUT_MS });
      if ((await queueRow.getAttribute('data-user-status')) !== phase) continue;
      const cancel = queueRow.getByTestId(`${kind}-row-cancel`);
      // A row whose Cancel is already being applied (取消中) is only waited for.
      if ((await cancel.count()) > 0 && (await cancel.isEnabled())) {
        await cancel.click({ timeout: ACTION_TIMEOUT_MS });
        cancelled += 1;
      }
      await expect(queueRow).not.toHaveAttribute('data-user-status', /^(?:waiting|processing)$/u, {
        timeout: CANCEL_TIMEOUT_MS,
      });
    }
  }

  await navigateTo(page, 'history');
  let deleted = 0;
  for (const document of await present()) {
    const historyRow = rowOf(page, 'history-row', document.documentId);
    const remove = historyRow.getByTestId('history-row-delete');
    await expect(remove).toBeEnabled({ timeout: SETTLE_TIMEOUT_MS });
    await remove.click({ timeout: ACTION_TIMEOUT_MS });
    const dialog = page.getByTestId('history-delete-dialog');
    await expect(dialog).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await page.getByTestId('history-delete-confirm').click({ timeout: ACTION_TIMEOUT_MS });
    await expect(dialog).toHaveCount(0, { timeout: SETTLE_TIMEOUT_MS });
    await expect(historyRow).toHaveCount(0, { timeout: SETTLE_TIMEOUT_MS });
    deleted += 1;
  }
  const left = await present();
  assert.equal(left.length, 0, `${left.length} of the documents to remove are still in the library.`);
  return { cancelled, deleted };
}

/**
 * Removes, the way a user ends them, the documents an earlier run left
 * stored waiting (`queued`) or in progress (`processing`): no capture of this
 * app run exists yet, so each is a leftover, typically of a stage 08 that
 * failed. A waiting one starts when the app loads and would run beside this
 * run's first captures; an interrupted one keeps a link that the app deletes
 * at every load.
 */
export async function removeUnfinishedDocuments(
  page: Page,
  input: { readonly baseUrl: string; readonly waitForRuntimeReady: (page: Page) => Promise<void> },
): Promise<RemovedDocuments & { readonly found: number }> {
  const unfinished = (await hostOf(page, input.baseUrl).documents())
    .filter((document) => document.status === 'queued' || document.status === 'processing')
    .map((document) => document.documentId);
  const removed = await removeDocumentsAsUser(page, { ...input, documentIds: unfinished });
  return { found: unfinished.length, ...removed };
}

/** In the page: every queue and History row, without its text; and every change of them. */
function observeRowsInPage({ header, binding }: { readonly header: string; readonly binding: string }): void {
  const rowKinds = ['ocr-queue-row', 'asr-queue-row', 'history-row'];
  const read = () => [...document.querySelectorAll('[data-document-id][data-user-status]')]
    .filter((row) => rowKinds.includes(row.getAttribute('data-testid') ?? ''))
    .map((row) => {
      const text = row.textContent ?? '';
      return {
        documentId: row.getAttribute('data-document-id') ?? '',
        row: row.getAttribute('data-testid') ?? '',
        status: row.getAttribute('data-user-status') ?? '',
        cancelling: text.includes('取消中'),
        interrupted: text.includes('已中斷'),
        cancelled: text.includes('已取消'),
        restart: row.querySelector('[data-testid$="-row-restart"]') !== null,
      };
    });
  const send = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/__host/invoke/')) return send(input, init);
    const headers = new Headers(init?.headers);
    headers.set(header, encodeURIComponent(JSON.stringify(read())));
    return send(input, { ...init, headers });
  };
  const last = new Map<string, string>();
  const report = (): void => {
    const changed = (globalThis as unknown as Record<string, ((change: unknown) => void) | undefined>)[binding];
    for (const row of read()) {
      const key = JSON.stringify(row);
      const id = `${row.row}:${row.documentId}`;
      if (last.get(id) === key) continue;
      last.set(id, key);
      changed?.({ ...row, at: Date.now() });
    }
  };
  const start = (): void => {
    new MutationObserver(report).observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    report();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

const runFile = promisify(execFile);

/**
 * One query of the speech-recognition worker processes the runtime runs from
 * this app data: their process IDs, the CPU seconds they have used and the
 * dedicated GPU memory they hold (Windows' GPU process memory counters). Any
 * WMI error fails the query, and so does an empty counter list when GPU
 * memory is the measure: neither may read as 0 MiB. Only numbers leave it.
 */
async function querySpeechWorkers(root: string, requireGpuCounters: boolean): Promise<WorkerSample> {
  const script = [
    "$ErrorActionPreference = 'Stop';",
    '$root = $env:CAPTURE_JOURNEY_WORKER_ROOT;',
    // The error's ID is ASCII; its message is in the console's code page.
    'try {',
    '$workers = @(Get-CimInstance Win32_Process -Property ProcessId, ExecutablePath, KernelModeTime, UserModeTime',
    '| Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) });',
    '$memory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -Property Name, DedicatedUsage);',
    '} catch { [Console]::Error.WriteLine("WMI query failed: $($_.FullyQualifiedErrorId)"); exit 2 }',
    "if ($env:CAPTURE_JOURNEY_REQUIRE_GPU_COUNTERS -eq '1' -and $memory.Count -eq 0) {",
    "[Console]::Error.WriteLine('Windows reported no GPU process memory counters.'); exit 3 }",
    'foreach ($worker in $workers) {',
    '$prefix = "pid_$($worker.ProcessId)_";',
    '$bytes = 0.0; foreach ($entry in $memory) { if ($entry.Name.StartsWith($prefix)) { $bytes += [double]$entry.DedicatedUsage } }',
    '"$($worker.ProcessId),$(([double]$worker.KernelModeTime + [double]$worker.UserModeTime) / 10000000),$bytes" }',
  ].join(' ');
  let stdout: string;
  try {
    ({ stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAPTURE_JOURNEY_WORKER_ROOT: root,
        CAPTURE_JOURNEY_REQUIRE_GPU_COUNTERS: requireGpuCounters ? '1' : '0',
      },
      timeout: ACTION_TIMEOUT_MS,
      windowsHide: true,
    }));
  } catch (error) {
    const { code, stderr } = error as { readonly code?: unknown; readonly stderr?: unknown };
    const reason = typeof stderr === 'string' && stderr.trim().length > 0 ? firstLineOf(stderr.trim()) : firstLineOf(error);
    throw new Error(`The worker process list could not be read (exit ${String(code)}): ${reason}`);
  }
  const rows = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    .map((line) => line.split(',').map(Number));
  assert.ok(rows.every((row) => row.length === 3 && row.every(Number.isFinite)), 'The worker process list was not understood.');
  return {
    processIds: rows.map((row) => row[0] ?? 0),
    processes: rows.length,
    cpuSeconds: Math.round(rows.reduce((total, row) => total + (row[1] ?? 0), 0) * 10) / 10,
    gpuMemoryMiB: Math.round(rows.reduce((total, row) => total + (row[2] ?? 0), 0) / 1_048_576),
  };
}

function workerUseOf(sample: WorkerSample): WorkerUse {
  return { processes: sample.processes, cpuSeconds: sample.cpuSeconds, gpuMemoryMiB: sample.gpuMemoryMiB };
}

/** Starts `work` now; the returned function waits for it and then throws its failure, if any. */
function startedNow<T>(work: Promise<T>): () => Promise<T> {
  const settled = work.then((value) => ({ value }), (error: unknown) => ({ error }));
  return async () => {
    const result = await settled;
    if ('error' in result) throw result.error;
    return result.value;
  };
}

/**
 * The page's clock against Node's, read just before a Cancel (see PageClock):
 * the page reading is also the Cancel's time on the page clock. The shortest
 * of three readings is kept.
 */
async function readCancelTiming(page: Page): Promise<CancelTiming> {
  let best: { readonly pageNow: number; readonly before: number; readonly after: number } | undefined;
  for (let reading = 0; reading < 3; reading += 1) {
    const before = Date.now();
    const pageNow = await page.evaluate(() => Date.now());
    const after = Date.now();
    if (!best || after - before < best.after - best.before) best = { pageNow, before, after };
  }
  assert.ok(best);
  return {
    cancelAt: best.pageNow,
    clock: { offsetMs: best.pageNow - (best.before + best.after) / 2, toleranceMs: best.after - best.before },
  };
}

function pageCommandOf(request: Request): PageCommandRecord | undefined {
  const path = new URL(request.url()).pathname;
  const prefix = '/__host/invoke/';
  if (!path.startsWith(prefix)) return undefined;
  const command = decodeURIComponent(path.slice(prefix.length));
  let body: unknown;
  try {
    body = request.postDataJSON();
  } catch {
    body = undefined;
  }
  const fields = (body ?? {}) as {
    readonly input?: { readonly id?: unknown; readonly documentId?: unknown };
    readonly request?: { readonly documentId?: unknown };
  };
  const captureId = typeof fields.input?.id === 'string' ? fields.input.id : undefined;
  const named = fields.input?.documentId ?? fields.request?.documentId;
  const write = command === 'library_update_capture' ? libraryWriteOf(body) : undefined;
  const shown = request.headers()[shownRowsHeader];
  return {
    command,
    sentAt: Date.now(),
    ...(captureId ? { captureId } : {}),
    ...(typeof named === 'string' ? { documentId: named } : {}),
    ...(write ? { write } : {}),
    ...(shown ? { shown: JSON.parse(decodeURIComponent(shown)) as readonly ShownRowRecord[] } : {}),
  };
}

async function observePage(page: Page): Promise<PageObservation> {
  const commands: PageCommandRecord[] = [];
  const changes: RowChangeRecord[] = [];
  const navigations: number[] = [];
  const pending = new Map<Request, PageCommandRecord>();
  await page.exposeFunction(rowChangedBinding, (change: RowChangeRecord) => {
    changes.push(change);
  });
  await page.addInitScript(observeRowsInPage, { header: shownRowsHeader, binding: rowChangedBinding });
  const onRequest = (request: Request): void => {
    const command = pageCommandOf(request);
    if (!command) return;
    commands.push(command);
    pending.set(request, command);
  };
  const onFinished = (request: Request): void => {
    const command = pending.get(request);
    if (!command) return;
    command.answeredAt = Date.now();
    pending.delete(request);
  };
  const onFailed = (request: Request): void => {
    const command = pending.get(request);
    if (!command) return;
    command.failedAt = Date.now();
    pending.delete(request);
  };
  const onNavigated = (frame: Frame): void => {
    if (frame === page.mainFrame()) navigations.push(commands.length);
  };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  page.on('framenavigated', onNavigated);
  return {
    commands,
    changes,
    navigations,
    stop: () => {
      page.off('request', onRequest);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
      page.off('framenavigated', onNavigated);
    },
  };
}

/**
 * Runs the stage, then removes every document it imported (those the library
 * did not hold when it began), also when it failed midway. A removal that
 * fails after the stage failed is logged and the stage's own error is thrown;
 * after a stage that passed, it fails the stage.
 */
export async function checkCaptureLifecycle(
  page: Page,
  input: CaptureLifecycleInput,
): Promise<CaptureLifecycleEvidence> {
  const host = hostOf(page, input.baseUrl);
  const known = new Set((await host.documents()).map((item) => item.documentId));
  let outcome: { readonly evidence: Omit<CaptureLifecycleEvidence, 'removed'> } | { readonly error: unknown };
  try {
    outcome = { evidence: await runCaptureLifecycle(page, input, host, known) };
  } catch (error) {
    outcome = { error };
  }
  let removed: RemovedDocuments;
  try {
    const imported = (await host.documents()).map((item) => item.documentId).filter((documentId) => !known.has(documentId));
    removed = await removeDocumentsAsUser(page, {
      baseUrl: input.baseUrl,
      documentIds: imported,
      waitForRuntimeReady: input.waitForRuntimeReady,
    });
    input.log(`removed its ${removed.deleted} documents, ${removed.cancelled} of them cancelled first`);
  } catch (removalError) {
    if ('error' in outcome) {
      input.log(`could not remove its documents after it failed: ${firstLineOf(removalError)}`);
      throw outcome.error;
    }
    throw removalError;
  }
  if ('error' in outcome) throw outcome.error;
  return { ...outcome.evidence, removed };
}

async function runCaptureLifecycle(
  page: Page,
  input: CaptureLifecycleInput,
  host: Host,
  known: ReadonlySet<string>,
): Promise<Omit<CaptureLifecycleEvidence, 'removed'>> {
  const { baseUrl, log } = input;
  const { documents, detail } = host;
  const stored = async (documentId: string): Promise<StoredState> => stateIn(await documents(), documentId);
  const waiting: StoredState = { status: 'queued', captureId: null, hasRaw: false };
  /** The runtime's status of the capture, or `gone` when it answers that it has no such capture. */
  const runtimeCapture = async (captureId: string): Promise<{ readonly status: string; readonly progress: number }> => {
    try {
      const operation = await host.invoke<{ readonly status: string; readonly progress?: number | null }>(
        'runtime_get_capture', { input: { id: captureId } },
      );
      return { status: operation.status, progress: operation.progress ?? 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b404\b|not found/iu.test(message)) return { status: 'gone', progress: 0 };
      throw error;
    }
  };
  const runtimeGone = async (captureId: string): Promise<boolean> => {
    await expect.poll(async () => (await runtimeCapture(captureId)).status, {
      timeout: SETTLE_TIMEOUT_MS, intervals: [500],
    }).toBe('gone');
    return true;
  };
  const workerRoot = `${join(input.appDataDir, 'runtime', 'engines', 'speech-recognition')}\\`;
  /** The speech workers now; a failed query is logged and asked again, and fails the stage after WORKER_QUERY_ATTEMPTS. */
  const speechWorkers = async (): Promise<WorkerSample> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await querySpeechWorkers(workerRoot, input.speechOnGpu);
      } catch (error) {
        if (attempt >= WORKER_QUERY_ATTEMPTS) throw error;
        log(`worker query ${attempt} of ${WORKER_QUERY_ATTEMPTS} failed, asked again: ${firstLineOf(error)}`);
      }
    }
  };
  const workerAtWorkCriterion: WorkerAtWorkCriterion = input.speechOnGpu
    ? { measure: 'dedicated-gpu-memory', minimum: WORKER_AT_WORK_GPU_MEMORY_MIB, unit: 'MiB' }
    : { measure: 'cpu-time', minimum: WORKER_AT_WORK_CPU_SECONDS, unit: 's' };
  /**
   * Waits until the capture is extracting and its speech worker is at work on
   * its device (workerAtWorkCriterion); a capture that ended or moved on first
   * fails the stage. Returns the workers at that moment.
   */
  const untilWorkerWorks = async (captureId: string, label: string): Promise<WorkerSample> => {
    let sample: WorkerSample = { processIds: [], processes: 0, cpuSeconds: 0, gpuMemoryMiB: 0 };
    await expect.poll(async () => {
      const operation = await runtimeCapture(captureId);
      if (operation.status !== 'waiting_input' && operation.status !== 'extracting') {
        throw new Error(`${label} capture was ${operation.status} before its worker was seen at work.`);
      }
      sample = await speechWorkers();
      const atWork = input.speechOnGpu
        ? sample.gpuMemoryMiB >= WORKER_AT_WORK_GPU_MEMORY_MIB
        : sample.cpuSeconds >= WORKER_AT_WORK_CPU_SECONDS;
      return operation.status === 'extracting' && atWork;
    }, { timeout: WORKER_AT_WORK_TIMEOUT_MS, intervals: [250] }).toBe(true);
    return sample;
  };
  /**
   * Waits until none of the sampled worker processes is left (a worker the
   * next capture starts is another process); returns how long after `since`
   * (a time) that was seen.
   */
  const untilWorkersEnded = async (atWork: WorkerSample, since: number): Promise<number> => {
    await expect.poll(async () => (await speechWorkers()).processIds.filter((id) => atWork.processIds.includes(id)).length, {
      timeout: WORKER_STOP_TIMEOUT_MS, intervals: [250], message: 'The speech worker kept running after the delete.',
    }).toBe(0);
    return Date.now() - since;
  };
  const newDocuments = async (before: ReadonlySet<string>, count: number): Promise<readonly DesktopLibrarySummaryRecord[]> => {
    let added: readonly DesktopLibrarySummaryRecord[] = [];
    await expect.poll(async () => {
      added = (await documents()).filter((item) => !before.has(item.documentId));
      return added.length;
    }, { timeout: SETTLE_TIMEOUT_MS, intervals: [250] }).toBe(count);
    return added;
  };
  /** Drops the files on the window as one batch in this order, as the shell imports a native drop. */
  const drop = async (paths: readonly string[]): Promise<void> => {
    const queued = await page.request.post(`${baseUrl}/__host/selection`, { headers: previewHeaders, data: { paths } });
    expect(queued.status()).toBe(200);
    await page.evaluate(() => {
      const dropQueued = (globalThis as { __captureDevHostDropQueuedSources?: () => Promise<void> })
        .__captureDevHostDropQueuedSources;
      if (!dropQueued) throw new Error('The dev-host preview bridge offers no drop of queued sources.');
      return dropQueued();
    });
  };
  const row = (kind: QueueRowKind, documentId: string): Locator => rowOf(page, kind, documentId);
  const navigate = (to: 'ocr' | 'asr' | 'history'): Promise<void> => navigateTo(page, to);

  const observed = await observePage(page);
  const { commands } = observed;
  /** The capture IDs the page linked to the document, in order: one per attempt that reached the runtime. */
  const linkedCaptures = (documentId: string): readonly string[] => commands
    .filter((command) => command.write?.documentId === documentId && command.write.captureId !== undefined)
    .map((command) => command.write?.captureId ?? '');
  const nextLinkedCapture = async (documentId: string, attempts: number, label: string): Promise<string> => {
    await expect.poll(() => linkedCaptures(documentId).length, {
      timeout: START_TIMEOUT_MS, intervals: [250], message: `${label} was not linked to a runtime capture.`,
    }).toBe(attempts);
    return linkedCaptures(documentId)[attempts - 1] ?? '';
  };
  /** The window of an attempt: from its capture create to `endedAt` (a page time). */
  const recordWindow = (
    label: string,
    engine: CaptureWindow['engine'],
    documentId: string,
    attempt: number,
    end: { readonly endedAt: number; readonly outcome: CaptureWindow['outcome']; readonly runtimeDeleteMs?: number },
  ): void => {
    const created = capturesCreatedFor(commands, documentId)[attempt - 1];
    assert.ok(created, `${label} has no capture create.`);
    input.recordWindow({
      label,
      engine,
      startedAt: new Date(created.sentAt).toISOString(),
      endedAt: new Date(end.endedAt).toISOString(),
      outcome: end.outcome,
      ...(end.runtimeDeleteMs !== undefined ? { runtimeDeleteMs: end.runtimeDeleteMs } : {}),
    });
  };
  /** When the document's terminal write of `status` (from `from` on) was answered. */
  const terminalAnsweredAt = (documentId: string, status: string, from: number): number => {
    const answered = terminalWritesOf(commands, documentId, from)
      .find((command) => command.write?.status === status)?.answeredAt;
    assert.ok(answered !== undefined, `The ${status} write was not answered.`);
    return answered;
  };
  let waitingWhileRunning = 0;
  let turnsAfterOutcome = 0;
  let turnsWithOutcomeShown = 0;
  const expectTurn = (turn: Turn): void => {
    assert.equal(turnProblem(commands, turn), undefined);
    turnsAfterOutcome += 1;
    if (predecessorShownAtStart(commands, turn)) turnsWithOutcomeShown += 1;
  };
  const startAgainBehindRunning: StartAgainBehindRunning[] = [];
  /**
   * After a Start again of `restarted` (whose stored link was `previousCapture`)
   * while `running` ran as `runningCapture`: either the restarted document was
   * stored waiting while the other still ran, or the other had already ended
   * and the restarted one was stored waiting or started. Two captures at once
   * fail at once; the order is proven by the turn check of the command log.
   */
  const afterStartAgain = async (
    restarted: string,
    previousCapture: string | null,
    running: string,
    runningCapture: string,
  ): Promise<StartAgainBehindRunning> => {
    const seen: { value: StartAgainBehindRunning | 'pending' } = { value: 'pending' };
    await expect.poll(async () => {
      const list = await documents();
      const restartedState = stateIn(list, restarted);
      const runningState = stateIn(list, running);
      const restartedStarted = restartedState.status === 'processing' && restartedState.captureId !== previousCapture;
      const stillRunning = runningState.status === 'processing' && runningState.captureId === runningCapture;
      if (stillRunning && restartedStarted) throw new Error('The restarted document started while the other one still ran.');
      if (stillRunning) seen.value = isDeepStrictEqual(restartedState, waiting) ? 'waited' : 'pending';
      else if (runningState.status === 'processing' || runningState.status === 'queued') seen.value = 'pending';
      else seen.value = restartedStarted || restartedState.status === 'queued' ? 'document-ended-first' : 'pending';
      return seen.value;
    }, { timeout: SETTLE_TIMEOUT_MS, intervals: [250], message: 'The Start again was not stored.' }).not.toBe('pending');
    const outcome = seen.value;
    assert.ok(outcome !== 'pending');
    startAgainBehindRunning.push(outcome);
    if (outcome === 'waited') waitingWhileRunning += 1;
    return outcome;
  };

  try {
    await page.goto(`${baseUrl}/asr`);
    await input.waitForRuntimeReady(page);
    const identifySpeakers = page.getByTestId('asr-identify-speakers');
    await expect(identifySpeakers).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
    if (!(await identifySpeakers.isChecked())) await identifySpeakers.check();

    // 1. The recording and the PDF imported together: the recording runs, the PDF waits.
    // A queue page takes only its own kind from a drop; History takes both.
    await navigate('history');
    await drop([input.audioPath, input.pdfPath]);
    await navigate('asr');
    const imported = await newDocuments(known, 2);
    const recording = imported.find((item) => item.mediaType.startsWith('audio/'))?.documentId;
    const pdf = imported.find((item) => item.mediaType === 'application/pdf')?.documentId;
    assert.ok(recording && pdf, 'The drop must import one recording and one PDF.');
    const firstRecordingCapture = await nextLinkedCapture(recording, 1, 'The recording');
    await expect(row('asr-queue-row', recording)).toHaveAttribute('data-user-status', 'processing', { timeout: SETTLE_TIMEOUT_MS });
    expect(await stored(pdf)).toEqual(waiting);
    expect(capturesCreatedFor(commands, pdf)).toHaveLength(0);
    await navigate('ocr');
    await expect(row('ocr-queue-row', pdf)).toHaveAttribute('data-user-status', 'waiting', { timeout: SETTLE_TIMEOUT_MS });
    await expect(row('ocr-queue-row', pdf).getByTestId('ocr-row-cancel')).toBeEnabled();
    await navigate('asr');
    waitingWhileRunning += 1;
    log('imported together: the recording runs, the PDF waits');

    // 2. A reload while the recording's worker is at work.
    const workerAtReload = await untilWorkerWorks(firstRecordingCapture, 'The recording');
    expect(await stored(pdf)).toEqual(waiting);
    const beforeReload = commands.length;
    await page.reload();
    await input.waitForRuntimeReady(page);
    const reloadedAt = observed.navigations.find((index) => index >= beforeReload);
    assert.ok(reloadedAt !== undefined, 'The reload was not observed.');
    const recordingRow = row('asr-queue-row', recording);
    await expect(recordingRow).toHaveAttribute('data-user-status', 'needs-attention', { timeout: SETTLE_TIMEOUT_MS });
    await expect(recordingRow).toContainText('已中斷');
    await expect(recordingRow.getByTestId('asr-row-restart')).toBeVisible();
    await expect(recordingRow.getByTestId('asr-row-cancel')).toHaveCount(0);
    // The new page deletes the earlier page's capture once, reads nothing of it and writes nothing for its row.
    const startupDeletes = () => commands.slice(reloadedAt)
      .filter((command) => command.command === 'runtime_delete_capture' && command.captureId === firstRecordingCapture);
    await expect.poll(() => startupDeletes().filter((command) => command.answeredAt !== undefined).length, {
      timeout: SETTLE_TIMEOUT_MS, intervals: [250],
    }).toBe(1);
    const startupDelete = startupDeletes()[0];
    assert.ok(startupDelete?.answeredAt !== undefined);
    // The runtime ends the capture before it answers the delete, but the worker
    // process exits after the answer (measured 0.7 to 1.7 s): its end is
    // watched from the answer on, beside the steps that follow.
    const reloadWorkerEnded = startedNow(untilWorkersEnded(workerAtReload, startupDelete.answeredAt));
    const reloadDeletes = startupDeletes().length;
    expect(commandsNamingCapture(commands, firstRecordingCapture, reloadedAt)).toEqual(['runtime_delete_capture']);
    expect(commands.slice(reloadedAt).filter((command) => command.write?.documentId === recording)).toEqual([]);
    expect(await stored(recording)).toEqual({ status: 'processing', captureId: firstRecordingCapture, hasRaw: false });

    // The PDF left waiting starts when the app loads.
    const firstPdfCapture = await nextLinkedCapture(pdf, 1, 'The PDF');

    // 3. Start again at once, while the PDF runs (or after it ended), then to
    // History, which shows the PDF's row when the recording starts.
    const beforeRestart = commands.length;
    await recordingRow.getByTestId('asr-row-restart').click({ timeout: ACTION_TIMEOUT_MS });
    await navigate('history');
    const firstStartAgain = await afterStartAgain(recording, firstRecordingCapture, pdf, firstPdfCapture);
    // Start again deletes the capture the old link names once more, without waiting (startAgain$).
    await expect.poll(() => commandsNamingCapture(commands, firstRecordingCapture, beforeRestart), {
      timeout: SETTLE_TIMEOUT_MS, intervals: [250],
    }).toEqual(['runtime_delete_capture']);
    const reloadRuntimeGone = await runtimeGone(firstRecordingCapture);
    const reloadWorkerStoppedMs = await reloadWorkerEnded();
    recordWindow('lifecycle-recording-1', 'speech-recognition', recording, 1, {
      endedAt: startupDelete.answeredAt,
      outcome: 'interrupted',
      runtimeDeleteMs: startupDelete.answeredAt - startupDelete.sentAt,
    });
    log(`reloaded with the speech worker at ${workerAtReload.cpuSeconds} CPU s and ${workerAtReload.gpuMemoryMiB} MiB GPU memory: the recording is interrupted; the runtime answered its delete in ${startupDelete.answeredAt - startupDelete.sentAt}ms; its worker process ended within ${reloadWorkerStoppedMs}ms of the answer; Start again behind the PDF: ${firstStartAgain}`);

    // 4. The PDF ends at its checkpoint; the recording starts after its outcome.
    await expect(row('history-row', pdf)).toHaveAttribute('data-user-status', 'done', { timeout: input.documentTimeoutMs });
    recordWindow('lifecycle-pdf-1', 'text-recognition', pdf, 1, {
      endedAt: terminalAnsweredAt(pdf, 'awaiting_confirmation', 0),
      outcome: 'done',
    });
    const secondRecordingCapture = await nextLinkedCapture(recording, 2, 'The recording started again');
    expectTurn({
      predecessor: pdf, status: 'awaiting_confirmation', shownStatus: 'done', successor: recording, from: beforeRestart,
      predecessorRowOptional: true,
    });
    log('the PDF reached its checkpoint; the recording started after its outcome was stored');

    // 5. While the recording runs, the PDF imported once more waits.
    await navigate('asr');
    await expect(recordingRow).toHaveAttribute('data-user-status', 'processing', { timeout: SETTLE_TIMEOUT_MS });
    const knownBeforeSecondPdf = new Set((await documents()).map((item) => item.documentId));
    await navigate('history');
    await drop([input.pdfPath]);
    await navigate('asr');
    const secondPdf = (await newDocuments(knownBeforeSecondPdf, 1))[0]?.documentId;
    assert.ok(secondPdf);
    await expect.poll(() => stored(secondPdf), { timeout: SETTLE_TIMEOUT_MS }).toEqual(waiting);
    expect(capturesCreatedFor(commands, secondPdf)).toHaveLength(0);
    waitingWhileRunning += 1;

    // 6. Cancel of the running recording while its worker is at work.
    const workerAtCancel = await untilWorkerWorks(secondRecordingCapture, 'The recording started again');
    const beforeCancel = commands.length;
    const cancelTiming = await readCancelTiming(page);
    await recordingRow.getByTestId('asr-row-cancel').click({ timeout: ACTION_TIMEOUT_MS });
    await expect(recordingRow).toHaveAttribute('data-user-status', 'cancelled', { timeout: CANCEL_TIMEOUT_MS });
    await expect(recordingRow).toContainText('已取消');
    await expect(recordingRow.getByTestId('asr-row-restart')).toBeVisible();
    // Every page command that names the cancelled capture from the Cancel on: one delete, nothing else.
    expect(commandsNamingCapture(commands, secondRecordingCapture, beforeCancel)).toEqual(['runtime_delete_capture']);
    const cancelDelete = commands.slice(beforeCancel)
      .find((command) => command.command === 'runtime_delete_capture' && command.captureId === secondRecordingCapture);
    assert.ok(cancelDelete?.answeredAt !== undefined, 'The Cancel\'s runtime delete was not answered.');
    const cancelWorkerEnded = startedNow(untilWorkersEnded(workerAtCancel, cancelDelete.answeredAt));
    const cancelProblem = cancellingWhileDeletePendingProblem(observed.changes, recording, cancelDelete, cancelTiming);
    assert.equal(cancelProblem, undefined);
    const cancelWrites = terminalWritesOf(commands, recording, beforeCancel);
    expect(cancelWrites.map((command) => command.write)).toEqual([{
      documentId: recording, status: 'canceled', stage: 'cancelled', clearCaptureId: true, hasRaw: false, hasResult: false,
    }]);
    await expect.poll(() => stored(recording), { timeout: SETTLE_TIMEOUT_MS })
      .toEqual({ status: 'canceled', captureId: null, hasRaw: false });
    const cancelled = await detail(recording);
    expect(cancelled.stage).toBe('cancelled');
    expect(cancelled.raw ?? null).toBeNull();
    // The waiting document starts after the cancelled row showed its outcome.
    const secondPdfCapture = await nextLinkedCapture(secondPdf, 1, 'The PDF imported again');
    expectTurn({ predecessor: recording, status: 'canceled', shownStatus: 'cancelled', successor: secondPdf, from: beforeCancel });

    // 7. Start again at once, while the PDF runs (or after it ended); then the
    // rest of the Cancel's checks; the recording is captured to its end.
    const beforeSecondRestart = commands.length;
    await recordingRow.getByTestId('asr-row-restart').click({ timeout: ACTION_TIMEOUT_MS });
    await navigate('history');
    const secondStartAgain = await afterStartAgain(recording, null, secondPdf, secondPdfCapture);
    const cancelRuntimeGone = await runtimeGone(secondRecordingCapture);
    const cancelWorkerStoppedMs = await cancelWorkerEnded();
    recordWindow('lifecycle-recording-2', 'speech-recognition', recording, 2, {
      endedAt: cancelDelete.answeredAt,
      outcome: 'cancelled',
      runtimeDeleteMs: cancelDelete.answeredAt - cancelDelete.sentAt,
    });
    log(`cancelled with the speech worker at ${workerAtCancel.cpuSeconds} CPU s and ${workerAtCancel.gpuMemoryMiB} MiB GPU memory: the runtime answered the delete in ${cancelDelete.answeredAt - cancelDelete.sentAt}ms; its worker process ended within ${cancelWorkerStoppedMs}ms of the answer; the waiting PDF started; Start again behind it: ${secondStartAgain}`);
    await expect(row('history-row', secondPdf)).toHaveAttribute('data-user-status', 'done', { timeout: input.documentTimeoutMs });
    recordWindow('lifecycle-pdf-2', 'text-recognition', secondPdf, 1, {
      endedAt: terminalAnsweredAt(secondPdf, 'awaiting_confirmation', 0),
      outcome: 'done',
    });
    const thirdRecordingCapture = await nextLinkedCapture(recording, 3, 'The recording started a second time');
    expectTurn({
      predecessor: secondPdf, status: 'awaiting_confirmation', shownStatus: 'done', successor: recording, from: beforeSecondRestart,
      predecessorRowOptional: true,
    });
    await expect(row('history-row', recording)).toHaveAttribute('data-user-status', 'done', { timeout: input.recordingTimeoutMs });
    recordWindow('lifecycle-recording-3', 'speech-recognition', recording, 3, {
      endedAt: terminalAnsweredAt(recording, 'completed', beforeSecondRestart),
      outcome: 'done',
    });
    log('the recording started again was captured to its end');

    // 8. Every capture that ended is stored as the checkpoint rule says, and is gone at the runtime.
    const outcomes: CaptureLifecycleEvidence['outcomes'][number][] = [];
    for (const [label, documentId, captureId] of [
      ['lifecycle-pdf-1', pdf, firstPdfCapture],
      ['lifecycle-pdf-2', secondPdf, secondPdfCapture],
    ] as const) {
      const document = await detail(documentId);
      const extraction = input.checkStoredDocument(document, label);
      expect(document.ocrEvidence?.captureId, `${label} evidence must be its attempt's.`).toBe(captureId);
      outcomes.push({
        label,
        status: document.status,
        stage: document.stage ?? null,
        linked: Boolean(document.captureId),
        hasRaw: document.hasRaw === true,
        ocrEvidenceStatus: document.ocrEvidence?.status ?? null,
        runtimeGone: await runtimeGone(captureId),
        extraction,
      });
    }
    const recorded = await detail(recording);
    const { extraction, structuring } = input.checkStoredRecording(recorded);
    outcomes.push({
      label: 'lifecycle-recording-3',
      status: recorded.status,
      stage: recorded.stage ?? null,
      linked: Boolean(recorded.captureId),
      hasRaw: recorded.hasRaw === true,
      ocrEvidenceStatus: null,
      runtimeGone: await runtimeGone(thirdRecordingCapture),
      extraction,
      structuring,
    });
    // Each attempt ended with one terminal write, and nothing was created but the five attempts.
    expect(terminalWritesOf(commands, recording).map((command) => command.write?.status)).toEqual(['canceled', 'completed']);
    expect(terminalWritesOf(commands, pdf).map((command) => command.write?.status)).toEqual(['awaiting_confirmation']);
    expect(terminalWritesOf(commands, secondPdf).map((command) => command.write?.status)).toEqual(['awaiting_confirmation']);
    expect([recording, pdf, secondPdf].map((documentId) => capturesCreatedFor(commands, documentId).length)).toEqual([3, 1, 1]);
    // To the stage's end, the interrupted capture was named only by the new page's delete and the
    // Start again's, and the cancelled one only by the Cancel's delete.
    expect(commandsNamingCapture(commands, firstRecordingCapture, reloadedAt))
      .toEqual(['runtime_delete_capture', 'runtime_delete_capture']);
    const cancelCommands = commandsNamingCapture(commands, secondRecordingCapture, beforeCancel);
    expect(cancelCommands).toEqual(['runtime_delete_capture']);

    return {
      workerAtWorkCriterion,
      waitingWhileRunning,
      startAgainBehindRunning,
      turnsAfterOutcome,
      turnsWithOutcomeShown,
      reload: {
        interruptedShown: true,
        restartOffered: true,
        workerAtReload: workerUseOf(workerAtReload),
        workerStoppedMsAfterDelete: reloadWorkerStoppedMs,
        runtimeDeletes: reloadDeletes,
        startAgainDeletes: commandsNamingCapture(commands, firstRecordingCapture, beforeRestart).length,
        runtimeDeleteMs: startupDelete.answeredAt - startupDelete.sentAt,
        otherCommandsForCapture: commandsNamingCapture(commands, firstRecordingCapture, reloadedAt)
          .filter((command) => command !== 'runtime_delete_capture').length,
        storedLinkKept: true,
        runtimeGone: reloadRuntimeGone,
      },
      cancel: {
        cancellingShownWhileDeletePending: true,
        cancelledShownAfterDelete: true,
        workerAtCancel: workerUseOf(workerAtCancel),
        workerStoppedMsAfterDelete: cancelWorkerStoppedMs,
        runtimeDeletes: cancelCommands.length,
        otherCommandsForCapture: cancelCommands.filter((command) => command !== 'runtime_delete_capture').length,
        runtimeDeleteMs: cancelDelete.answeredAt - cancelDelete.sentAt,
        clockToleranceMs: cancelTiming.clock.toleranceMs,
        terminalWrites: cancelWrites.length,
        storedStatus: 'canceled',
        storedLinked: false,
        storedHasRaw: false,
        runtimeGone: cancelRuntimeGone,
        nextStartedAfterOutcome: true,
      },
      outcomes,
    };
  } finally {
    observed.stop();
  }
}

function stateIn(list: readonly DesktopLibrarySummaryRecord[], documentId: string): StoredState {
  const document = list.find((item) => item.documentId === documentId);
  return {
    status: document?.status,
    captureId: document?.captureId ?? null,
    hasRaw: document?.hasRaw ?? false,
  };
}
