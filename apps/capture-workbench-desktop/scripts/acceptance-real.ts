import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @nx/enforce-module-boundaries -- acceptance is a workspace-level contract.
import { createAcceptanceRun } from '../../../tools/acceptance-contract.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- cleanup policy remains the existing owner.
import type { AcceptanceProjectPlan } from '../../../tools/three-project-acceptance.ts';
import { runCaptureWorkbenchAcceptanceOrchestration } from './acceptance-orchestration.ts';
const workspaceRoot = resolve(import.meta.dirname, '../../..');

export function waitForChildClose(child: ChildProcess): Promise<{ status: number; error: boolean }> { return new Promise((done) => { let error = false; child.once('error', () => { error = true; }); child.once('close', (status) => done({ status: status ?? 1, error })); }); }

async function runPlaywrightChild(cwd: string, environment: NodeJS.ProcessEnv): Promise<{ status: number; error: boolean }> { const child = spawn('corepack', ['pnpm', 'exec', 'playwright', 'test', '--config', 'apps/capture-workbench-desktop/playwright.acceptance.config.ts', 'apps/capture-workbench-desktop/scripts/real-desktop-ocr-acceptance.spec.ts', '--project=chromium'], { cwd, env: environment, stdio: 'ignore', shell: true, windowsHide: false }); return waitForChildClose(child); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const recorded = process.argv.includes('--recorded'); process.env.E2E_ACCEPTANCE_RUN_ID ||= `local-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`; process.env.E2E_RECORD_VIDEO = recorded ? '1' : process.env.E2E_RECORD_VIDEO || '0'; process.env.E2E_ARTIFACT_ROOT ||= join(workspaceRoot, 'output', 'playwright', 'capture-workbench', process.env.E2E_ACCEPTANCE_RUN_ID);
  const run = createAcceptanceRun(process.env, 'capture-workbench', workspaceRoot); await mkdir(run.artifactRoot, { recursive: true }); const eventRoot = resolve(process.env.E2E_ACCEPTANCE_EVENT_ROOT?.trim() || join(run.artifactRoot, 'acceptance-events')); const scopePath = process.env.E2E_ACCEPTANCE_SCOPE_PATH?.trim();
  const childEnvironment = { ...process.env, E2E_ACCEPTANCE_EVENT_ROOT: eventRoot }; const plan: AcceptanceProjectPlan = { project: 'capture-workbench', cwd: workspaceRoot, target: 'capture-workbench-desktop:acceptance-real', artifactRoot: run.artifactRoot, scopePath: scopePath ?? eventRoot, environment: childEnvironment };
  const result = await runCaptureWorkbenchAcceptanceOrchestration({ run, acceptanceEventRoot: eventRoot, manifestValidationPlan: plan, child: () => runPlaywrightChild(workspaceRoot, childEnvironment), ...(scopePath ? { scope: { context: { item: plan, scopePath } } } : {}) }); if (result.terminal.phase1Verdict !== 'pass') throw new Error('Capture Workbench acceptance did not complete truthfully.');
}
