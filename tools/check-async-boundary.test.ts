import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { acceptanceScopeDependencyFindings } from './check-async-boundary.ts';

const checkerSource = join(import.meta.dirname, 'check-async-boundary.ts');
const workspaceNodeModules = resolve(import.meta.dirname, '..', 'node_modules');
const productionAcceptanceScopePath =
  'apps/capture-workbench-desktop/scripts/acceptance-scope.ts';

function runChecker(checkerPath: string) {
  return spawnSync(process.execPath, [checkerPath], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: workspaceNodeModules },
    windowsHide: true,
  });
}

test('production acceptance scope stays on its evidence dependency seam', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, '..', productionAcceptanceScopePath),
    'utf8',
  );
  assert.deepEqual(
    acceptanceScopeDependencyFindings(productionAcceptanceScopePath, source),
    [],
  );
});

test('acceptance scope allows only the exact Windows probe deep-module seam', () => {
  const exactProbeImport = [
    "import { createWindowsAcceptanceScopeProbe } from './windows-acceptance-scope-probe.ts';",
    "import type { AcceptanceScopeProbe } from './windows-acceptance-scope-probe.ts';",
    "export { createWindowsAcceptanceScopeProbe } from './windows-acceptance-scope-probe.ts';",
  ].join('\n');
  assert.deepEqual(
    acceptanceScopeDependencyFindings(
      productionAcceptanceScopePath,
      exactProbeImport,
    ),
    [],
  );

  for (const specifier of [
    './acceptance-scope-helper.ts',
    './windows-acceptance-scope-probe.test.ts',
    './windows-acceptance-scope-neighbor.ts',
  ]) {
    assert.deepEqual(
      acceptanceScopeDependencyFindings(
        productionAcceptanceScopePath,
        `import { helper } from '${specifier}';`,
      ),
      [
        `apps/capture-workbench-desktop/scripts/acceptance-scope.ts:1 acceptance scope static import "${specifier}" is not allowed`,
      ],
    );
  }
});

