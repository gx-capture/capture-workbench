import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS = 5 * 60_000;
// Both the oracle and progressive audio checks use the same exact 310-second
// sample. This guarantees that the five-minute checkpoint is exercised before
// terminal completion assertions.
export const REAL_MODEL_AUDIO_SAMPLE_SECONDS = 5 * 60 + 10;
const CHECKPOINT_MAX_MS = REAL_MODEL_AUDIO_SAMPLE_SECONDS * 1000 + 30_000;
const PROGRESSIVE_STARTUP_BUDGET_MS = 2 * 60_000;
const CUDA_REALTIME_MULTIPLIER = 2;
const CPU_REALTIME_MULTIPLIER = 6;

export type SpeechPack = 'cuda' | 'cpu';

// Allow a cold worker start plus slower-than-real-time decoding, especially on CPU.
// The first real-engine run should calibrate these provisional allowances.
export function progressiveAudioBudgetMs(durationMs: number, device: SpeechPack): number {
  return PROGRESSIVE_STARTUP_BUDGET_MS
    + durationMs * (device === 'cuda' ? CUDA_REALTIME_MULTIPLIER : CPU_REALTIME_MULTIPLIER);
}

export function isCheckpointCoverage(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS && value <= CHECKPOINT_MAX_MS;
}

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

interface TranscriptSummary {
  readonly normalizedSha256: string;
  readonly segmentCount: number;
}

export interface ProgressiveAudioOracleEvidence {
  readonly evidenceKind: 'progressive-audio-oracle-v1';
  readonly oracle: 'non-tauri-production-worker';
  readonly speechPack: SpeechPack;
  readonly durationMs: number;
  readonly sampleIntervalMs: typeof PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS;
  readonly input: { readonly sha256: string; readonly bytes: number };
  readonly firstCheckpoint: {
    readonly coveredUntilMs: number;
    readonly partialRevision: number;
    readonly segmentCount: number;
  };
  readonly expectedOutput: TranscriptSummary;
  readonly finalOutput: TranscriptSummary;
  readonly afterCheckpoint: TranscriptSummary;
  readonly extraction: ProgressiveAudioSampleInput['extraction'];
}

export function summarizeTranscript(text: readonly string[]): TranscriptSummary {
  const normalized = text.map((value) => value.replace(/\s+/gu, ' ').trim()).join(' ');
  assert.ok(normalized.trim().length > 0, 'Transcript summary requires text.');
  return {
    normalizedSha256: createHash('sha256').update(normalized, 'utf8').digest('hex'),
    segmentCount: text.length,
  };
}

export function summarizeCheckpoint(input: ProgressiveAudioSampleInput): TranscriptSummary {
  assert.ok(isCheckpointCoverage(input.coveredUntilMs), 'Partial coverage is outside the checkpoint window.');
  assert.ok(positiveInteger(input.partialRevision), 'Partial revision must be positive.');
  assert.ok(isSpeechProvenance(input.extraction), 'Partial requires speech recognition provenance.');

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

  return summarizeTranscript(transcript);
}

