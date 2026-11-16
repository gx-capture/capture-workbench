import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import { BehaviorSubject, of, throwError } from 'rxjs';
import type { DesktopLibraryDetail } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
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
      ],
    });

    const store = TestBed.inject(ResultReviewStore);
    TestBed.tick();
    return { store, library, paramMap$ };
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

  it('exposes the PDF preview note and never requests source bytes for PDFs', () => {
    const raw = {
      sourceText: 'pdf text',
      segments: [
        { segmentId: 's1', order: 0, locator: { kind: 'page', page: 1 }, text: 'pdf text' },
      ],
    } as unknown as RawCapture;
    const sourceBytes = vi.fn();
    const { store } = setup({
      get: vi.fn(() => of(makeDetail({ mediaType: 'application/pdf', raw }))),
      sourceBytes,
    });

    store.loadSource();
    expect(store.pdfPreviewNote()).toBe('PDF 頁面影像將在之後的版本提供');
    expect(store.imageUrl()).toBeNull();
    expect(sourceBytes).not.toHaveBeenCalled();
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
