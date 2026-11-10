import { formatApproximateBytes } from './format-approximate-bytes';

describe('formatApproximateBytes', () => {
  it('formats downloadBytes in human units and returns null when absent', () => {
    expect(formatApproximateBytes(2_800_000_000)).toBe('約 2.8 GB');
    expect(formatApproximateBytes(1_000_000_000)).toBe('約 1 GB');
    expect(formatApproximateBytes(144_000_000)).toBe('約 144 MB');
    expect(formatApproximateBytes(500_000)).toBe('約 500 KB');
    expect(formatApproximateBytes(1)).toBe('約 1 KB');
    expect(formatApproximateBytes(null)).toBeNull();
    expect(formatApproximateBytes(undefined)).toBeNull();
    expect(formatApproximateBytes(0)).toBeNull();
    expect(formatApproximateBytes(-1)).toBeNull();
    expect(formatApproximateBytes(Number.NaN)).toBeNull();
    expect(formatApproximateBytes(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('uses the desktop English form when the locale is en', () => {
    expect(formatApproximateBytes(144_000_000, 'en')).toBe('~144 MB');
    expect(formatApproximateBytes(2_800_000_000, 'en')).toBe('~2.8 GB');
    expect(formatApproximateBytes(500_000, 'en')).toBe('~500 KB');
    expect(formatApproximateBytes(0, 'en')).toBeNull();
  });
});
