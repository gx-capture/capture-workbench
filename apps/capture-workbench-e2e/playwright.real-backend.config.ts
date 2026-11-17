import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const configFile = fileURLToPath(import.meta.url);
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const upstreamURL = 'http://localhost:4200';
const realBackendPort = 4313;
const realBackendURL = `http://127.0.0.1:${realBackendPort}`;

// Own a private temp root in the Playwright coordinator process so a tree-kill
// of the real-backend webServer on exit never leaves a dev-host app-data dir.
// Only the launcher (and the dev host and runtime it starts) gets it as its
// temp directory: Nx, which serves the Workbench, opens a socket under the temp
// directory and fails when that path is this much longer.
if (!process.env['CAPTURE_REAL_BACKEND_TEMP_ROOT']) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'capture-real-backend-'));
  process.env['CAPTURE_REAL_BACKEND_TEMP_ROOT'] = tempRoot;
  process.once('exit', () => {
    try {
      rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {
      // Best-effort cleanup after webServer shutdown.
    }
  });
}

const launcherTempRoot = process.env['CAPTURE_REAL_BACKEND_TEMP_ROOT'] ?? tmpdir();

export default defineConfig({
  ...nxE2EPreset(configFile, { testDir: './src' }),
  workers: 1,
  webServer: [
    {
      command: 'corepack pnpm nx run capture-workbench:serve',
      url: upstreamURL,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    {
      command: `node apps/capture-workbench-e2e/real-backend-server.ts ${realBackendPort}`,
      cwd: workspaceRoot,
      env: {
        TEMP: launcherTempRoot,
        TMP: launcherTempRoot,
        TMPDIR: launcherTempRoot,
      },
      url: `${realBackendURL}/__preview`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  use: {
    baseURL: realBackendURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium-real-backend',
      testMatch: /real-backend\.spec\.ts$/u,
      use: { ...devices['Desktop Chrome'], baseURL: realBackendURL },
    },
  ],
});
