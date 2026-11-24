import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requirePrivateDirectory } from './src/real-engines-inputs.ts';

const configFile = fileURLToPath(import.meta.url);
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const upstreamURL = 'http://localhost:4200';
const tempDir = process.env['CAPTURE_REAL_ENGINES_TEMP_DIR']?.trim();
if (!tempDir) throw new Error('CAPTURE_REAL_ENGINES_TEMP_DIR is required for private browser artifacts and temporary files.');
const privateTemp = requirePrivateDirectory(tempDir, workspaceRoot, 'CAPTURE_REAL_ENGINES_TEMP_DIR');
mkdirSync(privateTemp, { recursive: true });
// Playwright workers inherit the run ID when they reload this config.
const artifactRunId = process.env['CAPTURE_REAL_ENGINES_RUN_ID'] ??= randomUUID();
if (!/^[\da-f-]{36}$/u.test(artifactRunId)) throw new Error('Invalid real-engines run ID.');
const artifactRoot = requirePrivateDirectory(
  join(privateTemp, `playwright-real-engines-${artifactRunId}`), workspaceRoot, 'Playwright run folder',
);
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = privateTemp;

export default defineConfig({
  ...nxE2EPreset(configFile, { testDir: './src' }),
  workers: 1,
  retries: 0,
  // Each stage in real-engines-journey.ts enforces its own explicit timeout so a
  // hang fails naming the exact stage rather than a blanket test timeout.
  timeout: 0,
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
  projects: (['installation', 'execution'] as const).map((journey) => ({
    name: `chromium-real-engines-${journey}`,
    testMatch: /real-engines\.spec\.ts$/u,
    grep: new RegExp(`real-engine ${journey} journey`, 'u'),
    outputDir: join(artifactRoot, `real-engines-${journey}`, 'playwright'),
    use: { ...devices['Desktop Chrome'] },
  })),
});
