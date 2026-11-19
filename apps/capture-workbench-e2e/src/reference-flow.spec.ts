// Browser reference flow (CI): the reference app in a browser with a fake
// Tauri bridge and scripted runtime responses. It checks the Traditional
// Chinese shell navigation, first-run recognition card, the OCR queue
// (drop, install, page progress, raw .txt, waiting file across reload),
// ASR-only journey, install/cancel/retry/remove lifecycle, reload re-attachment,
// and the history queue.
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
// eslint-disable-next-line @nx/enforce-module-boundaries -- repository browser fixture shares release intent.
import { RELEASE_VERSION } from '../../../tools/release/release-intent.ts';
import {
  fakeRequirement as requirement,
  installFakeDesktop,
  type FakeDesktopOptions,
} from './fake-desktop.ts';

test('navigates the Traditional Chinese shell to each page from the left navigation', async ({ page }) => {
  await openDesktop(page, [], '/');

  await expect(page).toHaveURL(/\/ocr$/u);
  const nav = page.getByRole('navigation', { name: '主要功能' });
  await expect(nav.locator('ul').getByRole('link')).toHaveText(['文件轉文字', '錄音轉逐字稿', '紀錄', '設定']);
  await expect(nav.getByTestId('runtime-status')).toHaveAccessibleName('已就緒 診斷');
  await expect(nav.getByTestId('runtime-status')).toHaveAttribute('data-state', 'ready');

  const pages = [
    { link: '錄音轉逐字稿', path: /\/asr$/u, heading: '錄音轉逐字稿' },
    { link: '紀錄', path: /\/history$/u, heading: '紀錄' },
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
  await page.getByTestId('runtime-status').click();
  await expect(page).toHaveURL(/\/settings\/diagnostics$/u);
  await expect(page.getByTestId('diagnostics-runtime')).toBeVisible();
});

test('filters history, returns from result sub-pages and confirms deletion', async ({ page }) => {
  await openDesktop(page, [], '/history', { editedResults: true, persistLibrary: true });
  const rows = page.getByTestId('history-row');
  await expect(rows).toHaveCount(2);
  const document = rows.filter({ hasText: 'history.pdf' });
  const recording = rows.filter({ hasText: 'meeting.mp3' });
  await expect(document.getByRole('img', { name: '文件' })).toBeVisible();
  await expect(recording.getByRole('img', { name: '錄音' })).toBeVisible();
  await expect(document.locator('td').nth(2)).toHaveText('1');
  await expect(recording.locator('td').nth(2)).toHaveText('0:01');
  await expect(document.locator('td').nth(3)).toHaveText('完成');
  await expect(document.locator('td').nth(4)).not.toBeEmpty();
  await page.getByTestId('history-type-filter').selectOption('asr');
  await expect(rows).toHaveCount(1);
  await expect(recording).toBeVisible();
  await page.getByTestId('history-type-filter').selectOption('all');
  await page.getByTestId('history-status-filter').selectOption('waiting');
  await expect(page.getByTestId('history-empty')).toContainText('沒有符合篩選條件');
  await page.getByTestId('history-status-filter').selectOption('done');
  await expect(rows).toHaveCount(2);
  await page.getByTestId('history-search').fill('HISTORY');
  await expect(rows).toHaveCount(1);
  await document.getByTestId('history-row-view').click();
  await expect(page).toHaveURL(/\/content\?from=history$/u);
  await page.getByTestId('result-back').click();
  await expect(page).toHaveURL(/\/history$/u);
  await expect(page.getByTestId('history-search')).toHaveValue('HISTORY');
  await document.getByRole('link', { name: 'history.pdf', exact: true }).click();
  await page.getByTestId('result-nav-details').click();
  await expect(page).toHaveURL(/\/details\?from=history$/u);
  await page.reload();
  await page.getByTestId('result-back').click();
  await expect(page).toHaveURL(/\/history$/u);
  await document.getByTestId('history-row-delete').click();
  await expect(page.getByTestId('history-delete-dialog')).toContainText('history.pdf');
  await page.getByTestId('history-delete-cancel').click();
  await expect(document).toBeVisible();
  await expect(document.getByTestId('history-row-delete')).toBeFocused();
  await document.getByTestId('history-row-delete').click();
  await page.getByTestId('history-delete-confirm').click();
  await expect(document).toHaveCount(0);
  await expect(page.getByTestId('history-search')).toBeFocused();
  await page.getByTestId('history-search').fill('');
  await expect(rows).toHaveCount(1);
  await recording.getByTestId('history-row-view').click();
  await expect(page).toHaveURL(/\/content\?from=history$/u);
  await page.getByTestId('result-nav-export').click();
  await expect(page).toHaveURL(/\/export\?from=history$/u);
  await page.getByTestId('result-nav-speakers').click();
  await expect(page).toHaveURL(/\/speakers\?from=history$/u);
  await page.getByTestId('result-back').click();
  await expect(page).toHaveURL(/\/history$/u);
  await recording.getByTestId('history-row-delete').click();
  await page.getByTestId('history-delete-confirm').click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId('history-empty').getByRole('link', { name: '文件轉文字' })).toBeVisible();
  await expect(page.getByTestId('history-empty').getByRole('link', { name: '錄音轉逐字稿' })).toBeVisible();
});

