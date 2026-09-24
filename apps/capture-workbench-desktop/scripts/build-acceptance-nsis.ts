import { execFileSync, spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { firstValueFrom } from 'rxjs';

import {
  buildAcceptanceNsis,
} from './acceptance-nsis.ts';
import {
  appRoot,
  sha256File,
  stagedManifest,
} from './stage-runtime.ts';
import { assertStagedRuntime } from './assert-staged-runtime.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const formalBundleRoot = join(
  appRoot,
  'src-tauri',
  'target',
  'x86_64-pc-windows-msvc',
  'release',
  'bundle',
  'nsis',
);
const targetParent = resolve(
  process.env.CAPTURE_ACCEPTANCE_NSIS_TARGET_ROOT?.trim()
    || join(workspaceRoot, 'output', 'acceptance-nsis'),
);

const staged = await firstValueFrom(assertStagedRuntime('release'));
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
}).trim();
const runtimeManifestSha256 = await firstValueFrom(sha256File(stagedManifest));
const result = await buildAcceptanceNsis({
  formalBundleRoot,
  targetParent,
  sourceHead,
  stagedRuntimeSha256: staged.digest,
  runtimeManifestSha256,
  runTauriBuild: ({ cargoTargetDir }) => runTauriBuild(cargoTargetDir),
});
process.stdout.write(`Acceptance NSIS bundle created at ${result.outputDirectory}.\n`);

function runTauriBuild(cargoTargetDir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'corepack',
      [
        'pnpm',
        'exec',
        'tauri',
        'build',
        '--target',
        'x86_64-pc-windows-msvc',
        '--bundles',
        'nsis',
        '--ci',
        '--features',
        'acceptance-app-data',
        '--config',
        'apps/capture-workbench-desktop/src-tauri/tauri.conf.json',
      ],
      {
        cwd: workspaceRoot,
        env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
        shell: true,
        windowsHide: false,
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`Acceptance NSIS Tauri build failed with exit code ${code ?? 'unknown'}.`));
      }
    });
  });
}
