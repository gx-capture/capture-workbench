import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveProgressiveAudioOracleEvidence,
  PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
  type ProgressiveAudioSampleInput,
} from './progressive-audio-evidence.ts';

const digest = 'a'.repeat(64);
const extraction: ProgressiveAudioSampleInput['extraction'] = {
  engine: 'speech-recognition',
  model: 'tea-asr-1.1',
  device: 'cuda',
  digest: `sha256:${digest}`,
};

function sample(
  segments: ProgressiveAudioSampleInput['segments'],
  coveredUntilMs = PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
): ProgressiveAudioSampleInput {
  return {
    sourceSha256: digest,
    sourceBytes: 2_000_000,
    coveredUntilMs,
    partialRevision: 2,
    segments,
    extraction,
  };
}

test('progressive audio oracle is digest-only and bound to the five-minute gate', () => {
  const oracle = deriveProgressiveAudioOracleEvidence(sample([
    { order: 0, startMs: 0, endMs: 1_000, text: '  sample  one ' },
    { order: 1, startMs: 1_000, endMs: 2_000, text: 'sample\n two' },
  ]));
  assert.equal(oracle.evidenceKind, 'progressive-audio-oracle-v1');
  assert.equal(oracle.oracle, 'non-tauri-production-worker');
  assert.equal(oracle.sampleIntervalMs, 5 * 60_000);
  assert.equal(oracle.firstCheckpoint.segmentCount, 2);
  assert.equal(oracle.expectedOutput.segmentCount, 2);
  assert.match(oracle.expectedOutput.normalizedSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(oracle), /sample\s+one|sample\s+two/u);
  assert.doesNotMatch(JSON.stringify(oracle), /(?:sourceText|transcript|token|secret)/iu);
});

test('progressive audio oracle rejects incomplete samples and never keeps segment text', () => {
  assert.throws(() => deriveProgressiveAudioOracleEvidence(sample(
    [{ order: 0, startMs: 0, endMs: 1_000, text: 'sample' }],
    PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS - 1,
  )));
  const safe = deriveProgressiveAudioOracleEvidence(sample([
    { order: 0, startMs: 0, endMs: 1_000, text: 'C:\\private\\audio' },
  ]));
  assert.doesNotMatch(JSON.stringify(safe), /private/u);
});

test('progressive audio oracle digest follows the normalized transcript', () => {
  const oracle = deriveProgressiveAudioOracleEvidence(sample([
    { order: 0, startMs: 0, endMs: 1_000, text: 'oracle one' },
    { order: 1, startMs: 1_000, endMs: 2_000, text: 'oracle two' },
  ]));
  const sameAfterWhitespace = deriveProgressiveAudioOracleEvidence(sample([
    { order: 0, startMs: 0, endMs: 1_000, text: ' oracle   one' },
    { order: 1, startMs: 1_000, endMs: 2_000, text: 'oracle\ntwo ' },
  ]));
  const different = deriveProgressiveAudioOracleEvidence(sample([
    { order: 0, startMs: 0, endMs: 1_000, text: 'different' },
  ]));
  assert.equal(
    sameAfterWhitespace.expectedOutput.normalizedSha256,
    oracle.expectedOutput.normalizedSha256,
  );
  assert.notEqual(different.expectedOutput.normalizedSha256, oracle.expectedOutput.normalizedSha256);
  assert.doesNotMatch(JSON.stringify(oracle), /oracle one|oracle two|transcript/u);
});
