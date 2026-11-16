import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { DesktopLibraryDetail } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { ResultReviewStore } from '../services/result-review.store';
import { ResultPage } from './result-page';

describe('ResultPage', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  function setup(options: {
    readonly kind: 'ocr' | 'asr';
    readonly fileName: string;
  }) {
    const store = {
      detail: signal<DesktopLibraryDetail | null>({
        documentId: 'a'.repeat(32),
        fileName: options.fileName,
        mediaType: options.kind === 'asr' ? 'audio/mp4' : 'application/pdf',
        byteLength: 1024,
        createdAtMs: 100,
        updatedAtMs: 200,
        status: 'completed',
      }),
      loading: signal(false),
      loadError: signal<string | null>(null),
      kind: signal(options.kind),
      backRoute: signal(options.kind === 'asr' ? '/asr' : '/ocr'),
    };

    TestBed.configureTestingModule({
      imports: [ResultPage],
      providers: [provideRouter([])],
    });
    TestBed.overrideComponent(ResultPage, {
      set: {
        providers: [{ provide: ResultReviewStore, useValue: store }],
      },
    });

    const fixture = TestBed.createComponent(ResultPage);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('shows 內容 and 詳細資訊 without 說話者 for an OCR document', () => {
    const { el } = setup({ kind: 'ocr', fileName: 'contract.pdf' });

    expect(el.querySelector('[data-testid="result-title"]')?.textContent?.trim()).toBe('contract.pdf');
    expect(el.querySelector('[data-testid="result-back"]')?.getAttribute('href')).toBe('/ocr');
    expect(el.querySelector('[data-testid="result-nav-content"]')?.textContent?.trim()).toBe('內容');
    expect(el.querySelector('[data-testid="result-nav-speakers"]')).toBeNull();
    expect(el.querySelector('[data-testid="result-nav-details"]')?.textContent?.trim()).toBe('詳細資訊');
  });

  it('shows 說話者 in the sub-nav for a recording', () => {
    const { el } = setup({ kind: 'asr', fileName: 'meeting.m4a' });

    expect(el.querySelector('[data-testid="result-title"]')?.textContent?.trim()).toBe('meeting.m4a');
    expect(el.querySelector('[data-testid="result-back"]')?.getAttribute('href')).toBe('/asr');
    expect(el.querySelector('[data-testid="result-nav-content"]')?.textContent?.trim()).toBe('內容');
    expect(el.querySelector('[data-testid="result-nav-speakers"]')?.textContent?.trim()).toBe('說話者');
    expect(el.querySelector('[data-testid="result-nav-details"]')?.textContent?.trim()).toBe('詳細資訊');
  });
});
