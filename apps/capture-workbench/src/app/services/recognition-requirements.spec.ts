// Verifies requirement selection and removal guards for recognition features.
import type { RuntimeRequirement } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import {
  captureNeedsRequirement,
  FEATURE_REQUIREMENTS,
  isFeatureReady,
  selectFeatureMissing,
  selectInstallableRequirements,
  selectRecognitionRequirements,
  selectRequestedMissing,
  selectSpeechPack,
} from './recognition-requirements';

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

  it('maps each recognition feature to its own requirement', () => {
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

  it('lists recognition requirements in canonical order', () => {
    expect(
      selectRecognitionRequirements(requirements).map((item) => item.requirementId),
    ).toEqual([
      'windowsml-ocr',
      'speech-recognition',
      'speaker-diarization',
      'vertical-japanese-reader',
    ]);
  });

  it('never holds up documents until the user asks for a requirement', () => {
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

describe('captureNeedsRequirement', () => {
  const document = (
    status: DesktopLibrarySummary['status'],
    mediaType: string,
  ): DesktopLibrarySummary => ({
    documentId: 'b'.repeat(32),
    fileName: 'source',
    mediaType,
    byteLength: 8,
    createdAtMs: 1,
    updatedAtMs: 1,
    status,
  });

  it('blocks the requirements that kind of active capture needs', () => {
    const pdf = document('processing', 'application/pdf');
    const image = document('persisting', 'image/png');
    const audio = document('processing', 'audio/mpeg');
    const video = document('persisting', 'video/mp4');
    expect(captureNeedsRequirement('windowsml-ocr', [pdf])).toBe(true);
    expect(captureNeedsRequirement('vertical-japanese-reader', [image])).toBe(true);
    expect(captureNeedsRequirement('speech-recognition', [pdf])).toBe(false);
    expect(captureNeedsRequirement('speech-recognition', [audio])).toBe(true);
    expect(captureNeedsRequirement('speaker-diarization', [video])).toBe(true);
    expect(captureNeedsRequirement('windowsml-ocr', [audio])).toBe(false);
    expect(captureNeedsRequirement('ollama-runtime', [pdf])).toBe(true);
    expect(captureNeedsRequirement('windowsml-ocr', [])).toBe(false);
    expect(
      captureNeedsRequirement('windowsml-ocr', [
        document('queued', 'application/pdf'),
        document('awaiting_confirmation', 'application/pdf'),
      ]),
    ).toBe(false);
  });
});