test('loads a nested result route directly, with its scripts and styles', async ({ page }) => {
  // A window reload on a nested route requests the shell at that path. Under
  // the desktop CSP this only works while `<base href="/">` is honoured.
  await openDesktop(page, [], `/history/${'a'.repeat(32)}/details`);

  const nav = page.getByRole('navigation', { name: '主要功能' });
  await expect(nav.locator('ul').getByRole('link')).toHaveText(['文件轉文字', '錄音轉逐字稿', '紀錄', '設定']);
  await expect(page.getByTestId('page-result')).toBeVisible();
  await expect(page.getByTestId('page-result')).toHaveCSS('display', 'flex');
});

test('drops a PDF without OCR, installs it, and exports the raw text', async ({ page }) => {
  await openDesktop(
    page,
    [requirement('text-recognition', 'Text recognition', 'installable', 296_000_000)],
    '/ocr',
    { completeInstallOnPoll: 2, ocrJourney: true, persistLibrary: true },
  );

  await page.getByTestId('first-run-dismiss').click();
  await dropPdf(page, 'charge.pdf');

  const row = page.locator('[data-testid="ocr-queue-row"]', { hasText: 'charge.pdf' });
  await expect(row).toHaveAttribute('data-user-status', 'waiting');
  await expect(row.getByTestId('ocr-row-status')).toContainText('需要文字辨識（約 296 MB）');
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
  expect(await readFile(saved, 'utf8')).toBe('第 1 頁\n\n第一頁\n\n第 2 頁\n\n第二頁');

  await row.getByTestId('ocr-row-view').click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f]{32}\/content$/u);
  const pdfCanvas = page.getByTestId('result-source-pdf-canvas');
  await expect(pdfCanvas).toHaveAttribute('data-rendered-page', '1');
  expect(await pdfCanvas.evaluate((el: HTMLCanvasElement) => el.width)).toBeGreaterThan(0);
  await expect(page.getByTestId('result-page-text')).toHaveValue('第一頁');
  await page.getByTestId('result-page-text').fill('Corrected first page');
  await page.getByTestId('result-nav-export').click();
  const correctedDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('result-export-text').click();
  const correctedDownload = await correctedDownloadPromise;
  expect(correctedDownload.suggestedFilename()).toBe('charge.txt');
  const correctedPath = await correctedDownload.path();
  if (!correctedPath) throw new Error('download path missing');
  expect(await readFile(correctedPath, 'utf8')).toContain('Corrected first page');
  await page.getByTestId('result-nav-content').click();
  await expect(page.getByTestId('result-save-status')).toHaveText('已儲存');
  await page.reload();
  await expect(page.getByTestId('result-page-text')).toHaveValue('Corrected first page');
  await expect(page.getByTestId('result-page-edited')).toBeVisible();
  await page.getByTestId('result-page-restore').click();
  await expect(page.getByTestId('result-page-text')).toHaveValue('第一頁');
  await expect(page.getByTestId('result-page-restore')).toHaveCount(0);
  await expect(page.getByTestId('result-save-status')).toHaveText('已儲存');
  await page.getByTestId('result-page-next').click();
  await expect(pdfCanvas).toHaveAttribute('data-rendered-page', '2');
  await expect(page.getByTestId('result-page-text')).toHaveValue('第二頁');
  await page.getByTestId('result-nav-details').click();
  await expect(page.getByTestId('result-detail-filename')).toHaveText('charge.pdf');
  await page.getByTestId('result-back').click();
  await expect(page).toHaveURL(/\/ocr$/u);
});

