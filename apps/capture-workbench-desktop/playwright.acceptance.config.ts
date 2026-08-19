import { defineConfig, devices } from '@playwright/test';
import { join, resolve } from 'node:path';

const runId = process.env['E2E_ACCEPTANCE_RUN_ID'] || 'unconfigured';
const artifactRoot = resolve(
  process.env['E2E_ARTIFACT_ROOT'] || join(process.cwd(), 'output', 'playwright', 'capture-workbench', runId),
);
const updateSnapshots = process.env['E2E_ACCEPTANCE_UPDATE_SNAPSHOTS'] === '1';
if (updateSnapshots && process.env['E2E_ACCEPTANCE_BASELINE_REVIEWED'] !== '1') {
  throw new Error('E2E_ACCEPTANCE_BASELINE_REVIEWED=1 is required when updating acceptance screenshots.');
}

export default defineConfig({
  timeout: 60 * 60 * 1000,
  updateSnapshots: updateSnapshots ? 'all' : 'none',
  testDir: './scripts',
  outputDir: join(artifactRoot, 'test-results'),
  testMatch: /real-desktop-ocr-acceptance\.spec\.ts$/u,
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
