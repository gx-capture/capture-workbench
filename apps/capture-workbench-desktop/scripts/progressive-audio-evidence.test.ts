import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveProgressiveAudioOracleEvidence,
  parseProgressiveAudioOracle,
  progressiveAudioBudgetMs,
  readProgressiveAudioPartial,
  summarizeCheckpoint,
  summarizeTranscript,
  verifyProgressivePartial,
  verifyProgressiveFinal,
  PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
  type ProgressiveAudioSampleInput,
} from './progressive-audio-evidence.ts';

test('progressive budgets are whole milliseconds that grow with the recording and give the CPU more time', () => {
  for (const durationMs of [1, 300_001, 450_003, 2_400_001]) {
    for (const pack of ['cuda', 'cpu'] as const) {
      const budget = progressiveAudioBudgetMs(durationMs, pack);
      assert.ok(Number.isSafeInteger(budget), `${pack} budget for ${durationMs} ms is not whole`);
      assert.ok(budget >= progressiveAudioBudgetMs(durationMs - 1, pack));
      assert.ok(budget > durationMs / 10, 'a budget must exceed ten times real-time decoding');
      // AbortSignal.timeout refuses fractional delays.
      assert.doesNotThrow(() => AbortSignal.timeout(budget));
    }
    assert.ok(progressiveAudioBudgetMs(durationMs, 'cpu') > progressiveAudioBudgetMs(durationMs, 'cuda'));
  }
});

