// Browser reference flow (CI): the reference app in a browser with a fake
// Tauri bridge and scripted runtime responses. It checks the Traditional
// Chinese shell navigation, first-run recognition card, ASR-only journey,
// install/cancel/retry lifecycle, reload re-attachment, and the history queue.
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

  await page.getByRole('link', { name: '前往紀錄加入文件' }).click();
  await expect(page).toHaveURL(/\/history$/u);
  await expect(page.getByText('history.pdf')).toBeVisible();
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
  await page.getByLabel('搜尋文件').fill('history');

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
  expect(commands.filter((command) => command === 'library_list').length).toBeGreaterThan(1);
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
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (event: string, eventId: number) => void;
      };
    }
    const target = globalThis as unknown as TauriTestGlobal;
    let nextCallbackId = 1;
    let nextEventId = 1;
    let nextInstallSeq = 1;
    const mutableRequirements = runtimeRequirements.map((item) => ({ ...item }));
    const installations = new Map<string, Record<string, unknown>>();
    const pollCounts = new Map<string, number>();
    let cancelledOnce = false;

    for (const initial of installOptions.initialRunningInstallations ?? []) {
      const id = String(initial['installationId']);
      installations.set(id, { ...initial });
      pollCounts.set(id, 0);
    }

    target.isTauri = true;
    target.__captureInvokedCommands = [];
    target.__captureStartedRequirementIds = [];
    target.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
      },
      transformCallback: () => nextCallbackId++,
      invoke: (command: string, rawArgs?: unknown): Promise<unknown> => {
        target.__captureInvokedCommands.push(command);
        const args = (rawArgs ?? {}) as {
          readonly input?: {
            readonly id?: string;
            readonly installationId?: string;
            readonly requirementId?: string;
          };
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
          return Promise.resolve([{
            documentId: 'a'.repeat(32), fileName: 'history.pdf', mediaType: 'application/pdf',
            byteLength: 2048, createdAtMs: 1, updatedAtMs: 1, status: 'completed', stage: 'completed',
          }]);
        }
        if (command === 'plugin:event|listen') {
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
  }, { runtimeRequirements: requirements, runtimeVersion: RELEASE_VERSION, installOptions: options });
  await page.goto(path);
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
