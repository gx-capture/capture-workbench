import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyPromotionEvidence } from './verify-promotion-evidence.ts';

const candidateId = 'a'.repeat(64);
const manifestSha256 = 'b'.repeat(64);
const candidateSnapshotSha256 = 'f'.repeat(64);
const sourceCommit = 'c'.repeat(40);
const repository = 'WodenWang820118/cert-prep';
const workflowPath = '.github/workflows/capture-candidate-gate.yml';

function passingReport(verification: string) {
  return {
    schemaVersion: '1',
    candidateId,
    verification,
    status: 'success',
  };
}

function passingGate() {
  return {
    schemaVersion: '1',
    consumerRepository: repository,
    consumerCommit: 'd'.repeat(40),
    workflowPath,
    workflowRunId: 123,
    candidateId,
    candidateManifestSha256: manifestSha256,
    verdict: 'passed',
    checks: [],
    startedAt: '2026-08-06T00:00:00.000Z',
    completedAt: '2026-08-06T00:01:00.000Z',
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    candidateManifest: {
      schemaVersion: '1',
      candidateId,
      sourceCommit,
      releaseVersion: '0.3.10',
      releaseMode: 'core-only',
      artifacts: [
        {
          path: 'contracts/contract-snapshot.json',
          sha256: candidateSnapshotSha256,
        },
      ],
    },
    candidateManifestSha256: manifestSha256,
    candidateId,
    producerRun: {
      path: '.github/workflows/release-candidate.yml',
      status: 'completed',
      conclusion: 'success',
    },
    producerJobs: [
      'build-candidate',
      'windows-install',
      'runtime-product',
      'cross-framework-consumers',
    ].map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    verificationReports: [
      passingReport('windows-install'),
      passingReport('runtime-product'),
      passingReport('cross-framework-consumers'),
    ],
    contractImpact: {
      schemaVersion: '1',
      candidateId,
      candidateSnapshotSha256,
      classification: 'no-impact',
      baselineRelease: '0.3.9',
      changes: [],
    },
    candidateSnapshotSha256,
    consumerGateRun: {
      path: '.github/workflows/consumer-gates.yml',
      status: 'completed',
      conclusion: 'success',
    },
    consumerGateLedger: {
      schemaVersion: '1',
      candidateId,
      candidateManifestSha256: manifestSha256,
      contractClassification: 'no-impact',
      verdict: 'passed',
      gates: [passingGate()],
      resultDigests: [
        {
          consumerRepository: repository,
          workflowRunId: 123,
          sha256: 'e'.repeat(64),
        },
      ],
    },
    consumerGateConfig: [
      {
        name: 'cert-prep',
        repository,
        workflowPath,
        ref: 'main',
        requiredWhen: 'always',
      },
    ],
    ...overrides,
  };
}

test('promotion evidence requires passing exact candidate, producer, and consumer records', () => {
  const metadata = verifyPromotionEvidence(evidence());
  assert.deepEqual(metadata, {
    candidateId,
    candidateManifestSha256: manifestSha256,
    sourceCommit,
    releaseVersion: '0.3.10',
    releaseMode: 'core-only',
    contractClassification: 'no-impact',
  });
});

test('promotion evidence rejects a missing required producer job', () => {
  assert.throws(
    () =>
      verifyPromotionEvidence(
        evidence({
          producerJobs: [
            {
              name: 'build-candidate',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        }),
      ),
    /Required producer job did not pass/u,
  );
});

test('contract-affecting classifications require the additional configured gate', () => {
  const value = evidence({
    contractImpact: {
      ...evidence().contractImpact,
      classification: 'additive',
    },
    consumerGateLedger: {
      ...evidence().consumerGateLedger,
      contractClassification: 'additive',
    },
    consumerGateConfig: [
      ...evidence().consumerGateConfig,
      {
        name: 'gx-law-prep',
        repository: 'WodenWang820118/gx.law-prep',
        workflowPath: '.github/workflows/capture-contract-gate.yml',
        ref: 'main',
        requiredWhen: 'contract',
      },
    ],
  });
  assert.throws(
    () => verifyPromotionEvidence(value),
    /exactly the required gates/u,
  );
});
