import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const configFile = fileURLToPath(import.meta.url);
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const upstreamURL = 'http://localhost:4200';
const devHostPort = 4313;
const devHostURL = `http://127.0.0.1:${devHostPort}`;

// The e2e-dev-host target preloads tools/test-temp-root.ts (an import here
// would cross the Nx project boundary): the coordinator, the workers, the
// journeys' directories and the dev-host launcher with the dev host and
// runtime it starts all use its private temp root, which is removed when the
// coordinator exits, also when a tree-kill of the webServer left files there.
// Nx, which serves the Workbench, keeps the shared temp directory: it opens a
// socket under the temp directory and fails when that path is this much longer.
const sharedTemp = process.env['CAPTURE_TEST_SHARED_TEMP'];
if (!sharedTemp) {
  throw new Error('Run the dev-host journeys with capture-workbench-e2e:e2e-dev-host, which preloads tools/test-temp-root.ts.');
}
// Nx, which this config loads for its preset, copies its native binding under
// the temp directory and keeps it loaded until the process exits, so the
// coordinator could never remove its private root. For this run only, Nx keeps
// that copy in the workspace's own Nx data directory (git-ignored, cleared by
// `nx reset`), so nothing of the run stays under the temp directory; it is set
// before the preset loads Nx.
process.env['NX_NATIVE_FILE_CACHE_DIRECTORY'] ??= join(workspaceRoot, '.nx', 'workspace-data', 'native-file-cache');
const { nxE2EPreset } = await import('@nx/playwright/preset');

export default defineConfig({
  ...nxE2EPreset(configFile, { testDir: './src' }),
  workers: 1,
  webServer: [
    {
      command: 'corepack pnpm nx run capture-workbench:serve',
      env: {
        TEMP: sharedTemp,
        TMP: sharedTemp,
        TMPDIR: sharedTemp,
      },
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