export function deriveProgressiveAudioOracleEvidence(
  input: ProgressiveAudioSampleInput,
  speechPack: SpeechPack,
  durationMs: number,
  finalSegments: readonly ProgressiveAudioSampleSegment[],
): ProgressiveAudioOracleEvidence {
  assert.match(input.sourceSha256, SHA256);
  assert.ok(positiveInteger(input.sourceBytes));
  const expectedOutput = summarizeCheckpoint(input);
  return parseProgressiveAudioOracle({
    evidenceKind: 'progressive-audio-oracle-v1',
    oracle: 'non-tauri-production-worker',
    speechPack,
    durationMs,
    sampleIntervalMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
    input: { sha256: input.sourceSha256, bytes: input.sourceBytes },
    firstCheckpoint: {
      coveredUntilMs: input.coveredUntilMs,
      partialRevision: input.partialRevision,
      segmentCount: input.segments.length,
    },
    expectedOutput,
    finalOutput: summarizeTranscript(finalSegments.map((segment) => segment.text)),
    afterCheckpoint: summarizeTranscript(finalSegments
      .filter((segment) => segment.startMs >= input.coveredUntilMs)
      .map((segment) => segment.text)),
    extraction: input.extraction,
  });
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function isSpeechProvenance(value: unknown): value is ProgressiveAudioSampleInput['extraction'] {
  const source = record(value);
  return source?.['engine'] === 'speech-recognition'
    && matches(source['model'], /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u)
    && (source['device'] === 'cpu' || source['device'] === 'cuda')
    && matches(source['digest'], ENGINE_DIGEST);
}

function isTranscriptSummary(value: unknown): value is TranscriptSummary {
  const summary = record(value);
  return positiveInteger(summary?.['segmentCount']) && matches(summary?.['normalizedSha256'], SHA256);
}

export function parseProgressiveAudioOracle(value: unknown): ProgressiveAudioOracleEvidence {
  const oracle = record(value);
  const input = record(oracle?.['input']);
  const checkpoint = record(oracle?.['firstCheckpoint']);
  const pack = oracle?.['speechPack'];
  const duration = oracle?.['durationMs'];
  const partial = oracle?.['expectedOutput'];
  const final = oracle?.['finalOutput'];
  const tail = oracle?.['afterCheckpoint'];
  const extraction = oracle?.['extraction'];
  if (oracle?.['evidenceKind'] !== 'progressive-audio-oracle-v1'
    || oracle['oracle'] !== 'non-tauri-production-worker'
    || oracle['sampleIntervalMs'] !== PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS
    || (pack !== 'cuda' && pack !== 'cpu')
    || !positiveInteger(duration)
    || !matches(input?.['sha256'], SHA256) || !positiveInteger(input?.['bytes'])
    || !isCheckpointCoverage(checkpoint?.['coveredUntilMs'])
    || checkpoint['coveredUntilMs'] >= duration
    || !positiveInteger(checkpoint['partialRevision'])
    || !isTranscriptSummary(partial) || checkpoint['segmentCount'] !== partial.segmentCount
    || !isTranscriptSummary(final) || !isTranscriptSummary(tail)
    || final.segmentCount < partial.segmentCount || tail.segmentCount > final.segmentCount
    || !isSpeechProvenance(extraction) || (pack === 'cpu' && extraction.device !== 'cpu')) {
    throw new Error('Invalid progressive audio oracle structure. Regenerate it with the current oracle generator.');
  }
  return {
    evidenceKind: 'progressive-audio-oracle-v1',
    oracle: 'non-tauri-production-worker',
    sampleIntervalMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
    speechPack: pack,
    durationMs: duration,
    input: { sha256: input['sha256'], bytes: input['bytes'] },
    firstCheckpoint: {
      coveredUntilMs: checkpoint['coveredUntilMs'],
      partialRevision: checkpoint['partialRevision'],
      segmentCount: partial.segmentCount,
    },
    expectedOutput: { normalizedSha256: partial.normalizedSha256, segmentCount: partial.segmentCount },
    finalOutput: { normalizedSha256: final.normalizedSha256, segmentCount: final.segmentCount },
    afterCheckpoint: { normalizedSha256: tail.normalizedSha256, segmentCount: tail.segmentCount },
    extraction: {
      engine: extraction.engine, model: extraction.model, device: extraction.device, digest: extraction.digest,
    },
  };
}

export function readProgressiveAudioSegments(value: unknown): readonly (
  ProgressiveAudioSampleSegment & { readonly segmentId: string }
)[] {
  if (!Array.isArray(value)) throw new Error('Expected progressive transcript segments.');
  return value.map((item: unknown, index) => {
    const segment = record(item);
    const locator = record(segment?.['locator']);
    const startMs = locator?.['startMs'];
    const endMs = locator?.['endMs'];
    const text = segment?.['text'];
    const segmentId = segment?.['segmentId'];
    assert.ok(locator?.['kind'] === 'time' && typeof startMs === 'number'
      && Number.isSafeInteger(startMs) && startMs >= 0 && positiveInteger(endMs) && endMs > startMs
      && segment?.['order'] === index && typeof text === 'string' && text.trim()
      && typeof segmentId === 'string' && segmentId, 'Invalid progressive transcript segment.');
    return { order: index, startMs, endMs, text, segmentId };
  });
}

export function readProgressiveAudioPartial(
  value: unknown,
  expectedSource: ProgressiveAudioOracleEvidence['input'],
): ProgressiveAudioSampleInput {
  const partial = record(value);
  const source = record(partial?.['source']);
  const coveredUntilMs = partial?.['coveredUntilMs'];
  const partialRevision = partial?.['revision'];
  const extraction = partial?.['extractionEngine'];
  assert.ok(source?.['sha256'] === expectedSource.sha256 && source['bytes'] === expectedSource.bytes,
    'Progressive partial source binding did not match.');
  assert.ok(isCheckpointCoverage(coveredUntilMs), 'Partial coverage is outside the checkpoint window.');
  assert.ok(positiveInteger(partialRevision), 'Partial revision must be positive.');
  assert.ok(isSpeechProvenance(extraction), 'Partial requires speech recognition provenance.');
  return {
    sourceSha256: expectedSource.sha256,
    sourceBytes: expectedSource.bytes,
    coveredUntilMs,
    partialRevision,
    segments: readProgressiveAudioSegments(partial?.['segments']),
    extraction,
  };
}

export function verifyProgressivePartial(
  oracle: ProgressiveAudioOracleEvidence,
  snapshot: unknown,
  displayed: readonly string[],
): void {
  const partial = readProgressiveAudioPartial(snapshot, oracle.input);
  assert.equal(partial.partialRevision, oracle.firstCheckpoint.partialRevision, 'Host partial revision differs from the oracle.');
  assert.equal(partial.coveredUntilMs, oracle.firstCheckpoint.coveredUntilMs, 'Host partial coverage differs from the oracle.');
  assert.deepEqual(summarizeCheckpoint(partial), oracle.expectedOutput, 'Host partial differs from the oracle.');
  assert.deepEqual(summarizeTranscript(displayed), oracle.expectedOutput, 'Displayed partial differs from the oracle.');
  assertProgressiveRecognitionEngine(partial.extraction, oracle.extraction);
}

function assertProgressiveRecognitionEngine(value: unknown, expected: ProgressiveAudioOracleEvidence['extraction']): void {
  assert.ok(isSpeechProvenance(value), 'Progressive transcript requires recognition provenance.');
  for (const key of ['engine', 'model', 'device', 'digest'] as const) {
    assert.equal(value[key], expected[key], 'Progressive transcript recognition provenance differs from the oracle.');
  }
}

export function verifyProgressiveFinal(
  oracle: ProgressiveAudioOracleEvidence,
  raw: unknown,
  rendered: readonly { readonly segmentId: string | null; readonly text: string }[],
): void {
  const stored = record(raw);
  assertProgressiveRecognitionEngine(stored?.['extractionEngine'], oracle.extraction);
  const segments = readProgressiveAudioSegments(stored?.['segments']);
  const tail = segments.filter((segment) => segment.startMs >= oracle.firstCheckpoint.coveredUntilMs);
  const tailIds = new Set(tail.map((segment) => segment.segmentId));
  assert.deepEqual(summarizeTranscript(segments.map((segment) => segment.text)), oracle.finalOutput,
    'Stored final transcript differs from the oracle.');
  assert.deepEqual(summarizeTranscript(tail.map((segment) => segment.text)), oracle.afterCheckpoint,
    'Stored speech after the checkpoint differs from the oracle.');
  assert.ok(rendered.length === segments.length && rendered.every((line, index) => line.segmentId === segments[index]?.segmentId),
    'Displayed final transcript rows must correspond to the stored segments.');
  assert.deepEqual(summarizeTranscript(rendered.map((line) => line.text)), oracle.finalOutput,
    'Displayed final transcript differs from the oracle.');
  assert.deepEqual(summarizeTranscript(rendered.filter((line) => line.segmentId && tailIds.has(line.segmentId))
    .map((line) => line.text)), oracle.afterCheckpoint, 'Displayed speech after the checkpoint differs from the oracle.');
}
