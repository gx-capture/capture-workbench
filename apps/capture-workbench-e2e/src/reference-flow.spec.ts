// Browser reference flow (CI): the reference app in a browser with a fake
// Tauri bridge and scripted runtime responses. It checks the Traditional
// Chinese shell navigation, first-run recognition card, the OCR queue
// (drop, install, page progress, raw .txt, waiting file across reload),
// ASR-only journey, install/cancel/retry lifecycle, reload re-attachment,
// and the history queue.
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
// eslint-disable-next-line @nx/enforce-module-boundaries -- repository browser fixture shares release intent.
import { RELEASE_VERSION } from '../../../tools/release/release-intent.ts';

test('navigates the Traditional Chinese shell to each page from the left navigation', async ({ page }) => {
  await openDesktop(page, [], '/');

  await expect(page).toHaveURL(/\/ocr$/u);
  const nav = page.getByRole('navigation', { name: '主要功能' });
  await expect(nav.getByRole('link')).toHaveText(['文件轉文字', '錄音轉逐字稿', '紀錄', '設定']);
  await expect(nav.getByTestId('runtime-status')).toHaveText('已就緒');
  await expect(nav.getByTestId('runtime-status')).toHaveAttribute('data-state', 'ready');

  const pages = [
    { link: '錄音轉逐字稿', path: /\/asr$/u, heading: '錄音轉逐字稿' },
    { link: '紀錄', path: /\/history$/u, heading: '文件擷取工作台' },
    { link: '設定', path: /\/settings\/engines$/u, heading: '設定' },
    { link: '文件轉文字', path: /\/ocr$/u, heading: '文件轉文字' },
  ];
  for (const target of pages) {
    await nav.getByRole('link', { name: target.link }).click();
    await expect(page).toHaveURL(target.path);
    await expect(nav.getByRole('link', { name: target.link })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1, name: target.heading })).toBeVisible();
  }

  await expect(page.getByTestId('ocr-dropzone')).toBeVisible();
  await expect(page.getByRole('link', { name: '前往紀錄加入文件' })).toHaveCount(0);
  await nav.getByRole('link', { name: '紀錄' }).click();
  await expect(page).toHaveURL(/\/history$/u);
  await expect(page.getByText('history.pdf')).toBeVisible();
});

test('drops a PDF without OCR, installs it, and exports the raw text', async ({ page }) => {
  await openDesktop(
    page,
    [requirement('windowsml-ocr', 'WindowsML OCR', 'installable', 144_000_000)],
    '/ocr',
    { completeInstallOnPoll: 2, ocrJourney: true, runtimeVersion: '0.9.0' },
  );

  await page.getByTestId('first-run-dismiss').click();
  await dropPdf(page, 'charge.pdf');

  const row = page.locator('[data-testid="ocr-queue-row"]', { hasText: 'charge.pdf' });
  await expect(row).toHaveAttribute('data-user-status', 'waiting');
  await expect(row.getByTestId('ocr-row-status')).toContainText('需要文字辨識（約 144 MB）');
  await row.getByTestId('ocr-row-install').click();

  await expect(row.getByTestId('ocr-row-progress')).toContainText('第 9/12 頁', { timeout: 15_000 });
  await expect(row).toHaveAttribute('data-user-status', 'done', { timeout: 15_000 });
  await expect(row.getByTestId('ocr-row-status')).toContainText('完成');

  const downloadPromise = page.waitForEvent('download');
  await row.getByTestId('ocr-row-export-txt').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('charge.txt');
  const saved = await download.path();
  if (!saved) throw new Error('download path missing');
  expect(await readFile(saved, 'utf8')).toBe('第一頁\n\n第二頁');
});

test('keeps a waiting OCR file after the window reloads', async ({ page }) => {
  await openDesktop(
    page,
    [requirement('windowsml-ocr', 'WindowsML OCR', 'installable', 144_000_000)],
    '/ocr',
    { persistLibrary: true },
  );

  await page.getByTestId('first-run-dismiss').click();
  await dropPdf(page, 'charge.pdf');

  const row = page.locator('[data-testid="ocr-queue-row"]', { hasText: 'charge.pdf' });
  await expect(row).toHaveAttribute('data-user-status', 'waiting');
  await expect(row.getByTestId('ocr-row-status')).toContainText('等待中');

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '文件轉文字' })).toBeVisible();
  const reloaded = page.locator('[data-testid="ocr-queue-row"]', { hasText: 'charge.pdf' });
  await expect(reloaded).toHaveAttribute('data-user-status', 'waiting');
  await expect(reloaded.getByTestId('ocr-row-install')).toBeVisible();
});

