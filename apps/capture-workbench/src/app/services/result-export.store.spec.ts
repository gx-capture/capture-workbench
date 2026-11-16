import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import { of, Subject, throwError } from 'rxjs';
import type { DesktopLibraryEdits, DesktopLibraryExport } from '../contracts';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';
import { PdfPageRenderer } from './pdf-page-renderer.service';
import { ResultExportStore } from './result-export.store';
import { ResultReviewStore } from './result-review.store';

describe('ResultExportStore', () => {
  beforeEach(() => { vi.useFakeTimers(); setDesktopLocale('zh-TW'); });
  afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  function setup(mediaType = 'application/pdf') {
    const payload = { fileName: 'host-name.txt', content: 'host text', mediaType: 'text/plain' };
    const library = {
      get: vi.fn(() => of({ documentId: 'doc', fileName: 'input.pdf', mediaType,
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
    const params = convertToParamMap({ id: 'doc' });
    TestBed.configureTestingModule({ providers: [ResultReviewStore, ResultExportStore,
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: params }, paramMap: of(params) } },
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: { started: signal(true) } },
      { provide: DesktopWorkspaceFormattingService, useValue: formatting },
      { provide: PdfPageRenderer, useValue: {} },
    ] });
    const store = TestBed.inject(ResultExportStore);
    const review = TestBed.inject(ResultReviewStore);
    TestBed.tick();
    return { store, review, library, formatting, clipboard, payload };
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
    expect(library.saveEdits).toHaveBeenCalledTimes(1);
    expect(library.export).not.toHaveBeenCalled();
    expect(library.saveEdits.mock.calls[0][1].ocrPages).toEqual({ '1': 'corrected' });
    saved.next(library.saveEdits.mock.calls[0][1]);
    saved.complete();
    expect(library.export).toHaveBeenCalledTimes(1);
    expect(store.busy()).toBe(false);
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
