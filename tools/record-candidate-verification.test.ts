import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = join(import.meta.dirname, 'record-candidate-verification.ts');

test('candidate verification report binds the candidate ID without mutating the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-candidate-report-'));
  const candidate = join(root, 'candidate');
  const output = join(root, 'verification.json');
  const candidateId = 'a'.repeat(64);
  try {
    await mkdir(candidate, { recursive: true });
    await writeFile(
      join(candidate, 'candidate-manifest.json'),
      `${JSON.stringify({ candidateId }, null, 2)}\n`,
      'utf8',
    );
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--candidate',
        candidate,
        '--verification',
        'runtime-product',
        '--status',
        'success',
        '--output',
        output,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {
      schemaVersion: '1',
      candidateId,
      verification: 'runtime-product',
      status: 'success',
    });
    assert.equal(
      await readFile(join(candidate, 'candidate-manifest.json'), 'utf8'),
      `${JSON.stringify({ candidateId }, null, 2)}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