test('accepts a non-prefix PDF page list on /ocr, binds the request, and rejects 5-1', async ({ page }) => {
  await openDesktop(
    page,
    [requirement('text-recognition', 'Text recognition', 'ready', 296_000_000)],
    '/ocr',
    { ocrJourney: true, persistLibrary: true },
  );

  const pagesInput = page.getByTestId('ocr-pages');
  await pagesInput.fill('5-1');
  await expect(pagesInput).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('ocr-pages-error')).toBeVisible();

  await dropPdf(page, 'invalid-range.pdf');
  await expect(page.getByTestId('ocr-import-error')).toHaveCount(0);
  await expect(page.getByTestId('ocr-pages-error')).toBeVisible();
  await expect(page.locator('[data-testid="ocr-queue-row"]', { hasText: 'invalid-range.pdf' })).toHaveCount(0);

  await pagesInput.fill('2');
  await expect(pagesInput).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('ocr-pages-error')).toHaveCount(0);
  await dropPdf(page, 'range.pdf');

  const row = page.locator('[data-testid="ocr-queue-row"]', { hasText: 'range.pdf' });
  await expect(row).toHaveAttribute('data-user-status', 'done', { timeout: 15_000 });
  const sentPageNumbers = await page.evaluate(() => (
    globalThis as unknown as { readonly __captureCreatedPdfPageNumbers?: readonly (readonly number[] | null)[] }
  ).__captureCreatedPdfPageNumbers ?? []);
  expect(sentPageNumbers).toEqual([[2]]);

  await row.getByTestId('ocr-row-view').click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f]{32}\/content$/u);
  await expect(page.getByTestId('result-page-indicator')).toHaveText('第 2 頁（1 / 1）');
});

test('shows persisted page and transcript edits and speaker names on result pages', async ({ page }) => {
  await openDesktop(page, [], `/history/${'a'.repeat(32)}/content`, { editedResults: true });
  await expect(page.getByTestId('result-page-text')).toHaveValue('Edited page three');
  await page.goto(`/history/${'b'.repeat(32)}/content`);
  await expect(page.getByTestId('result-line-text')).toHaveText('Edited transcript line');
  await expect(page.getByTestId('result-line-speaker')).toHaveText('Named speaker');
  await page.getByTestId('result-line-text').dblclick();
  await page.getByTestId('result-line-input').fill('Corrected transcript');
  await page.getByTestId('result-line-input').press('Enter');
  await expect(page.getByTestId('result-line-text')).toHaveText('Corrected transcript');
  await expect(page.getByTestId('result-save-status')).toHaveText('已儲存');
  await page.getByTestId('result-line-restore').click();
  await expect(page.getByTestId('result-line-text')).toHaveText('recognized line');
  await page.getByTestId('result-nav-speakers').click();
  await expect(page.getByTestId('result-speaker-name')).toHaveText('Named speaker');
  await page.getByTestId('result-speaker-input').fill('Alice');
  await page.getByTestId('result-speaker-input').press('Enter');
  await expect(page.getByTestId('result-save-status')).toHaveText('已儲存');
  await page.getByTestId('result-nav-content').click();
  await expect(page.getByTestId('result-line-speaker')).toHaveText('Alice');
  await page.getByTestId('result-line-time').click();
  await expect(page.getByTestId('result-player')).toBeVisible();
  await page.getByTestId('result-nav-export').click();
  const subtitleDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('result-export-srt').click();
  const subtitleDownload = await subtitleDownloadPromise;
  expect(subtitleDownload.suggestedFilename()).toBe('meeting.srt');
  const subtitlePath = await subtitleDownload.path();
  if (!subtitlePath) throw new Error('download path missing');
  expect(await readFile(subtitlePath, 'utf8')).toContain('00:00:00,000 --> 00:00:01,000');
});

