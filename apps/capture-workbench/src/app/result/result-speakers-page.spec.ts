import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DesktopLibraryDetail } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import type { ResultSpeakerView } from '../services/result-review';
import { ResultReviewStore } from '../services/result-review.store';
import { ResultSpeakersPage } from './result-speakers-page';

describe('ResultSpeakersPage', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  function setup(speakers: readonly ResultSpeakerView[]) {
    const store = {
      detail: signal<DesktopLibraryDetail | null>({
        documentId: 'b'.repeat(32),
        fileName: 'meeting.m4a',
        mediaType: 'audio/mp4',
        byteLength: 4096,
        createdAtMs: 100,
        updatedAtMs: 200,
        status: 'completed',
      }),
      hasResult: signal(true),
      statusText: signal('完成'),
      playbackUnavailableMessage: signal<string | null>(null),
      speakers: signal(speakers),
      loadSource: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [ResultSpeakersPage],
      providers: [{ provide: ResultReviewStore, useValue: store }],
    });

    const fixture = TestBed.createComponent(ResultSpeakersPage);
    fixture.detectChanges();
    return { el: fixture.nativeElement as HTMLElement };
  }

  it('renders speaker names and sample audio elements', () => {
    const { el } = setup([
      { speakerId: 'SPEAKER_00', displayName: '王律師', sampleUrl: 'blob:rec#t=1,3' },
    ]);

    const rows = el.querySelectorAll('[data-testid="result-speaker-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('[data-testid="result-speaker-name"]')?.textContent?.trim()).toBe('王律師');
    const audio = rows[0].querySelector('[data-testid="result-speaker-sample"]') as HTMLAudioElement;
    expect(audio.getAttribute('preload')).toBe('none');
    expect(audio.getAttribute('src')).toBe('blob:rec#t=1,3');
  });

  it('shows an empty message when no speakers are present', () => {
    const { el } = setup([]);

    expect(el.querySelector('[data-testid="result-speakers-empty"]')?.textContent?.trim()).toBe(
      '這段錄音沒有標記說話者。',
    );
  });
});
