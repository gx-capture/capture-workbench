import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const configFile = fileURLToPath(import.meta.url);
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const upstreamURL = 'http://localhost:4200';
const artifactRoot = join(workspaceRoot, 'tmp', 'capture-workbench-e2e', 'real-engines');

export default defineConfig({
  ...nxE2EPreset(configFile, { testDir: './src' }),
  workers: 1,
  retries: 0,
  // Each stage in real-engines.spec.ts enforces its own explicit timeout so a
  // hang fails naming the exact stage rather than a blanket test timeout.
  timeout: 0,
  outputDir: join(artifactRoot, 'playwright'),
  reporter: [['list']],
  webServer: [
    {
      command: 'corepack pnpm nx run capture-workbench:serve',
      url: upstreamURL,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
  use: {
    video: 'on',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-real-engines',
      testMatch: /real-engines\.spec\.ts$/u,
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
