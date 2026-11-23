// The capture lifecycle of the Workbench against the real
// capture-workbench-dev-host and the deterministic fixture runtime: a capture
// belongs to the app run that started it, and captures run one at a time in
// import order. Each journey starts its own dev-host preview with a private
// app-data directory and a private TEMP. Through that TEMP the test steers the
// fixture runtime (`capture-deterministic-capture-control.json`: hold captures
// running, fail them, refuse a delete) and reads the runtime's request log
// (`capture-deterministic-request-log.json`). What is stored is read from the
// host's own library commands, and the library writes the Workbench sends are
// recorded from the page's requests to the host. Every journey directory lies
// under the private temp root of tools/test-temp-root.ts, which the
// e2e-dev-host target preloads; each journey also removes its own directory.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Locator, type Page, type Request, type Route } from '@playwright/test';
import { startDevHostLauncher, type StartedDevHostLauncher } from './dev-host-launcher.ts';

const twoPagePdf = readFileSync(
  fileURLToPath(new URL('./fixtures/two-pages.pdf', import.meta.url)),
);
const previewHeaders = { 'x-capture-preview': '1' };

interface CaptureControl {
  readonly holdCaptures?: boolean;
  readonly failCaptures?: boolean;
  /** A capture delete answers 503 and leaves the capture as it is. */
  readonly deleteUnavailable?: boolean;
}

interface StoredDocument {
  readonly documentId: string;
  readonly fileName: string;
  readonly status: string;
  readonly stage?: string;
  readonly captureId?: string;
  readonly errorCode?: string;
  readonly hasRaw?: boolean;
  readonly updatedAtMs: number;
}

interface StoredDetail extends StoredDocument {
  readonly raw?: unknown;
  readonly ocrEvidence?: { readonly captureId: string; readonly status: string };
}

interface RuntimeRequest {
  readonly timestamp: number;
  readonly method: string;
  readonly route: string;
  readonly status: number;
}

/** A library write the Workbench sent to the host (`library_update_capture`). */
interface LibraryWrite {
  readonly documentId: string;
  readonly status: string;
  readonly stage?: string;
  readonly captureId?: string;
  readonly clearCaptureId?: boolean;
  readonly raw?: unknown;
  readonly result?: unknown;
  readonly ocrEvidence?: { readonly captureId: string; readonly status: string };
}

/**
 * A host command the page sent, or the answer it got, in the order the page
 * saw them, and each navigation of the page between them. The journeys' own
 * reads (`invoke`) are not among them.
 */
interface PageCommand {
  readonly event: 'sent' | 'answered' | 'navigated';
  /** The host command, or for a navigation the URL navigated to. */
  readonly command: string;
  /** The capture a runtime command names (`input.id`). */
  readonly captureId?: string;
  /** The document a capture create (`input.documentId`) or a library read (`request.documentId`) names. */
  readonly documentId?: string;
  /** The library write of a `library_update_capture`. */
  readonly write?: LibraryWrite;
  /**
   * For a sent command: every row the page showed when it sent it, as its
   * user status and its text (recorded in the page by `recordShownRows`).
   */
  readonly shown?: readonly ShownRow[];
}

/** A row of a queue or History as the page showed it: `data-user-status` and its text. */
interface ShownRow {
  readonly status: string;
  readonly text: string;
}

/** The request header that carries the rows the page showed when it sent a host command. */
const shownRowsHeader = 'x-journey-shown-rows';

/**
 * Records in every host command the page sends the rows it shows at that
 * moment: the page's fetch of `/__host/invoke/` carries them in a header the
 * preview server does not pass on.
 */
async function recordShownRows(page: Page): Promise<void> {
  await page.addInitScript((header) => {
    const send = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/__host/invoke/')) return send(input, init);
      const rows = [...document.querySelectorAll('[data-user-status]')].map((row) => ({
        status: row.getAttribute('data-user-status') ?? '',
        text: (row.textContent ?? '').replace(/\s+/gu, ' ').trim(),
      }));
      const headers = new Headers(init?.headers);
      headers.set(header, encodeURIComponent(JSON.stringify(rows)));
      return send(input, { ...init, headers });
    };
  }, shownRowsHeader);
}

interface JourneyHost {
  readonly baseUrl: string;
  /** Writes a source file the test can hand to the host. */
  source(fileName: string, bytes: Buffer): string;
  controlCaptures(control: CaptureControl): void;
  runtimeRequests(method: string, route: string): readonly RuntimeRequest[];
  /** Every request the runtime has logged, in order. */
  runtimeLog(): readonly RuntimeRequest[];
  /** Every host command the page has sent and every answer it got, in order. */
  readonly commands: readonly PageCommand[];
  /** A host command, as the Workbench sends it; rejects with the host's error text. */
  invoke<T>(command: string, args: object): Promise<T>;
  documents(): Promise<readonly StoredDocument[]>;
  document(fileName: string): Promise<StoredDocument | undefined>;
  detail(fileName: string): Promise<StoredDetail>;
  /** Whether the library still holds a directory for the document. */
  hasFiles(documentId: string): boolean;
  /** Every library write the page has sent, in the order it sent them. */
  readonly writes: readonly LibraryWrite[];
}

/**
 * The request log's complete records. The fixture runtime writes a record's
 * newline after the record, so text after the last newline may still be
 * being written and is left for the next read; a complete record that does
 * not parse, an empty one too, fails the journey.
 */
function completeRecords(log: string): readonly RuntimeRequest[] {
  const end = log.lastIndexOf('\n');
  if (end < 0) return [];
  return log.slice(0, end)
    .split('\n')
    .map((line) => JSON.parse(line) as RuntimeRequest);
}

/** The host command a page request carries, or undefined for any other request. */
function pageCommand(request: Request): Omit<PageCommand, 'event'> | undefined {
  const path = new URL(request.url()).pathname;
  const prefix = '/__host/invoke/';
  if (!path.startsWith(prefix)) return undefined;
  const command = decodeURIComponent(path.slice(prefix.length));
  // The page sends every host command as a JSON object.
  const body = (request.postDataJSON() ?? {}) as {
    readonly input?: { readonly id?: unknown; readonly documentId?: unknown };
    readonly request?: { readonly documentId?: unknown };
    readonly update?: LibraryWrite;
  };
  const captureId = typeof body.input?.id === 'string' ? body.input.id : undefined;
  const named = body.input?.documentId ?? body.request?.documentId;
  const documentId = typeof named === 'string' ? named : undefined;
  const shown = request.headers()[shownRowsHeader];
  return {
    command,
    ...(captureId ? { captureId } : {}),
    ...(documentId ? { documentId } : {}),
    ...(command === 'library_update_capture' && body.update ? { write: body.update } : {}),
    ...(shown ? { shown: JSON.parse(decodeURIComponent(shown)) as readonly ShownRow[] } : {}),
  };
}

