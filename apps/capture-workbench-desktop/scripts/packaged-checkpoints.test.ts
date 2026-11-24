// Which checkpoints of the real-engine journeys on the packaged Desktop App
// are compared with approved baselines, and that every baseline belongs to one.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { comparedCheckpointNames, type JourneyCheckpoint } from './packaged-checkpoint-comparison.ts';
import { ASR_JOURNEY_CHECKPOINTS } from './real-desktop-asr-journey.ts';
import { DESKTOP_OCR_CHECKPOINTS } from './real-desktop-ocr-smoke.ts';

const journeys: ReadonlyArray<{ readonly spec: string; readonly checkpoints: readonly JourneyCheckpoint[] }> = [
  { spec: 'real-desktop-ocr-acceptance.spec.ts', checkpoints: DESKTOP_OCR_CHECKPOINTS },
  { spec: 'real-desktop-asr-acceptance.spec.ts', checkpoints: ASR_JOURNEY_CHECKPOINTS },
];

test('the OCR journey compares the stable screens, the OCR result among them', () => {
  assert.deepEqual(DESKTOP_OCR_CHECKPOINTS.map(({ name }) => name), [
    '01-consent-required',
    '01-core-install-started',
    '01-core-install-retry',
    '01-runtime-ready',
    '02-document-processing',
    '03-ocr-checkpoint',
    '04-review-complete',
  ]);
  assert.deepEqual(comparedCheckpointNames(DESKTOP_OCR_CHECKPOINTS), [
    '01-consent-required',
    '01-runtime-ready',
    '03-ocr-checkpoint',
    '04-review-complete',
  ]);
});

test('the ASR journey compares each of its five screens', () => {
  assert.deepEqual(ASR_JOURNEY_CHECKPOINTS.map(({ name }) => name), [
    'asr-ready',
    'asr-done-row',
    'asr-result',
    'asr-cancelled-row',
    'asr-restarted-row',
    'engine-removed',
  ]);
  assert.deepEqual(comparedCheckpointNames(ASR_JOURNEY_CHECKPOINTS), [
    'asr-ready',
    'asr-done-row',
    'asr-result',
    'asr-cancelled-row',
    'engine-removed',
  ]);
});

test('checkpoint names are unique across both journeys', () => {
  const names = journeys.flatMap((journey) => journey.checkpoints.map((checkpoint) => checkpoint.name));
  assert.equal(new Set(names).size, names.length);
});

test('every approved baseline belongs to a compared checkpoint of its journey', async () => {
  for (const journey of journeys) {
    const compared = new Set(comparedCheckpointNames(journey.checkpoints));
    const directory = join(import.meta.dirname, `${journey.spec}-snapshots`);
    const baselines = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const baseline of baselines) {
      const name = baseline.replace(/-chromium-win32\.png$/u, '');
      assert.ok(compared.has(name), `${journey.spec} keeps a baseline no checkpoint compares: ${baseline}`);
    }
  }
});
