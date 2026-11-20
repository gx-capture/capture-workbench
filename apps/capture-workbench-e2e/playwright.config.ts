import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { fileURLToPath } from 'node:url';

// For CI, you may want to set BASE_URL to the deployed application.
const baseURL = process.env['BASE_URL'] || 'http://localhost:4200';
const configFile = fileURLToPath(import.meta.url);
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
// The production build served with the desktop app's CSP
// (desktop-csp-server.ts). The dev server sends no CSP, so only this project
// sees what the packaged app's policy blocks.
const desktopCspPort = 4311;
const desktopCspURL = `http://127.0.0.1:${desktopCspPort}`;
const previewPort = 4312;
const previewURL = `http://127.0.0.1:${previewPort}`;
const simulatedBackendTestIgnore = /(?:(?:preview|dev-host|real-engines)\.spec|real-engines-inputs\.test)\.ts$/u;

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv').config();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  ...nxE2EPreset(configFile, { testDir: './src' }),
  workers: 1,
  webServer: process.env['BASE_URL']
    ? undefined
    : [
        {
          command: 'corepack pnpm nx run capture-workbench:serve',
          url: baseURL,
          reuseExistingServer: !process.env['CI'],
          timeout: 120_000,
        },
        {
          command: `node apps/capture-workbench-e2e/desktop-csp-server.ts ${desktopCspPort}`,
          cwd: workspaceRoot,
          url: desktopCspURL,
          reuseExistingServer: false,
          timeout: 30_000,
        },
        {
          command: `node apps/capture-workbench-e2e/preview-server.ts ${previewPort}`,
          cwd: workspaceRoot,
          url: `${previewURL}/__preview`,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      // dev-host and real-engines have their own configs (a dev host with the
      // fixture runtime; real engines and private inputs) and must not run with
      // the simulated backend.
      testIgnore: simulatedBackendTestIgnore,
      use: { ...devices['Desktop Chrome'] },
    },
    ...(process.env['BASE_URL']
      ? []
      : [
          {
            name: 'chromium-desktop-csp',
            testIgnore: simulatedBackendTestIgnore,
            use: { ...devices['Desktop Chrome'], baseURL: desktopCspURL },
          },
          {
            name: 'chromium-preview',
            testMatch: /preview\.spec\.ts$/u,
            use: { ...devices['Desktop Chrome'], baseURL: previewURL },
          },
        ]),
  ],
});
