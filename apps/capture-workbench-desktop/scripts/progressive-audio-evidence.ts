import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS = 5 * 60_000;

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

export interface ProgressiveAudioObservedOutput {
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly coveredUntilMs: number;
  readonly partialRevision: number;
  readonly segments: readonly ProgressiveAudioSampleSegment[];
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
 * The caller must provide segments from that independent process; the Tauri
 * observation is checked later by assertProgressiveAudioSampleMatchesOracle.
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

export function assertProgressiveAudioOracleEvidence(
  value: unknown,
): asserts value is ProgressiveAudioOracleEvidence {
  const report = value as Partial<ProgressiveAudioOracleEvidence> | null;
  assert.equal(report?.evidenceKind, 'progressive-audio-oracle-v1');
  assert.equal(report?.oracle, 'non-tauri-production-worker');
  assert.equal(report?.sampleIntervalMs, PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS);
  assert.match(String(report?.input?.sha256), SHA256);
  assert.ok(Number.isSafeInteger(report?.input?.bytes) && Number(report.input.bytes) > 0);
  assert.ok(
    Number.isSafeInteger(report?.firstCheckpoint?.coveredUntilMs)
      && Number(report.firstCheckpoint.coveredUntilMs) >= PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
  );
  assert.ok(
    Number.isSafeInteger(report?.firstCheckpoint?.partialRevision)
      && Number(report.firstCheckpoint.partialRevision) > 0,
  );
  assert.ok(
    Number.isSafeInteger(report?.firstCheckpoint?.segmentCount)
      && Number(report.firstCheckpoint.segmentCount) > 0,
  );
  assert.match(String(report?.expectedOutput?.normalizedSha256), SHA256);
  assert.equal(report?.expectedOutput?.segmentCount, report?.firstCheckpoint?.segmentCount);
  assert.match(String(report?.extraction?.engine), /^[a-z][a-z0-9-]{1,63}$/u);
  assert.match(String(report?.extraction?.model), /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);
  assert.match(String(report?.extraction?.device), /^(?:cuda|cpu)$/u);
  assert.match(String(report?.extraction?.digest), ENGINE_DIGEST);
  assertSafeEvidenceSerialization(value);
}

export function assertProgressiveAudioSampleMatchesOracle(
  oracle: ProgressiveAudioOracleEvidence,
  observed: ProgressiveAudioObservedOutput,
): void {
  assertProgressiveAudioOracleEvidence(oracle);
  assert.equal(observed.sourceSha256, oracle.input.sha256);
  assert.equal(observed.sourceBytes, oracle.input.bytes);
  assert.equal(observed.extraction.engine, oracle.extraction.engine);
  assert.equal(observed.extraction.model, oracle.extraction.model);
  assert.equal(observed.extraction.device, oracle.extraction.device);
  assert.equal(observed.extraction.digest, oracle.extraction.digest);
  assert.ok(observed.coveredUntilMs >= PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS);
  assert.ok(observed.partialRevision > 0);
  assert.equal(observed.segments.length, oracle.expectedOutput.segmentCount);
  assert.equal(normalizedSegmentDigest(observed.segments), oracle.expectedOutput.normalizedSha256);
}

export function assertProgressiveAudioSampleEvidence(
  value: unknown,
): asserts value is ProgressiveAudioSampleEvidence {
  const report = value as Partial<ProgressiveAudioSampleEvidence> | null;
  assert.equal(report?.evidenceKind, 'progressive-audio-sample-v1');
  assert.equal(report?.sampleIntervalMs, PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS);
  assert.match(String(report?.input?.sha256), SHA256);
  assert.ok(Number.isSafeInteger(report?.input?.bytes) && Number(report.input.bytes) > 0);
  assert.ok(
    Number.isSafeInteger(report?.firstCheckpoint?.coveredUntilMs)
      && Number(report.firstCheckpoint.coveredUntilMs) >= PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
  );
  assert.ok(
    Number.isSafeInteger(report?.firstCheckpoint?.partialRevision)
      && Number(report.firstCheckpoint.partialRevision) > 0,
  );
  assert.ok(
    Number.isSafeInteger(report?.firstCheckpoint?.segmentCount)
      && Number(report.firstCheckpoint.segmentCount) > 0,
  );
  assert.match(String(report?.expectedOutput?.normalizedSha256), SHA256);
  assert.equal(
    report?.expectedOutput?.segmentCount,
    report?.firstCheckpoint?.segmentCount,
  );
  assert.match(String(report?.extraction?.engine), /^[a-z][a-z0-9-]{1,63}$/u);
  assert.match(String(report?.extraction?.model), /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);
  assert.match(String(report?.extraction?.device), /^(?:cuda|cpu)$/u);
  assert.match(String(report?.extraction?.digest), ENGINE_DIGEST);

  assertSafeEvidenceSerialization(value);
}

function assertSafeEvidenceSerialization(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/u);
  assert.doesNotMatch(serialized, /(?:authorization|bearer|token|secret|api[_-]?key)/iu);
  assert.doesNotMatch(serialized, /(?:sourceText|expectedText|transcript|audioText|fileName|sourcePath|warnings)/iu);
}

function normalizedSegmentDigest(segments: readonly ProgressiveAudioSampleSegment[]): string {
  let previousStartMs = 0;
  const normalized = segments.map((segment, index) => {
    assert.equal(segment.order, index);
    // Overlap windows may legitimately extend a later segment over the prior
    // locator. The durable contract is stable ordering by start time and
    // bounded, positive locators; requiring non-overlap would reject the
    // decoder's 30-second merge window.
    assert.ok(Number.isSafeInteger(segment.startMs) && segment.startMs >= previousStartMs);
    assert.ok(Number.isSafeInteger(segment.endMs) && segment.endMs > segment.startMs);
    assert.ok(segment.text.trim().length > 0);
    previousStartMs = segment.startMs;
    return segment.text.replace(/\s+/gu, ' ').trim();
  }).filter(Boolean).join(' ');
  assert.ok(normalized.length > 0);
  return sha256Utf8(normalized);
}

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