test('shows the first-run recognition card on /ocr and remembers dismissing it across reloads', async ({ page }) => {
  await openDesktop(
    page,
    [
      requirement('windowsml-ocr', 'WindowsML OCR', 'installable', 144_000_000),
      requirement('speech-recognition', '本機語音轉文字', 'installable', 2_800_000_000),
      requirement('speaker-diarization', '說話者辨識', 'installable', 300_000_000),
    ],
    '/ocr',
  );

  const card = page.getByTestId('first-run-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: '需要時再安裝辨識功能' })).toBeVisible();
  await expect(card.getByTestId('first-run-size-ocr')).toHaveText('約 144 MB');
  await expect(card.getByTestId('first-run-size-asr')).toHaveText('約 2.8 GB');
  await expect(card.getByTestId('first-run-size-speakers')).toHaveText('約 300 MB');
  await expect(card.getByTestId('first-run-install')).toHaveText('安裝所選（約 144 MB）');

  await card.getByTestId('first-run-dismiss').click();
  await expect(card).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '文件轉文字' })).toBeVisible();
  await expect(page.getByTestId('first-run-card')).toHaveCount(0);
});

test('lets an ASR-only user install speech recognition on /asr without ever requiring OCR', async ({ page }) => {
  await openDesktop(
    page,
    [
      requirement('windowsml-ocr', 'WindowsML OCR', 'installable', 144_000_000),
      requirement('speech-recognition', '本機語音轉文字', 'installable', 2_800_000_000),
      requirement('speaker-diarization', '說話者辨識', 'installable', 300_000_000),
    ],
    '/asr',
    { completeInstallOnPoll: 2 },
  );

  await expect(page.getByTestId('runtime-status')).toHaveAttribute('data-state', 'ready');
  const panel = page.getByTestId('asr-install-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('link', { name: '前往紀錄加入錄音' })).toHaveCount(0);
  await expect(panel.getByText('WindowsML OCR')).toHaveCount(0);

  const speechCard = panel.locator('[data-testid="engine-card"][data-requirement-id="speech-recognition"]');
  await expect(speechCard.getByTestId('engine-card-install')).toHaveText('安裝（約 2.8 GB）');
  await speechCard.getByTestId('engine-card-install').click();

  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('link', { name: '前往紀錄加入錄音' })).toBeVisible();

  const startedIds = await page.evaluate(() => {
    const target = globalThis as unknown as {
      readonly __captureStartedRequirementIds: readonly string[];
    };
    return target.__captureStartedRequirementIds;
  });
  expect(startedIds).toEqual(['speech-recognition']);
});

test('shows the size, then progress, cancel and retry on /settings/engines', async ({ page }) => {
  await openDesktop(
    page,
    [
      requirement('windowsml-ocr', 'WindowsML OCR', 'ready', 144_000_000),
      requirement('speech-recognition', '本機語音轉文字', 'installable', 2_800_000_000),
      requirement('speaker-diarization', '說話者辨識', 'installable', 300_000_000),
    ],
    '/settings/engines',
    { holdRunningUntilCancel: true },
  );

  const table = page.getByTestId('engines-table');
  await expect(table.locator('thead th')).toHaveText(['功能', '狀態', '大小', '用途', '動作']);
  await expect(page.getByRole('button', { name: '移除' })).toHaveCount(0);

  const speechRow = table.locator('[data-testid="engine-row"][data-requirement-id="speech-recognition"]');
  await speechRow.getByTestId('engine-row-toggle').click();
  await expect(
    table.locator('[data-testid="engine-row-details"][data-requirement-id="speech-recognition"]'),
  ).toContainText('TEA-ASR 1.1');

  await expect(speechRow.getByTestId('engine-row-install')).toHaveText('安裝（約 2.8 GB）');
  await speechRow.getByTestId('engine-row-install').click();

  await expect(speechRow.getByTestId('engine-row-progress')).toContainText('正在下載 50%');
  await speechRow.getByTestId('engine-row-cancel').click();

  await expect(speechRow.getByTestId('engine-row-retry')).toHaveText('再試一次');
  await speechRow.getByTestId('engine-row-retry').click();

  await expect(speechRow).toHaveAttribute('data-status', 'ready');
  await expect(speechRow.getByTestId('engine-row-status')).toContainText('已安裝');

  const commands = await page.evaluate(() => {
    const target = globalThis as unknown as {
      readonly __captureInvokedCommands: readonly string[];
    };
    return target.__captureInvokedCommands;
  });
  expect(commands).toContain('runtime_list_installations');
  expect(commands).toContain('runtime_cancel_installation');
});