const test = base.extend<{ host: JourneyHost }>({
  host: async ({ page }, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'journey-'));
    let launcher: StartedDevHostLauncher | undefined;
    // From here on the directory is removed and the launcher stopped, also
    // when the start, the journey or closing the page fails.
    try {
      const runtimeTemp = join(directory, 't');
      const appData = join(directory, 'a');
      const sources = join(directory, 's');
      for (const path of [runtimeTemp, appData, sources]) mkdirSync(path);
      const requestLog = join(runtimeTemp, 'runtime-requests.jsonl');
      writeFileSync(
        join(runtimeTemp, 'capture-deterministic-request-log.json'),
        JSON.stringify({ CAPTURE_DETERMINISTIC_REQUEST_LOG: requestLog }),
      );
      const controlFile = join(runtimeTemp, 'capture-deterministic-capture-control.json');
      launcher = await startDevHostLauncher({
        appDataDir: appData,
        env: { TEMP: runtimeTemp, TMP: runtimeTemp, TMPDIR: runtimeTemp },
        startupTimeoutMs: 40_000,
      });
      const started = launcher;
      await recordShownRows(page);
      const writes: LibraryWrite[] = [];
      const commands: PageCommand[] = [];
      page.on('request', (request) => {
        const command = pageCommand(request);
        if (!command) return;
        commands.push({ event: 'sent', ...command });
        if (command.write) writes.push(command.write);
      });
      // Answered, including an answer with an error status; a request that got
      // no answer at all is not.
      page.on('requestfinished', (request) => {
        const command = pageCommand(request);
        if (command) commands.push({ event: 'answered', ...command });
      });
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) commands.push({ event: 'navigated', command: frame.url() });
      });
      const runtimeLog = () => completeRecords(existsSync(requestLog) ? readFileSync(requestLog, 'utf8') : '');
      const invoke = async <T>(command: string, args: object): Promise<T> => {
        const response = await page.request.post(`${started.baseUrl}/__host/invoke/${command}`, {
          headers: previewHeaders,
          data: args,
        });
        const text = await response.text();
        if (response.ok()) return (text.length > 0 ? JSON.parse(text) : null) as T;
        const parsed = JSON.parse(text) as { readonly error?: unknown };
        throw new Error(typeof parsed.error === 'string' ? parsed.error : text);
      };
      const documents = (): Promise<readonly StoredDocument[]> =>
        invoke<readonly StoredDocument[]>('library_list', { request: { query: '', status: '' } });
      const document = async (fileName: string): Promise<StoredDocument | undefined> =>
        (await documents()).find((item) => item.fileName === fileName);
      await use({
        baseUrl: started.baseUrl,
        source: (fileName, bytes) => {
          const path = join(sources, fileName);
          writeFileSync(path, bytes);
          return path;
        },
        controlCaptures: (control) => {
          // Replace the file in one step: the runtime reads it on every capture request.
          writeFileSync(`${controlFile}.next`, JSON.stringify(control));
          renameSync(`${controlFile}.next`, controlFile);
        },
        runtimeRequests: (method, route) => runtimeLog()
          .filter((entry) => entry.method === method && entry.route === route),
        runtimeLog,
        commands,
        invoke,
        documents,
        document,
        detail: async (fileName) => {
          const stored = await document(fileName);
          if (!stored) throw new Error(`${fileName} is not stored.`);
          return invoke<StoredDetail>('library_get', { request: { documentId: stored.documentId } });
        },
        hasFiles: (documentId) => readdirSync(appData, { recursive: true, encoding: 'utf8' })
          .some((entry) => entry.split(/[\\/]/u).includes(documentId)),
        writes,
      });
    } finally {
      try {
        await page.close();
      } catch {
        // The page may already be gone; the host and the directory are still cleaned up.
      }
      try {
        await launcher?.stop();
      } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  },
});

test.describe.configure({ timeout: 120_000 });

const runtimeCaptures = '/v2/captures';
const runtimeCapture = '/v2/captures/{captureId}';
const runtimeCancel = '/v2/captures/{captureId}/cancel';
const runtimeIngestions = '/v2/ingestions';
const settles = { timeout: 15_000 };

function recording(words: readonly string[]): Buffer {
  return Buffer.from(`RIFF\0\0\0\0WAVECAPTURE_TEXT:${words.join('|')}`, 'latin1');
}

async function openWorkbench(page: Page, host: JourneyHost, path: string): Promise<void> {
  await page.goto(`${host.baseUrl}${path}`);
  await expectRuntimeReady(page);
}

