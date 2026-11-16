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
      saveState: signal('idle'),
      saveError: signal<string | null>(null),
      editError: signal<string | null>(null),
      editsNotice: signal<string | null>(null),
      retrySave: vi.fn(),
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
    return { fixture, store, el: fixture.nativeElement as HTMLElement };
  }

  it('renders pending, saving, saved and failed status with retry and correction notices', () => {
    const { fixture, el, store } = setup({ kind: 'ocr', fileName: 'test.pdf' });
    const status = () => el.querySelector('[data-testid="result-save-status"]')?.textContent?.trim();
    expect(status()).toBe('');
    for (const state of ['pending', 'saving']) {
      store.saveState.set(state);
      fixture.detectChanges();
      expect(status()).toBe('儲存中');
    }
    store.saveState.set('saved');
    fixture.detectChanges();
    expect(status()).toBe('已儲存');
    store.saveState.set('failed');
    store.saveError.set('儲存失敗');
    store.editsNotice.set('Earlier corrections could not be read.');
    store.editError.set('Input exceeds the limit.');
    fixture.detectChanges();
    expect(status()).toContain('儲存失敗');
    (el.querySelector('[data-testid="result-save-retry"]') as HTMLButtonElement).click();
    expect(store.retrySave).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[data-testid="result-edits-notice"]')?.textContent).toContain('Earlier corrections');
    expect(el.querySelector('[data-testid="result-edit-error"]')?.getAttribute('role')).toBe('alert');
  });

  it('shows 內容, 匯出 and 詳細資訊 without 說話者 for an OCR document', () => {
    const { el } = setup({ kind: 'ocr', fileName: 'contract.pdf' });

    expect(el.querySelector('[data-testid="result-title"]')?.textContent?.trim()).toBe('contract.pdf');
    expect(el.querySelector('[data-testid="result-back"]')?.getAttribute('href')).toBe('/ocr');
    expect(el.querySelector('[data-testid="result-nav-content"]')?.textContent?.trim()).toBe('內容');
    expect(el.querySelector('[data-testid="result-nav-speakers"]')).toBeNull();
    expect([...el.querySelectorAll('[data-testid="result-subnav"] a')].map((link) => link.textContent?.trim()))
      .toEqual(['內容', '匯出', '詳細資訊']);
    expect(el.querySelector('[data-testid="result-nav-details"]')?.textContent?.trim()).toBe('詳細資訊');
  });

  it('shows 說話者 in the sub-nav for a recording', () => {
    const { el } = setup({ kind: 'asr', fileName: 'meeting.m4a' });

    expect(el.querySelector('[data-testid="result-title"]')?.textContent?.trim()).toBe('meeting.m4a');
    expect(el.querySelector('[data-testid="result-back"]')?.getAttribute('href')).toBe('/asr');
    expect(el.querySelector('[data-testid="result-nav-content"]')?.textContent?.trim()).toBe('內容');
    expect(el.querySelector('[data-testid="result-nav-speakers"]')?.textContent?.trim()).toBe('說話者');
    expect([...el.querySelectorAll('[data-testid="result-subnav"] a')].map((link) => link.textContent?.trim()))
      .toEqual(['內容', '說話者', '匯出', '詳細資訊']);
    expect(el.querySelector('[data-testid="result-nav-details"]')?.textContent?.trim()).toBe('詳細資訊');
  });
});
