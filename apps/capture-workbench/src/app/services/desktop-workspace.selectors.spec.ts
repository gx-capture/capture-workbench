import { captureResultText, installationPercent } from './desktop-workspace.selectors';

describe('installationPercent', () => {
  it('rounds and clamps an installation progress', () => {
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
    expect(captureResultText({ ...spoken, speakers: [] })).toBe(spoken.targetText);
    expect(captureResultText({ targetText: 'page one' })).toBe('page one');
  });
});
