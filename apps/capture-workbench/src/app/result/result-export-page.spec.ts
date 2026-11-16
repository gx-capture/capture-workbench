import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopLibraryService } from '../services/desktop-library.service';
import { DesktopWorkspaceFormattingService } from '../services/desktop-workspace-formatting.service';
import { LibraryExportService } from '../services/library-export.service';
import { ResultExportStore } from '../services/result-export.store';
import { ResultReviewStore } from '../services/result-review.store';
import { ResultExportPage } from './result-export-page';

describe('ResultExportPage', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it.each(['ocr', 'asr'] as const)('renders and binds %s format buttons and copy', (kind) => {
    TestBed.configureTestingModule({ imports: [ResultExportPage], providers: [
      { provide: ResultReviewStore, useValue: { kind: signal(kind), documentId: signal('doc'), hasResult: signal(true), saveBeforeExport: () => of(undefined) } },
      { provide: DesktopLibraryService, useValue: { export: vi.fn(() => of({ fileName: 'host.txt', mediaType: 'text/plain', content: 'host text' })) } },
      { provide: DesktopWorkspaceFormattingService, useValue: { downloadText: vi.fn() } },
    ] });
    const fixture = TestBed.createComponent(ResultExportPage);
    const store = fixture.debugElement.injector.get(ResultExportStore);
    const download = vi.spyOn(store, 'download').mockImplementation(() => undefined);
    const copy = vi.spyOn(store, 'copy').mockImplementation(() => undefined);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const formats = kind === 'ocr' ? ['text', 'markdown'] : ['text', 'srt', 'vtt', 'markdown'];
    expect(el.querySelectorAll('button')).toHaveLength(formats.length + 1);
    for (const format of formats) {
      (el.querySelector(`[data-testid="result-export-${format}"]`) as HTMLButtonElement).click();
      expect(download).toHaveBeenLastCalledWith(format);
    }
    (el.querySelector('[data-testid="result-export-copy"]') as HTMLButtonElement).click();
    expect(copy).toHaveBeenCalledOnce();
    TestBed.inject(LibraryExportService).busyIds.set(new Set(['doc']));
    store.status.set(desktopMessages().exportInProgress);
    fixture.detectChanges();
    expect([...el.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    expect(el.querySelector('[data-testid="result-export-status"]')?.textContent).toContain(desktopMessages().exportInProgress);
    expect(el.querySelector('[data-testid="result-export-status"]')?.getAttribute('role')).toBe('status');
    TestBed.inject(LibraryExportService).busyIds.set(new Set());
    store.status.set(desktopMessages().exportCopied);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="result-export-status"]')?.textContent).toContain(desktopMessages().exportCopied);
  });
});
