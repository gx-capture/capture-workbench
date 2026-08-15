import assert from 'node:assert/strict';
import test from 'node:test';

import {
  updateReleaseIndex,
  type ReleaseIndex,
  type StableIndex,
} from './update-release-index.ts';

const firstCandidate = 'a'.repeat(64);
const secondCandidate = 'b'.repeat(64);
const firstManifest = 'c'.repeat(64);
const secondManifest = 'd'.repeat(64);

function stable(releaseTag: string | null = null): StableIndex {
  return {
    schemaVersion: '1',
    channel: 'stable',
    releaseTag,
    manifestSha256: releaseTag === 'v0.3.10' ? firstManifest : null,
    manifestAssetName: 'capture-release-manifest-v1.json',
    updatedAt: null,
  };
}

function releases(entries: ReleaseIndex['releases'] = {}): ReleaseIndex {
  return { schemaVersion: '1', releases: entries };
}

test('promotion records an immutable release and stable pointer', () => {
  const result = updateReleaseIndex(stable(), releases(), {
    operation: 'promote',
    tag: 'v0.4.0',
    candidateId: firstCandidate,
    manifestSha256: firstManifest,
    updatedAt: '2026-08-06T00:00:00.000Z',
  });
  assert.equal(result.stable.releaseTag, 'v0.4.0');
  assert.deepEqual(result.releases.releases['v0.4.0'], {
    status: 'released',
    manifestSha256: firstManifest,
    candidateId: firstCandidate,
  });
});

test('supersession moves stable to the replacement and preserves defective history', () => {
  const result = updateReleaseIndex(
    stable('v0.3.10'),
    releases({
      'v0.3.10': {
        status: 'released',
        manifestSha256: firstManifest,
        candidateId: firstCandidate,
      },
      'v0.4.0': {
        status: 'released',
        manifestSha256: secondManifest,
        candidateId: secondCandidate,
      },
    }),
    {
      operation: 'supersede',
      defectiveTag: 'v0.3.10',
      replacementTag: 'v0.4.0',
      defectiveManifestSha256: firstManifest,
      replacementManifestSha256: secondManifest,
      reason: 'runtime metadata defect',
      updatedAt: '2026-08-06T00:00:00.000Z',
    },
  );
  assert.equal(result.stable.releaseTag, 'v0.4.0');
  assert.deepEqual(result.releases.releases['v0.3.10'], {
    status: 'superseded',
    manifestSha256: firstManifest,
    candidateId: firstCandidate,
    supersededBy: 'v0.4.0',
    reason: 'runtime metadata defect',
  });
});

test('superseded history cannot be revived by a promotion retry', () => {
  assert.throws(
    () =>
      updateReleaseIndex(
        stable(),
        releases({
          'v0.4.0': {
            status: 'superseded',
            manifestSha256: secondManifest,
            candidateId: secondCandidate,
            supersededBy: 'v0.4.0',
            reason: 'known defect',
          },
        }),
        {
          operation: 'promote',
          tag: 'v0.4.0',
          candidateId: secondCandidate,
          manifestSha256: secondManifest,
          updatedAt: '2026-08-06T00:00:00.000Z',
        },
      ),
    /cannot be promoted again/u,
  );
});
