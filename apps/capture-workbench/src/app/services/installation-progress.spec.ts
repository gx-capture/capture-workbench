import { describe, expect, it } from 'vitest';
import {
  installationPercent,
  installationProgress,
  installationProgressLabel,
} from './installation-progress';

const messages = {
  installProgressPreparing: 'preparing',
  installProgressInstalling: 'installing',
  downloadingProgress: (percent: number) => `downloading ${percent}%`,
};

describe('installationProgress', () => {
  it('shows no figure before the runtime knows the download size', () => {
    expect(installationProgress(null)).toEqual({ phase: 'preparing', percent: 0 });
    expect(installationProgress({ progress: 0 })).toEqual({ phase: 'preparing', percent: 0 });
    // The runtime reports a fixed 5 % until the byte counts arrive.
    expect(
      installationProgress({ progress: 0.05, downloadedBytes: null, downloadBytes: null }),
    ).toEqual({ phase: 'preparing', percent: 0 });
  });

  it('never steps back when the byte counts arrive', () => {
    const before = installationProgress({ progress: 0.05 });
    const after = installationProgress({
      progress: 0.001,
      downloadedBytes: 650_598,
      downloadBytes: 296_199_321,
    });
    expect(before.phase).toBe('preparing');
    expect(after).toEqual({ phase: 'downloading', percent: 0 });
  });

  it('shows the downloaded share while bytes are still arriving', () => {
    expect(
      installationProgress({
        progress: 0.1,
        downloadedBytes: 1_400_000_000,
        downloadBytes: 2_800_000_000,
      }),
    ).toEqual({ phase: 'downloading', percent: 50 });
    // One byte short is not complete.
    expect(
      installationProgress({ progress: 0.84, downloadedBytes: 999, downloadBytes: 1000 }),
    ).toEqual({ phase: 'downloading', percent: 99 });
  });

  it('is installing, not downloading 100 %, once every byte has arrived', () => {
    expect(
      installationProgress({ progress: 0.845, downloadedBytes: 1000, downloadBytes: 1000 }),
    ).toEqual({ phase: 'installing', percent: 100 });
  });

  it('falls back to the overall progress of a runtime without byte counts', () => {
    expect(installationProgress({ progress: 0.5 })).toEqual({ phase: 'downloading', percent: 50 });
    expect(installationProgress({ progress: 0.999 })).toEqual({ phase: 'downloading', percent: 99 });
    expect(installationProgress({ progress: 1 })).toEqual({ phase: 'installing', percent: 100 });
  });
});

describe('installationProgressLabel', () => {
  it('names the phase and carries a figure only while downloading', () => {
    expect(installationProgressLabel({ phase: 'preparing', percent: 0 }, messages)).toBe('preparing');
    expect(installationProgressLabel({ phase: 'downloading', percent: 37 }, messages)).toBe('downloading 37%');
    expect(installationProgressLabel({ phase: 'installing', percent: 100 }, messages)).toBe('installing');
  });
});

describe('installationPercent', () => {
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