test('imports an OCR selection through the native picker command', async ({ page }) => {
  await openDesktop(page, [requirement('text-recognition', 'Text recognition', 'installable', 296_000_000)], '/ocr');
  await page.getByTestId('first-run-dismiss').click();
  await page.getByTestId('ocr-dropzone').getByRole('button').click();
  await expect(page.getByTestId('ocr-queue-row').filter({ hasText: 'charge.pdf' })).toHaveAttribute('data-user-status', 'waiting');
  const calls = await page.evaluate(() => (globalThis as { __captureInvokedCommands?: string[] }).__captureInvokedCommands ?? []);
  expect(calls).toContain('library_select_sources');
  expect(calls).toContain('library_import_selection');
  expect(calls).not.toContain('library_import_source');
});

test('keeps a waiting OCR file after the window reloads', async ({ page }) => {
  await openDesktop(
    page,
    [requirement('text-recognition', 'Text recognition', 'installable', 296_000_000)],
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
      requirement('text-recognition', 'Text recognition', 'installable', 296_000_000),
      requirement('speech-recognition', '本機語音轉文字', 'installable', 10_500_000_000),
      requirement('speaker-diarization', '說話者辨識', 'installable', 714_000_000),
    ],
    '/ocr',
  );

  const card = page.getByTestId('first-run-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: '要安裝哪些辨識功能？' })).toBeVisible();
  await expect(card.getByTestId('first-run-size-ocr')).toHaveText('約 296 MB');
  await expect(card.getByTestId('first-run-size-asr')).toHaveText('約 10.5 GB');
  await expect(card.getByTestId('first-run-size-speakers')).toHaveText('約 714 MB');
  await expect(card.getByTestId('first-run-install')).toHaveText('安裝所選（約 296 MB）');

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
      requirement('text-recognition', 'Text recognition', 'installable', 296_000_000),
      requirement('speech-recognition', '本機語音轉文字', 'installable', 10_500_000_000),
      requirement('speaker-diarization', '說話者辨識', 'installable', 714_000_000),
    ],
    '/asr',
    { completeInstallOnPoll: 2 },
  );

  await expect(page.getByTestId('runtime-status')).toHaveAttribute('data-state', 'ready');
  const panel = page.getByTestId('asr-install-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('asr-dropzone')).toHaveCount(0);
  await expect(panel.locator('[data-requirement-id="text-recognition"]')).toHaveCount(0);

  const speechCard = panel.locator('[data-testid="engine-card"][data-requirement-id="speech-recognition"]');
  await expect(speechCard.getByTestId('engine-card-install')).toHaveText('安裝（約 10.5 GB）');
  await speechCard.getByTestId('engine-card-install').click();

  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('asr-dropzone')).toBeVisible();

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
      requirement('text-recognition', 'Text recognition', 'ready', 296_000_000),
      requirement('speech-recognition', '本機語音轉文字', 'installable', 10_500_000_000),
      requirement('speaker-diarization', '說話者辨識', 'installable', 714_000_000),
    ],
    '/settings/engines',
    { holdRunningUntilCancel: true },
  );

  const table = page.getByTestId('engines-table');
  await expect(table.locator('thead th')).toHaveText(['功能', '狀態', '大小', '動作']);
  const ocrRow = table.locator('[data-testid="engine-row"][data-requirement-id="text-recognition"]');
  // The purpose is a second line under the feature name, not a column of its own.
  await expect(ocrRow.getByTestId('engine-row-purpose')).toHaveText('讀出掃描檔與照片的文字');
  await expect(ocrRow.getByTestId('engine-row-remove')).toHaveText('移除');

  const speechRow = table.locator('[data-testid="engine-row"][data-requirement-id="speech-recognition"]');
  await expect(speechRow.getByTestId('engine-row-remove')).toHaveCount(0);
  await speechRow.getByTestId('engine-row-toggle').click();
  await expect(
    table.locator('[data-testid="engine-row-details"][data-requirement-id="speech-recognition"]'),
  ).toContainText('TEA-ASR 1.1');

  await expect(speechRow.getByTestId('engine-row-install')).toHaveText('安裝（約 10.5 GB）');
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

