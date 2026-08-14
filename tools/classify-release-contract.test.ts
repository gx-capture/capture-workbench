import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const candidateId = 'a'.repeat(64);

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshot(releaseVersion: string, title: string): object {
  return {
    schemaVersion: '1',
    releaseVersion,
    runtimeApi: {
      apiVersion: '2.0',
      documentSchemaVersion: '2',
      documentSchemaId: 'capture-document-v2',
    },
    contractManifest: { title },
    schemas: {},
    contractSetSha256: 'a'.repeat(64),
    typescript: 'type Capture = { id: string }',
    python: 'class Capture: pass',
    events: [],
    errorCodes: [],
  };
}

test('classification is generated from the candidate snapshot and exact candidate ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-contract-impact-'));
  try {
    const candidate = join(root, 'candidate');
    const contracts = join(candidate, 'contracts');
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(contracts, { recursive: true }),
    );
    const candidateBytes = Buffer.from(
      `${JSON.stringify(snapshot('0.4.0', 'same'))}\n`,
    );
    const baselineBytes = Buffer.from(
      `${JSON.stringify(snapshot('0.4.0', 'same'))}\n`,
    );
    const candidatePath = join(contracts, 'contract-snapshot.json');
    const baselinePath = join(root, 'baseline.json');
    const output = join(root, 'contract-impact.json');
    await writeFile(candidatePath, candidateBytes);
    await writeFile(baselinePath, baselineBytes);
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, 'classify-release-contract.ts'),
        '--candidate',
        candidate,
        '--candidate-id',
        candidateId,
        '--baseline',
        baselinePath,
        '--output',
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const impact = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(impact.candidateId, candidateId);
    assert.equal(impact.candidateSnapshotSha256, digest(candidateBytes));
    assert.equal(impact.classification, 'no-impact');
    assert.equal(impact.baselineRelease, '0.4.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing stable baseline fails closed into manual review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-contract-impact-'));
  try {
    const candidate = join(root, 'candidate');
    const contracts = join(candidate, 'contracts');
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(contracts, { recursive: true }),
    );
    await writeFile(
      join(contracts, 'contract-snapshot.json'),
      `${JSON.stringify(snapshot('0.4.0', 'candidate'))}\n`,
    );
    const output = join(root, 'contract-impact.json');
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, 'classify-release-contract.ts'),
        '--candidate',
        candidate,
        '--candidate-id',
        candidateId,
        '--output',
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const impact = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(impact.classification, 'manual-review');
    assert.equal(impact.baselineRelease, 'unavailable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
