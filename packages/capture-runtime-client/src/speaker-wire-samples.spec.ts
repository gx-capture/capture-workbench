import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeJson, type RuntimeResponseModel } from './codec';
import type { CaptureDocument, RawCapture, StructuringSession } from './contracts';

const samples = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../capture-runtime/tests/fixtures/speaker-wire-samples.json',
    ),
    'utf8',
  ),
) as Record<string, unknown>;

function decode<T>(name: string, model: RuntimeResponseModel): Promise<T> {
  return decodeJson<T>(
    new Response(JSON.stringify(samples[name])),
    undefined,
    model,
  );
}

describe('what the runtime sends for speakers', () => {
  it.each([
    { elapsedMs: -1 },
    { elapsedMs: 1.5 },
    { elapsedMs: true },
    { stageMs: { inference: -1 } },
    { stageMs: { inference: true } },
    { stageMs: { ' ': 1 } },
  ])('rejects invalid engine timings in a provider %j', async (timings) => {
    const session = {
      protocolVersion: '2', sessionId: 'session', captureId: 'capture',
      rawSourceSha256: 'a'.repeat(64), contractSetSha256: 'b'.repeat(64),
      providerCapability: {
        provider: { engine: 'host', model: 'test', digest: `sha256:${'a'.repeat(64)}`, ...timings },
        capability: 'capture-structuring', schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
      },
      schemaDialect: 'https://json-schema.org/draft/2020-12/schema', batchCount: 1,
      nextBatchIndex: 0, sessionDigest: 'c'.repeat(64), status: 'open',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    await expect(decodeJson<StructuringSession>(Response.json(session), undefined, 'StructuringSession'))
      .rejects.toThrow('processing times');
  });

  it('preserves optional device processing times on both document engines', async () => {
    const original = await decode<CaptureDocument>('captureDocument', 'CaptureDocument');
    const extractionEngine = {
      ...original.extractionEngine,
      elapsedMs: 1500,
      stageMs: { modelLoad: 100, transcription: 900, alignerLoad: 100, alignment: 300 },
    };
    const diarizationEngine = {
      ...original.diarizationEngine!,
      elapsedMs: 2300,
      stageMs: { modelLoad: 200, inference: 1200, postprocessing: 0 },
    };
    const document = await decodeJson<CaptureDocument>(
      Response.json({ ...original, extractionEngine, diarizationEngine }),
      undefined,
      'CaptureDocument',
    );
    expect(document.extractionEngine).toEqual(extractionEngine);
    expect(document.diarizationEngine).toEqual(diarizationEngine);
  });

  it('decodes a capture with speakers, their samples and overlap', async () => {
    const raw = await decode<RawCapture>('rawCapture', 'RawCapture');
    expect(raw.segments.map((segment) => segment.speaker)).toEqual([
      'SPEAKER_00',
      null,
    ]);
    expect(raw.segments[1].speakerOverlap).toBe(true);
    expect(raw.speakers?.map((speaker) => speaker.speakerId)).toEqual([
      'SPEAKER_00',
      'SPEAKER_01',
    ]);
    expect(raw.speakers?.[0].sample).toEqual({
      kind: 'time',
      startMs: 0,
      endMs: 1000,
    });
    expect(raw.diarizationEngine?.engine).toBe('speaker-diarization');

    const document = await decode<CaptureDocument>(
      'captureDocument',
      'CaptureDocument',
    );
    expect(document.speakers).toEqual(raw.speakers);
  });

  it('decodes a capture without speakers and an optional unit', async () => {
    const raw = await decode<RawCapture>(
      'rawCaptureWithoutSpeakers',
      'RawCapture',
    );
    expect(raw.speakers).toEqual([]);
    expect(raw.diarizationEngine).toBeNull();

    const requirements = await decode<{
      items: { requirementId: string; optional?: boolean }[];
    }>('runtimeRequirements', 'RuntimeRequirements');
    expect(requirements.items[0]).toMatchObject({
      requirementId: 'speaker-diarization',
      optional: true,
    });
  });
});
