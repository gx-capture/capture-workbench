import { defineConfig, devices } from '@playwright/test';
import { join, resolve } from 'node:path';

// The real-engine journeys on the packaged Desktop App (OCR and ASR), run in
// acceptance mode (E2E_ACCEPTANCE_RUN_ID) or baseline review mode
// (E2E_BASELINE_REVIEW_RUN_ID); see scripts/packaged-journey-run.ts.
const acceptanceRunId = process.env['E2E_ACCEPTANCE_RUN_ID']?.trim();
const reviewRunId = process.env['E2E_BASELINE_REVIEW_RUN_ID']?.trim();
const artifactRoot = resolve(
  process.env['E2E_ARTIFACT_ROOT']
    || (reviewRunId
      ? join(process.cwd(), 'output', 'playwright', 'capture-workbench-review', reviewRunId)
      : join(process.cwd(), 'output', 'playwright', 'capture-workbench', acceptanceRunId || 'unconfigured')),
);
export default defineConfig({
  timeout: 60 * 60 * 1000,
  updateSnapshots: 'none',
  testDir: './scripts',
  outputDir: join(artifactRoot, 'test-results'),
  testMatch: /real-desktop-(?:ocr|asr)-acceptance\.spec\.ts$/u,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: join(artifactRoot, 'html-report'), open: 'never' }],
  ],
  expect: {
    toHaveScreenshot: { animations: 'disabled', scale: 'css' },
  },
  use: {
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    // DOM snapshots can contain private OCR text; acceptance evidence uses
    // redacted screenshots and structured counts instead of Playwright traces.
    trace: 'off',
    video: process.env['E2E_RECORD_VIDEO'] === '1' ? 'on' : 'retain-on-failure',
    // Playwright Test sets no action or navigation timeout by default, so a
    // locator read whose element never appears waits until the test timeout.
    // The journeys were written against the library's defaults.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
    },
  }],
});
