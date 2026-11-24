import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCancelSequence,
  expectedSpeechProvenance,
  readRecordingOutcome,
} from './real-desktop-asr-journey.ts';

const digest = `sha256:${'d'.repeat(64)}`;

function completedRecording(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'completed',
    captureId: null,
    raw: {
      segments: [{ segmentId: 's1', text: 'synthetic line' }],
      extractionEngine: { engine: 'speech-recognition', model: 'tea-asr-1.1', device: 'cuda', digest },
    },
    result: {
      extractionEngine: { engine: 'speech-recognition', model: 'tea-asr-1.1', device: 'cuda', digest },
      structuringEngine: { engine: 'ollama', model: 'synthetic-structuring-model', device: 'cuda', digest },
    },
    ...overrides,
  };
}

test('the packaged app runs the installed pack\'s default: TEA-ASR 1.1 on CUDA with the NVIDIA driver, mini on CPU without', () => {
  assert.deepEqual(expectedSpeechProvenance(true), { pack: 'cuda', model: 'tea-asr-1.1', device: 'cuda' });
  assert.deepEqual(expectedSpeechProvenance(false), { pack: 'cpu', model: 'tea-asr-1.1-mini', device: 'cpu' });
});

test('a cancelled recording shows 取消中 and then 已取消, with nothing else between them', () => {
  assertCancelSequence([
    { status: 'processing', text: '處理中' },
    { status: 'processing', text: '取消中' },
    { status: 'cancelled', text: '已取消' },
  ]);
  assert.throws(
    () => assertCancelSequence([{ status: 'processing', text: '處理中' }, { status: 'cancelled', text: '已取消' }]),
    /never showed 取消中/u,
  );
  assert.throws(
    () => assertCancelSequence([{ status: 'processing', text: '取消中' }, { status: 'done', text: '完成' }]),
    /did not show 已取消 after 取消中/u,
  );
  assert.throws(
    () => assertCancelSequence([
      { status: 'processing', text: '取消中' },
      { status: 'done', text: '完成' },
      { status: 'cancelled', text: '已取消' },
    ]),
    /another state between/u,
  );
});

test('a done recording is stored completed with the installed pack\'s provenance and its structuring', () => {
  const expected = expectedSpeechProvenance(true);
  const outcome = readRecordingOutcome(completedRecording(), expected, { structuringDevice: 'cuda' });
  assert.deepEqual(outcome, {
    extraction: { engine: 'speech-recognition', model: 'tea-asr-1.1', device: 'cuda', digest },
    structuring: { engine: 'ollama', model: 'synthetic-structuring-model', device: 'cuda' },
    segmentCount: 1,
  });
});

test('a recording transcribed elsewhere, kept linked or structured on another device is refused', () => {
  const expected = expectedSpeechProvenance(true);
  const onCpu = { engine: 'speech-recognition', model: 'tea-asr-1.1', device: 'cpu', digest };
  assert.throws(
    () => readRecordingOutcome(completedRecording({ result: { ...completedRecording().result as object, extractionEngine: onCpu } }), expected),
    /installed pack's device/u,
  );
  assert.throws(() => readRecordingOutcome(completedRecording({ captureId: 'capture-1' }), expected), /kept its capture link/u);
  assert.throws(() => readRecordingOutcome(completedRecording({ status: 'canceled' }), expected), /not stored completed/u);
  assert.throws(
    () => readRecordingOutcome(completedRecording(), expected, { structuringDevice: 'vulkan' }),
    /structured on the designed device/u,
  );
});

test('the structured result must carry the same speech provenance as the raw capture', () => {
  const expected = expectedSpeechProvenance(true);
  const result = completedRecording().result as object;
  assert.throws(
    () => readRecordingOutcome(completedRecording({ result: { ...result, extractionEngine: undefined } }), expected),
    /structured result omitted its speech provenance/u,
  );
  const mismatchedRaw = {
    segments: [{ text: 'synthetic line' }],
    extractionEngine: { engine: 'speech-recognition', model: 'tea-asr-1.1', device: 'cuda', digest: `sha256:${'e'.repeat(64)}` },
  };
  assert.throws(
    () => readRecordingOutcome(completedRecording({ raw: mismatchedRaw }), expected),
    /structured result and raw capture disagree/u,
  );
});
