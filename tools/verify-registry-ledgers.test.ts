import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requiredRegistries,
  verifyRegistryLedger,
} from './verify-registry-ledgers.ts';

test('registry scope selects only the requested publication recovery lane', () => {
  assert.deepEqual(requiredRegistries('all'), [
    'npm',
    'pypi',
    'crates.io',
    'maven',
  ]);
  assert.deepEqual(requiredRegistries('pypi-client'), ['pypi']);
  assert.deepEqual(requiredRegistries('crates'), ['crates.io']);
  assert.deepEqual(requiredRegistries('maven'), ['maven']);
  assert.throws(() => requiredRegistries('unknown'), /invalid/u);
});

test('registry ledger requires the full-candidate and contract-set bindings', () => {
  const hash = 'c'.repeat(64);
  const sourceManifestHash = 'd'.repeat(64);
  assert.doesNotThrow(() =>
    verifyRegistryLedger(
      {
        schemaVersion: '1',
        registry: 'maven',
        candidateId: 'a'.repeat(64),
        releaseCandidateId: 'b'.repeat(64),
        contractSetSha256: hash,
        sourceCandidateManifestSha256: sourceManifestHash,
        releaseVersion: '0.4.1',
        status: 'published',
      },
      'maven',
      'b'.repeat(64),
      '0.4.1',
      {
        sourceCandidateId: 'a'.repeat(64),
        releaseCandidateId: 'b'.repeat(64),
        contractSetSha256: hash,
      },
    ),
  );
  assert.throws(
    () =>
      verifyRegistryLedger(
        {
          schemaVersion: '1',
          registry: 'maven',
          candidateId: 'b'.repeat(64),
          releaseCandidateId: 'b'.repeat(64),
          contractSetSha256: hash,
          sourceCandidateManifestSha256: sourceManifestHash,
          releaseVersion: '0.4.1',
          status: 'published',
        },
        'maven',
        'b'.repeat(64),
        '0.4.1',
        {
          sourceCandidateId: 'a'.repeat(64),
          releaseCandidateId: 'b'.repeat(64),
          contractSetSha256: hash,
        },
      ),
    /passing/u,
  );
  assert.throws(
    () =>
      verifyRegistryLedger(
        {
          schemaVersion: '1',
          registry: 'maven',
          candidateId: 'a'.repeat(64),
          releaseCandidateId: 'b'.repeat(64),
          contractSetSha256: 'd'.repeat(64),
          sourceCandidateManifestSha256: sourceManifestHash,
          releaseVersion: '0.4.1',
          status: 'published',
        },
        'maven',
        'b'.repeat(64),
        '0.4.1',
        {
          sourceCandidateId: 'a'.repeat(64),
          releaseCandidateId: 'b'.repeat(64),
          contractSetSha256: hash,
        },
      ),
    /contract set/u,
  );
  assert.throws(
    () =>
      verifyRegistryLedger(
        {
          schemaVersion: '1',
          registry: 'maven',
          candidateId: 'a'.repeat(64),
          releaseCandidateId: 'b'.repeat(64),
          contractSetSha256: hash,
          sourceCandidateManifestSha256: sourceManifestHash,
          releaseVersion: '0.4.1',
          status: 'published',
        },
        'maven',
        'b'.repeat(64),
        '0.4.1',
        {
          sourceCandidateId: 'a'.repeat(64),
          releaseCandidateId: 'b'.repeat(64),
          contractSetSha256: hash,
          sourceCandidateManifestSha256: 'e'.repeat(64),
        },
      ),
    /source candidate manifest/u,
  );
});

test('registry ledger is bound to one candidate and release version', () => {
  assert.doesNotThrow(() =>
    verifyRegistryLedger(
      {
        schemaVersion: '1',
        registry: 'npm',
        candidateId: 'a'.repeat(64),
        sourceCandidateManifestSha256: 'e'.repeat(64),
        releaseVersion: '0.4.1',
        status: 'published',
      },
      'npm',
      'a'.repeat(64),
      '0.4.1',
    ),
  );
  assert.throws(
    () =>
      verifyRegistryLedger(
        {
          schemaVersion: '1',
          registry: 'npm',
          candidateId: 'b'.repeat(64),
          sourceCandidateManifestSha256: 'e'.repeat(64),
          releaseVersion: '0.4.1',
          status: 'published',
        },
        'npm',
        'a'.repeat(64),
        '0.4.1',
      ),
    /passing/u,
  );
});
