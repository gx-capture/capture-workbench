import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DesktopLibraryDetail } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import type { TranscriptLine } from '../services/desktop-workspace.selectors';
import type { OcrPageText } from '../services/ocr-queue';
import type { ResultSeekRequest } from '../services/result-review';
import { ResultReviewStore } from '../services/result-review.store';
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
      pdfPreviewNote: signal<string | null>('PDF 頁面影像將在之後的版本提供'),
      imageUrl: signal<string | null>(null),
      sourceError: signal<string | null>(null),
      totalPages: signal(2),
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

  it('renders OCR page text, PDF note, and page controls with disabled previous on page 1', () => {
    const { el, store } = setup();

    expect(el.querySelector('[data-testid="result-pdf-note"]')?.textContent?.trim()).toBe(
      'PDF 頁面影像將在之後的版本提供',
    );
    expect(el.querySelector('[data-testid="result-page-text"]')?.textContent).toBe('第一頁文字');
    expect(el.querySelector('[data-testid="result-page-indicator"]')?.textContent?.trim()).toBe('1 / 2');

    const prev = el.querySelector('[data-testid="result-page-prev"]') as HTMLButtonElement;
    const next = el.querySelector('[data-testid="result-page-next"]') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    next.click();
    expect(store.nextPage).toHaveBeenCalledTimes(1);
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
      pdfPreviewNote: signal(null),
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