test('re-attaches to an in-progress installation returned by runtime_list_installations on start', async ({ page }) => {
  await openDesktop(
    page,
    [
      requirement('windowsml-ocr', 'WindowsML OCR', 'installable', 144_000_000),
      requirement('speech-recognition', '本機語音轉文字', 'installable', 2_800_000_000),
    ],
    '/settings/engines',
    {
      initialRunningInstallations: [
        {
          installationId: 'inst-reattach-1',
          requirementId: 'speech-recognition',
          status: 'running',
          progress: 0.5,
          downloadedBytes: 1_400_000_000,
          downloadBytes: 2_800_000_000,
          createdAt: '2026-11-03T00:00:00Z',
          updatedAt: '2026-11-03T00:00:00Z',
        },
      ],
      completeInstallOnPoll: 2,
    },
  );

  const speechRow = page.locator('[data-testid="engine-row"][data-requirement-id="speech-recognition"]');
  await expect(speechRow).toHaveAttribute('data-status', 'ready');
  await expect(speechRow.getByTestId('engine-row-status')).toContainText('已安裝');
});

test('renders the desktop queue and history filter through the authenticated runtime client', async ({ page }) => {
  await openDesktop(page, []);

  await expect(page.getByText('已就緒', { exact: true })).toBeVisible();
  await expect(page.getByText('history.pdf')).toBeVisible();
  await expect(page.getByText('Ollama · qwen3.5:0.8b')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '處理狀態' })).toBeVisible();
  await expect(page.getByRole('button', { name: '選擇檔案' })).toBeEnabled();
  await page.getByLabel('搜尋文件').fill('not-a-file');
  await expect(page.getByText('history.pdf')).toHaveCount(0);
  await page.getByLabel('搜尋文件').fill('history');
  await expect(page.getByText('history.pdf')).toBeVisible();

  const commands = await page.evaluate(() => {
    const target = globalThis as unknown as {
      readonly __captureInvokedCommands: readonly string[];
    };
    return target.__captureInvokedCommands;
  });
  expect(commands).toContain('desktop_runtime_status');
  expect(commands).toContain('runtime_requirements');
  expect(commands).toContain('runtime_list_installations');
  expect(commands).not.toContain('backend_config');
  expect(commands).toContain('library_list');
});

