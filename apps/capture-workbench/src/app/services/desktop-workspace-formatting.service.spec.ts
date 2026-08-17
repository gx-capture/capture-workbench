import { TestBed } from '@angular/core/testing';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';

describe('DesktopWorkspaceFormattingService', () => {
  let service: DesktopWorkspaceFormattingService;

  beforeEach(() => {
    service = TestBed.inject(DesktopWorkspaceFormattingService);
  });

  it('keeps the existing decimal byte formatting contract', () => {
    expect(service.formatBytes(1)).toBe('1 KB');
    expect(service.formatBytes(1_000_000)).toBe('1.0 MB');
  });

  it('formats persisted timestamps with the workspace locale', () => {
    expect(service.formatDate(Date.UTC(2026, 6, 28, 3, 18))).toContain('2026');
  });
});
