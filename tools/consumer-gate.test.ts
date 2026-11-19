import './test-temp-root.ts';
import { RELEASE_VERSION } from './release/release-intent.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateConsumerGateResults,
  verifyConsumerGateResult,
  verifyCandidateManifest,
} from './consumer-gate.ts';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANDIDATE_VERIFICATION_SUMMARY,
  verifyCandidateVerificationSummary,
} from './release/candidate-verification-summary.ts';

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
          releaseVersion: RELEASE_VERSION,
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
      releaseVersion: RELEASE_VERSION,
    });
    await assert.rejects(
      verifyCandidateManifest(root, {
        candidateId,
        candidateManifestSha256: 'e'.repeat(64),
        sourceCommit: consumerCommit,
        releaseVersion: RELEASE_VERSION,
      }),
      /digest/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate verification evidence is versioned, bound to its bytes, and read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-candidate-summary-'));
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const schemaPath = 'runtime/capture-document-v2.schema.json';
  const schema = '{"title":"Fixture schema"}\n';
  const contracts = '{"contracts":[]}\n';
  const captureDocumentSchemaSha256 = digest(schema);
  const contractSetSha256 = digest(contracts);
  const common = {
    candidateId,
    sourceCommit: consumerCommit,
    releaseMode: 'model-enabled',
    contractSetSha256,
    artifacts: [{ path: schemaPath, sha256: captureDocumentSchemaSha256 }],
  };
  const previous = { ...common, releaseVersion: '0.9.9' };
  const current = { ...common, releaseVersion: '99.0.0' };
  const summaryPath = join(root, CANDIDATE_VERIFICATION_SUMMARY);
  const legacyPath = join(root, 'release-ledger.json');
  try {
    await mkdir(join(root, 'runtime'));
    await mkdir(join(root, 'contracts'));
    await writeFile(join(root, schemaPath), schema);
    await writeFile(join(root, 'contracts', 'contract-set.json'), contracts);
    const legacyDigest = digest(JSON.stringify(previous));
    const legacy = JSON.stringify({
      candidateId,
      sourceCommit: consumerCommit,
      releaseMode: previous.releaseMode,
      candidateManifestSha256: legacyDigest,
      version: previous.releaseVersion,
      schemaSha256: captureDocumentSchemaSha256,
      artifacts: [],
      status: 'candidate-verified',
    });
    await writeFile(legacyPath, legacy);
    verifyCandidateVerificationSummary(root, previous, legacyDigest);
    assert.equal(await readFile(legacyPath, 'utf8'), legacy);

    const candidateManifestSha256 = digest(JSON.stringify(current));
    assert.throws(
      () => verifyCandidateVerificationSummary(root, current, candidateManifestSha256),
      { code: 'ENOENT' },
    );
    const summary = {
      schemaVersion: '1',
      candidateId,
      sourceCommit: consumerCommit,
      candidateManifestSha256,
      contractSetSha256,
      captureDocumentSchemaSha256,
    };
    for (const field of Object.keys(summary)) {
      await writeFile(summaryPath, JSON.stringify({ ...summary, [field]: 'wrong' }));
      assert.throws(
        () => verifyCandidateVerificationSummary(root, current, candidateManifestSha256),
        /does not match the candidate manifest/u,
      );
    }
    const summaryBytes = JSON.stringify(summary);
    await writeFile(summaryPath, summaryBytes);
    verifyCandidateVerificationSummary(root, current, candidateManifestSha256);
    assert.equal(await readFile(summaryPath, 'utf8'), summaryBytes);
    assert.equal(await readFile(join(root, schemaPath), 'utf8'), schema);
    assert.equal(
      await readFile(join(root, 'contracts', 'contract-set.json'), 'utf8'),
      contracts,
    );
    await writeFile(join(root, schemaPath), 'changed schema');
    assert.throws(
      () => verifyCandidateVerificationSummary(root, current, candidateManifestSha256),
      /digest mismatch for runtime/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('consumer gate result validation keeps its exact evidence-value messages', () => {
  assert.throws(
    () => verifyConsumerGateResult({ ...result(), extra: 1 }, expectation),
    { message: 'Consumer gate result fields are not canonical.' },
  );
  const { checks: _checks, ...missing } = result();
  assert.throws(() => verifyConsumerGateResult(missing, expectation), {
    message: 'Consumer gate result fields are not canonical.',
  });
  for (const consumerCommit of ['C'.repeat(40), 'c'.repeat(39), 7]) {
    assert.throws(
      () => verifyConsumerGateResult(result({ consumerCommit }), expectation),
      { message: 'Consumer commit must be a full lowercase Git SHA.' },
    );
  }
});

test('aggregate ledger keeps its exact SHA-256 messages', () => {
  const run = (id: unknown, manifest: unknown) => () =>
    aggregateConsumerGateResults([], id as string, manifest as string, 'x');
  for (const bad of ['A'.repeat(64), 'a'.repeat(63), undefined]) {
    assert.throws(run(bad, manifestSha256), {
      message: 'Candidate ID must be a lowercase SHA-256 digest.',
    });
    assert.throws(run(candidateId, bad), {
      message: 'Candidate manifest digest must be a lowercase SHA-256 digest.',
    });
  }
});
