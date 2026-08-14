import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checkerSource = join(import.meta.dirname, 'check-async-boundary.ts');

function runChecker(checkerPath: string) {
  return spawnSync(process.execPath, [checkerPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

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
  const angularSdkAdapterPath = join(
    workspaceRoot,
    'packages',
    'capture-angular',
    'src',
    'lib',
    'http-capture-client.ts',
  );
  const javaCandidateToolPath = join(
    workspaceRoot,
    'tools',
    'assemble-java-sdk-candidate.ts',
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
      mkdir(dirname(angularSdkAdapterPath), { recursive: true }),
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

    const installedCliResult = runChecker(checkerPath);
    assert.equal(installedCliResult.status, 0, installedCliResult.stderr);
    assert.match(
      installedCliResult.stdout,
      /Async-boundary check passed; [1-9]\d* approved framework\/test boundary occurrence\(s\)\./u,
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
