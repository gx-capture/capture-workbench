import assert from 'node:assert/strict';
import test from 'node:test';

import {
  liveCheckpointProblem,
  persistedCaptureState,
  shownPastCheckpointProblem,
  sinceCaptureStart,
} from './real-engines-checkpoint.ts';

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

test('a card past the checkpoint reports a capture that failed or was cancelled meanwhile, not a missed revision', () => {
  // The row said processing when it was read; the capture state read afterwards decides.
  const failed = shownPastCheckpointProblem({
    expectedRevision: 3, shownRevision: 5, capture: { status: 'failed', error: { code: 'synthetic_failure' } },
  });
  assert.match(failed, /extraction failed .*code=synthetic_failure/u);
  assert.doesNotMatch(failed, /Missed/u);
  const cancelled = shownPastCheckpointProblem({
    expectedRevision: 3, shownRevision: 4, capture: persistedCaptureState({ status: 'canceled', errorCode: 'synthetic_cancel' }),
  });
  assert.match(cancelled, /stopped \(cancelled\).*code=synthetic_cancel/u);
  for (const status of ['extracting', 'awaiting_structuring']) {
    assert.match(shownPastCheckpointProblem({ expectedRevision: 3, shownRevision: 4, capture: { status } }),
      new RegExp(`Missed the live checkpoint revision between UI polls: the card shows revision 4, expected 3; the capture is ${status}`, 'u'));
  }
});

test('the persisted state uses the runtime terms and keeps the error code', () => {
  assert.deepEqual(persistedCaptureState({ status: 'canceled' }), { status: 'cancelled', error: null });
  assert.deepEqual(persistedCaptureState({ status: 'failed', errorCode: 'synthetic_failure' }),
    { status: 'failed', error: { code: 'synthetic_failure' } });
});

test('timings count from the runtime capture start', () => {
  const createdAt = '2030-01-01T00:00:00.000Z';
  assert.equal(sinceCaptureStart({ status: 'extracting', createdAt }, Date.parse(createdAt) + 24_000), 24_000);
  assert.equal(sinceCaptureStart({ status: 'extracting' }, 1), undefined);
  assert.equal(sinceCaptureStart({ status: 'extracting', createdAt: 'not a time' }, 1), undefined);
});