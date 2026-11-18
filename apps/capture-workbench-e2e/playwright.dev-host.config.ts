import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const configFile = fileURLToPath(import.meta.url);
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const upstreamURL = 'http://localhost:4200';
const devHostPort = 4313;
const devHostURL = `http://127.0.0.1:${devHostPort}`;

// Own a private temp root in the Playwright coordinator process so a tree-kill
// of the dev-host webServer on exit never leaves a dev-host app-data dir.
// Only the launcher (and the dev host and runtime it starts) gets it as its
// temp directory: Nx, which serves the Workbench, opens a socket under the temp
// directory and fails when that path is this much longer.
if (!process.env['CAPTURE_DEV_HOST_TEMP_ROOT']) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'capture-dev-host-'));
  process.env['CAPTURE_DEV_HOST_TEMP_ROOT'] = tempRoot;
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

const launcherTempRoot = process.env['CAPTURE_DEV_HOST_TEMP_ROOT'] ?? tmpdir();

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
      command: `node apps/capture-workbench-e2e/dev-host-preview-server.ts ${devHostPort}`,
      cwd: workspaceRoot,
      env: {
        TEMP: launcherTempRoot,
        TMP: launcherTempRoot,
        TMPDIR: launcherTempRoot,
      },
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