async function expectRuntimeReady(page: Page): Promise<void> {
  await expect(page.getByTestId('runtime-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  });
}

/** Queues the files for the host's next file dialog and opens it with the page's button. */
async function chooseFiles(
  page: Page,
  host: JourneyHost,
  buttonTestId: 'ocr-choose-files' | 'asr-choose-files',
  paths: readonly string[],
): Promise<void> {
  await queueSelection(page, host, paths);
  await page.getByTestId(buttonTestId).click();
}

/** Drops the files on the window, as one batch in this order (the shell imports it). */
async function dropFiles(page: Page, host: JourneyHost, paths: readonly string[]): Promise<void> {
  await queueSelection(page, host, paths);
  await page.evaluate(() => {
    const drop = (globalThis as { __captureDevHostDropQueuedSources?: () => Promise<void> })
      .__captureDevHostDropQueuedSources;
    if (!drop) throw new Error('The dev-host preview bridge offers no drop of queued sources.');
    return drop();
  });
}

async function queueSelection(page: Page, host: JourneyHost, paths: readonly string[]): Promise<void> {
  const queued = await page.request.post(`${host.baseUrl}/__host/selection`, {
    headers: previewHeaders,
    data: { paths },
  });
  expect(queued.status()).toBe(200);
}

function asrRow(page: Page, fileName: string): Locator {
  return page.getByTestId('asr-queue-row').filter({ hasText: fileName });
}

function ocrRow(page: Page, fileName: string): Locator {
  return page.getByTestId('ocr-queue-row').filter({ hasText: fileName });
}

function historyRow(page: Page, fileName: string): Locator {
  return page.getByTestId('history-row').filter({ hasText: fileName });
}

/** The stored fields the journeys compare. */
async function stored(host: JourneyHost, fileName: string) {
  const document = await host.document(fileName);
  return {
    status: document?.status,
    captureId: document?.captureId ?? null,
    hasRaw: document?.hasRaw ?? false,
  };
}

/** The stored fields and the stage the row keeps from its last write. */
async function storedWithStage(host: JourneyHost, fileName: string) {
  const document = await host.document(fileName);
  return {
    status: document?.status,
    stage: document?.stage,
    captureId: document?.captureId ?? null,
    hasRaw: document?.hasRaw ?? false,
  };
}

/** An OCR document whose checkpoint was stored: the stage the write took from the runtime's status. */
const storedCheckpoint = {
  status: 'awaiting_confirmation', stage: 'awaiting_structuring', captureId: null, hasRaw: true,
};

async function linkedCaptureId(host: JourneyHost, fileName: string): Promise<string> {
  await expect.poll(async () => (await host.document(fileName))?.captureId, settles).toBeTruthy();
  return (await host.document(fileName))?.captureId ?? '';
}

async function documentIdOf(host: JourneyHost, fileName: string): Promise<string> {
  const document = await host.document(fileName);
  if (!document) throw new Error(`${fileName} is not stored.`);
  return document.documentId;
}

/** The capture id the stored row links, or '' when it links none. */
async function storedLink(host: JourneyHost, fileName: string): Promise<string> {
  return (await host.document(fileName))?.captureId ?? '';
}

/** The runtime's answer to a status read of the capture: '' when it answers, else the host's error. */
async function runtimeReadError(host: JourneyHost, captureId: string): Promise<string> {
  try {
    await host.invoke('runtime_get_capture', { input: { id: captureId } });
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function writesOf(host: JourneyHost, documentId: string): readonly LibraryWrite[] {
  return host.writes.filter((write) => write.documentId === documentId);
}

/**
 * Holds the page's first library write that `matches` until the test
 * releases it. Other writes go on to the next hold or to the host, so
 * several holds can wait for different writes at once.
 */
async function holdLibraryWrite(
  page: Page,
  matches: (write: LibraryWrite) => boolean,
): Promise<{ readonly requested: Promise<void>; release: () => Promise<void> }> {
  let held: Route | undefined;
  let markRequested: () => void = () => undefined;
  const requested = new Promise<void>((resolveRequested) => {
    markRequested = resolveRequested;
  });
  const pattern = '**/__host/invoke/library_update_capture';
  const handler = async (route: Route): Promise<void> => {
    const write = (route.request().postDataJSON() as { readonly update: LibraryWrite }).update;
    if (held || !matches(write)) {
      await route.fallback();
      return;
    }
    held = route;
    markRequested();
  };
  await page.route(pattern, handler);
  return {
    requested,
    release: async () => {
      await held?.continue();
      await page.unroute(pattern, handler);
    },
  };
}

const captureCreates = new Set(['runtime_create_capture', 'runtime_start_recording_capture']);

/** How far the page's commands and the runtime's log had come before a reload or a user action. */
interface JourneyMark {
  readonly commands: number;
  readonly runtimeLog: number;
}

/** Taken just before the journey reloads the page (or opens it again), or acts on it. */
function markNow(host: JourneyHost): JourneyMark {
  return { commands: host.commands.length, runtimeLog: host.runtimeLog().length };
}

/**
 * What the page may send while one capture runs held and the user cancels a
 * waiting row, each for its reason; anything else fails the journey.
 */
function allowedDuringCancelOfWaiting(
  command: PageCommand,
  cancel: { readonly runningCapture: string; readonly cancelled: string },
): boolean {
  switch (command.command) {
    // The Cancel's read of the stored rows, and the list's reload after its write.
    case 'library_list':
      return true;
    // The Cancel's one write (checked to be the cancelled write).
    case 'library_update_capture':
      return command.write?.documentId === cancel.cancelled;
    // The detail of the selected document is read again after its write.
    case 'library_get':
      return command.documentId === cancel.cancelled;
    // A status read of the running capture.
    case 'runtime_get_capture':
      return command.captureId === cancel.runningCapture;
    default:
      return false;
  }
}

/**
 * Since `mark`, while one capture runs held and the user cancels a waiting
 * row: every host command the page sent is one `allowedDuringCancelOfWaiting`
 * names, its one library write is the cancelled write, and every request the
 * runtime logged is a status read (its log names no capture, so a status read
 * stands for the running one): no other runtime command or request.
 */
function expectOnlyCancelOfWaitingSince(
  host: JourneyHost,
  mark: JourneyMark,
  cancel: { readonly runningCapture: string; readonly cancelled: string },
): void {
  const sent = host.commands.slice(mark.commands).filter((command) => command.event === 'sent');
  expect(sent.filter((command) => !allowedDuringCancelOfWaiting(command, cancel))
    .map((command) => `${command.command} ${command.captureId ?? command.documentId ?? ''}`.trim())).toEqual([]);
  expect(sent.filter((command) => command.command === 'library_update_capture').map((command) => command.write))
    .toEqual([cancelledWrite(cancel.cancelled)]);
  expect(host.runtimeLog().slice(mark.runtimeLog)
    .filter((entry) => !(entry.method === 'GET' && entry.route === runtimeCapture))
    .map((entry) => `${entry.method} ${entry.route} ${entry.status}`)).toEqual([]);
}

const terminalStatuses = new Set(['completed', 'failed', 'canceled', 'awaiting_confirmation']);

/** The terminal library writes the page sent for the document, in order. */
function terminalWritesOf(host: JourneyHost, documentId: string): readonly LibraryWrite[] {
  return writesOf(host, documentId).filter((write) => terminalStatuses.has(write.status));
}

/** The one write that ends a cancelled attempt: cancelled, link cleared, nothing of the capture. */
function cancelledWrite(documentId: string): LibraryWrite {
  return { documentId, status: 'canceled', stage: 'cancelled', clearCaptureId: true };
}

/**
 * What the page sent after the reload that followed `mark`: everything after
 * the first navigation since then. A request of the earlier page comes
 * before that navigation, even when its answer comes after it.
 */
function sentAfterReload(host: JourneyHost, mark: JourneyMark): readonly PageCommand[] {
  const reload = host.commands.findIndex((command, index) => index >= mark.commands && command.event === 'navigated');
  expect(reload).toBeGreaterThanOrEqual(0);
  return host.commands.slice(reload + 1).filter((command) => command.event === 'sent');
}

/**
 * After the reload that followed `mark`, the new page asked the runtime to
 * delete the capture of the earlier page once, read nothing of it (status,
 * events, partial, raw, OCR, result) and wrote nothing for its row: the
 * capture is not this run's. `runtimeDeletes` are the answers of every
 * capture delete the runtime logged since `mark`. Taken as the logs are,
 * before the journey reads the runtime itself.
 */
function expectOnlyDeletedAfterReload(
  host: JourneyHost,
  mark: JourneyMark,
  earlier: { readonly captureId: string; readonly documentId: string; readonly runtimeDeletes: readonly number[] },
): void {
  const sent = sentAfterReload(host, mark);
  expect(sent.filter((command) => command.captureId === earlier.captureId).map((command) => command.command))
    .toEqual(['runtime_delete_capture']);
  expect(sent.filter((command) => command.write?.documentId === earlier.documentId)).toEqual([]);
  expect(host.runtimeLog().slice(mark.runtimeLog)
    .filter((entry) => entry.method === 'DELETE' && entry.route === runtimeCapture)
    .map((entry) => entry.status)).toEqual(earlier.runtimeDeletes);
}

/**
 * The turn passed only after the predecessor's terminal write: from
 * `successorFrom` on (by default from the start), the page sent nothing for
 * the successor before that write was answered, and when it sent the
 * successor's first command (a write for it or its capture create), the
 * predecessor's row (`predecessorFile`) showed `done` on the open page.
 */
function expectTurnAfterWrite(
  host: JourneyHost,
  turn: {
    readonly predecessor: string;
    readonly predecessorFile: string;
    readonly status: string;
    readonly successor: string;
    readonly successorFrom?: number;
  },
): void {
  const answered = host.commands.findIndex((command) => command.event === 'answered'
    && command.write?.documentId === turn.predecessor && command.write.status === turn.status);
  const successorFirst = host.commands.findIndex((command, index) => index >= (turn.successorFrom ?? 0)
    && command.event === 'sent'
    && (command.write?.documentId === turn.successor
      || (captureCreates.has(command.command) && command.documentId === turn.successor)));
  expect(answered).toBeGreaterThanOrEqual(0);
  expect(successorFirst).toBeGreaterThan(answered);
  const shown = host.commands[successorFirst]?.shown ?? [];
  expect(shown.filter((row) => row.text.includes(turn.predecessorFile)).map((row) => row.status)).toEqual(['done']);
}

async function deleteInHistory(page: Page, fileName: string): Promise<void> {
  const row = historyRow(page, fileName);
  await expect(row.getByTestId('history-row-delete')).toBeEnabled(settles);
  await row.getByTestId('history-row-delete').click();
  await expect(page.getByTestId('history-delete-dialog')).toContainText(fileName);
  await page.getByTestId('history-delete-confirm').click();
  await expect(row).toHaveCount(0, settles);
}

test('documents are captured one at a time in import order, recordings and documents together', async ({ page, host }) => {
  host.controlCaptures({ holdCaptures: true });
  const paths = [
    host.source('first-scan.pdf', twoPagePdf),
    host.source('middle-talk.wav', recording(['middle talk'])),
    host.source('last-scan.pdf', twoPagePdf),
  ];
  await openWorkbench(page, host, '/history');
  await dropFiles(page, host, paths);

  const firstCapture = await linkedCaptureId(host, 'first-scan.pdf');
  await expect.poll(() => stored(host, 'middle-talk.wav'), settles)
    .toEqual({ status: 'queued', captureId: null, hasRaw: false });
  expect(await stored(host, 'last-scan.pdf')).toEqual({ status: 'queued', captureId: null, hasRaw: false });
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(1);

  // Each queue shows its waiting row as waiting while the other kind's capture runs.
  await page.getByTestId('nav-ocr').click();
  await expect(ocrRow(page, 'first-scan.pdf')).toHaveAttribute('data-user-status', 'processing', settles);
  await expect(ocrRow(page, 'last-scan.pdf')).toHaveAttribute('data-user-status', 'waiting');
  await expect(ocrRow(page, 'last-scan.pdf').getByTestId('ocr-row-cancel')).toBeEnabled();
  await page.getByTestId('nav-asr').click();
  await expect(asrRow(page, 'middle-talk.wav')).toHaveAttribute('data-user-status', 'waiting');
  await expect(asrRow(page, 'middle-talk.wav').getByTestId('asr-row-cancel')).toBeEnabled();

  // Each predecessor's result write is held in turn: nothing else starts
  // meanwhile, and the next capture follows the answered write.
  const [first, middle, last] = await Promise.all(
    ['first-scan.pdf', 'middle-talk.wav', 'last-scan.pdf'].map((fileName) => documentIdOf(host, fileName)),
  ) as [string, string, string];
  const firstWrite = await holdLibraryWrite(page, (write) =>
    write.documentId === first && write.status === 'awaiting_confirmation');
  const middleWrite = await holdLibraryWrite(page, (write) =>
    write.documentId === middle && write.status === 'completed');
  host.controlCaptures({});
  await firstWrite.requested;
  await page.getByTestId('nav-ocr').click();
  await expect(ocrRow(page, 'first-scan.pdf')).toHaveAttribute('data-user-status', 'processing');
  // A wrong admission would start the next document within this time.
  await page.waitForTimeout(1_500);
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(1);
  expect(await stored(host, 'middle-talk.wav')).toEqual({ status: 'queued', captureId: null, hasRaw: false });

  await page.getByTestId('nav-history').click();
  await firstWrite.release();
  await middleWrite.requested;
  await expect(historyRow(page, 'first-scan.pdf')).toHaveAttribute('data-user-status', 'done');
  await expect(historyRow(page, 'middle-talk.wav')).toHaveAttribute('data-user-status', 'processing');
  // A wrong admission would start the last document within this time.
  await page.waitForTimeout(1_500);
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(2);
  expect(await stored(host, 'last-scan.pdf')).toEqual({ status: 'queued', captureId: null, hasRaw: false });
  expectTurnAfterWrite(host, {
    predecessor: first, predecessorFile: 'first-scan.pdf', status: 'awaiting_confirmation', successor: middle,
  });

  await middleWrite.release();
  await expect(historyRow(page, 'middle-talk.wav')).toHaveAttribute('data-user-status', 'done', settles);
  await expect(historyRow(page, 'last-scan.pdf')).toHaveAttribute('data-user-status', 'done', settles);
  expectTurnAfterWrite(host, {
    predecessor: middle, predecessorFile: 'middle-talk.wav', status: 'completed', successor: last,
  });

  expect(await storedWithStage(host, 'first-scan.pdf')).toEqual(storedCheckpoint);
  expect(await stored(host, 'middle-talk.wav')).toEqual({ status: 'completed', captureId: null, hasRaw: true });
  expect(await storedWithStage(host, 'last-scan.pdf')).toEqual(storedCheckpoint);
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(3);
  // Each capture was deleted at the runtime after its result was stored.
  await expect.poll(() => runtimeReadError(host, firstCapture), settles).toContain('404');
});

test('a document left waiting by an earlier page is captured when the app loads, without a queue page', async ({ page, host }) => {
  host.controlCaptures({ holdCaptures: true });
  await openWorkbench(page, host, '/ocr');
  await chooseFiles(page, host, 'ocr-choose-files', [
    host.source('running-scan.pdf', twoPagePdf),
    host.source('left-scan.pdf', twoPagePdf),
  ]);
  await expect(ocrRow(page, 'running-scan.pdf')).toHaveAttribute('data-user-status', 'processing', settles);
  await expect(ocrRow(page, 'left-scan.pdf')).toHaveAttribute('data-user-status', 'waiting');
  const runningCapture = await linkedCaptureId(host, 'running-scan.pdf');
  const running = await documentIdOf(host, 'running-scan.pdf');

  // The page ends; the next one opens on History, which is not a queue.
  await page.goto('about:blank');
  const reloaded = markNow(host);
  host.controlCaptures({});
  await openWorkbench(page, host, '/history');

  await expect(historyRow(page, 'left-scan.pdf')).toHaveAttribute('data-user-status', 'done', settles);
  await expect.poll(() => storedWithStage(host, 'left-scan.pdf'), settles).toEqual(storedCheckpoint);
  // The document the earlier page was capturing is interrupted, not followed.
  await expect(historyRow(page, 'running-scan.pdf')).toHaveAttribute('data-user-status', 'needs-attention');
  await expect(historyRow(page, 'running-scan.pdf')).toContainText('已中斷');
  expect(await stored(host, 'running-scan.pdf')).toEqual({ status: 'processing', captureId: runningCapture, hasRaw: false });
  // Two deletes: the earlier page's capture, and left-scan.pdf's after its result was stored.
  await expect(() => expectOnlyDeletedAfterReload(host, reloaded, {
    captureId: runningCapture, documentId: running, runtimeDeletes: [204, 204],
  })).toPass(settles);
  await expect.poll(() => runtimeReadError(host, runningCapture), settles).toContain('404');
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(2);
});

test('a reload while a recording runs leaves it interrupted, deleted at the runtime, and Start again captures it in its turn', async ({ page, host }) => {
  host.controlCaptures({ holdCaptures: true });
  await openWorkbench(page, host, '/asr');
  await chooseFiles(page, host, 'asr-choose-files', [
    host.source('interview.wav', recording(['first words heard', 'second words heard'])),
  ]);
  const row = asrRow(page, 'interview.wav');
  await expect(row).toHaveAttribute('data-user-status', 'processing', settles);
  await expect(page.getByTestId('asr-live-card')).toContainText('first words heard');
  const captureId = await linkedCaptureId(host, 'interview.wav');
  const interview = await documentIdOf(host, 'interview.wav');

  const reloaded = markNow(host);
  await page.reload();
  await expectRuntimeReady(page);
  await expect(row).toHaveAttribute('data-user-status', 'needs-attention', settles);
  await expect(row).toContainText('已中斷');
  await expect(row.getByTestId('asr-row-restart')).toBeVisible();
  await expect(row.getByTestId('asr-row-cancel')).toHaveCount(0);
  await expect(page.getByTestId('asr-live-card')).toHaveCount(0);
  // The new page asked the runtime once to delete the capture it does not
  // own, read nothing of it and wrote nothing at the start.
  await expect(() => expectOnlyDeletedAfterReload(host, reloaded, {
    captureId, documentId: interview, runtimeDeletes: [204],
  })).toPass(settles);
  // Only now the journey reads the runtime itself.
  expect(await runtimeReadError(host, captureId)).toContain('404');
  // The stored row keeps its state and link.
  expect(await stored(host, 'interview.wav')).toEqual({ status: 'processing', captureId, hasRaw: false });

  await page.getByTestId('nav-history').click();
  await expect(historyRow(page, 'interview.wav').getByTestId('history-row-delete')).toBeEnabled();
  await page.getByTestId('nav-asr').click();

  // Another recording runs; Start again makes the interrupted one wait for its turn.
  await chooseFiles(page, host, 'asr-choose-files', [host.source('later-talk.wav', recording(['later talk']))]);
  await expect(asrRow(page, 'later-talk.wav')).toHaveAttribute('data-user-status', 'processing', settles);
  await row.getByTestId('asr-row-restart').click();
  await expect(row).toHaveAttribute('data-user-status', 'waiting', settles);
  expect(await stored(host, 'interview.wav')).toEqual({ status: 'queued', captureId: null, hasRaw: false });
  // Commands after the stored Start again belong to the interview's next attempt.
  const startedAgain = host.commands.findIndex((command) => command.event === 'answered'
    && command.write?.documentId === interview && command.write.status === 'queued') + 1;
  expect(startedAgain).toBeGreaterThan(0);

  // later-talk.wav's result write is held: the interview waits meanwhile.
  const later = await documentIdOf(host, 'later-talk.wav');
  const laterWrite = await holdLibraryWrite(page, (write) => write.documentId === later && write.status === 'completed');
  host.controlCaptures({});
  await laterWrite.requested;
  // A wrong admission would start the interview within this time.
  await page.waitForTimeout(1_500);
  await expect(row).toHaveAttribute('data-user-status', 'waiting');
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(2);
  await laterWrite.release();
  await expect(asrRow(page, 'later-talk.wav')).toHaveAttribute('data-user-status', 'done', settles);
  await expect(row).toHaveAttribute('data-user-status', 'done', settles);
  await expect.poll(() => stored(host, 'interview.wav'), settles)
    .toEqual({ status: 'completed', captureId: null, hasRaw: true });
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(3);
  expect(host.runtimeRequests('POST', runtimeCancel)).toHaveLength(0);
  // The two attempts ran in turn: the interview's began after later-talk.wav's result write was answered.
  expectTurnAfterWrite(host, {
    predecessor: later, predecessorFile: 'later-talk.wav', status: 'completed',
    successor: interview, successorFrom: startedAgain,
  });
});

test('Cancel of the running recording sends one runtime delete, stores it cancelled and starts the next one', async ({ page, host }) => {
  host.controlCaptures({ holdCaptures: true });
  await openWorkbench(page, host, '/asr');
  await chooseFiles(page, host, 'asr-choose-files', [
    host.source('first-talk.wav', recording(['first talk'])),
    host.source('second-talk.wav', recording(['second talk'])),
  ]);
  const firstRow = asrRow(page, 'first-talk.wav');
  const secondRow = asrRow(page, 'second-talk.wav');
  await expect(firstRow).toHaveAttribute('data-user-status', 'processing', settles);
  await expect(secondRow).toHaveAttribute('data-user-status', 'waiting');
  await expect(page.getByTestId('asr-live-card')).toContainText('first talk');
  const firstCapture = await linkedCaptureId(host, 'first-talk.wav');

  await firstRow.getByTestId('asr-row-cancel').click();
  await expect(firstRow).toHaveAttribute('data-user-status', 'cancelled', settles);
  await expect(firstRow.getByTestId('asr-row-restart')).toBeVisible();
  await expect.poll(() => stored(host, 'first-talk.wav'), settles)
    .toEqual({ status: 'canceled', captureId: null, hasRaw: false });
  expect((await host.document('first-talk.wav'))?.stage).toBe('cancelled');
  const firstId = await documentIdOf(host, 'first-talk.wav');
  expect(terminalWritesOf(host, firstId)).toEqual([cancelledWrite(firstId)]);
  expect(host.runtimeRequests('DELETE', runtimeCapture).map((entry) => entry.status)).toEqual([204]);
  expect(host.runtimeRequests('POST', runtimeCancel)).toHaveLength(0);
  expect(await runtimeReadError(host, firstCapture)).toContain('404');

  await expect(secondRow).toHaveAttribute('data-user-status', 'processing', settles);
  await expect(page.getByTestId('asr-live-card')).toContainText('second talk');
  await expect(page.getByTestId('asr-live-card')).not.toContainText('first talk');
  host.controlCaptures({});
  await expect(secondRow).toHaveAttribute('data-user-status', 'done', settles);
  await expect(firstRow).toHaveAttribute('data-user-status', 'cancelled');
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(2);
  // No second terminal write came for the cancelled recording.
  expect(terminalWritesOf(host, firstId)).toEqual([cancelledWrite(firstId)]);
  expect(writesOf(host, firstId).filter((write) => write.raw !== undefined)).toEqual([]);
});

test('Cancel stores a running document cancelled although the runtime refuses the delete, and Start again captures it later', async ({ page, host }) => {
  host.controlCaptures({ holdCaptures: true, deleteUnavailable: true });
  await openWorkbench(page, host, '/ocr');
  await chooseFiles(page, host, 'ocr-choose-files', [host.source('refused-scan.pdf', twoPagePdf)]);
  const row = ocrRow(page, 'refused-scan.pdf');
  await expect(row).toHaveAttribute('data-user-status', 'processing', settles);
  const captureId = await linkedCaptureId(host, 'refused-scan.pdf');

  await row.getByTestId('ocr-row-cancel').click();
  await expect(row).toHaveAttribute('data-user-status', 'cancelled', settles);
  await expect.poll(() => stored(host, 'refused-scan.pdf'), settles)
    .toEqual({ status: 'canceled', captureId: null, hasRaw: false });
  const refused = await documentIdOf(host, 'refused-scan.pdf');
  expect(terminalWritesOf(host, refused)).toEqual([cancelledWrite(refused)]);
  expect(host.runtimeRequests('DELETE', runtimeCapture).map((entry) => entry.status)).toEqual([503]);
  expect(host.runtimeRequests('POST', runtimeCancel)).toHaveLength(0);
  // The accepted leftover: the runtime still has the capture.
  expect(await runtimeReadError(host, captureId)).toBe('');

  host.controlCaptures({});
  await row.getByTestId('ocr-row-restart').click();
  await expect(row).toHaveAttribute('data-user-status', 'done', settles);
  await expect.poll(() => storedWithStage(host, 'refused-scan.pdf'), settles).toEqual(storedCheckpoint);
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(2);
  // The cancelled attempt wrote no second terminal write; the next one wrote its own.
  expect(terminalWritesOf(host, refused).map((write) => write.status)).toEqual(['canceled', 'awaiting_confirmation']);
});

test('Cancel of waiting rows in both queues stores them cancelled and they are never created at the runtime', async ({ page, host }) => {
  host.controlCaptures({ holdCaptures: true });
  await openWorkbench(page, host, '/history');
  await dropFiles(page, host, [
    host.source('running-scan.pdf', twoPagePdf),
    host.source('waiting-talk.wav', recording(['waiting talk'])),
    host.source('waiting-scan.pdf', twoPagePdf),
  ]);
  const runningCapture = await linkedCaptureId(host, 'running-scan.pdf');

  // Each Cancel, while the running capture is held, is one library write and
  // causes no runtime request: only the running capture's status is read
  // meanwhile, by the page and at the runtime.
  await page.getByTestId('nav-ocr').click();
  await expect(ocrRow(page, 'running-scan.pdf')).toHaveAttribute('data-user-status', 'processing', settles);
  const waitingScan = ocrRow(page, 'waiting-scan.pdf');
  await expect(waitingScan).toHaveAttribute('data-user-status', 'waiting');
  const beforeScanCancel = markNow(host);
  await waitingScan.getByTestId('ocr-row-cancel').click();
  await expect(waitingScan).toHaveAttribute('data-user-status', 'cancelled', settles);
  await expect.poll(() => stored(host, 'waiting-scan.pdf'), settles)
    .toEqual({ status: 'canceled', captureId: null, hasRaw: false });
  expectOnlyCancelOfWaitingSince(host, beforeScanCancel, {
    runningCapture, cancelled: await documentIdOf(host, 'waiting-scan.pdf'),
  });

  await page.getByTestId('nav-asr').click();
  const waitingTalk = asrRow(page, 'waiting-talk.wav');
  await expect(waitingTalk).toHaveAttribute('data-user-status', 'waiting');
  const beforeTalkCancel = markNow(host);
  await waitingTalk.getByTestId('asr-row-cancel').click();
  await expect(waitingTalk).toHaveAttribute('data-user-status', 'cancelled', settles);
  await expect.poll(() => stored(host, 'waiting-talk.wav'), settles)
    .toEqual({ status: 'canceled', captureId: null, hasRaw: false });
  expectOnlyCancelOfWaitingSince(host, beforeTalkCancel, {
    runningCapture, cancelled: await documentIdOf(host, 'waiting-talk.wav'),
  });

  for (const fileName of ['waiting-scan.pdf', 'waiting-talk.wav']) {
    const documentId = await documentIdOf(host, fileName);
    expect(terminalWritesOf(host, documentId)).toEqual([cancelledWrite(documentId)]);
  }
  host.controlCaptures({});
  await page.getByTestId('nav-ocr').click();
  await expect(ocrRow(page, 'running-scan.pdf')).toHaveAttribute('data-user-status', 'done', settles);
  // The page reloads and the admission looks again: the cancelled rows stay cancelled.
  await page.reload();
  await expectRuntimeReady(page);
  await expect(waitingScan).toHaveAttribute('data-user-status', 'cancelled');
  // An admission that took a cancelled row would create its capture within this time.
  await page.waitForTimeout(1_500);
  for (const fileName of ['waiting-scan.pdf', 'waiting-talk.wav']) {
    expect(await stored(host, fileName)).toEqual({ status: 'canceled', captureId: null, hasRaw: false });
  }
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(1);
  expect(host.runtimeRequests('POST', runtimeIngestions)).toHaveLength(1);
  expect(host.runtimeRequests('POST', runtimeCancel)).toHaveLength(0);
});

test('a document that failed keeps nothing of the capture, and Start again stores the new result in one write', async ({ page, host }) => {
  host.controlCaptures({ failCaptures: true });
  await openWorkbench(page, host, '/ocr');
  await chooseFiles(page, host, 'ocr-choose-files', [host.source('failing-scan.pdf', twoPagePdf)]);
  const row = ocrRow(page, 'failing-scan.pdf');
  await expect(row).toHaveAttribute('data-user-status', 'needs-attention', settles);
  await expect(row.getByTestId('ocr-row-restart')).toBeVisible();
  await expect(row.getByTestId('ocr-row-view')).toHaveCount(0);
  await expect.poll(() => stored(host, 'failing-scan.pdf'), settles)
    .toEqual({ status: 'failed', captureId: null, hasRaw: false });
  const failed = await host.detail('failing-scan.pdf');
  // The host answers a field it does not hold with null.
  expect(failed.raw ?? null).toBeNull();
  expect(failed.ocrEvidence ?? null).toBeNull();
  const documentId = failed.documentId;
  const writesBefore = writesOf(host, documentId).length;

  host.controlCaptures({});
  await row.getByTestId('ocr-row-restart').click();
  await expect(row).toHaveAttribute('data-user-status', 'done', settles);
  await expect.poll(() => storedWithStage(host, 'failing-scan.pdf'), settles).toEqual(storedCheckpoint);

  const again = writesOf(host, documentId).slice(writesBefore);
  const secondCapture = again.find((write) => write.captureId !== undefined)?.captureId;
  expect(secondCapture).toBeTruthy();
  expect(again.map((write) => [write.status, write.captureId !== undefined, write.raw !== undefined])).toEqual([
    ['queued', false, false],
    ['processing', false, false],
    ['processing', true, false],
    ['awaiting_confirmation', false, true],
  ]);
  const resultWrite = again.at(-1);
  expect(resultWrite?.clearCaptureId).toBe(true);
  expect(resultWrite?.stage).toBe('awaiting_structuring');
  expect(resultWrite?.ocrEvidence).toMatchObject({ captureId: secondCapture, status: 'completed' });
  const done = await host.detail('failing-scan.pdf');
  expect(done.raw).toBeTruthy();
  expect(done.ocrEvidence).toMatchObject({ captureId: secondCapture, status: 'completed' });
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(2);
});

test('a row that holds a result offers View and Delete, never Start again', async ({ page, host }) => {
  await openWorkbench(page, host, '/ocr');
  await chooseFiles(page, host, 'ocr-choose-files', [host.source('finished-scan.pdf', twoPagePdf)]);
  await expect(ocrRow(page, 'finished-scan.pdf')).toHaveAttribute('data-user-status', 'done', settles);
  await page.getByTestId('nav-asr').click();
  await chooseFiles(page, host, 'asr-choose-files', [host.source('finished-talk.wav', recording(['finished talk']))]);
  await expect(asrRow(page, 'finished-talk.wav')).toHaveAttribute('data-user-status', 'done', settles);

  // Also on a later page, which owns neither of them.
  await page.reload();
  await expectRuntimeReady(page);
  // Both rows hold their raw text and link no capture.
  expect(await storedWithStage(host, 'finished-scan.pdf')).toEqual(storedCheckpoint);
  expect(await stored(host, 'finished-talk.wav')).toEqual({ status: 'completed', captureId: null, hasRaw: true });
  for (const fileName of ['finished-scan.pdf', 'finished-talk.wav']) {
    expect((await host.detail(fileName)).raw).toBeTruthy();
  }
  const talk = asrRow(page, 'finished-talk.wav');
  await expect(talk).toHaveAttribute('data-user-status', 'done');
  await expect(talk.getByTestId('asr-row-view')).toBeVisible();
  await expect(talk.getByTestId('asr-row-restart')).toHaveCount(0);
  await expect(talk.getByTestId('asr-row-cancel')).toHaveCount(0);
  await page.getByTestId('nav-ocr').click();
  const scan = ocrRow(page, 'finished-scan.pdf');
  await expect(scan).toHaveAttribute('data-user-status', 'done');
  await expect(scan.getByTestId('ocr-row-view')).toBeVisible();
  await expect(scan.getByTestId('ocr-row-restart')).toHaveCount(0);
  await expect(scan.getByTestId('ocr-row-cancel')).toHaveCount(0);
  await page.getByTestId('nav-history').click();
  for (const fileName of ['finished-scan.pdf', 'finished-talk.wav']) {
    await expect(historyRow(page, fileName).getByTestId('history-row-view')).toBeEnabled();
    await expect(historyRow(page, fileName).getByTestId('history-row-delete')).toBeEnabled();
  }
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(2);
});

test('History deletes every row this run is not working on, with its files, and the capture an interrupted row still names', async ({ page, host }) => {
  host.controlCaptures({ failCaptures: true });
  await openWorkbench(page, host, '/ocr');
  await chooseFiles(page, host, 'ocr-choose-files', [host.source('failed-scan.pdf', twoPagePdf)]);
  await expect(ocrRow(page, 'failed-scan.pdf')).toHaveAttribute('data-user-status', 'needs-attention', settles);
  host.controlCaptures({});
  await chooseFiles(page, host, 'ocr-choose-files', [host.source('done-scan.pdf', twoPagePdf)]);
  await expect(ocrRow(page, 'done-scan.pdf')).toHaveAttribute('data-user-status', 'done', settles);

  // An interrupted recording whose capture the startup delete could not remove.
  host.controlCaptures({ holdCaptures: true });
  await page.getByTestId('nav-asr').click();
  await chooseFiles(page, host, 'asr-choose-files', [host.source('interrupted-talk.wav', recording(['interrupted talk']))]);
  await expect(asrRow(page, 'interrupted-talk.wav')).toHaveAttribute('data-user-status', 'processing', settles);
  const interruptedCapture = await linkedCaptureId(host, 'interrupted-talk.wav');
  const interrupted = await documentIdOf(host, 'interrupted-talk.wav');
  host.controlCaptures({ holdCaptures: true, deleteUnavailable: true });
  const reloaded = markNow(host);
  await page.reload();
  await expectRuntimeReady(page);
  await expect(asrRow(page, 'interrupted-talk.wav')).toHaveAttribute('data-user-status', 'needs-attention', settles);
  await expect(() => expectOnlyDeletedAfterReload(host, reloaded, {
    captureId: interruptedCapture, documentId: interrupted, runtimeDeletes: [503],
  })).toPass(settles);
  // Only now the journey reads the runtime itself.
  expect(await runtimeReadError(host, interruptedCapture)).toBe('');
  expect(await stored(host, 'interrupted-talk.wav'))
    .toEqual({ status: 'processing', captureId: interruptedCapture, hasRaw: false });

  // A running, a waiting and a cancelled document.
  host.controlCaptures({ holdCaptures: true });
  await page.getByTestId('nav-ocr').click();
  await chooseFiles(page, host, 'ocr-choose-files', [
    host.source('running-scan.pdf', twoPagePdf),
    host.source('waiting-scan.pdf', twoPagePdf),
    host.source('cancelled-scan.pdf', twoPagePdf),
  ]);
  await expect(ocrRow(page, 'running-scan.pdf')).toHaveAttribute('data-user-status', 'processing', settles);
  await ocrRow(page, 'cancelled-scan.pdf').getByTestId('ocr-row-cancel').click();
  await expect(ocrRow(page, 'cancelled-scan.pdf')).toHaveAttribute('data-user-status', 'cancelled', settles);
  await expect(ocrRow(page, 'waiting-scan.pdf')).toHaveAttribute('data-user-status', 'waiting');

  await page.getByTestId('nav-history').click();
  await expect(historyRow(page, 'running-scan.pdf').getByTestId('history-row-delete')).toBeDisabled();
  const deletesBefore = host.runtimeRequests('DELETE', runtimeCapture).length;
  for (const fileName of ['waiting-scan.pdf', 'cancelled-scan.pdf', 'failed-scan.pdf', 'done-scan.pdf']) {
    const documentId = await documentIdOf(host, fileName);
    expect(host.hasFiles(documentId)).toBe(true);
    await deleteInHistory(page, fileName);
    expect(await host.document(fileName)).toBeUndefined();
    expect(host.hasFiles(documentId)).toBe(false);
  }
  // None of them named a capture: the runtime was not asked.
  expect(host.runtimeRequests('DELETE', runtimeCapture)).toHaveLength(deletesBefore);

  await deleteInHistory(page, 'interrupted-talk.wav');
  expect(await host.document('interrupted-talk.wav')).toBeUndefined();
  expect(host.hasFiles(interrupted)).toBe(false);
  await expect.poll(() => host.runtimeRequests('DELETE', runtimeCapture).slice(deletesBefore)
    .map((entry) => entry.status), settles).toEqual([204]);
  expect(await runtimeReadError(host, interruptedCapture)).toContain('404');

  // The running document was not touched, and ends as usual.
  host.controlCaptures({});
  await expect(historyRow(page, 'running-scan.pdf')).toHaveAttribute('data-user-status', 'done', settles);
  await expect(historyRow(page, 'running-scan.pdf').getByTestId('history-row-delete')).toBeEnabled();
});

test('a result write the page sees answered with a host error (the journey answers it) leaves the row interrupted with that error; nothing retries, the next document is captured, Start again captures it', async ({ page, host }) => {
  // What this proves is the page's behaviour on the real host when its result
  // write is answered with an error. The dev host has no seam that makes a
  // library write fail, so the journey answers the page's request for the
  // first result write itself; the host never receives that write. That the
  // service sends exactly one terminal write and retries nothing is pinned by
  // the unit tests of a failed terminal write in desktop-capture.service.spec.ts.
  let refused = false;
  const refusal = 'Capture library index cannot be written: the disk is full.';
  await page.route('**/__host/invoke/library_update_capture', async (route) => {
    const write = (route.request().postDataJSON() as { readonly update: LibraryWrite }).update;
    if (refused || write.status !== 'awaiting_confirmation') {
      await route.continue();
      return;
    }
    refused = true;
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: refusal }),
    });
  });
  await openWorkbench(page, host, '/ocr');
  await chooseFiles(page, host, 'ocr-choose-files', [
    host.source('unsaved-scan.pdf', twoPagePdf),
    host.source('next-scan.pdf', twoPagePdf),
  ]);
  const row = ocrRow(page, 'unsaved-scan.pdf');
  await expect(row).toHaveAttribute('data-user-status', 'needs-attention', settles);
  await expect(row).toContainText('已中斷');
  // The row says why, in the host's words; the page shows no error line of its own.
  await expect(row.getByTestId('ocr-row-reason')).toHaveText(refusal);
  await expect(page.getByText(refusal)).toHaveCount(1);
  await expect(row.getByTestId('ocr-row-restart')).toBeVisible();
  await expect(row.getByTestId('ocr-row-cancel')).toHaveCount(0);
  const unsavedCapture = await storedLink(host, 'unsaved-scan.pdf');
  expect(unsavedCapture).toBeTruthy();
  expect(await stored(host, 'unsaved-scan.pdf')).toEqual({ status: 'processing', captureId: unsavedCapture, hasRaw: false });
  // The capture is deleted after the write, whatever the write's outcome.
  await expect.poll(() => runtimeReadError(host, unsavedCapture), settles).toContain('404');

  // Nothing retries the write, and the next document is not held up.
  await expect(ocrRow(page, 'next-scan.pdf')).toHaveAttribute('data-user-status', 'done', settles);
  // A write tried again by itself would reach the host within this time.
  await page.waitForTimeout(1_500);
  expect(await stored(host, 'unsaved-scan.pdf')).toEqual({ status: 'processing', captureId: unsavedCapture, hasRaw: false });
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(2);

  // History and the result view say the same, without a page load.
  await page.getByTestId('nav-history').click();
  await expect(historyRow(page, 'unsaved-scan.pdf').getByTestId('history-row-reason')).toHaveText(refusal);
  await historyRow(page, 'unsaved-scan.pdf').getByTestId('history-row-view').click();
  await expect(page.getByTestId('result-pending-status')).toHaveText('已中斷');
  await expect(page.getByTestId('result-no-result')).toContainText(refusal);
  await page.getByTestId('nav-ocr').click();

  await row.getByTestId('ocr-row-restart').click();
  await expect(row).toHaveAttribute('data-user-status', 'done', settles);
  // Start again was stored: the row keeps no error of the earlier attempt.
  await expect(row.getByTestId('ocr-row-reason')).toHaveCount(0);
  await expect.poll(() => storedWithStage(host, 'unsaved-scan.pdf'), settles).toEqual(storedCheckpoint);
  expect(host.runtimeRequests('POST', runtimeCaptures)).toHaveLength(3);
});
