import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DesktopLibraryDetail } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import type { TranscriptLine } from '../services/desktop-workspace.selectors';
import type { OcrPageText } from '../services/ocr-queue';
import type { ResultSeekRequest } from '../services/result-review';
import {
  type PdfPreviewState,
  ResultReviewStore,
} from '../services/result-review.store';
import { ResultContentPage } from './result-content-page';

describe('ResultContentPage', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  function setup(overrides: Record<string, unknown> = {}) {
    const store = {
      detail: signal<DesktopLibraryDetail | null>({
        documentId: 'a'.repeat(32),
        fileName: 'contract.pdf',
        mediaType: 'application/pdf',
        byteLength: 1024,
        createdAtMs: 100,
        updatedAtMs: 200,
        status: 'completed',
      }),
      hasResult: signal(true),
      statusText: signal('完成'),
      noResultReason: signal<string | null>(null),
      kind: signal<'ocr' | 'asr'>('ocr'),
      isPdf: signal(true),
      pdfState: signal<PdfPreviewState>('ready'),
      pdfError: signal<string | null>(null),
      renderedPdfPage: signal<number | null>(1),
      renderCurrentPdfPage: vi.fn(),
      imageUrl: signal<string | null>(null),
      sourceError: signal<string | null>(null),
      totalPages: signal(2),
      currentPagePosition: signal(1),
      pagesContiguousFromOne: signal(true),
      currentPage: signal<OcrPageText | null>({ page: 1, text: '第一頁文字' }),
      canPrevious: signal(false),
      canNext: signal(true),
      previousPage: vi.fn(),
      nextPage: vi.fn(),
      playbackUnavailable: signal(false),
      playbackUnavailableMessage: signal<string | null>(null),
      recordingUrl: signal<string | null>(null),
      isVideo: signal(false),
      lines: signal<readonly TranscriptLine[]>([]),
      activeSeek: signal<ResultSeekRequest | null>(null),
      editPage: vi.fn(),
      restorePage: vi.fn(),
      editLine: vi.fn(),
      restoreLine: vi.fn(),
      loadSource: vi.fn(),
      requestSeek: vi.fn(),
      onMediaCanPlay: vi.fn(),
      ...overrides,
    };

    TestBed.configureTestingModule({
      imports: [ResultContentPage],
      providers: [{ provide: ResultReviewStore, useValue: store }],
    });

    const fixture = TestBed.createComponent(ResultContentPage);
    fixture.detectChanges();
    return { fixture, store, el: fixture.nativeElement as HTMLElement };
  }

  it('binds page typing and only offers restore for an edited page', () => {
    const currentPage = signal({ page: 1, text: 'recognized', recognizedText: 'recognized', edited: false });
    const { fixture, el, store } = setup({ currentPage });
    const textarea = el.querySelector('[data-testid="result-page-text"]') as HTMLTextAreaElement;
    textarea.value = 'correction';
    textarea.dispatchEvent(new Event('input'));
    expect(store.editPage).toHaveBeenCalledWith(1, 'correction');
    expect(el.querySelector('[data-testid="result-page-restore"]')).toBeNull();
    currentPage.set({ page: 1, text: 'correction', recognizedText: 'recognized', edited: true });
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="result-page-edited"]')).not.toBeNull();
    (el.querySelector('[data-testid="result-page-restore"]') as HTMLButtonElement).click();
    expect(store.restorePage).toHaveBeenCalledWith(1);
  });

  it('edits transcript text by double-click or button, commits on Enter or blur and cancels on Escape', () => {
    const { fixture, el, store } = setup({ kind: signal('asr'), isPdf: signal(false),
      lines: signal([{ segmentId: 's1', startMs: 0, timeLabel: '0:00', text: 'recognized', recognizedText: 'recognized', edited: true }]),
    });
    (el.querySelector('[data-testid="result-line-text"]') as HTMLElement).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();
    const input = el.querySelector('[data-testid="result-line-input"]') as HTMLTextAreaElement;
    expect(input.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    input.value = 'corrected';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(store.editLine).toHaveBeenCalledExactlyOnceWith('s1', 'corrected');
    (el.querySelector('[data-testid="result-line-edit"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    input.value = 'cancelled';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(store.editLine).toHaveBeenCalledTimes(1);
    expect(input.hidden).toBe(true);
    (el.querySelector('[data-testid="result-line-edit"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    input.value = 'blur correction';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    expect(store.editLine).toHaveBeenLastCalledWith('s1', 'blur correction');
    fixture.detectChanges();
    (el.querySelector('[data-testid="result-line-restore"]') as HTMLButtonElement).click();
    expect(store.restoreLine).toHaveBeenCalledWith('s1');
  });

  it('renders PDF canvas, data-rendered-page, OCR page text, and page controls', () => {
    const { el, store } = setup();

    const canvas = el.querySelector('[data-testid="result-source-pdf-canvas"]') as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    expect(canvas.getAttribute('data-rendered-page')).toBe('1');
    expect(canvas.classList.contains('hidden')).toBe(false);
    expect(store.renderCurrentPdfPage).toHaveBeenCalledWith(canvas, expect.any(Number));
    expect((el.querySelector('[data-testid="result-page-text"]') as HTMLTextAreaElement).value).toBe('第一頁文字');
    expect(el.querySelector('[data-testid="result-page-indicator"]')?.textContent?.trim()).toBe('1 / 2');

    const prev = el.querySelector('[data-testid="result-page-prev"]') as HTMLButtonElement;
    const next = el.querySelector('[data-testid="result-page-next"]') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    next.click();
    expect(store.nextPage).toHaveBeenCalledTimes(1);
  });

  it('shows the source page and position when recognized pages are not contiguous from 1', () => {
    const { fixture, el } = setup({
      totalPages: signal(3),
      currentPagePosition: signal(2),
      pagesContiguousFromOne: signal(false),
      currentPage: signal<OcrPageText | null>({ page: 7, text: '第七頁' }),
      renderedPdfPage: signal<number | null>(7),
    });

    expect(el.querySelector('[data-testid="result-page-indicator"]')?.textContent?.trim()).toBe(
      '第 7 頁（2 / 3）',
    );

    setDesktopLocale('en');
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="result-page-indicator"]')?.textContent?.trim()).toBe(
      'Page 7 (2 of 3)',
    );
  });

  it('shows loading text while pdfState is loading and error text when failed', () => {
    const pdfState = signal<PdfPreviewState>('loading');
    const pdfError = signal<string | null>(null);
    const renderedPdfPage = signal<number | null>(null);
    const { fixture, el } = setup({ pdfState, pdfError, renderedPdfPage });

    expect(el.querySelector('[data-testid="result-pdf-loading"]')?.textContent?.trim()).toBe(
      '正在載入結果…',
    );
    const canvas = el.querySelector('[data-testid="result-source-pdf-canvas"]') as HTMLCanvasElement;
    expect(canvas.classList.contains('hidden')).toBe(true);
    expect(canvas.getAttribute('data-rendered-page')).toBeNull();

    pdfState.set('failed');
    pdfError.set('無法顯示這份 PDF 的頁面影像，仍可查看辨識文字。');
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="result-pdf-loading"]')).toBeNull();
    expect(el.querySelector('[data-testid="result-pdf-error"]')?.textContent?.trim()).toBe(
      '無法顯示這份 PDF 的頁面影像，仍可查看辨識文字。',
    );
    expect((el.querySelector('[data-testid="result-page-text"]') as HTMLTextAreaElement).value).toBe('第一頁文字');
  });

  it('renders ASR player and transcript rows and requests seek on time click', () => {
    const { el, store } = setup({
      detail: signal<DesktopLibraryDetail | null>({
        documentId: 'b'.repeat(32),
        fileName: 'meeting.m4a',
        mediaType: 'audio/mp4',
        byteLength: 4096,
        createdAtMs: 100,
        updatedAtMs: 200,
        status: 'completed',
      }),
      kind: signal('asr'),
      isPdf: signal(false),
      pdfState: signal<PdfPreviewState>('idle'),
      recordingUrl: signal('blob:audio-1'),
      lines: signal<readonly TranscriptLine[]>([
        { segmentId: 'seg-1', startMs: 12_000, timeLabel: '0:12', speaker: '王律師', text: '請說明經過。' },
      ]),
    });

    const player = el.querySelector('[data-testid="result-player"]') as HTMLAudioElement;
    expect(player).not.toBeNull();

    const rows = el.querySelectorAll('[data-testid="result-transcript-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('[data-testid="result-line-speaker"]')?.textContent?.trim()).toBe('王律師');
    expect(rows[0].querySelector('[data-testid="result-line-text"]')?.textContent?.trim()).toBe('請說明經過。');

    (rows[0].querySelector('[data-testid="result-line-time"]') as HTMLButtonElement).click();
    expect(store.requestSeek).toHaveBeenCalledWith(12_000);
  });
});
