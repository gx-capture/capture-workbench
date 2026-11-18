import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import type { DesktopLibraryExport } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { LibraryStore } from './library.store';
import { DesktopFormattingService } from './desktop-formatting.service';
import { LibraryExportService } from './library-export.service';

describe('LibraryExportService', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  function setup() {
    const response = new Subject<DesktopLibraryExport>();
    const library = { export: vi.fn(() => response) };
    const formatting = { downloadText: vi.fn() };
    TestBed.configureTestingModule({ providers: [
      { provide: LibraryStore, useValue: library },
      { provide: DesktopFormattingService, useValue: formatting },
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

  it('exports different documents concurrently and keeps the remaining request busy', () => {
    const { service, library, formatting, response: first } = setup();
    const second = new Subject<DesktopLibraryExport>();
    library.export.mockReturnValueOnce(first).mockReturnValueOnce(second);
    service.run('first', 'text').subscribe();
    service.run('second', 'text').subscribe();
    expect(library.export).toHaveBeenCalledTimes(2);
    expect(service.busyIds()).toEqual(new Set(['first', 'second']));
    first.next({ fileName: 'first.txt', content: 'first text', mediaType: 'text/plain' });
    first.complete();
    expect(service.busyIds()).toEqual(new Set(['second']));
    expect(formatting.downloadText).toHaveBeenCalledTimes(1);
    second.next({ fileName: 'second.txt', content: 'second text', mediaType: 'text/plain' });
    second.complete();
    expect(service.busyIds().size).toBe(0);
    expect(formatting.downloadText).toHaveBeenCalledTimes(2);
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
