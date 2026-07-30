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

test('async boundary permits only the exact installed desktop CLI path', async () => {
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
  const angularSourcePath = join(
    workspaceRoot,
    'apps',
    'capture-workbench',
    'src',
    'app',
    'forbidden-async.ts',
  );

  try {
    await Promise.all([
      mkdir(dirname(checkerPath), { recursive: true }),
      mkdir(dirname(installedCliPath), { recursive: true }),
      mkdir(dirname(angularSourcePath), { recursive: true }),
      mkdir(join(workspaceRoot, 'packages'), { recursive: true }),
    ]);
    await copyFile(checkerSource, checkerPath);
    await writeFile(
      installedCliPath,
      'export async function runInstalledCli() { await Promise.resolve(); }\n',
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
