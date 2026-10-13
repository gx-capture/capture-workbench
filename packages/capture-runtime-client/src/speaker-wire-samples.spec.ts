import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeJson, type RuntimeResponseModel } from './codec';
import type { CaptureDocument, RawCapture } from './contracts';

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
