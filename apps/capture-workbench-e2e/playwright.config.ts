// The browser journeys against the simulated desktop backend. Run them with
// `pnpm nx run capture-workbench-e2e:e2e`, the only supported entry point: it
// builds the Workbench and preloads tools/test-temp-root.ts, so the run leaves
// nothing in the shared temp directory. A direct `playwright test` with this
// config runs without that preload, in the shared temp directory, where the
// Workbench dev server's Nx leaves a socket directory behind. Nx infers no
// Playwright targets for this project (nx.json has no Playwright plugin); the
// dev-host journeys have their own target and config.
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { privateTempRun } from './private-temp-run.ts';

// For CI, you may want to set BASE_URL to the deployed application.
const baseURL = process.env['BASE_URL'] || 'http://localhost:4200';
const configFile = fileURLToPath(import.meta.url);
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
// Under the e2e target, the coordinator, the workers, the Workbench dev server
// and the other web servers use the run's private temp root.
const run = privateTempRun(workspaceRoot);
const { nxE2EPreset } = await import('@nx/playwright/preset');
// The production build served with the desktop app's CSP
// (desktop-csp-server.ts). The dev server sends no CSP, so only this project
// sees what the packaged app's policy blocks.
const desktopCspPort = 4311;
const desktopCspURL = `http://127.0.0.1:${desktopCspPort}`;
const previewPort = 4312;
const previewURL = `http://127.0.0.1:${previewPort}`;
// Every *.test.ts under src/ is a Node test (node --test), not a Playwright spec.
const simulatedBackendTestIgnore = /(?:(?:preview|dev-host|real-engines)\.spec|\.test)\.ts$/u;

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
          env: run?.devServerEnvironment ?? {},
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
