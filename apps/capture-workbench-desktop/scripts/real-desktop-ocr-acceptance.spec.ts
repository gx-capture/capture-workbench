import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { expect, test } from '@playwright/test';

import { main } from './real-desktop-ocr-smoke.ts';

const OCR_ONLY_MAIN_CHECKPOINT_NAMES: readonly string[] = [
  '01-consent-required',
  '01-core-install-started',
  '01-core-install-retry',
  '01-runtime-ready',
  '02-document-processing',
  '03-ocr-checkpoint',
  '04-review-complete',
];

const OCR_ONLY_SKIPPED_CHECKPOINT_NAMES: readonly string[] = [
  '01-core-install-started',
  '01-core-install-retry',
  '02-document-processing',
  '03-ocr-checkpoint',
];

const STRUCTURING_ONLY_CHECKPOINT_NAME = '03-successful-result';

const ACCEPTANCE_SCREENSHOT_CALL_PATTERN =
  /acceptanceScreenshot\(\s*page\s*,\s*acceptance\s*,\s*acceptanceScreenshots\s*,\s*'([^']+)'\s*,/gu;

async function readAcceptanceScreenshotNames(): Promise<readonly string[]> {
  const smokeSource = await readFile(
    new URL('./real-desktop-ocr-smoke.ts', import.meta.url),
    'utf8',
  );
  const calls = [...smokeSource.matchAll(ACCEPTANCE_SCREENSHOT_CALL_PATTERN)];
  const allAcceptanceScreenshotExpressions = smokeSource.match(/acceptanceScreenshot\(/gu) ?? [];

  expect(allAcceptanceScreenshotExpressions).toHaveLength(calls.length + 1);
  expect(calls).toHaveLength(8);

  return calls.map((call) => call[1]);
}

export function screenshotName(
  name: string,
  installedOcrOnly = Boolean(process.env.E2E_ACCEPTANCE_RUN_ID?.trim()),
): string {
  const sourcePath = process.env.CAPTURE_REAL_DESKTOP_OCR_PDF?.trim()
    || process.env.CAPTURE_REAL_DESKTOP_OCR_INPUT?.trim()
    || '';
  if (installedOcrOnly && (name === '01-runtime-ready' || name === '04-review-complete')) {
    return `${name}-ocr-only`;
  }
  return name === '03-successful-result' && extname(sourcePath).toLowerCase() === '.pdf'
    ? `${name}-pdf`
    : name;
}

test('installed OCR-only routing uses the dedicated runtime-ready golden', () => {
  expect(screenshotName('01-runtime-ready', true)).toBe('01-runtime-ready-ocr-only');
});

test('non-acceptance structuring routing retains the shared runtime-ready golden', () => {
  expect(screenshotName('01-runtime-ready', false)).toBe('01-runtime-ready');
});

test('installed OCR-only routing uses the dedicated review-complete golden', () => {
  expect(screenshotName('04-review-complete', true)).toBe('04-review-complete-ocr-only');
});

test('non-acceptance structuring routing retains the shared review-complete golden', () => {
  expect(screenshotName('04-review-complete', false)).toBe('04-review-complete');
});

test('OCR-only routing enumerates every main checkpoint and its visual policy', () => {
  expect(OCR_ONLY_MAIN_CHECKPOINT_NAMES).toEqual([
    '01-consent-required',
    '01-core-install-started',
    '01-core-install-retry',
    '01-runtime-ready',
    '02-document-processing',
    '03-ocr-checkpoint',
    '04-review-complete',
  ]);
  expect(OCR_ONLY_SKIPPED_CHECKPOINT_NAMES).toEqual([
    '01-core-install-started',
    '01-core-install-retry',
    '02-document-processing',
    '03-ocr-checkpoint',
  ]);

  const skipped = new Set(OCR_ONLY_SKIPPED_CHECKPOINT_NAMES);
  expect(OCR_ONLY_MAIN_CHECKPOINT_NAMES.filter((name) => skipped.has(name))).toEqual([
    '01-core-install-started',
    '01-core-install-retry',
    '02-document-processing',
    '03-ocr-checkpoint',
  ]);
  expect(OCR_ONLY_MAIN_CHECKPOINT_NAMES.filter((name) => !skipped.has(name))).toEqual([
    '01-consent-required',
    '01-runtime-ready',
    '04-review-complete',
  ]);
  expect(OCR_ONLY_MAIN_CHECKPOINT_NAMES
    .filter((name) => !skipped.has(name))
    .map((name) => screenshotName(name, true)))
    .toEqual([
      '01-consent-required',
      '01-runtime-ready-ocr-only',
      '04-review-complete-ocr-only',
    ]);
  expect(OCR_ONLY_MAIN_CHECKPOINT_NAMES.map((name) => screenshotName(name, false)))
    .toEqual(OCR_ONLY_MAIN_CHECKPOINT_NAMES);
});

test('OCR-only checkpoint inventory is bound to the smoke journey source', async () => {
  const acceptanceScreenshotNames = await readAcceptanceScreenshotNames();

  expect(new Set(acceptanceScreenshotNames).size).toBe(acceptanceScreenshotNames.length);
  expect(acceptanceScreenshotNames.filter((name) => name === STRUCTURING_ONLY_CHECKPOINT_NAME))
    .toEqual([STRUCTURING_ONLY_CHECKPOINT_NAME]);
  expect(acceptanceScreenshotNames.filter((name) => name !== STRUCTURING_ONLY_CHECKPOINT_NAME))
    .toEqual(OCR_ONLY_MAIN_CHECKPOINT_NAMES);
});

test('structuring PDF successful-result routing remains unchanged', () => {
  const previousPdf = process.env.CAPTURE_REAL_DESKTOP_OCR_PDF;
  process.env.CAPTURE_REAL_DESKTOP_OCR_PDF = 'approved-fixture.pdf';
  try {
    expect(screenshotName('03-successful-result', false)).toBe('03-successful-result-pdf');
  } finally {
    if (previousPdf === undefined) {
      delete process.env.CAPTURE_REAL_DESKTOP_OCR_PDF;
    } else {
      process.env.CAPTURE_REAL_DESKTOP_OCR_PDF = previousPdf;
    }
  }
});

test('real Capture Workbench WebView2 golden journey matches approved screenshots', async () => {
  await main({
    checkpoint: async (page, name) => {
      // Installation has an intentionally moving progress indicator. Keep its
      // artifact for the journey, but only diff visual checkpoints after the
      // UI has reached a stable state. At the Phase 1 OCR checkpoint,
      // semantic/proof assertions remain the hard gate and the first-run
      // artifact is retained for manual baseline approval. Snapshot updates
      // are never automatic.
      if (name === '01-core-install-retry') return;
      if (name === '01-core-install-started' || name === '02-document-processing' || name === '03-ocr-checkpoint') return;
      await page.addStyleTag({
        content: `
          *, *::before, *::after {
            animation: none !important;
            transition: none !important;
            caret-color: transparent !important;
          }
        `,
      });
      await expect(page).toHaveScreenshot(`${screenshotName(name)}.png`, {
        animations: 'disabled',
        fullPage: false,
        mask: [
          page.locator('time'),
          page.locator('.dynamic-id'),
          page.locator('.document-copy strong'),
          page.locator('.detail-heading h2'),
          page.locator('.detail-heading p:last-child'),
          // Mask complete privacy-sensitive cards; dynamic OCR segment text
          // may overflow the child nodes that previously carried masks.
          page.getByTestId('document-raw'),
          page.getByTestId('document-result'),
        ],
      });
    },
  });
});
