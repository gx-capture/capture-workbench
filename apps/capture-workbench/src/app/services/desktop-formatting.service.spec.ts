import { TestBed } from '@angular/core/testing';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopFormattingService, formatApproximateBytes } from './desktop-formatting.service';

describe('DesktopFormattingService', () => {
  let service: DesktopFormattingService;

  beforeEach(() => {
    service = TestBed.inject(DesktopFormattingService);
  });

  it('keeps the existing decimal byte formatting contract', () => {
    expect(service.formatBytes(1)).toBe('1 KB');
    expect(service.formatBytes(1_000_000)).toBe('1.0 MB');
  });

  it('formats persisted timestamps with the workspace locale', () => {
    expect(service.formatDate(Date.UTC(2026, 6, 28, 3, 18))).toContain('2026');
  });
});

describe('formatApproximateBytes', () => {
  afterEach(() => setDesktopLocale('zh-TW'));

  it('follows the app language and returns null when the size is unknown', () => {
    setDesktopLocale('zh-TW');
    expect(formatApproximateBytes(2_800_000_000)).toBe('約 2.8 GB');
    setDesktopLocale('en');
    expect(formatApproximateBytes(144_000_000)).toBe('~144 MB');
    expect(formatApproximateBytes(null)).toBeNull();
  });
});
