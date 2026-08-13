import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateConsumerGateResults,
  verifyConsumerGateResult,
  verifyCandidateManifest,
} from './consumer-gate.ts';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const candidateId = 'a'.repeat(64);
const manifestSha256 = 'b'.repeat(64);
const consumerCommit = 'c'.repeat(40);
const expectation = {
  repository: 'WodenWang820118/cert-prep',
  workflowPath: '.github/workflows/capture-candidate-gate.yml',
  workflowRunId: 123,
  candidateId,
  candidateManifestSha256: manifestSha256,
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1',
    consumerRepository: expectation.repository,
    consumerCommit: consumerCommit,
    workflowPath: expectation.workflowPath,
    workflowRunId: expectation.workflowRunId,
    candidateId,
    candidateManifestSha256: manifestSha256,
    verdict: 'passed',
    checks: [],
    startedAt: '2026-08-06T00:00:00.000Z',
    completedAt: '2026-08-06T00:01:00.000Z',
    ...overrides,
  };
}

test('consumer gate result is bound to repository, workflow, run, and candidate', () => {
  const verified = verifyConsumerGateResult(result(), expectation);
  assert.equal(verified.workflowRunId, 123);
  assert.equal(
    aggregateConsumerGateResults(
      [verified],
      candidateId,
      manifestSha256,
      'additive',
      [
        {
          consumerRepository: expectation.repository,
          workflowRunId: expectation.workflowRunId,
          sha256: 'e'.repeat(64),
        },
      ],
    ).verdict,
    'passed',
  );
});

test('aggregate ledger requires a digest for every verified consumer run', () => {
  const verified = verifyConsumerGateResult(result(), expectation);
  assert.throws(
    () =>
      aggregateConsumerGateResults(
        [verified],
        candidateId,
        manifestSha256,
        'additive',
      ),
    /downloaded result digest/u,
  );
});

test('consumer gate result rejects candidate mismatch and extra fields', () => {
  assert.throws(
    () =>
      verifyConsumerGateResult(
        result({ candidateId: 'd'.repeat(64) }),
        expectation,
      ),
    /candidate ID/u,
  );
  assert.throws(
    () =>
      verifyConsumerGateResult({ ...result(), unexpected: true }, expectation),
    /canonical/u,
  );
});

test('downloaded candidate manifest is verified by exact digest and identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-consumer-gate-'));
  try {
    const bytes = Buffer.from(
      `${JSON.stringify(
        {
          schemaVersion: '1',
          candidateId,
          sourceCommit: consumerCommit,
          releaseVersion: '0.3.12',
        },
        null,
        2,
      )}\n`,
    );
    const manifestPath = join(root, 'candidate-manifest.json');
    await writeFile(manifestPath, bytes);
    await verifyCandidateManifest(root, {
      candidateId,
      candidateManifestSha256: createHash('sha256').update(bytes).digest('hex'),
      sourceCommit: consumerCommit,
      releaseVersion: '0.3.12',
    });
    await assert.rejects(
      verifyCandidateManifest(root, {
        candidateId,
        candidateManifestSha256: 'e'.repeat(64),
        sourceCommit: consumerCommit,
        releaseVersion: '0.3.12',
      }),
      /digest/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