test('removes an installed engine after confirming its size and shows it on the OCR page', async ({ page }) => {
  await openDesktop(
    page,
    [
      requirement('text-recognition', 'Text recognition', 'ready', 296_000_000),
      requirement('speech-recognition', '本機語音轉文字', 'installable', 10_500_000_000),
    ],
    '/settings/engines',
  );

  const ocrRow = page.locator('[data-testid="engine-row"][data-requirement-id="text-recognition"]');
  await expect(ocrRow).toHaveAttribute('data-status', 'ready');
  await ocrRow.getByTestId('engine-row-remove').click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('約 296 MB');
  await expect(dialog).toContainText('已經做好的文件和逐字稿會留在這台電腦');
  await dialog.getByTestId('engine-remove-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(ocrRow.getByTestId('engine-row-status')).toContainText('已安裝');

  await ocrRow.getByTestId('engine-row-remove').click();
  await dialog.getByTestId('engine-remove-confirm').click();
  await expect(ocrRow.getByTestId('engine-row-removing')).toContainText('正在移除');
  await expect(ocrRow).toHaveAttribute('data-status', 'installable');
  await expect(ocrRow.getByTestId('engine-row-status')).toContainText('未安裝');
  await expect(ocrRow.getByTestId('engine-row-install')).toBeVisible();

  const commands = await page.evaluate(() => {
    const target = globalThis as unknown as {
      readonly __captureInvokedCommands: readonly string[];
    };
    return target.__captureInvokedCommands;
  });
  expect(commands.filter((command) => command === 'runtime_uninstall_requirement')).toEqual([
    'runtime_uninstall_requirement',
  ]);

  await page.getByRole('navigation', { name: '主要功能' }).getByRole('link', { name: '文件轉文字' }).click();
  await expect(
    page.locator('[data-testid="first-run-option"][data-requirement-id="text-recognition"]'),
  ).toBeVisible();
});

test('re-attaches to an in-progress installation returned by runtime_list_installations on start', async ({ page }) => {
  await openDesktop(
    page,
    [
      requirement('text-recognition', 'Text recognition', 'installable', 296_000_000),
      requirement('speech-recognition', '本機語音轉文字', 'installable', 10_500_000_000),
    ],
    '/settings/engines',
    {
      initialRunningInstallations: [
        {
          installationId: 'inst-reattach-1',
          requirementId: 'speech-recognition',
          status: 'running',
          progress: 0.5,
          downloadedBytes: 5_250_000_000,
          downloadBytes: 10_500_000_000,
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

  await expect(page.getByTestId('page-ocr')).toBeVisible();
  await expect(page.getByTestId('runtime-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('runtime-status')).toHaveAccessibleName('已就緒 診斷');
  await expect(
    page.getByTestId('ocr-queue-row').filter({ hasText: 'history.pdf' }),
  ).toBeVisible();
  await expect(page.getByTestId('ocr-choose-files')).toBeEnabled();

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

  await page.getByRole('navigation', { name: '主要功能' }).getByRole('link', { name: '紀錄' }).click();
  await expect(page).toHaveURL(/\/history$/u);
  await expect(page.getByTestId('history-status-filter')).toBeVisible();
  await expect(page.getByText('history.pdf')).toBeVisible();
  await page.getByTestId('history-search').fill('not-a-file');
  await expect(page.getByText('history.pdf')).toHaveCount(0);
  await page.getByTestId('history-search').fill('history');
  await expect(page.getByText('history.pdf')).toBeVisible();

  await page.getByTestId('runtime-status').click();
  await expect(page).toHaveURL(/\/settings\/diagnostics$/u);
  await expect(page.getByTestId('diagnostics-active-model')).toContainText('Qwen 3.5 0.8B');
});

test('does not run a deterministic provider in an unconfigured browser', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('page-ocr')).toBeVisible();
  await expect(page.getByTestId('runtime-status')).toHaveAttribute('data-state', 'error');
  await expect(page.getByText(/deterministic/i)).toHaveCount(0);

  await page.getByTestId('runtime-status').click();
  await expect(page).toHaveURL(/\/settings\/diagnostics$/u);
  await expect(page.getByTestId('page-settings-diagnostics')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Windows 桌面 App');
  await expect(page.getByText(/deterministic/i)).toHaveCount(0);
});

test('navigates settings sub-pages, toggles speech GPU preference, and switches language', async ({ page }) => {
  await openDesktop(page, [], '/settings', { cudaAvailable: true });

  await expect(page).toHaveURL(/\/settings\/engines$/u);
  const subnav = page.getByRole('navigation', { name: '設定導覽' });
  await expect(subnav.getByRole('link')).toHaveText(['辨識功能', '運算裝置', '一般', '診斷']);
  await expect(subnav.getByTestId('settings-nav-engines')).toHaveAttribute('aria-current', 'page');

  await subnav.getByTestId('settings-nav-compute').click();
  await expect(page).toHaveURL(/\/settings\/compute$/u);
  await expect(subnav.getByTestId('settings-nav-compute')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('ocr-compute-status')).toHaveText('GPU 加速');

  const preferGpu = page.getByTestId('compute-prefer-gpu');
  await expect(preferGpu).toBeChecked();
  await preferGpu.click();
  await expect(preferGpu).not.toBeChecked();

  await subnav.getByTestId('settings-nav-general').click();
  await expect(page).toHaveURL(/\/settings\/general$/u);
  await expect(subnav.getByTestId('settings-nav-general')).toHaveAttribute('aria-current', 'page');

  const shellNav = page.getByRole('navigation', { name: '主要功能' });
  await expect(shellNav.getByTestId('nav-settings')).toHaveText('設定');
  await page.locator('[data-testid="general-language-option"][data-locale="en"]').click();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByTestId('nav-settings')).toHaveText('Settings');

  await page.locator('[data-testid="general-language-option"][data-locale="zh-TW"]').click();
  await expect(shellNav.getByTestId('nav-settings')).toHaveText('設定');
});

test('opens diagnostics from the status dot and from result details with provenance and JSON export', async ({ page }) => {
  const docId = 'a'.repeat(32);
  await openDesktop(page, [], '/ocr', { editedResults: true });

  await page.getByTestId('runtime-status').click();
  await expect(page).toHaveURL(/\/settings\/diagnostics$/u);
  await expect(page.getByTestId('diagnostics-runtime-status')).toHaveText('已就緒');
  await expect(page.getByTestId('diagnostics-runtime-version')).toHaveText(RELEASE_VERSION);
  await expect(page.getByTestId('diagnostics-api-version')).toHaveText('2.0');
  await expect(page.getByTestId('diagnostics-document')).toHaveCount(0);

  const modelOptions = page.getByTestId('diagnostics-model-option');
  await expect(modelOptions).toHaveCount(3);
  await expect(modelOptions.nth(0)).toHaveAttribute('data-model-option-id', 'qwen3.5-0.8b-v1');

  await page.goto(`/history/${docId}/details`);
  await page.getByTestId('result-detail-diagnostics').click();
  await expect(page).toHaveURL(new RegExp(`/settings/diagnostics\\?document=${docId}$`, 'u'));

  const docSection = page.getByTestId('diagnostics-document');
  await expect(docSection).toBeVisible();
  await expect(docSection).toHaveAttribute('data-document-id', docId);
  const ext = page.getByTestId('diagnostics-extraction-provenance');
  await expect(ext).toHaveAttribute('data-engine', 'text-recognition');
  await expect(ext).toHaveAttribute('data-model', 'pp-ocrv6-medium');
  await expect(ext).toHaveAttribute('data-device', 'directml');
  await expect(ext).toHaveAttribute('data-digest', `sha256:${'d'.repeat(64)}`);

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('diagnostics-export-json').click();
  const jsonDownload = await jsonDownloadPromise;
  expect(jsonDownload.suggestedFilename()).toBe('history.json');
  const jsonPath = await jsonDownload.path();
  if (!jsonPath) throw new Error('download path missing');
  expect(await readFile(jsonPath, 'utf8')).toContain('recognized page');
});

async function openDesktop(
  page: Page,
  requirements: readonly Record<string, unknown>[],
  path = '/ocr',
  options: FakeDesktopOptions = {},
): Promise<void> {
  const pdfBase64 = (
    await readFile(new URL('./fixtures/two-pages.pdf', import.meta.url))
  ).toString('base64');
  await page.addInitScript(installFakeDesktop, {
    runtimeRequirements: requirements,
    runtimeVersion: RELEASE_VERSION,
    installOptions: options,
    pdfFixtureBase64: pdfBase64,
  });
  await page.goto(path);
}

/** Delivers the batch emitted by native drop inspection, through the registered channel. */
async function dropPdf(page: Page, fileName: string): Promise<void> {
  await page.waitForFunction(() => (globalThis as { __captureNativeSourcesReady?: boolean }).__captureNativeSourcesReady);
  await page.evaluate((name) => {
    (globalThis as { __captureDropSources?: (fileName: string) => void }).__captureDropSources?.(name);
  }, fileName);
}

