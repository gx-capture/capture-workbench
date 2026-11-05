import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tap } from 'rxjs';
import { appRoot } from './stage-runtime.ts';
import { assertStagedRuntime } from './assert-staged-runtime.ts';
import { deterministicQaPaths, deterministicQaProductName, deterministicQaTarget } from './deterministic-qa.ts';

const dev = process.argv[2] === '--dev';
if (process.argv.length > (dev ? 3 : 2)) throw new Error('Use no arguments or --dev.');
assertStagedRuntime('deterministic').pipe(tap(() => build())).subscribe({
  error: (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
});

function build(): void {
  process.stdout.write(`${deterministicQaProductName}: QA ONLY, fake runtime and fake capture data.\n`);
  const artifactRoot = join(deterministicQaTarget, 'dev', 'artifacts');
  const appDataRoot = join(artifactRoot, 'appdata');
  if (dev) mkdirSync(appDataRoot, { recursive: true });
  const result = spawnSync('corepack', [
    'pnpm', 'exec', 'tauri', dev ? 'dev' : 'build',
    '--target', 'x86_64-pc-windows-msvc',
    ...(dev ? [] : ['--bundles', 'nsis', '--ci']),
    '--features', 'acceptance-app-data',
    '--config', 'apps/capture-workbench-desktop/src-tauri/tauri.conf.json',
    '--config', 'apps/capture-workbench-desktop/src-tauri/tauri.deterministic-qa.conf.json',
  ], {
    cwd: resolve(appRoot, '..', '..'),
    env: {
      ...process.env,
      CARGO_TARGET_DIR: deterministicQaTarget,
      ...(dev ? {
        E2E_ARTIFACT_ROOT: artifactRoot,
        CAPTURE_ACCEPTANCE_APP_DATA_ROOT: appDataRoot,
        CAPTURE_WORKBENCH_RUNTIME_MANIFEST: deterministicQaPaths.stagedManifest,
        CAPTURE_WORKBENCH_RUNTIME_EXECUTABLE: deterministicQaPaths.stagedExecutable,
      } : {}),
    },
    shell: true,
    windowsHide: true,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
