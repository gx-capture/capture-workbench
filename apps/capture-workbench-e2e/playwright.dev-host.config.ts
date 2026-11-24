import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { privateTempRun } from './private-temp-run.ts';

const configFile = fileURLToPath(import.meta.url);
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const upstreamURL = 'http://localhost:4200';
const devHostPort = 4313;
const devHostURL = `http://127.0.0.1:${devHostPort}`;

// The coordinator, the workers, the journeys' directories, the Workbench dev
// server and the dev-host launcher with the dev host and runtime it starts all
// use the run's private temp root.
const run = privateTempRun(workspaceRoot);
if (!run) {
  throw new Error('Run the dev-host journeys with capture-workbench-e2e:e2e-dev-host, which preloads tools/test-temp-root.ts.');
}
const { nxE2EPreset } = await import('@nx/playwright/preset');

export default defineConfig({
  ...nxE2EPreset(configFile, { testDir: './src' }),
  workers: 1,
  webServer: [
    {
      command: 'corepack pnpm nx run capture-workbench:serve',
      env: run.devServerEnvironment,
      url: upstreamURL,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    {
      command: `node apps/capture-workbench-e2e/dev-host-preview-server.ts ${devHostPort}`,
      cwd: workspaceRoot,
      url: `${devHostURL}/__preview`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  use: {
    baseURL: devHostURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium-dev-host',
      testMatch: /dev-host\.spec\.ts$/u,
      use: { ...devices['Desktop Chrome'], baseURL: devHostURL },
    },
  ],
});
