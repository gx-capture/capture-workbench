import assert from 'node:assert/strict';
import test from 'node:test';

import { liveCheckpointProblem } from './real-engines-checkpoint.ts';

const captureId = 'synthetic-capture';
const atCheckpoint = { captureId, revision: 3 };

function read(snapshot: unknown, capture: { readonly status: string; readonly error?: { readonly code?: unknown } | null }) {
  return liveCheckpointProblem({ captureId, expectedRevision: 3, snapshot, capture });
}

test('a live read at the checkpoint revision while extracting has no problem', () => {
  assert.equal(read(atCheckpoint, { status: 'extracting' }), undefined);
});

test('a failed capture is reported as failed with the runtime error code, not as a missed revision', () => {
  for (const snapshot of [undefined, atCheckpoint, { ...atCheckpoint, revision: 4 }]) {
    const problem = read(snapshot, { status: 'failed', error: { code: 'synthetic_failure' } });
    assert.match(problem ?? '', /extraction failed .*code=synthetic_failure/u);
    assert.doesNotMatch(problem ?? '', /Missed/u);
  }
  assert.match(read(undefined, { status: 'failed', error: null }) ?? '', /code=unknown/u);
});

test('a cancelled capture is reported as stopped with its code, not as a missed revision', () => {
  const problem = read(undefined, { status: 'cancelled', error: { code: 'synthetic_cancel' } });
  assert.match(problem ?? '', /stopped \(cancelled\).*code=synthetic_cancel/u);
  assert.doesNotMatch(problem ?? '', /Missed/u);
});

test('a capture that moved on is a missed revision', () => {
  for (const status of ['awaiting_structuring', 'completed']) {
    assert.match(read(atCheckpoint, { status }) ?? '', new RegExp(`Missed the live checkpoint revision: the capture moved on to ${status}`, 'u'));
    assert.match(read(undefined, { status }) ?? '', /Missed the live checkpoint revision/u);
  }
  assert.match(read({ ...atCheckpoint, revision: 4 }, { status: 'extracting' }) ?? '',
    /Missed the live checkpoint revision: the host partial is at revision 4, expected 3/u);
});

test('the capture id is checked separately from the revision', () => {
  assert.equal(read({ ...atCheckpoint, captureId: 'another-capture' }, { status: 'extracting' }),
    'Host partial belongs to another capture.');
  assert.equal(read({ revision: 3 }, { status: 'extracting' }), 'Host partial belongs to another capture.');
});

test('a missing partial while extracting is not a missed revision', () => {
  assert.equal(read(undefined, { status: 'extracting' }), 'Host partial is unavailable while extraction is active.');
});
