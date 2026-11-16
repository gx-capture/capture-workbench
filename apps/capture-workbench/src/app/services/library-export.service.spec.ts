import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import type { DesktopLibraryExport } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';
import { LibraryExportService } from './library-export.service';

describe('LibraryExportService', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  function setup() {
    const response = new Subject<DesktopLibraryExport>();
    const library = { export: vi.fn(() => response) };
    const formatting = { downloadText: vi.fn() };
    TestBed.configureTestingModule({ providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopWorkspaceFormattingService, useValue: formatting },
    ] });
    return { service: TestBed.inject(LibraryExportService), library, formatting, response };
  }

  it('serializes presses for the same document and releases busy state on completion', () => {
    const { service, library, formatting, response } = setup();
    service.run('doc', 'text').subscribe();
    service.run('doc', 'text').subscribe();
    expect(service.busyIds().has('doc')).toBe(true);
    expect(library.export).toHaveBeenCalledTimes(1);
    expect(library.export).toHaveBeenCalledWith('doc', 'text', '第 {page} 頁');
    response.next({ fileName: 'host.txt', content: 'saved text', mediaType: 'text/plain' });
    response.complete();
    expect(formatting.downloadText).toHaveBeenCalledWith('host.txt', 'saved text', 'text/plain');
    expect(service.busyIds().has('doc')).toBe(false);
  });

  it.each(['srt', 'vtt'] as const)('requests %s without a page heading', (format) => {
    const { service, library } = setup();
    const subscription = service.run('recording', format).subscribe();
    expect(library.export).toHaveBeenCalledWith('recording', format, undefined);
    subscription.unsubscribe();
    expect(service.busyIds().size).toBe(0);
  });

  it('does not invoke the host if the save command fails', () => {
    const { service, library } = setup();
    const saved = new Subject<void>();
    const failed = vi.fn();
    service.run('doc', 'text', false, saved).subscribe({ error: failed });
    saved.error(new Error('save failed'));
    expect(failed).toHaveBeenCalledOnce();
    expect(library.export).not.toHaveBeenCalled();
    expect(service.busyIds().size).toBe(0);
  });

  it('releases busy state if the host throws before returning an observable', () => {
    const { service, library } = setup();
    library.export.mockImplementation(() => { throw new Error('host unavailable'); });
    const failed = vi.fn();
    service.run('doc', 'text', false, of(undefined)).subscribe({ error: failed });
    expect(failed).toHaveBeenCalledOnce();
    expect(service.busyIds().size).toBe(0);
  });
});