const digest = 'a'.repeat(64);
const extraction: ProgressiveAudioSampleInput['extraction'] = {
  engine: 'speech-recognition',
  model: 'synthetic-speech',
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

function oracleFor(input: ProgressiveAudioSampleInput) {
  return deriveProgressiveAudioOracleEvidence(input, 'cuda', 310_000, [
    ...input.segments,
    { order: input.segments.length, startMs: 305_000, endMs: 308_000, text: 'synthetic tail' },
  ]);
}

test('progressive audio oracle is digest-only and bound to the five-minute gate', () => {
  const oracle = oracleFor(sample([
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
  assert.throws(() => oracleFor(sample(
    [{ order: 0, startMs: 0, endMs: 1_000, text: 'sample' }],
    PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS - 1,
  )));
  const safe = oracleFor(sample([
    { order: 0, startMs: 0, endMs: 1_000, text: 'C:\\private\\audio' },
  ]));
  assert.doesNotMatch(JSON.stringify(safe), /private/u);
});

test('progressive audio oracle digest follows the normalized transcript', () => {
  const oracle = oracleFor(sample([
    { order: 0, startMs: 0, endMs: 1_000, text: 'oracle one' },
    { order: 1, startMs: 1_000, endMs: 2_000, text: 'oracle two' },
  ]));
  const sameAfterWhitespace = oracleFor(sample([
    { order: 0, startMs: 0, endMs: 1_000, text: ' oracle   one' },
    { order: 1, startMs: 1_000, endMs: 2_000, text: 'oracle\ntwo ' },
  ]));
  const different = oracleFor(sample([
    { order: 0, startMs: 0, endMs: 1_000, text: 'different' },
  ]));
  assert.equal(
    sameAfterWhitespace.expectedOutput.normalizedSha256,
    oracle.expectedOutput.normalizedSha256,
  );
  assert.notEqual(different.expectedOutput.normalizedSha256, oracle.expectedOutput.normalizedSha256);
  assert.doesNotMatch(JSON.stringify(oracle), /oracle one|oracle two|transcript/u);
});

test('checkpoint validates both coverage boundaries, segment end times and provenance', () => {
  for (const coveredUntilMs of [300_000, 340_000]) {
    const input = sample([{ order: 0, startMs: 0, endMs: coveredUntilMs, text: 'sample' }], coveredUntilMs);
    assert.equal(summarizeCheckpoint(input).segmentCount, 1);
    assert.throws(() => summarizeCheckpoint({
      ...input, segments: [{ order: 0, startMs: 0, endMs: coveredUntilMs + 1, text: 'sample' }],
    }));
    assert.throws(() => summarizeCheckpoint({
      ...input, extraction: { ...extraction, engine: 'another-engine' },
    }), /provenance/u);
  }
  assert.throws(() => summarizeCheckpoint(sample([], 340_001)), /checkpoint window/u);
  assert.throws(() => readProgressiveAudioPartial({
    source: { sha256: digest, bytes: 2 }, revision: 1, coveredUntilMs: 300_000, segments: [],
  }, { sha256: digest, bytes: 2 }), /provenance/u);
});

test('oracle reader validates pack, model, device, checkpoint and final output structure', () => {
  const oracle = oracleFor(sample([{ order: 0, startMs: 0, endMs: 1_000, text: 'prefix' }]));
  assert.deepEqual(parseProgressiveAudioOracle(JSON.parse(JSON.stringify(oracle))), oracle);
  assert.deepEqual(oracle.afterCheckpoint, summarizeTranscript(['synthetic tail']));
  assert.equal(oracle.finalOutput.segmentCount, 2);
  const cpu = { ...oracle, speechPack: 'cpu', extraction: { ...extraction, device: 'cpu' } };
  assert.deepEqual(parseProgressiveAudioOracle(cpu), cpu);
  for (const invalid of [
    null,
    [],
    { ...oracle, speechPack: undefined },
    { ...oracle, speechPack: 'cpu' },
    { ...oracle, extraction: { ...extraction, device: 'unknown' } },
    { ...oracle, extraction: { ...extraction, model: '' } },
    { ...oracle, firstCheckpoint: { ...oracle.firstCheckpoint, partialRevision: '2' } },
    { ...oracle, firstCheckpoint: { ...oracle.firstCheckpoint, coveredUntilMs: 340_001 } },
    { ...oracle, durationMs: 300_000 },
    { ...oracle, input: [] },
    { ...oracle, finalOutput: { segmentCount: 2, normalizedSha256: 'invalid' } },
    { ...oracle, afterCheckpoint: undefined },
  ]) {
    assert.throws(() => parseProgressiveAudioOracle(invalid), /invalid progressive audio oracle/i);
  }
});

test('progressive evidence compares the host snapshot and displayed partial at the same revision', () => {
  const prefix = { order: 0, startMs: 0, endMs: 1000, text: 'prefix' };
  const oracle = oracleFor(sample([prefix]));
  const snapshot = {
    source: oracle.input,
    revision: oracle.firstCheckpoint.partialRevision,
    coveredUntilMs: oracle.firstCheckpoint.coveredUntilMs,
    extractionEngine: extraction,
    segments: [{
      segmentId: 'segment-1', order: 0, text: prefix.text,
      locator: { kind: 'time', startMs: prefix.startMs, endMs: prefix.endMs },
    }],
  };
  verifyProgressivePartial(oracle, snapshot, ['prefix']);
  assert.throws(() => verifyProgressivePartial(oracle, { ...snapshot, revision: 3 }, ['prefix']), /revision/u);
  assert.throws(() => verifyProgressivePartial(oracle, snapshot, ['different']), /Displayed partial/u);
});

test('progressive final check requires stored and displayed speech after the checkpoint', () => {
  const prefix = { order: 0, startMs: 0, endMs: 1000, text: 'prefix' };
  const oracle = oracleFor(sample([prefix]));
  const segments = [
    { order: 0, segmentId: 'segment-1', text: 'prefix', locator: { kind: 'time', startMs: 0, endMs: 1000 } },
    { order: 1, segmentId: 'segment-2', text: 'synthetic tail', locator: { kind: 'time', startMs: 305_000, endMs: 308_000 } },
  ];
  const raw = { extractionEngine: extraction, segments };
  const rendered = segments.map(({ segmentId, text }) => ({ segmentId, text }));
  verifyProgressiveFinal(oracle, raw, rendered);
  const earlyTail = { ...segments[1], locator: { kind: 'time', startMs: 290_000, endMs: 298_000 } };
  assert.throws(() => verifyProgressiveFinal(oracle, { ...raw, segments: [segments[0], earlyTail] }, rendered),
    /speech after the checkpoint differs/u);
  assert.throws(() => verifyProgressiveFinal(oracle, raw, [
    rendered[0], { segmentId: 'segment-2', text: 'different tail' },
  ]), /Displayed final transcript/u);
});