test('async boundary permits only the exact approved CLI paths', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'capture-async-boundary-'),
  );
  const checkerPath = join(workspaceRoot, 'tools', 'check-async-boundary.ts');
  const installedCliPath = join(
    workspaceRoot,
    'apps',
    'capture-workbench-desktop',
    'scripts',
    'installed-deterministic-smoke.ts',
  );
  const modelMediaCliPath = join(
    workspaceRoot,
    'apps',
    'capture-workbench-desktop',
    'scripts',
    'real-media-model-smoke.ts',
  );
  const boundaryDoctorPath = join(
    workspaceRoot,
    'tools',
    'capture-boundary-doctor.ts',
  );
  const angularSourcePath = join(
    workspaceRoot,
    'apps',
    'capture-workbench',
    'src',
    'app',
    'forbidden-async.ts',
  );
  const runtimeClientPath = join(
    workspaceRoot,
    'packages',
    'capture-runtime-client',
    'src',
    'client.ts',
  );
  const runtimeE2ePath = join(
    workspaceRoot,
    'packages',
    'capture-runtime',
    'tests',
    'e2e',
    'local-package',
    'pdf-ocr.e2e.ts',
  );
  const angularSdkAdapterPath = join(
    workspaceRoot,
    'packages',
    'capture-workbench-ui',
    'src',
    'lib',
    'http-capture-client.ts',
  );
  const javaCandidateToolPath = join(
    workspaceRoot,
    'tools',
    'assemble-java-sdk-candidate.ts',
  );
  const realOcrAssertionsPath = join(
    workspaceRoot,
    'apps',
    'capture-workbench-desktop',
    'scripts',
    'real-ocr-result-assertions.ts',
  );
  const localCandidateWorkerMirrorPath = join(
    workspaceRoot,
    'apps',
    'capture-workbench-desktop',
    'scripts',
    'local-candidate-worker-mirror.ts',
  );
  const localCandidateWorkerMirrorNeighborPath = join(
    workspaceRoot,
    'apps',
    'capture-workbench-desktop',
    'scripts',
    'local-candidate-worker-mirror-neighbor.ts',
  );
  const filesystemAuthorityPath = join(
    workspaceRoot,
    'apps',
    'capture-workbench-desktop',
    'scripts',
    'filesystem-authority.ts',
  );
  const filesystemAuthorityNeighborPath = join(
    workspaceRoot,
    'apps',
    'capture-workbench-desktop',
    'scripts',
    'filesystem-authority-neighbor.ts',
  );
  const acceptanceRunnerPath = join(
    workspaceRoot,
    'apps',
    'capture-workbench-desktop',
    'scripts',
    'acceptance-real.ts',
  );
  const acceptanceContractPath = join(
    workspaceRoot,
    'tools',
    'acceptance-contract.ts',
  );
  const threeProjectAcceptancePath = join(
    workspaceRoot,
    'tools',
    'three-project-acceptance.ts',
  );
  const acceptanceScopePath = join(
    workspaceRoot,
    'apps',
    'capture-workbench-desktop',
    'scripts',
    'acceptance-scope.ts',
  );
  const acceptanceScopeNeighborPath = join(
    workspaceRoot,
    'apps',
    'capture-workbench-desktop',
    'scripts',
    'acceptance-scope-helper.ts',
  );
  const acceptanceScopeLegalSource = [
    "import { randomUUID } from 'node:crypto';",
    "import { spawnSync } from 'node:child_process';",
    "import { mkdir } from 'node:fs/promises';",
    "import { basename } from 'node:path';",
    "import { acceptanceScopeContractFor } from '../../../tools/three-project-acceptance.ts';",
    'export async function runAcceptanceBoundary() { await Promise.resolve(); }',
  ].join('\n');
  const escapedMtsPath = join(
    workspaceRoot,
    'tools',
    'acceptance-contract.mts',
  );

  try {
    await Promise.all([
      mkdir(dirname(checkerPath), { recursive: true }),
      mkdir(dirname(installedCliPath), { recursive: true }),
      mkdir(dirname(modelMediaCliPath), { recursive: true }),
      mkdir(dirname(boundaryDoctorPath), { recursive: true }),
      mkdir(dirname(angularSourcePath), { recursive: true }),
      mkdir(join(workspaceRoot, 'packages'), { recursive: true }),
      mkdir(dirname(runtimeClientPath), { recursive: true }),
      mkdir(dirname(runtimeE2ePath), { recursive: true }),
      mkdir(dirname(angularSdkAdapterPath), { recursive: true }),
      mkdir(dirname(realOcrAssertionsPath), { recursive: true }),
      mkdir(dirname(localCandidateWorkerMirrorPath), { recursive: true }),
      mkdir(dirname(filesystemAuthorityPath), { recursive: true }),
      mkdir(dirname(acceptanceRunnerPath), { recursive: true }),
      mkdir(dirname(acceptanceContractPath), { recursive: true }),
      mkdir(dirname(threeProjectAcceptancePath), { recursive: true }),
      mkdir(dirname(acceptanceScopePath), { recursive: true }),
    ]);
    await copyFile(checkerSource, checkerPath);
    await writeFile(
      installedCliPath,
      'export async function runInstalledCli() { await Promise.resolve(); }\n',
      'utf8',
    );
    await writeFile(
      modelMediaCliPath,
      'export async function runModelMediaCli() { await Promise.resolve(); }\n',
      'utf8',
    );
    await writeFile(
      boundaryDoctorPath,
      'export async function runBoundaryDoctor() { await Promise.resolve(); }\n',
      'utf8',
    );
    await writeFile(
      runtimeClientPath,
      'export async function runRuntimeClient() { await Promise.resolve(); }\n',
      'utf8',
    );
    await writeFile(
      angularSdkAdapterPath,
      'export async function bridgeSdk() { await Promise.resolve(); }\n',
      'utf8',
    );
    await writeFile(
      javaCandidateToolPath,
      'export async function runJavaCandidateTool() { await Promise.resolve(); }\n',
      'utf8',
    );
    await writeFile(
      runtimeE2ePath,
      'export async function runRuntimeE2e() { await Promise.resolve(); }\n',
      'utf8',
    );
    for (const path of [
      realOcrAssertionsPath,
      acceptanceRunnerPath,
      acceptanceContractPath,
      threeProjectAcceptancePath,
    ]) {
      await writeFile(path, 'export async function runAcceptanceBoundary() { await Promise.resolve(); }\n', 'utf8');
    }
    await writeFile(
      localCandidateWorkerMirrorPath,
      'export async function runLocalCandidateWorkerMirror() { await Promise.resolve(); }\n',
      'utf8',
    );
    await writeFile(
      filesystemAuthorityPath,
      'export async function probeFilesystemAuthority() { await Promise.resolve(); }\n',
      'utf8',
    );
    await writeFile(acceptanceScopePath, acceptanceScopeLegalSource, 'utf8');

    const installedCliResult = runChecker(checkerPath);
    assert.equal(installedCliResult.status, 0, installedCliResult.stderr);
    assert.match(
      installedCliResult.stdout,
      /Async-boundary check passed; [1-9]\d* approved framework\/test boundary occurrence\(s\)\./u,
    );

    await writeFile(
      filesystemAuthorityNeighborPath,
      'export async function escapedFilesystemAuthority() { await Promise.resolve(); }\n',
      'utf8',
    );
    const escapedFilesystemAuthorityResult = runChecker(checkerPath);
    assert.equal(escapedFilesystemAuthorityResult.status, 1);
    assert.match(
      escapedFilesystemAuthorityResult.stderr,
      /apps\/capture-workbench-desktop\/scripts\/filesystem-authority-neighbor\.ts:1 async function/u,
    );

    await writeFile(
      localCandidateWorkerMirrorNeighborPath,
      'export async function escapedLocalCandidateWorkerMirror() { await Promise.resolve(); }\n',
      'utf8',
    );
    const escapedLocalCandidateWorkerMirrorResult = runChecker(checkerPath);
    assert.equal(escapedLocalCandidateWorkerMirrorResult.status, 1);
    assert.match(
      escapedLocalCandidateWorkerMirrorResult.stderr,
      /apps\/capture-workbench-desktop\/scripts\/local-candidate-worker-mirror-neighbor\.ts:1 async function/u,
    );

    await writeFile(
      acceptanceScopePath,
      [
        "import /*c*/ { CaptureRuntimeClient } from '../../../packages/capture-runtime-client/src/client.ts';",
        "export { x } from /*c*/ '../../../apps/capture-workbench/src/app/app.config.ts';",
        'export async function escapedRuntimeClient() { await Promise.resolve(); }',
      ].join('\n'),
      'utf8',
    );
    const escapedStaticImportResult = runChecker(checkerPath);
    assert.equal(escapedStaticImportResult.status, 1);
    assert.match(
      escapedStaticImportResult.stderr,
      /apps\/capture-workbench-desktop\/scripts\/acceptance-scope\.ts:\d+ acceptance scope static import .*capture-runtime-client/u,
    );
    assert.match(
      escapedStaticImportResult.stderr,
      /apps\/capture-workbench-desktop\/scripts\/acceptance-scope\.ts:\d+ acceptance scope static export .*apps\/capture-workbench/u,
    );

    await writeFile(
      acceptanceScopePath,
      [
        "const productPath = '../../../apps/capture-workbench/src/app/app.config.ts';",
        'const loadProduct = () => import /*c*/ (productPath);',
        'export async function escapedDynamicImport() { await Promise.resolve(); }',
      ].join('\n'),
      'utf8',
    );
    const escapedDynamicImportResult = runChecker(checkerPath);
    assert.equal(escapedDynamicImportResult.status, 1);
    assert.match(
      escapedDynamicImportResult.stderr,
      /apps\/capture-workbench-desktop\/scripts\/acceptance-scope\.ts:\d+ acceptance scope dynamic import "module expression" is not allowed/u,
    );

    await writeFile(
      acceptanceScopePath,
      [
        "import helperAlias = require('./acceptance-scope-helper.ts');",
        'const load = require;',
        "const helperPath = './acceptance-scope-helper.ts';",
        'const helper = require /*c*/ (helperPath);',
        'const aliased = load(helperPath);',
        'export async function escapedRequire() { await Promise.resolve(); }',
      ].join('\n'),
      'utf8',
    );
    const escapedRequireResult = runChecker(checkerPath);
    assert.equal(escapedRequireResult.status, 1);
    assert.match(
      escapedRequireResult.stderr,
      /apps\/capture-workbench-desktop\/scripts\/acceptance-scope\.ts:\d+ acceptance scope require "module expression" is not allowed/u,
    );
    assert.match(
      escapedRequireResult.stderr,
      /apps\/capture-workbench-desktop\/scripts\/acceptance-scope\.ts:\d+ acceptance scope require identifier "identifier reference" is not allowed/u,
    );
    assert.match(
      escapedRequireResult.stderr,
      /apps\/capture-workbench-desktop\/scripts\/acceptance-scope\.ts:\d+ acceptance scope import-equals .*acceptance-scope-helper/u,
    );

    await writeFile(
      acceptanceScopePath,
      'export async function malformed() { await Promise.resolve(\n',
      'utf8',
    );
    const malformedSourceResult = runChecker(checkerPath);
    assert.equal(malformedSourceResult.status, 1);
    assert.match(
      malformedSourceResult.stderr,
      /apps\/capture-workbench-desktop\/scripts\/acceptance-scope\.ts:1 acceptance scope parse diagnostics \(\d+\)/u,
    );

    await writeFile(acceptanceScopePath, acceptanceScopeLegalSource, 'utf8');
    await writeFile(
      acceptanceScopeNeighborPath,
      'export async function escapedAcceptanceScope() { await Promise.resolve(); }\n',
      'utf8',
    );
    const escapedAcceptanceScopeResult = runChecker(checkerPath);
    assert.equal(escapedAcceptanceScopeResult.status, 1);
    assert.match(
      escapedAcceptanceScopeResult.stderr,
      /apps\/capture-workbench-desktop\/scripts\/acceptance-scope-helper\.ts:1 async function/u,
    );

    await writeFile(
      escapedMtsPath,
      'export async function escapedMtsBoundary() { await Promise.resolve(); }\n',
      'utf8',
    );
    const escapedMtsResult = runChecker(checkerPath);
    assert.equal(escapedMtsResult.status, 1);
    assert.match(
      escapedMtsResult.stderr,
      /tools\/acceptance-contract\.mts:1 async function/u,
    );

    await writeFile(
      angularSourcePath,
      'export async function forbiddenProductSource() { await Promise.resolve(); }\n',
      'utf8',
    );
    const angularSourceResult = runChecker(checkerPath);
    assert.equal(angularSourceResult.status, 1);
    assert.match(
      angularSourceResult.stderr,
      /apps\/capture-workbench\/src\/app\/forbidden-async\.ts:1 async function/u,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
