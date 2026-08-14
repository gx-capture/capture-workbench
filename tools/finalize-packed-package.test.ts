import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const finalizer = resolve('tools/finalize-packed-package.ts');
const expectedLoader =
  "import '@angular/compiler';\nexport * from './fesm2022/gx-capture-capture-workbench-ui.mjs';\n";

function runFinalizer(packageDirectory: string) {
  return spawnSync(process.execPath, [finalizer, packageDirectory], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('packed package finalization is exact, idempotent, and fail-closed', async () => {
  const packageDirectory = await mkdtemp(
    join(tmpdir(), 'capture-package-finalizer-'),
  );
  try {
    const manifestPath = join(packageDirectory, 'package.json');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          name: '@gx-capture/capture-workbench-ui',
          module: 'fesm2022/gx-capture-capture-workbench-ui.mjs',
          exports: {
            '.': {
              default: './fesm2022/gx-capture-capture-workbench-ui.mjs',
            },
          },
          sideEffects: ['./loader.mjs'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const first = runFinalizer(packageDirectory);
    assert.equal(first.status, 0, first.stderr);
    const second = runFinalizer(packageDirectory);
    assert.equal(second.status, 0, second.stderr);

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.module, 'loader.mjs');
    assert.equal(manifest.exports['.'].default, './loader.mjs');
    assert.deepEqual(manifest.sideEffects, ['./loader.mjs']);
    assert.equal(
      await readFile(join(packageDirectory, 'loader.mjs'), 'utf8'),
      expectedLoader,
    );

    manifest.module = 'unexpected.mjs';
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    const invalid = runFinalizer(packageDirectory);
    assert.notEqual(invalid.status, 0);
    assert.match(
      invalid.stderr,
      /Refusing to finalize an unexpected Capture Workbench package layout/u,
    );
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
  }
});
