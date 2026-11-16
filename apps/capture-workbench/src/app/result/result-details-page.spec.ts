import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { setDesktopLocale } from '../i18n/desktop-messages';
import type { ResultDetailsView } from '../services/result-review';
import { ResultReviewStore } from '../services/result-review.store';
import { ResultDetailsPage } from './result-details-page';

describe('ResultDetailsPage', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('renders the document details list', () => {
    const details: ResultDetailsView = {
      fileName: 'contract.pdf',
      mediaType: 'application/pdf',
      sizeLabel: '2 KB',
      statusLabel: '完成',
      pageCount: 4,
      durationLabel: null,
      createdAtLabel: '2026/11/16 08:00',
      updatedAtLabel: '2026/11/16 08:05',
    };

    TestBed.configureTestingModule({
      imports: [ResultDetailsPage],
      providers: [
        {
          provide: ResultReviewStore,
          useValue: { details: signal(details) },
        },
      ],
    });

    const fixture = TestBed.createComponent(ResultDetailsPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="result-detail-filename"]')?.textContent?.trim()).toBe('contract.pdf');
    expect(el.querySelector('[data-testid="result-detail-type"]')?.textContent?.trim()).toBe('application/pdf');
    expect(el.querySelector('[data-testid="result-detail-size"]')?.textContent?.trim()).toBe('2 KB');
    expect(el.querySelector('[data-testid="result-detail-status"]')?.textContent?.trim()).toBe('完成');
    expect(el.querySelector('[data-testid="result-detail-pages"]')?.textContent?.trim()).toBe('4');
    expect(el.querySelector('[data-testid="result-detail-duration"]')).toBeNull();
  });
});
