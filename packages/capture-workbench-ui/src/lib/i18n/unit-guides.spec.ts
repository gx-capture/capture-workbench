import { CAPTURE_UNIT_GUIDES, type CaptureUnitGuide } from './unit-guides';

const DOWNLOAD_SIZE = /\d+(?:\.\d+)?\s*(?:GB|MB)/u;

function guideFields(guide: CaptureUnitGuide): readonly string[] {
  return [
    guide.name,
    guide.summary,
    guide.languages,
    guide.hardware,
    guide.download,
    guide.license,
  ];
}

describe('CAPTURE_UNIT_GUIDES', () => {
  it('says what a download contains and never a GB or MB size', () => {
    expect(CAPTURE_UNIT_GUIDES['zh-TW']['speech-recognition']?.download).toBe(
      '兩種大小的辨識模型、對齊時間點的 Qwen3 模型與 GPU 執行環境。',
    );
    expect(CAPTURE_UNIT_GUIDES.en['speech-recognition']?.download).toBe(
      'Recognition models in two sizes, a Qwen3 model that aligns the times, and the GPU runtime.',
    );
    expect(CAPTURE_UNIT_GUIDES['zh-TW']['speaker-diarization']?.download).toBe(
      '說話者辨識模型與 CPU 執行環境。',
    );
    expect(CAPTURE_UNIT_GUIDES.en['speaker-diarization']?.download).toBe(
      'The speaker-identification model and the CPU runtime.',
    );

    for (const catalog of Object.values(CAPTURE_UNIT_GUIDES)) {
      for (const guide of Object.values(catalog)) {
        if (!guide) continue;
        for (const field of guideFields(guide)) {
          expect(field).not.toMatch(DOWNLOAD_SIZE);
        }
      }
    }
  });
});
