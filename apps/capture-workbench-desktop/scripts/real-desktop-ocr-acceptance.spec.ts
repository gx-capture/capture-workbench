// Playwright wrapper for the real desktop OCR journey in
// real-desktop-ocr-smoke.ts. The small tests at the top pin which screenshot
// checkpoints have pixel baselines; the last test runs the journey itself and
// compares each checkpoint with the approved screenshots.
import { expect, test } from '@playwright/test';

import {
  DESKTOP_OCR_ACCEPTANCE_CHECKPOINTS,
  main,
} from './real-desktop-ocr-smoke.ts';
import { checkpointScreenshotMasks } from './packaged-workbench-session.ts';

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

export function screenshotName(
  name: string,
  installedOcrOnly = Boolean(process.env.E2E_ACCEPTANCE_RUN_ID?.trim()),
): string {
  if (installedOcrOnly && (name === '01-runtime-ready' || name === '04-review-complete')) {
    return `${name}-ocr-only`;
  }
  return name;
}

test('installed OCR-only routing uses the dedicated runtime-ready golden', () => {
  expect(screenshotName('01-runtime-ready', true)).toBe('01-runtime-ready-ocr-only');
});

test('non-acceptance routing retains the shared runtime-ready golden', () => {
  expect(screenshotName('01-runtime-ready', false)).toBe('01-runtime-ready');
});

test('installed OCR-only routing uses the dedicated review-complete golden', () => {
  expect(screenshotName('04-review-complete', true)).toBe('04-review-complete-ocr-only');
});

test('non-acceptance routing retains the shared review-complete golden', () => {
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

test('OCR-only checkpoint inventory is bound to the smoke journey source', () => {
  expect(new Set(DESKTOP_OCR_ACCEPTANCE_CHECKPOINTS).size).toBe(
    DESKTOP_OCR_ACCEPTANCE_CHECKPOINTS.length,
  );
  expect([...DESKTOP_OCR_ACCEPTANCE_CHECKPOINTS]).toEqual(OCR_ONLY_MAIN_CHECKPOINT_NAMES);
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
        mask: checkpointScreenshotMasks(page),
      });
    },
  });
});
