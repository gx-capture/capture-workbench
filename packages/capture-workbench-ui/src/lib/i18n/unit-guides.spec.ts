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
    for (const catalog of Object.values(CAPTURE_UNIT_GUIDES)) {
      // Shown before the runtime picks a pack for this machine, so the speech
      // guide describes the GPU pack and the CPU pack.
      const speechDownload = catalog['speech-recognition']?.download ?? '';
      expect(speechDownload).toContain('GPU');
      expect(speechDownload).toContain('CPU');
      expect(catalog['speaker-diarization']?.download).toContain('CPU');
    }

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
