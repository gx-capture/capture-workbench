import assert from 'node:assert/strict';
import test from 'node:test';

import { computeCandidateId } from './verify-release-candidate.ts';

test('candidate identity is deterministic and changes when an artifact digest changes', () => {
  const manifest = {
    schemaVersion: '1',
    sourceCommit: 'a'.repeat(40),
    releaseVersion: '0.3.12',
    releaseMode: 'core-only',
    runtimeApiVersion: '1.0',
    documentSchemaVersion: '1',
    artifacts: [{ path: 'runtime/a.exe', bytes: 1, sha256: 'a'.repeat(64) }],
    toolchains: { node: 'v24.0.0' },
    contractImpact: null,
  };
  assert.equal(
    computeCandidateId(manifest),
    computeCandidateId({ ...manifest }),
  );
  assert.notEqual(
    computeCandidateId(manifest),
    computeCandidateId({
      ...manifest,
      artifacts: [{ ...manifest.artifacts[0], sha256: 'b'.repeat(64) }],
    }),
  );
});
