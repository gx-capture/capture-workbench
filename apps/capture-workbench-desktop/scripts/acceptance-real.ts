import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// eslint-disable-next-line @nx/enforce-module-boundaries -- acceptance runner is a workspace-level test contract.
import {
  createAcceptanceRun,
  collectAcceptanceArtifactInputs,
  writeAcceptanceManifest,
} from '../../../tools/acceptance-contract.ts';

const workspaceRoot = resolve(import.meta.dirname, '../../..');
const recorded = process.argv.includes('--recorded');
const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
process.env.E2E_ACCEPTANCE_RUN_ID ||= `local-${timestamp}-${process.pid}`;
process.env.E2E_RECORD_VIDEO = recorded ? '1' : process.env.E2E_RECORD_VIDEO || '0';
process.env.E2E_ARTIFACT_ROOT ||= join(
  workspaceRoot,
  'output',
  'playwright',
  'capture-workbench',
  process.env.E2E_ACCEPTANCE_RUN_ID,
);

const run = createAcceptanceRun(process.env, 'capture-workbench', workspaceRoot);
await mkdir(run.artifactRoot, { recursive: true });

const result = spawnSync(
  'corepack',
  ['pnpm', 'exec', 'playwright', 'test', '--config', 'apps/capture-workbench-desktop/playwright.acceptance.config.ts', 'apps/capture-workbench-desktop/scripts/real-desktop-ocr-acceptance.spec.ts', '--project=chromium'],
  { cwd: workspaceRoot, env: process.env, stdio: 'inherit', shell: true, windowsHide: false },
);
if (result.error) throw result.error;
const manifestPath = join(run.artifactRoot, 'acceptance-manifest.json');
await mkdir(run.artifactRoot, { recursive: true });
const existing = existsSync(manifestPath)
  ? JSON.parse(await readFile(manifestPath, 'utf8')) as {
      status?: 'completed' | 'failed';
      errors?: string[];
      consoleErrors?: string[];
      pageErrors?: string[];
      cleanup?: { app: boolean; sidecar: boolean; cdpPort: boolean; temporaryAppData: boolean };
      fixture?: { name: string; sha256: string };
    }
  : undefined;
const exitCode = result.status ?? 1;
const cleanupComplete = existing?.cleanup
  ? Object.values(existing.cleanup).every(Boolean)
  : false;
const acceptancePassed = exitCode === 0 && existing?.status === 'completed' && cleanupComplete &&
  (existing?.errors?.length ?? 0) === 0 && (existing?.consoleErrors?.length ?? 0) === 0 &&
  (existing?.pageErrors?.length ?? 0) === 0;
await writeAcceptanceManifest(run.artifactRoot, {
  project: run.project,
  runId: run.runId,
  status: acceptancePassed ? 'completed' : 'failed',
  recordVideo: run.recordVideo,
  artifacts: await collectAcceptanceArtifactInputs(run.artifactRoot),
  errors: existing?.errors ?? [`Capture Workbench acceptance Playwright exited with ${exitCode}.`],
  consoleErrors: existing?.consoleErrors ?? [],
  pageErrors: existing?.pageErrors ?? [],
  cleanup: existing?.cleanup ?? { app: false, sidecar: false, cdpPort: false, temporaryAppData: false },
  fixture: existing?.fixture,
});
if (!acceptancePassed) {
  throw new Error(`Capture Workbench acceptance did not complete truthfully (Playwright=${exitCode}, manifest=${existing?.status ?? 'missing'}).`);
}
