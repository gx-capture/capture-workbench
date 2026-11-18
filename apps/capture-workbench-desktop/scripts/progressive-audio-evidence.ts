import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS = 5 * 60_000;
// Both the oracle and progressive audio checks use the same exact 310-second
// sample. This guarantees that the five-minute checkpoint is exercised before
// terminal completion assertions.
export const REAL_MODEL_AUDIO_SAMPLE_SECONDS = 5 * 60 + 10;
export const PROGRESSIVE_AUDIO_CHECKPOINT_MS = 5 * 60_000;

const SHA256 = /^[a-f0-9]{64}$/u;
const ENGINE_DIGEST = /^sha256:[a-f0-9]{64}$/u;

export interface ProgressiveAudioSampleSegment {
  readonly order: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface ProgressiveAudioSampleInput {
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly coveredUntilMs: number;
  readonly partialRevision: number;
  readonly segments: readonly ProgressiveAudioSampleSegment[];
  readonly extraction: {
    readonly engine: string;
    readonly model: string;
    readonly device: 'cuda' | 'cpu';
    readonly digest: string;
  };
}

export interface ProgressiveAudioSampleEvidence {
  readonly evidenceKind: 'progressive-audio-sample-v1';
  readonly sampleIntervalMs: typeof PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS;
  readonly input: {
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly firstCheckpoint: {
    readonly coveredUntilMs: number;
    readonly partialRevision: number;
    readonly segmentCount: number;
  };
  readonly expectedOutput: {
    readonly normalizedSha256: string;
    readonly segmentCount: number;
  };
  readonly extraction: ProgressiveAudioSampleInput['extraction'];
}

export interface ProgressiveAudioOracleEvidence {
  readonly evidenceKind: 'progressive-audio-oracle-v1';
  readonly oracle: 'non-tauri-production-worker';
  readonly sampleIntervalMs: typeof PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS;
  readonly input: {
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly firstCheckpoint: {
    readonly coveredUntilMs: number;
    readonly partialRevision: number;
    readonly segmentCount: number;
  };
  readonly expectedOutput: {
    readonly normalizedSha256: string;
    readonly segmentCount: number;
  };
  readonly extraction: ProgressiveAudioSampleInput['extraction'];
}

export function deriveProgressiveAudioSampleEvidence(
  input: ProgressiveAudioSampleInput,
): ProgressiveAudioSampleEvidence {
  assert.match(input.sourceSha256, SHA256);
  assert.ok(Number.isSafeInteger(input.sourceBytes) && input.sourceBytes > 0);
  assert.ok(
    Number.isSafeInteger(input.coveredUntilMs)
      && input.coveredUntilMs >= PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
  );
  assert.ok(Number.isSafeInteger(input.partialRevision) && input.partialRevision > 0);
  assert.ok(input.segments.length > 0);
  assert.match(input.extraction.engine, /^[a-z][a-z0-9-]{1,63}$/u);
  assert.match(input.extraction.model, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);
  assert.match(input.extraction.digest, ENGINE_DIGEST);

  let previousStartMs = 0;
  const transcript: string[] = [];
  input.segments.forEach((segment, index) => {
    assert.equal(segment.order, index);
    assert.ok(Number.isSafeInteger(segment.startMs) && segment.startMs >= previousStartMs);
    assert.ok(Number.isSafeInteger(segment.endMs) && segment.endMs > segment.startMs);
    assert.ok(segment.endMs <= input.coveredUntilMs);
    assert.ok(segment.text.trim().length > 0);
    transcript.push(segment.text);
    previousStartMs = segment.startMs;
  });

  const normalized = transcript
    .map((value) => value.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join(' ');
  assert.ok(normalized.length > 0);

  return {
    evidenceKind: 'progressive-audio-sample-v1',
    sampleIntervalMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
    input: {
      sha256: input.sourceSha256,
      bytes: input.sourceBytes,
    },
    firstCheckpoint: {
      coveredUntilMs: input.coveredUntilMs,
      partialRevision: input.partialRevision,
      segmentCount: input.segments.length,
    },
    expectedOutput: {
      normalizedSha256: sha256Utf8(normalized),
      segmentCount: input.segments.length,
    },
    extraction: input.extraction,
  };
}

/**
 * Create the digest-only oracle from a separately executed non-Tauri worker.
 * The caller must provide segments from that independent process; the
 * localhost real-engine smoke compares its own result against this digest.
 */
export function deriveProgressiveAudioOracleEvidence(
  input: ProgressiveAudioSampleInput,
): ProgressiveAudioOracleEvidence {
  const evidence = deriveProgressiveAudioSampleEvidence(input);
  return {
    evidenceKind: 'progressive-audio-oracle-v1',
    oracle: 'non-tauri-production-worker',
    sampleIntervalMs: evidence.sampleIntervalMs,
    input: evidence.input,
    firstCheckpoint: evidence.firstCheckpoint,
    expectedOutput: evidence.expectedOutput,
    extraction: evidence.extraction,
  };
}

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
