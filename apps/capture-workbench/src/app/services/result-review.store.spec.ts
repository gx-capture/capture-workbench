import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import { BehaviorSubject, of, Subject, throwError } from 'rxjs';
import type { DesktopLibraryDetail } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import {
  PdfPageRenderer,
  type PdfDocumentHandle,
} from './pdf-page-renderer.service';
import { MAX_PLAYBACK_BYTES } from './recording-playback';
import { ResultReviewStore } from './result-review.store';

const DOC_ID = 'a'.repeat(32);

function makeDetail(
  overrides: Partial<DesktopLibraryDetail> = {},
): DesktopLibraryDetail {
  return {
    documentId: DOC_ID,
    fileName: 'contract.pdf',
    mediaType: 'application/pdf',
    byteLength: 2048,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    status: 'completed',
    hasRaw: true,
    ...overrides,
  };
}

describe('ResultReviewStore', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  function setup(options: {
    readonly id?: string;
    readonly get?: ReturnType<typeof vi.fn>;
    readonly sourceBytes?: ReturnType<typeof vi.fn>;
    readonly pdfOpen?: ReturnType<typeof vi.fn>;
  } = {}) {
    const paramMap$ = new BehaviorSubject(
      convertToParamMap({ id: options.id ?? DOC_ID }),
    );
    const library = {
      get: options.get ?? vi.fn(() => of(makeDetail())),
      sourceBytes: options.sourceBytes ?? vi.fn(() => of(new ArrayBuffer(8))),
    };
    const runtime = {
      started: signal(true),
    };
    const defaultHandle: PdfDocumentHandle = {
      pageCount: 2,
      renderPage: vi.fn(() => of(undefined)),
      destroy: vi.fn(),
    };
    const pdfRenderer = {
      open: options.pdfOpen ?? vi.fn(() => of(defaultHandle)),
    };

    TestBed.configureTestingModule({
      providers: [
        ResultReviewStore,
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: paramMap$.value },
            paramMap: paramMap$.asObservable(),
          },
        },
        { provide: DesktopLibraryService, useValue: library },
        { provide: DesktopRuntimeClientService, useValue: runtime },
        { provide: PdfPageRenderer, useValue: pdfRenderer },
      ],
    });

    const store = TestBed.inject(ResultReviewStore);
    TestBed.tick();
    return { store, library, paramMap$, pdfRenderer, defaultHandle };
  }

  it('loads document detail by route id', () => {
    const detail = makeDetail({ fileName: 'brief.pdf' });
    const get = vi.fn(() => of(detail));
    const { store } = setup({ id: DOC_ID, get });

    expect(get).toHaveBeenCalledWith(DOC_ID, expect.any(AbortSignal));
    expect(store.detail()).toEqual(detail);
    expect(store.kind()).toBe('ocr');
    expect(store.backRoute()).toBe('/ocr');
    expect(store.notFound()).toBe(false);
    expect(store.failed()).toBe(false);
  });

  it('exposes persisted page edits and the unreadable flag without saving', () => {
    const raw = { sourceText: 'recognized', segments: [
      { segmentId: 'p3', order: 0, locator: { kind: 'page', page: 3 }, text: 'recognized' },
    ] } as unknown as RawCapture;
    const { store } = setup({ get: vi.fn(() => of(makeDetail({ raw,
      editsUnreadable: true,
      edits: { schemaVersion: 1, updatedAtMs: 42, ocrPages: { '3': 'edited' }, transcriptLines: {}, speakerNames: {} },
    }))) });
    expect(store.pages()).toEqual([{ page: 3, text: 'edited', recognizedText: 'recognized', edited: true }]);
    expect(store.editsUnreadable()).toBe(true);
  });

  it('uses persisted transcript and speaker edits for both ASR views', () => {
    const raw = { sourceText: 'recognized', speakers: [{ speakerId: 'sp1', displayName: 'Recognized name' }], segments: [
      { segmentId: 's1', order: 0, locator: { kind: 'time', startMs: 0, endMs: 1000 }, speaker: 'sp1', text: 'recognized' },
    ] } as unknown as RawCapture;
    const { store } = setup({ get: vi.fn(() => of(makeDetail({ raw, mediaType: 'audio/mpeg',
      edits: { schemaVersion: 1, updatedAtMs: 42, ocrPages: {}, transcriptLines: { s1: 'edited' }, speakerNames: { sp1: 'Edited name' } },
    }))) });
    expect(store.lines()[0]).toMatchObject({ text: 'edited', recognizedText: 'recognized', edited: true, speaker: 'Edited name' });
    expect(store.speakers()[0].displayName).toBe('Edited name');
    expect(store.editsUnreadable()).toBe(false);
  });

  it('marks notFound when the library reports an unknown document', () => {
    const get = vi.fn(() =>
      throwError(() => new Error(`Unknown document: ${DOC_ID}`)),
    );
    const { store } = setup({ get });

    expect(store.notFound()).toBe(true);
    expect(store.failed()).toBe(false);
    expect(store.loadError()).toBe('找不到這份文件。');
  });

  it('reports status and hasResult=false when raw is not available yet', () => {
    const get = vi.fn(() =>
      of(makeDetail({ status: 'queued', hasRaw: false, raw: undefined })),
    );
    const { store } = setup({ get });

    expect(store.hasResult()).toBe(false);
    expect(store.statusText()).toBe('等待中');
  });

  it('steps through OCR pages with bounds', () => {
    const raw = {
      sourceText: 'p1\n\np2',
      ocrPageScope: {
        sourcePageCount: 2,
        requestedPageNumbers: [1, 2],
        processedPageNumbers: [1, 2],
      },
      segments: [
        { segmentId: 's1', order: 0, locator: { kind: 'page', page: 1 }, text: '第一頁' },
        { segmentId: 's2', order: 0, locator: { kind: 'page', page: 2 }, text: '第二頁' },
      ],
    } as unknown as RawCapture;
    const { store } = setup({ get: vi.fn(() => of(makeDetail({ raw }))) });

    expect(store.totalPages()).toBe(2);
    expect(store.currentPage()?.page).toBe(1);
    expect(store.canPrevious()).toBe(false);
    expect(store.canNext()).toBe(true);

    store.previousPage();
    expect(store.currentPage()?.page).toBe(1);

    store.nextPage();
    expect(store.currentPage()?.page).toBe(2);
    expect(store.canPrevious()).toBe(true);
    expect(store.canNext()).toBe(false);

    store.nextPage();
    expect(store.currentPage()?.page).toBe(2);

    store.selectPage(1);
    expect(store.currentPage()?.page).toBe(1);
  });

  it('creates an image Blob URL once and revokes it on destroy', () => {
    const raw = {
      sourceText: 'hello',
      segments: [
        { segmentId: 's1', order: 0, locator: { kind: 'page', page: 1 }, text: 'hello' },
      ],
    } as unknown as RawCapture;
    const sourceBytes = vi.fn(() => of(new ArrayBuffer(12)));
    const createObjectURL = vi.fn(() => 'blob:image-1');
    const revokeObjectURL = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    try {
      const { store } = setup({
        get: vi.fn(() =>
          of(makeDetail({ fileName: 'scan.png', mediaType: 'image/png', raw })),
        ),
        sourceBytes,
      });

      store.loadSource();
      store.loadSource();
      expect(sourceBytes).toHaveBeenCalledTimes(1);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(store.imageUrl()).toBe('blob:image-1');

      TestBed.resetTestingModule();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:image-1');
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('opens a PDF through PdfPageRenderer without creating a Blob URL and tracks pdfState', () => {
    const raw = {
      sourceText: 'pdf text',
      segments: [
        { segmentId: 's1', order: 0, locator: { kind: 'page', page: 1 }, text: 'pdf text' },
      ],
    } as unknown as RawCapture;
    const open$ = new Subject<PdfDocumentHandle>();
    const handle: PdfDocumentHandle = {
      pageCount: 2,
      renderPage: vi.fn(() => of(undefined)),
      destroy: vi.fn(),
    };
    const pdfOpen = vi.fn(() => open$.asObservable());
    const sourceBytes = vi.fn(() => of(new ArrayBuffer(16)));
    const createObjectURL = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });

    try {
      const { store } = setup({
        get: vi.fn(() => of(makeDetail({ mediaType: 'application/pdf', raw }))),
        sourceBytes,
        pdfOpen,
      });

      expect(store.pdfState()).toBe('idle');
      store.loadSource();
      store.loadSource();

      expect(sourceBytes).toHaveBeenCalledTimes(1);
      expect(pdfOpen).toHaveBeenCalledTimes(1);
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(store.imageUrl()).toBeNull();
      expect(store.pdfState()).toBe('loading');

      open$.next(handle);
      open$.complete();

      expect(store.pdfState()).toBe('ready');
      expect(store.pdfError()).toBeNull();
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else Reflect.deleteProperty(URL, 'createObjectURL');
    }
  });

  it('sets pdfState to failed and exposes pdfError when opening a PDF fails', () => {
    const raw = {
      sourceText: 'pdf text',
      segments: [
        { segmentId: 's1', order: 0, locator: { kind: 'page', page: 1 }, text: 'pdf text' },
      ],
    } as unknown as RawCapture;
    const pdfOpen = vi.fn(() => throwError(() => new Error('corrupt pdf')));
    const { store } = setup({
      get: vi.fn(() => of(makeDetail({ mediaType: 'application/pdf', raw }))),
      pdfOpen,
    });

    store.loadSource();

    expect(store.pdfState()).toBe('failed');
    expect(store.pdfError()).toBe('無法顯示這份 PDF 的頁面影像，仍可查看辨識文字。');
  });

  it('renders the source page number and marks out-of-range pages failed without hiding text', () => {
    const raw = {
      sourceText: 'p2\n\np5',
      segments: [
        { segmentId: 's1', order: 0, locator: { kind: 'page', page: 2 }, text: '第二頁' },
        { segmentId: 's2', order: 0, locator: { kind: 'page', page: 5 }, text: '第五頁' },
      ],
    } as unknown as RawCapture;
    const renderPage = vi.fn(() => of(undefined));
    const handle: PdfDocumentHandle = {
      pageCount: 3,
      renderPage,
      destroy: vi.fn(),
    };
    const { store } = setup({
      get: vi.fn(() => of(makeDetail({ mediaType: 'application/pdf', raw }))),
      pdfOpen: vi.fn(() => of(handle)),
    });

    store.loadSource();

    const canvas = document.createElement('canvas');
    store.renderCurrentPdfPage(canvas, 600);

    expect(renderPage).toHaveBeenCalledWith(2, canvas, {
      cssWidth: 600,
      devicePixelRatio: expect.any(Number),
    });
    expect(store.renderedPdfPage()).toBe(2);
    expect(store.pdfState()).toBe('ready');

    store.nextPage();
    store.renderCurrentPdfPage(canvas, 600);
    expect(store.pdfState()).toBe('failed');
    expect(store.renderedPdfPage()).toBeNull();
    expect(store.currentPage()?.text).toBe('第五頁');

    store.previousPage();
    expect(store.pdfState()).toBe('ready');
  });

  it('destroys the PDF handle when switching documents or destroying the store', () => {
    const raw = {
      sourceText: 'pdf text',
      segments: [
        { segmentId: 's1', order: 0, locator: { kind: 'page', page: 1 }, text: 'pdf text' },
      ],
    } as unknown as RawCapture;
    const destroyHandle = vi.fn();
    const handle: PdfDocumentHandle = {
      pageCount: 1,
      renderPage: vi.fn(() => of(undefined)),
      destroy: destroyHandle,
    };
    const { store, paramMap$ } = setup({
      get: vi.fn(() => of(makeDetail({ mediaType: 'application/pdf', raw }))),
      pdfOpen: vi.fn(() => of(handle)),
    });

    store.loadSource();

    paramMap$.next(convertToParamMap({ id: 'b'.repeat(32) }));
    TestBed.tick();
    expect(destroyHandle).toHaveBeenCalledTimes(1);

    TestBed.resetTestingModule();
  });

  it('destroys the PDF handle when the store is destroyed', () => {
    const raw = {
      sourceText: 'pdf text',
      segments: [
        { segmentId: 's1', order: 0, locator: { kind: 'page', page: 1 }, text: 'pdf text' },
      ],
    } as unknown as RawCapture;
    const destroyHandle = vi.fn();
    const handle: PdfDocumentHandle = {
      pageCount: 1,
      renderPage: vi.fn(() => of(undefined)),
      destroy: destroyHandle,
    };
    const { store } = setup({
      get: vi.fn(() => of(makeDetail({ mediaType: 'application/pdf', raw }))),
      pdfOpen: vi.fn(() => of(handle)),
    });

    store.loadSource();

    TestBed.resetTestingModule();
    expect(destroyHandle).toHaveBeenCalledTimes(1);
  });

  it('builds ASR transcript lines with speaker names and speaker sample URLs', () => {
    const raw = {
      sourceText: '你好',
      speakers: [
        { speakerId: 'SPEAKER_00', sample: { kind: 'time', startMs: 1000, endMs: 3500 } },
      ],
      segments: [
        {
          segmentId: 'seg-1',
          order: 0,
          locator: { kind: 'time', startMs: 1000, endMs: 2500 },
          speaker: 'SPEAKER_00',
          text: '你好',
        },
      ],
    } as unknown as RawCapture;
    const result = {
      targetText: '你好',
      speakers: [
        {
          speakerId: 'SPEAKER_00',
          displayName: '王律師',
          sample: { kind: 'time', startMs: 1000, endMs: 3500 },
        },
      ],
    } as unknown as DesktopLibraryDetail['result'];
    const createObjectURL = vi.fn(() => 'blob:rec-1');
    const revokeObjectURL = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    try {
      const { store } = setup({
        get: vi.fn(() =>
          of(makeDetail({ fileName: 'meeting.m4a', mediaType: 'audio/mp4', raw, result })),
        ),
      });

      expect(store.kind()).toBe('asr');
      expect(store.backRoute()).toBe('/asr');
      expect(store.lines()).toEqual([
        {
          segmentId: 'seg-1',
          startMs: 1000,
          timeLabel: '0:01',
          speaker: '王律師',
          text: '你好',
          recognizedText: '你好',
          edited: false,
        },
      ]);

      store.loadSource();
      expect(store.speakers()).toEqual([
        {
          speakerId: 'SPEAKER_00',
          displayName: '王律師',
          sampleUrl: 'blob:rec-1#t=1,3.5',
        },
      ]);
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('defers requestSeek until media can play and applies immediately afterwards', () => {
    const raw = {
      sourceText: 'hello',
      segments: [
        { segmentId: 'seg-1', order: 0, locator: { kind: 'time', startMs: 12_000, endMs: 15_000 }, text: 'hello' },
      ],
    } as unknown as RawCapture;
    const createObjectURL = vi.fn(() => 'blob:rec-2');
    const revokeObjectURL = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    try {
      const { store } = setup({
        get: vi.fn(() =>
          of(makeDetail({ fileName: 'call.mp4', mediaType: 'video/mp4', raw })),
        ),
      });

      expect(store.kind()).toBe('asr');
      expect(store.isVideo()).toBe(true);

      store.requestSeek(12_000);
      expect(store.pendingSeekMs()).toBe(12_000);
      expect(store.activeSeek()).toBeNull();

      store.onMediaCanPlay();
      expect(store.pendingSeekMs()).toBeNull();
      expect(store.activeSeek()).toEqual({ ms: 12_000, seq: 1 });

      store.requestSeek(25_000);
      expect(store.pendingSeekMs()).toBeNull();
      expect(store.activeSeek()).toEqual({ ms: 25_000, seq: 2 });
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('refuses playback for recordings over the size limit without fetching bytes', () => {
    const raw = {
      sourceText: 'long',
      segments: [
        { segmentId: 'seg-1', order: 0, locator: { kind: 'time', startMs: 0, endMs: 1000 }, text: 'long' },
      ],
    } as unknown as RawCapture;
    const sourceBytes = vi.fn();
    const { store } = setup({
      get: vi.fn(() =>
        of(
          makeDetail({
            fileName: 'huge.wav',
            mediaType: 'audio/wav',
            byteLength: MAX_PLAYBACK_BYTES + 1,
            raw,
          }),
        ),
      ),
      sourceBytes,
    });

    store.loadSource();
    store.requestSeek(0);
    expect(sourceBytes).not.toHaveBeenCalled();
    expect(store.recordingUrl()).toBeNull();
    expect(store.playbackUnavailable()).toBe(true);
    expect(store.playbackUnavailableMessage()).toBe('大型錄音暫時無法播放，仍可查看逐字稿。');
  });
});