test('does not run a deterministic provider in an unconfigured browser', async ({ page }) => {
  await page.goto('/history');

  await expect(page.getByRole('heading', { name: '文件擷取工作台' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Windows 桌面 App');
  await expect(page.getByText(/deterministic/i)).toHaveCount(0);
});

interface OpenDesktopOptions {
  readonly completeInstallOnPoll?: number;
  readonly holdRunningUntilCancel?: boolean;
  readonly initialRunningInstallations?: readonly Record<string, unknown>[];
  /** Script capture commands so one OCR file can reach raw text. */
  readonly ocrJourney?: boolean;
  /** Keep the fake library in sessionStorage so a reload still lists it. */
  readonly persistLibrary?: boolean;
  /** Overrides the runtime version the fake reports. The OCR journey uses 0.9.0. */
  readonly runtimeVersion?: string;
}

async function openDesktop(
  page: Page,
  requirements: readonly Record<string, unknown>[],
  path = '/history',
  options: OpenDesktopOptions = {},
): Promise<void> {
  await page.addInitScript(({ runtimeRequirements, runtimeVersion, installOptions }) => {
    interface TauriTestGlobal {
      isTauri: boolean;
      __captureInvokedCommands: string[];
      __captureStartedRequirementIds: string[];
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown) => Promise<unknown>;
        metadata: {
          currentWindow: { label: string };
          currentWebview: { label: string };
        };
        transformCallback: (...args: unknown[]) => number;
      };
      __captureEmitTauriEvent?: (event: string, payload: unknown) => void;
      __captureTauriListenerCount?: (event: string) => number;
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (event: string, eventId: number) => void;
      };
    }
    const target = globalThis as unknown as TauriTestGlobal;
    let nextCallbackId = 1;
    let nextEventId = 1;
    let nextInstallSeq = 1;
    const callbacks = new Map<number, (eventData: unknown) => void>();
    const listeners = new Map<string, number[]>();
    const mutableRequirements = runtimeRequirements.map((item) => ({ ...item }));
    const installations = new Map<string, Record<string, unknown>>();
    const pollCounts = new Map<string, number>();
    let cancelledOnce = false;
    const historyId = 'a'.repeat(32);
    const libraryKey = 'capture-workbench.e2e-ocr-library';
    interface StoredDoc {
      documentId: string;
      fileName: string;
      mediaType: string;
      byteLength: number;
      createdAtMs: number;
      updatedAtMs: number;
      status: string;
      stage?: string;
      captureId?: string;
      captureOptions?: Record<string, unknown>;
      hasRaw?: boolean;
    }
    const historyDocument = (): StoredDoc => ({
      documentId: historyId,
      fileName: 'history.pdf',
      mediaType: 'application/pdf',
      byteLength: 2048,
      createdAtMs: 1,
      updatedAtMs: 1,
      status: 'completed',
      stage: 'completed',
    });
    let documents: StoredDoc[] = [historyDocument()];
    const rawByDocument = new Map<string, unknown>();
    const rememberLibrary = (): void => {
      if (!installOptions.persistLibrary) return;
      sessionStorage.setItem(libraryKey, JSON.stringify({
        documents,
        raw: [...rawByDocument.entries()],
      }));
    };
    if (installOptions.persistLibrary) {
      try {
        const stored = sessionStorage.getItem(libraryKey);
        if (stored) {
          const parsed = JSON.parse(stored) as {
            documents?: StoredDoc[];
            raw?: readonly (readonly [string, unknown])[];
          };
          if (Array.isArray(parsed.documents) && parsed.documents.length > 0) {
            documents = parsed.documents;
          }
          for (const entry of parsed.raw ?? []) {
            if (Array.isArray(entry) && typeof entry[0] === 'string') {
              rawByDocument.set(entry[0], entry[1]);
            }
          }
        }
      } catch {
        documents = [historyDocument()];
        rawByDocument.clear();
      }
      if (!documents.some((item) => item.documentId === historyId)) {
        documents = [historyDocument(), ...documents];
      }
    }
    const listedSummary = (document: StoredDoc): StoredDoc => {
      const hasRaw = rawByDocument.has(document.documentId) || document.hasRaw === true;
      return hasRaw ? { ...document, hasRaw: true } : { ...document };
    };
    let ocrPolls = 0;
    const ocrCaptureId = 'capture-ocr-1';
    const sourceSha = 'a'.repeat(64);
    const ocrJob = (status: string, stage: string): Record<string, unknown> => ({
      protocolVersion: '2',
      ingestionId: 'ingestion-ocr-1',
      captureId: ocrCaptureId,
      partialRevision: 0,
      lastEventSequence: 0,
      createdAt: '2026-07-20T00:00:00Z',
      status,
      stage,
      progress: status === 'running' ? 0.75 : 1,
      pagesDone: 9,
      pagesTotal: 12,
      source: {
        sha256: sourceSha,
        fileName: 'charge.pdf',
        mediaType: 'application/pdf',
        bytes: 12,
      },
    });
    const ocrProvenance = {
      status: 'resolved',
      engine: 'windowsml-ocr',
      model: 'ppocrv6-traditional-multilingual',
      modelDigest: `sha256:${'d'.repeat(64)}`,
      device: 'RTX4060',
      profileId: 'profile-1',
      profileSpecSha256: 'e'.repeat(64),
    };
    const ocrProjection = (): Record<string, unknown> => ({
      apiVersion: '2.0',
      schemaVersion: '3',
      captureId: ocrCaptureId,
      status: 'completed',
      source: {
        sha256: sourceSha,
        fileName: 'charge.pdf',
        mediaType: 'application/pdf',
        bytes: 12,
      },
      pages: [{
        page: 1,
        status: 'recognized',
        raster: { width: 1200, height: 800, scale: 1, coordinateSystem: 'pixel' },
        text: 'OCR text',
        boxes: [{
          polygon: [
            { x: 100, y: 120 },
            { x: 220, y: 120 },
            { x: 220, y: 160 },
            { x: 100, y: 160 },
          ],
          text: 'OCR text',
          confidence: 0.875,
        }],
        confidence: 0.875,
        provenance: ocrProvenance,
      }],
      pageCount: 1,
      runtimeVersion,
      contractSha256: 'a'.repeat(64),
      provenance: ocrProvenance,
      createdAt: '2026-07-20T00:00:00Z',
    });
    const ocrRaw = (): Record<string, unknown> => ({
      schemaVersion: '2',
      diagnosticOnly: true,
      source: {
        sha256: sourceSha,
        fileName: 'charge.pdf',
        mediaType: 'application/pdf',
        bytes: 12,
      },
      segments: [
        { segmentId: 'seg-1', order: 0, locator: { kind: 'page', page: 1 }, text: '第一頁' },
        { segmentId: 'seg-2', order: 0, locator: { kind: 'page', page: 2 }, text: '第二頁' },
      ],
      sourceText: '第一頁\n第二頁',
      extractionEngine: 'windowsml-ocr',
      createdAt: '2026-07-20T00:00:00Z',
    });

    for (const initial of installOptions.initialRunningInstallations ?? []) {
      const id = String(initial['installationId']);
      installations.set(id, { ...initial });
      pollCounts.set(id, 0);
    }

    target.isTauri = true;
    target.__captureInvokedCommands = [];
    target.__captureStartedRequirementIds = [];
    target.__captureTauriListenerCount = (event: string) => (listeners.get(event) ?? []).length;
    target.__captureEmitTauriEvent = (event: string, payload: unknown) => {
      for (const handlerId of listeners.get(event) ?? []) {
        callbacks.get(handlerId)?.({ event, id: handlerId, payload });
      }
    };
    target.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
      },
      transformCallback: (...args: unknown[]) => {
        const id = nextCallbackId++;
        const callback = args[0];
        if (typeof callback === 'function') {
          callbacks.set(id, callback as (eventData: unknown) => void);
        }
        return id;
      },
      invoke: (command: string, rawArgs?: unknown): Promise<unknown> => {
        target.__captureInvokedCommands.push(command);
        const args = (rawArgs ?? {}) as {
          readonly input?: {
            readonly id?: string;
            readonly installationId?: string;
            readonly requirementId?: string;
          };
          readonly request?: Record<string, unknown>;
          readonly update?: Record<string, unknown>;
          readonly event?: string;
          readonly handler?: number;
        };
        if (command === 'desktop_runtime_status') {
          return Promise.resolve({ status: 'ready', detail: 'Capture Runtime 已準備完成。' });
        }
        if (command === 'desktop_compute_status') {
          return Promise.resolve({ cudaAvailable: false, preferGpu: true });
        }
        if (command === 'runtime_ready') {
          return Promise.resolve({
            ready: true,
            service: 'capture-runtime',
            apiVersion: '2.0',
            runtimeVersion,
            captureDocumentSchemaVersion: '2',
            contractSetVersion: '2',
            capabilities: {},
            ocrCompute: {
              apiVersion: '2.0',
              schemaVersion: '1',
              service: 'capture-runtime',
              runtimeVersion,
              contractSetVersion: '2',
              contractSha256: 'a'.repeat(64),
              workerSha256: 'b'.repeat(64),
              mode: 'gpu-dml',
              adapterClass: 'dedicated',
              reasonCode: null,
              userNoticeRequired: false,
              noticeCode: null,
            },
          });
        }
        if (command === 'runtime_requirements') {
          return Promise.resolve({ items: mutableRequirements.map((item) => ({ ...item })) });
        }
        if (command === 'runtime_list_installations') {
          return Promise.resolve({
            items: [...installations.values()].map((item) => ({ ...item })),
          });
        }
        if (command === 'runtime_start_installation') {
          const requirementId = String(args.input?.requirementId ?? 'speech-recognition');
          target.__captureStartedRequirementIds.push(requirementId);
          const installationId = `inst-${nextInstallSeq++}`;
          const req = mutableRequirements.find((item) => item['requirementId'] === requirementId);
          const downloadBytes =
            typeof req?.['downloadBytes'] === 'number' ? (req['downloadBytes'] as number) : 2_800_000_000;
          const record: Record<string, unknown> = {
            installationId,
            requirementId,
            status: 'running',
            progress: 0.5,
            downloadedBytes: Math.round(downloadBytes / 2),
            downloadBytes,
            createdAt: '2026-11-03T00:00:00Z',
            updatedAt: '2026-11-03T00:00:00Z',
          };
          installations.set(installationId, record);
          pollCounts.set(installationId, 0);
          return Promise.resolve({ ...record });
        }
        if (command === 'runtime_get_installation') {
          const id = String(args.input?.id ?? args.input?.installationId ?? '');
          const record = installations.get(id);
          if (!record) {
            return Promise.reject(new Error(`Unknown installation: ${id}`));
          }
          const count = (pollCounts.get(id) ?? 0) + 1;
          pollCounts.set(id, count);
          const holdRunning = Boolean(installOptions.holdRunningUntilCancel) && !cancelledOnce;
          const targetPolls = installOptions.completeInstallOnPoll ?? 1;
          if (!holdRunning && record['status'] === 'running' && count >= targetPolls) {
            record['status'] = 'completed';
            record['progress'] = 1;
            record['downloadedBytes'] = record['downloadBytes'];
            const req = mutableRequirements.find(
              (item) => item['requirementId'] === record['requirementId'],
            );
            if (req) {
              req['status'] = 'ready';
            }
          }
          return Promise.resolve({ ...record });
        }
        if (command === 'runtime_cancel_installation') {
          const id = String(args.input?.id ?? args.input?.installationId ?? '');
          cancelledOnce = true;
          const record = installations.get(id) ?? {
            installationId: id,
            requirementId: 'speech-recognition',
          };
          record['status'] = 'cancelled';
          installations.set(id, record);
          return Promise.resolve({ ...record });
        }
        if (command === 'runtime_model_options') {
          return Promise.resolve({
            catalogSha256: 'a'.repeat(64),
            items: [{
              optionId: 'qwen3.5-0.8b-v1',
              displayName: 'Ollama · qwen3.5:0.8b',
              modelReference: 'qwen3.5:0.8b',
              expectedDigest: null,
              expectedBytes: null,
              profileId: 'capture-workbench-qwen3.5-0.8b-structure-v1',
              profileSpecSha256: 'b'.repeat(64),
              status: 'active',
            }],
          });
        }
        if (command === 'library_list') {
          return Promise.resolve(documents.map((item) => listedSummary(item)));
        }
        if (command === 'library_import_source') {
          const request = args.request ?? {};
          const sourcePath = typeof request['sourcePath'] === 'string' ? request['sourcePath'] : '';
          const fileName = sourcePath.split(/[/\\]/u).pop() || 'source.pdf';
          const lower = fileName.toLowerCase();
          const mediaType = lower.endsWith('.png')
            ? 'image/png'
            : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
              ? 'image/jpeg'
              : 'application/pdf';
          const options = request['captureOptions'];
          const pdfPageCount = options !== null && typeof options === 'object'
            ? (options as { readonly pdfPageCount?: unknown }).pdfPageCount
            : undefined;
          const document: StoredDoc = {
            documentId: 'b'.repeat(32),
            fileName,
            mediaType,
            byteLength: 12,
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            status: 'queued',
            stage: 'uploading',
            ...(typeof pdfPageCount === 'number' ? { captureOptions: { pdfPageCount } } : {}),
          };
          documents = [
            document,
            ...documents.filter((item) => item.documentId !== document.documentId),
          ];
          rememberLibrary();
          return Promise.resolve(listedSummary(document));
        }
        if (command === 'library_get') {
          const documentId = String(args.request?.['documentId'] ?? '');
          const current = documents.find((item) => item.documentId === documentId);
          if (!current) return Promise.reject(new Error(`Unknown document: ${documentId}`));
          return Promise.resolve({
            ...listedSummary(current),
            ...(rawByDocument.has(documentId) ? { raw: rawByDocument.get(documentId) } : {}),
          });
        }
        if (command === 'library_update_capture') {
          const update = args.update ?? {};
          const documentId = String(update['documentId'] ?? '');
          const current = documents.find((item) => item.documentId === documentId);
          if (!current) return Promise.reject(new Error(`Unknown document: ${documentId}`));
          if (update['raw'] !== undefined && update['raw'] !== null) {
            rawByDocument.set(documentId, update['raw']);
            current.hasRaw = true;
          }
          if (typeof update['status'] === 'string') current.status = update['status'];
          if (typeof update['stage'] === 'string') current.stage = update['stage'];
          if (typeof update['captureId'] === 'string') current.captureId = update['captureId'];
          if (update['clearCaptureId'] === true) delete current.captureId;
          current.updatedAtMs = Date.now();
          rememberLibrary();
          return Promise.resolve(listedSummary(current));
        }
        if (installOptions.ocrJourney && command === 'runtime_create_capture') {
          ocrPolls = 0;
          return Promise.resolve(ocrJob('running', 'extracting'));
        }
        if (installOptions.ocrJourney && command === 'runtime_get_capture') {
          ocrPolls += 1;
          if (ocrPolls <= 4) return Promise.resolve(ocrJob('running', 'extracting'));
          return Promise.resolve(ocrJob('awaiting_structuring', 'awaiting_structuring'));
        }
        if (installOptions.ocrJourney && command === 'runtime_get_raw') {
          return Promise.resolve(ocrRaw());
        }
        if (installOptions.ocrJourney && command === 'runtime_get_ocr') {
          return Promise.resolve(ocrProjection());
        }
        if (installOptions.ocrJourney && command === 'runtime_delete_capture') {
          return Promise.resolve(null);
        }
        if (command === 'plugin:event|listen') {
          const eventName = typeof args.event === 'string' ? args.event : '';
          const handlerId = typeof args.handler === 'number' ? args.handler : -1;
          const bucket = listeners.get(eventName) ?? [];
          bucket.push(handlerId);
          listeners.set(eventName, bucket);
          return Promise.resolve(nextEventId++);
        }
        if (command === 'plugin:event|unlisten') {
          return Promise.resolve(null);
        }
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      },
    };
    target.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => undefined,
    };
  }, {
    runtimeRequirements: requirements,
    runtimeVersion: options.runtimeVersion ?? RELEASE_VERSION,
    installOptions: options,
  });
  await page.goto(path);
}

/** Drops one PDF the way the desktop app receives it: a Tauri drag-drop path. */
async function dropPdf(page: Page, fileName: string): Promise<void> {
  const sourcePath = `C:\\fixtures\\${fileName}`;
  await page.waitForFunction(() => {
    const target = globalThis as {
      __captureTauriListenerCount?: (event: string) => number;
    };
    return (target.__captureTauriListenerCount?.('tauri://drag-drop') ?? 0) > 0;
  });
  await page.evaluate((path) => {
    const target = globalThis as {
      __captureEmitTauriEvent?: (event: string, payload: unknown) => void;
    };
    target.__captureEmitTauriEvent?.('tauri://drag-drop', {
      paths: [path],
      position: { x: 0, y: 0 },
    });
  }, sourcePath);
}

function requirement(
  requirementId: string,
  displayName: string,
  status: string,
  downloadBytes?: number,
) {
  return {
    requirementId,
    displayName,
    status,
    kind: 'runtime',
    requiredFor: ['capture'],
    installStrategy: 'automatic',
    detail: '需要使用者同意後才能安裝。',
    ...(downloadBytes !== undefined ? { downloadBytes } : {}),
  };
}
