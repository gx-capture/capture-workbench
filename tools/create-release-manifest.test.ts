import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const candidateId = 'a'.repeat(64);
const sourceCommit = 'b'.repeat(40);

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('release manifest is immutable, candidate-bound, and records registry and gate evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-release-manifest-'));
  try {
    const candidate = join(root, 'candidate');
    const runtime = join(candidate, 'runtime');
    const desktop = join(candidate, 'desktop');
    const registries = join(root, 'registries');
    await mkdir(runtime, { recursive: true });
    await mkdir(desktop, { recursive: true });
    await mkdir(registries, { recursive: true });
    await writeFile(join(runtime, 'runtime.bin'), 'runtime');
    await writeFile(join(desktop, 'installer.exe'), 'installer');
    await mkdir(join(candidate, 'contracts'), { recursive: true });
    const candidateManifest = Buffer.from(
      `${JSON.stringify({
        schemaVersion: '1',
        candidateId,
        sourceCommit,
        releaseVersion: '0.3.10',
        runtimeApiVersion: '1.0',
        documentSchemaVersion: '1',
      })}\n`,
    );
    await writeFile(
      join(candidate, 'candidate-manifest.json'),
      candidateManifest,
    );
    const snapshot = Buffer.from(
      `${JSON.stringify({ schemaVersion: '1', releaseVersion: '0.3.10' })}\n`,
    );
    await writeFile(
      join(candidate, 'contracts', 'contract-snapshot.json'),
      snapshot,
    );
    await writeFile(
      join(candidate, 'contract-impact.json'),
      JSON.stringify({
        schemaVersion: '1',
        candidateId,
        candidateSnapshotSha256: digest(snapshot),
        classification: 'no-impact',
        baselineRelease: '0.3.9',
        changes: [],
      }),
    );
    const gate = {
      consumerRepository: 'WodenWang820118/cert-prep',
      consumerCommit: 'c'.repeat(40),
      workflowPath: '.github/workflows/capture-candidate-gate.yml',
      workflowRunId: 123,
      candidateId,
      candidateManifestSha256: digest(candidateManifest),
      verdict: 'passed',
      startedAt: '2026-08-06T00:00:00.000Z',
      completedAt: '2026-08-06T00:01:00.000Z',
    };
    const gateLedger = {
      schemaVersion: '1',
      candidateId,
      candidateManifestSha256: digest(candidateManifest),
      contractClassification: 'no-impact',
      verdict: 'passed',
      gates: [gate],
      resultDigests: [
        {
          consumerRepository: gate.consumerRepository,
          workflowRunId: gate.workflowRunId,
          sha256: 'd'.repeat(64),
        },
      ],
    };
    const evidencePath = join(root, 'promotion-evidence.json');
    const gatePath = join(root, 'consumer-gate-ledger.json');
    await writeFile(
      evidencePath,
      JSON.stringify({
        candidateId,
        candidateManifestSha256: digest(candidateManifest),
        sourceCommit,
        releaseVersion: '0.3.10',
        contractClassification: 'no-impact',
      }),
    );
    await writeFile(gatePath, JSON.stringify(gateLedger));
    await writeFile(
      join(registries, 'registry-ledger-npm.json'),
      JSON.stringify({
        schemaVersion: '1',
        registry: 'npm',
        candidateId,
        releaseVersion: '0.3.10',
        status: 'published',
        packages: [
          { name: '@gx-capture/capture-contracts', integrity: 'sha512-a' },
        ],
      }),
    );
    await writeFile(
      join(registries, 'registry-ledger-pypi.json'),
      JSON.stringify({
        schemaVersion: '1',
        registry: 'pypi',
        candidateId,
        releaseVersion: '0.3.10',
        status: 'published',
        artifacts: [
          {
            name: 'capture_contracts-0.3.10-py3-none-any.whl',
            sha256: 'e'.repeat(64),
          },
        ],
      }),
    );
    await writeFile(
      join(registries, 'registry-ledger-crates.io.json'),
      JSON.stringify({
        schemaVersion: '1',
        registry: 'crates.io',
        candidateId,
        releaseVersion: '0.3.10',
        status: 'published',
        artifacts: [
          {
            name: 'capture-sidecar-launcher-0.3.10.crate',
            candidateSha256: 'f'.repeat(64),
            registrySha256: 'f'.repeat(64),
          },
        ],
      }),
    );
    const output = join(root, 'capture-release-manifest-v1.json');
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, 'create-release-manifest.ts'),
        '--candidate',
        candidate,
        '--tag',
        'v0.3.10',
        '--promotion-evidence',
        evidencePath,
        '--consumer-gate-ledger',
        gatePath,
        '--registry-directory',
        registries,
        '--output',
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(manifest.status, 'released');
    assert.equal(manifest.candidateId, candidateId);
    assert.equal(manifest.releaseTag, 'v0.3.10');
    assert.equal(manifest.registryArtifacts.length, 3);
    assert.equal(manifest.consumerGates.gates[0].verdict, 'passed');
    assert.match(
      await readFile(`${output}.sha256`, 'utf8'),
      /^[0-9a-f]{64}  capture-release-manifest-v1\.json\n$/u,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(candidate, 'candidate-manifest.json'), 'utf8'),
      ),
      JSON.parse(candidateManifest.toString('utf8')),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
