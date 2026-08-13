import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requiredRegistries,
  verifyRegistryLedger,
} from './verify-registry-ledgers.ts';

test('registry scope selects only the requested publication recovery lane', () => {
  assert.deepEqual(requiredRegistries('all'), ['npm', 'pypi', 'crates.io']);
  assert.deepEqual(requiredRegistries('crates'), ['crates.io']);
  assert.throws(() => requiredRegistries('unknown'), /invalid/u);
});

test('registry ledger is bound to one candidate and release version', () => {
  assert.doesNotThrow(() =>
    verifyRegistryLedger(
      {
        schemaVersion: '1',
        registry: 'npm',
        candidateId: 'a'.repeat(64),
        releaseVersion: '0.3.12',
        status: 'published',
      },
      'npm',
      'a'.repeat(64),
      '0.3.12',
    ),
  );
  assert.throws(
    () =>
      verifyRegistryLedger(
        {
          schemaVersion: '1',
          registry: 'npm',
          candidateId: 'b'.repeat(64),
          releaseVersion: '0.3.12',
          status: 'published',
        },
        'npm',
        'a'.repeat(64),
        '0.3.12',
      ),
    /passing/u,
  );
});
