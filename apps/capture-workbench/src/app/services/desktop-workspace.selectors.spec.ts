import type { RuntimeRequirement } from '@gx-capture/capture-workbench-ui';
import { setDesktopLocale } from '../i18n/desktop-messages';
import {
  captureResultText,
  FEATURE_REQUIREMENTS,
  formatApproximateBytes,
  installationPercent,
  isFeatureReady,
  selectFeatureMissing,
  selectInstallableRequirements,
  selectRecognitionEngines,
  selectRequestedMissing,
  selectSpeechPack,
} from './desktop-workspace.selectors';

function requirement(
  requirementId: RuntimeRequirement['requirementId'],
  status: RuntimeRequirement['status'] = 'installable',
  downloadBytes?: number | null,
): RuntimeRequirement {
  return {
    requirementId,
    kind: requirementId,
    displayName: requirementId,
    status,
    requiredFor: [],
    installStrategy: 'runtime-catalog',
    optional: requirementId !== 'windowsml-ocr',
    ...(downloadBytes === undefined ? {} : { downloadBytes }),
  };
}

describe('feature requirements and speech pack', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  const requirements = [
    requirement('vertical-japanese-reader', 'installable', 120_000_000),
    requirement('speaker-diarization', 'installable', 300_000_000),
    requirement('windowsml-ocr', 'ready', 144_000_000),
    requirement('speech-recognition', 'installable', 2_800_000_000),
  ];

  it('maps each recognition feature to its own requirement unit', () => {
    expect(FEATURE_REQUIREMENTS).toEqual({
      ocr: ['windowsml-ocr'],
      asr: ['speech-recognition'],
      'asr.speakers': ['speaker-diarization'],
    });
    expect(isFeatureReady(requirements, 'ocr')).toBe(true);
    expect(isFeatureReady(requirements, 'asr')).toBe(false);
    expect(isFeatureReady(requirements, 'asr.speakers')).toBe(false);
    expect(
      selectFeatureMissing(requirements, 'asr').map((item) => item.requirementId),
    ).toEqual(['speech-recognition']);
  });

  it('never asks an ASR-only user for OCR when speech recognition is ready', () => {
    const asrOnly = [
      requirement('windowsml-ocr', 'installable'),
      requirement('speech-recognition', 'ready'),
      requirement('speaker-diarization', 'installable'),
    ];
    expect(isFeatureReady(asrOnly, 'asr')).toBe(true);
    expect(selectFeatureMissing(asrOnly, 'asr')).toEqual([]);
    expect(isFeatureReady(asrOnly, 'ocr')).toBe(false);
  });

  it('lists speech-to-text before speaker identification and nothing else', () => {
    expect(
      selectSpeechPack(requirements).map((item) => item.requirementId),
    ).toEqual(['speech-recognition', 'speaker-diarization']);
  });

  it('lists recognition engines in canonical order', () => {
    expect(
      selectRecognitionEngines(requirements).map((item) => item.requirementId),
    ).toEqual([
      'windowsml-ocr',
      'speech-recognition',
      'speaker-diarization',
      'vertical-japanese-reader',
    ]);
  });

  it('never holds up documents until the user asks for a unit', () => {
    expect(selectRequestedMissing(requirements, new Set())).toEqual([]);
    expect(
      selectRequestedMissing(
        requirements,
        new Set(['speech-recognition']),
      ).map((item) => item.requirementId),
    ).toEqual(['speech-recognition']);
    expect(
      selectInstallableRequirements(requirements, [
        'speaker-diarization',
        'speech-recognition',
      ]).map((item) => item.requirementId),
    ).toEqual(['speech-recognition', 'speaker-diarization']);
  });
});

describe('formatApproximateBytes and installationPercent', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('formats downloadBytes in human units and returns null when absent', () => {
    expect(formatApproximateBytes(2_800_000_000)).toBe('約 2.8 GB');
    expect(formatApproximateBytes(144_000_000)).toBe('約 144 MB');
    expect(formatApproximateBytes(null)).toBeNull();
    expect(formatApproximateBytes(undefined)).toBeNull();
    expect(formatApproximateBytes(0)).toBeNull();
  });

  it('computes percentage from downloadedBytes / downloadBytes and falls back to progress', () => {
    expect(
      installationPercent({
        progress: 0.1,
        downloadedBytes: 1_400_000_000,
        downloadBytes: 2_800_000_000,
      }),
    ).toBe(50);
    expect(installationPercent({ progress: 1 / 3 })).toBe(33);
    expect(installationPercent({ progress: 1.2 })).toBe(100);
    expect(installationPercent(null)).toBe(0);
  });
});

describe('captureResultText', () => {
  const spoken = {
    targetText: 'Good morning\nHello there\nmm',
    rawSegments: [
      { segmentId: 'segment-1', speaker: 'SPEAKER_00' },
      { segmentId: 'segment-2', speaker: 'SPEAKER_01' },
      { segmentId: 'segment-3', speaker: null },
    ],
    blocks: [
      { sourceSegmentId: 'segment-1', targetText: 'Good morning' },
      { sourceSegmentId: 'segment-2', targetText: 'Hello there' },
      { sourceSegmentId: 'segment-3', targetText: 'mm' },
    ],
  };

  it('puts the given name, or the anonymous label, before each line', () => {
    expect(
      captureResultText({
        ...spoken,
        speakers: [
          { speakerId: 'SPEAKER_00', displayName: ' Ms. Lin ' },
          { speakerId: 'SPEAKER_01', displayName: null },
        ],
      }),
    ).toBe('Ms. Lin: Good morning\nSPEAKER_01: Hello there\nmm');
  });

  it('leaves a result without speakers as it is', () => {
    expect(captureResultText({ ...spoken, speakers: [] })).toBe(
      spoken.targetText,
    );
    expect(captureResultText({ targetText: 'page one' })).toBe('page one');
  });
});
