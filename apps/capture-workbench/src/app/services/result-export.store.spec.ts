import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import { BehaviorSubject, of, Subject, throwError } from 'rxjs';
import type { DesktopLibraryEdits, DesktopLibraryExport } from '../contracts';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { LibraryStore } from './library.store';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopFormattingService } from './desktop-formatting.service';
import { PdfPageRenderer } from './pdf-page-renderer.service';
import { LibraryExportService } from './library-export.service';
import { ResultExportStore } from './result-export.store';
import { ResultReviewStore } from './result-review.store';

describe('ResultExportStore', () => {
  beforeEach(() => { vi.useFakeTimers(); setDesktopLocale('zh-TW'); });
  afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  function setup(mediaType = 'application/pdf') {
    const payload = { fileName: 'host-name.txt', content: 'host text', mediaType: 'text/plain' };
    const library = {
      allDocuments: signal([]),
      get: vi.fn((documentId: string) => of({ documentId, fileName: 'input.pdf', mediaType,
        status: 'completed', byteLength: 8, createdAtMs: 1, updatedAtMs: 1,
        raw: { sourceText: 'recognized', segments: [
          { segmentId: 'p1', order: 0, locator: { kind: 'page', page: 1 }, text: 'recognized' },
        ] } as unknown as RawCapture })),
      saveEdits: vi.fn((_id: string, edits: DesktopLibraryEdits) => of(edits)),
      export: vi.fn(() => of(payload)),
    };
    const formatting = { downloadText: vi.fn() };
    const clipboard = { writeText: vi.fn(() => Promise.resolve()) };
    vi.stubGlobal('navigator', { clipboard });
    const paramMap$ = new BehaviorSubject(convertToParamMap({ id: 'doc' }));
    TestBed.configureTestingModule({ providers: [ResultReviewStore, ResultExportStore,
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: paramMap$.value }, paramMap: paramMap$.asObservable() } },
      { provide: LibraryStore, useValue: library },
      { provide: DesktopLibraryService, useValue: { sourceBytes: () => of(new ArrayBuffer(0)) } },
      { provide: DesktopRuntimeClientService, useValue: { started: signal(true) } },
      { provide: DesktopFormattingService, useValue: formatting },
      { provide: PdfPageRenderer, useValue: {} },
    ] });
    const store = TestBed.inject(ResultExportStore);
    const review = TestBed.inject(ResultReviewStore);
    TestBed.tick();
    return { store, review, library, formatting, clipboard, payload, paramMap$ };
  }

  it.each([
    ['application/pdf', ['text', 'markdown']],
    ['audio/mpeg', ['text', 'srt', 'vtt', 'markdown']],
    ['video/mp4', ['text', 'srt', 'vtt', 'markdown']],
  ] as const)('offers formats for %s', (mediaType, formats) => {
    expect(setup(mediaType).store.formats().map((item) => item.format)).toEqual(formats);
  });

  it.each(['zh-TW', 'en'] as const)('downloads host payload with localized page headings in %s', (locale) => {
    const { store, library, formatting, payload } = setup();
    setDesktopLocale(locale);
    for (const format of ['text', 'markdown'] as const) {
      store.download(format);
      expect(library.export).toHaveBeenLastCalledWith('doc', format, desktopMessages().exportPageLabel);
      expect(formatting.downloadText).toHaveBeenLastCalledWith(payload.fileName, payload.content, payload.mediaType);
    }
  });

  it('flushes pending corrections before exporting and ignores a second press', () => {
    const { store, review, library } = setup();
    const saved = new Subject<DesktopLibraryEdits>();
    library.saveEdits.mockReturnValue(saved);
    review.editPage(1, 'corrected');
    store.download('text');
    store.copy();
    store.download('text');
    expect(store.busy()).toBe(true);
    expect(store.status()).toBe(desktopMessages().exportInProgress);
    expect(library.saveEdits).toHaveBeenCalledTimes(1);
    expect(library.export).not.toHaveBeenCalled();
    expect(library.saveEdits.mock.calls[0][1].ocrPages).toEqual({ '1': 'corrected' });
    saved.next(library.saveEdits.mock.calls[0][1]);
    saved.complete();
    expect(library.export).toHaveBeenCalledTimes(1);
    expect(store.busy()).toBe(false);
  });

  it.each([false, true])('cancels the old document export on route change (copy: %s)', async (copy) => {
    const { store, review, library, formatting, clipboard, payload, paramMap$ } = setup();
    const response = new Subject<DesktopLibraryExport>();
    library.export.mockReturnValue(response);
    if (copy) store.copy();
    else store.download('text');
    expect(store.status()).toBe(desktopMessages().exportInProgress);
    expect(TestBed.inject(LibraryExportService).busyIds().has('doc')).toBe(true);
    paramMap$.next(convertToParamMap({ id: 'other' }));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    expect(review.documentId()).toBe('other');
    expect(store.status()).toBeNull();
    expect(TestBed.inject(LibraryExportService).busyIds().size).toBe(0);
    response.next(payload);
    response.complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(formatting.downloadText).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(store.status()).toBeNull();
  });

  it('clears a completed outcome when the document changes', () => {
    const { store, paramMap$ } = setup();
    store.download('text');
    expect(store.status()).toBe(desktopMessages().exportDownloaded);
    paramMap$.next(convertToParamMap({ id: 'other' }));
    TestBed.tick();
    expect(store.status()).toBeNull();
  });

  it('cancels an export waiting for a save when the document changes', async () => {
    const { store, review, library, formatting, clipboard, paramMap$ } = setup();
    const saved = new Subject<DesktopLibraryEdits>();
    library.saveEdits.mockReturnValueOnce(saved);
    review.editPage(1, 'correction');
    store.copy();
    paramMap$.next(convertToParamMap({ id: 'other' }));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    expect(TestBed.inject(LibraryExportService).busyIds().size).toBe(0);
    saved.next(library.saveEdits.mock.calls[0][1]);
    saved.complete();
    expect(library.export).not.toHaveBeenCalled();
    expect(formatting.downloadText).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(store.status()).toBeNull();
  });

  it.each(['zh-TW', 'en'] as const)('shows progress during a host request in %s', (locale) => {
    const { store, library, payload } = setup();
    setDesktopLocale(locale);
    const response = new Subject<DesktopLibraryExport>();
    library.export.mockReturnValue(response);
    store.download('text');
    expect(store.status()).toBe(desktopMessages().exportInProgress);
    response.next(payload);
    response.complete();
    expect(store.status()).toBe(desktopMessages().exportDownloaded);
  });

  it('waits for its own save queued behind the previous document save', async () => {
    const { store, review, library, paramMap$ } = setup();
    const first = new Subject<DesktopLibraryEdits>();
    const second = new Subject<DesktopLibraryEdits>();
    library.saveEdits.mockReturnValueOnce(first).mockReturnValueOnce(second);
    review.editPage(1, 'first document correction');
    vi.advanceTimersByTime(600);
    paramMap$.next(convertToParamMap({ id: 'other' }));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    review.editPage(1, 'second document correction');
    store.download('text');
    expect(library.saveEdits).toHaveBeenCalledTimes(1);
    expect(library.export).not.toHaveBeenCalled();
    first.next(library.saveEdits.mock.calls[0][1]);
    first.complete();
    expect(library.saveEdits).toHaveBeenCalledTimes(2);
    expect(library.saveEdits).toHaveBeenLastCalledWith('other', expect.objectContaining({ ocrPages: { '1': 'second document correction' } }));
    expect(library.export).not.toHaveBeenCalled();
    second.next(library.saveEdits.mock.calls[1][1]);
    second.complete();
    expect(library.export).toHaveBeenCalledWith('other', 'text', '第 {page} 頁');
  });

  it('saves edits typed after the export press before calling the host export', () => {
    const { store, review, library } = setup();
    const first = new Subject<DesktopLibraryEdits>();
    const second = new Subject<DesktopLibraryEdits>();
    library.saveEdits.mockReturnValueOnce(first).mockReturnValueOnce(second);
    review.editPage(1, 'initial correction');
    store.download('text');
    review.editPage(1, 'newer correction');
    expect(store.status()).toBe(desktopMessages().exportInProgress);
    first.next(library.saveEdits.mock.calls[0][1]);
    first.complete();
    expect(library.export).not.toHaveBeenCalled();
    expect(library.saveEdits.mock.calls[1][1].ocrPages).toEqual({ '1': 'newer correction' });
    second.next(library.saveEdits.mock.calls[1][1]);
    second.complete();
    expect(library.export).toHaveBeenCalledTimes(1);
  });

  it('exports the corrected persisted text after a failed save, retry, and second press', () => {
    const { store, review, library, formatting, payload } = setup();
    let persistedText = 'recognized';
    library.saveEdits.mockReturnValueOnce(throwError(() => new Error('save failed')))
      .mockImplementation((_id: string, edits: DesktopLibraryEdits) => {
        persistedText = edits.ocrPages['1'] ?? 'recognized';
        return of(edits);
      });
    library.export.mockImplementation(() => of({ ...payload, content: persistedText }));
    review.editPage(1, 'corrected');
    store.download('text');
    expect(library.export).not.toHaveBeenCalled();
    expect(store.status()).toBe(desktopMessages().resultSaveFailed);
    review.retrySave();
    expect(review.saveState()).toBe('saved');
    expect(review.saveError()).toBeNull();
    store.download('text');
    expect(formatting.downloadText).toHaveBeenCalledWith(payload.fileName, 'corrected', payload.mediaType);
    expect(store.status()).toBe(desktopMessages().exportDownloaded);
  });

  it('waits for an active autosave and the newer working copy in serial order', () => {
    const { store, review, library } = setup();
    const saved = new Subject<DesktopLibraryEdits>();
    library.saveEdits.mockReturnValueOnce(saved);
    review.editPage(1, 'first');
    vi.advanceTimersByTime(600);
    review.editPage(1, 'newest');
    store.download('text');
    expect(library.export).not.toHaveBeenCalled();
    saved.next(library.saveEdits.mock.calls[0][1]);
    saved.complete();
    expect(library.saveEdits).toHaveBeenCalledTimes(2);
    expect(library.saveEdits.mock.calls[1][1].ocrPages).toEqual({ '1': 'newest' });
    expect(library.export).toHaveBeenCalledTimes(1);
  });

  it('blocks stale export on save failure and shows the save message', () => {
    const { store, review, library } = setup();
    library.saveEdits.mockReturnValue(throwError(() => new Error('private document text')));
    review.editPage(1, 'corrected');
    store.download('text');
    expect(library.export).not.toHaveBeenCalled();
    expect(store.status()).toBe(desktopMessages().resultSaveFailed);
    expect(store.busy()).toBe(false);
  });

  it('reports the export failure when a failing save has no remaining unsaved corrections', () => {
    const { store, review, library } = setup();
    const saved = new Subject<DesktopLibraryEdits>();
    library.saveEdits.mockReturnValueOnce(saved);
    library.export.mockReturnValue(throwError(() => new Error('host export failed')));
    review.editPage(1, 'temporary correction');
    store.download('text');
    review.restorePage(1);
    saved.error(new Error('save failed'));
    expect(review.saveState()).toBe('idle');
    expect(review.saveError()).toBeNull();
    expect(library.export).toHaveBeenCalledTimes(1);
    expect(store.status()).toBe(desktopMessages().exportFailed);
    expect(store.busy()).toBe(false);
  });

  it('ignores a second press while the host export is running and reports safe errors', () => {
    const { store, library } = setup();
    const response = new Subject<DesktopLibraryExport>();
    library.export.mockReturnValue(response);
    store.download('text');
    store.download('markdown');
    expect(library.export).toHaveBeenCalledTimes(1);
    response.error(new Error('private document text'));
    expect(store.status()).toBe(desktopMessages().exportFailed);
    expect(store.busy()).toBe(false);
  });

  it('copies the text export after saving and shows success', async () => {
    const { store, review, library, formatting, clipboard } = setup();
    review.editPage(1, 'corrected');
    store.copy();
    expect(library.saveEdits).toHaveBeenCalledTimes(1);
    expect(library.export).toHaveBeenCalledWith('doc', 'text', '第 {page} 頁');
    expect(clipboard.writeText).toHaveBeenCalledWith('host text');
    expect(store.busy()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.status()).toBe(desktopMessages().exportCopied);
    expect(store.busy()).toBe(false);
    expect(formatting.downloadText).not.toHaveBeenCalled();
  });

  it('reports clipboard failure without exposing document text', async () => {
    const { store, clipboard } = setup();
    clipboard.writeText.mockRejectedValue(new Error('private document text'));
    store.copy();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.status()).toBe(desktopMessages().exportCopyFailed);
    expect(store.busy()).toBe(false);
  });
});
