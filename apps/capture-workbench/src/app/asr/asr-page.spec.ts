import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  CaptureRequirementId,
  RuntimeInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { setDesktopLocale } from '../i18n/desktop-messages';
import type {
  AsrLiveCaptureView,
  AsrQueueView,
  AsrSpokenLanguage,
} from '../services/asr-queue';
import { AsrQueueStore } from '../services/asr-queue.store';
import { MAX_PLAYBACK_BYTES } from '../services/recording-playback';
import { RecognitionFeaturesStore } from '../services/recognition-features.store';
import { AsrPage } from './asr-page';

function makeRequirement(
  requirementId: CaptureRequirementId,
  status: RuntimeRequirement['status'],
  downloadBytes: number,
): RuntimeRequirement {
  return {
    requirementId,
    displayName: requirementId,
    status,
    kind: 'runtime',
    requiredFor: ['capture'],
    installStrategy: 'automatic',
    detail: null,
    downloadBytes,
  };
}

describe('AsrPage', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  function setup(options: {
    readonly speechReady?: boolean;
    readonly speakersReady?: boolean;
    readonly rows?: readonly AsrQueueView[];
    readonly liveCapture?: AsrLiveCaptureView | null;
    readonly importError?: string;
    readonly installation?: RuntimeInstallation;
  } = {}) {
    const speechStatus: RuntimeRequirement['status'] =
      options.speechReady === false ? 'installable' : 'ready';
    const speakersStatus: RuntimeRequirement['status'] =
      options.speakersReady ? 'ready' : 'installable';
    const requirements = signal<readonly RuntimeRequirement[]>([
      makeRequirement('speech-recognition', speechStatus, 2_800_000_000),
      makeRequirement('speaker-diarization', speakersStatus, 300_000_000),
    ]);
    const spokenLanguage = signal<AsrSpokenLanguage>('zh');
    const identifySpeakers = signal(false);
    const speechReady = computed(() =>
      requirements().some(
        (r) => r.requirementId === 'speech-recognition' && r.status === 'ready',
      ),
    );
    const speakersReady = computed(() =>
      requirements().some(
        (r) => r.requirementId === 'speaker-diarization' && r.status === 'ready',
      ),
    );
    const optionalSpeakerUnit = computed(
      () =>
        requirements().find(
          (r) => r.requirementId === 'speaker-diarization' && r.status !== 'ready',
        ) ?? null,
    );

    const queue = {
      attach: vi.fn(),
      speechReady,
      speakersReady,
      speechPack: requirements,
      optionalSpeakerUnit,
      spokenLanguage,
      identifySpeakers,
      importError: signal(options.importError ?? ''),
      rows: signal<readonly AsrQueueView[]>(options.rows ?? []),
      liveCapture: signal<AsrLiveCaptureView | null>(options.liveCapture ?? null),
      speechSizeLabel: signal('約 2.8 GB'),
      setSpokenLanguage: vi.fn((lang: AsrSpokenLanguage) => spokenLanguage.set(lang)),
      setIdentifySpeakers: vi.fn((enabled: boolean) => identifySpeakers.set(enabled)),
      chooseFiles: vi.fn(),
      install: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      restart: vi.fn(),
      view: vi.fn(),
      exportTxt: vi.fn(),
    };

    const features = {
      installing: signal(false),
      installationFor: vi.fn((requirementId: CaptureRequirementId): RuntimeInstallation | null =>
        options.installation?.requirementId === requirementId ? options.installation : null),
      installUnit: vi.fn(),
      cancelInstallation: vi.fn(),
      retryInstallation: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [AsrPage],
      providers: [
        { provide: AsrQueueStore, useValue: queue },
        { provide: RecognitionFeaturesStore, useValue: features },
      ],
    });
    const fixture = TestBed.createComponent(AsrPage);
    fixture.detectChanges();
    return { fixture, queue, features };
  }

  it('shows the install panel and disabled empty-queue button when speech recognition is missing', () => {
    const { fixture, queue, features } = setup({
      speechReady: false,
      speakersReady: false,
    });
    const el = fixture.nativeElement as HTMLElement;

    expect(queue.attach).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[data-testid="asr-install-panel"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="asr-dropzone"]')).toBeNull();
    expect(el.querySelector('[data-testid="asr-queue-empty"]')?.textContent).toContain(
      '還沒有錄音',
    );
    const emptyBtn = el.querySelector(
      '[data-testid="asr-empty-choose-files"]',
    ) as HTMLButtonElement;
    expect(emptyBtn.disabled).toBe(true);

    const installBtn = el.querySelector(
      '[data-testid="engine-card"][data-requirement-id="speech-recognition"] [data-testid="engine-card-install"]',
    ) as HTMLButtonElement;
    installBtn.click();
    expect(features.installUnit).toHaveBeenCalledWith('speech-recognition');
  });

  it('renders drop zone, language selector, optional speaker install vs checkbox, and speaker note', () => {
    const { fixture: withoutSpeakers, features } = setup({
      speechReady: true,
      speakersReady: false,
    });
    const el1 = withoutSpeakers.nativeElement as HTMLElement;
    expect(el1.querySelector('[data-testid="asr-dropzone"]')).not.toBeNull();
    expect(el1.querySelector('[data-testid="asr-identify-speakers"]')).toBeNull();
    const optInstall = el1.querySelector(
      '[data-testid="asr-optional-speakers"] [data-testid="engine-card-install"]',
    ) as HTMLButtonElement;
    optInstall.click();
    expect(features.installUnit).toHaveBeenCalledWith('speaker-diarization');

    TestBed.resetTestingModule();
    const { fixture: withSpeakers, queue } = setup({
      speechReady: true,
      speakersReady: true,
    });
    const el2 = withSpeakers.nativeElement as HTMLElement;
    const select = el2.querySelector(
      '[data-testid="asr-language-select"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe('zh');
    select.value = 'en';
    select.dispatchEvent(new Event('change'));
    expect(queue.setSpokenLanguage).toHaveBeenCalledWith('en');

    const checkbox = el2.querySelector(
      '[data-testid="asr-identify-speakers"]',
    ) as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(queue.setIdentifySpeakers).toHaveBeenCalledWith(true);
    expect(el2.querySelector('[data-testid="asr-speakers-note"]')?.textContent).toContain(
      '分辨說話者時，要整段完成才看得到逐字稿。',
    );
  });

  it.each([
    { speechReady: false, requirementId: 'speech-recognition' as const },
    { speechReady: true, requirementId: 'speaker-diarization' as const },
  ])('binds engine cancellation and retry for $requirementId', ({ speechReady, requirementId }) => {
    const installation: RuntimeInstallation = {
      installationId: 'install-1',
      requirementId,
      status: 'running',
      progress: 0.5,
      createdAt: '2026-11-13T00:00:00Z',
      updatedAt: '2026-11-13T00:00:00Z',
    };
    const { fixture, features } = setup({ speechReady, installation });
    const el = fixture.nativeElement as HTMLElement;
    const card = el.querySelector(`[data-requirement-id="${requirementId}"]`) as HTMLElement;

    (card.querySelector('[data-testid="engine-card-cancel"]') as HTMLButtonElement).click();
    expect(features.cancelInstallation).toHaveBeenCalledExactlyOnceWith('install-1');

    features.installationFor.mockReturnValue({ ...installation, status: 'failed' });
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    (card.querySelector('[data-testid="engine-card-retry"]') as HTMLButtonElement).click();
    expect(features.retryInstallation).toHaveBeenCalledExactlyOnceWith(requirementId);
  });

  it('renders the live capture card and queue table rows with status notes and actions', () => {
    const liveCapture: AsrLiveCaptureView = {
      documentId: '1'.repeat(32),
      fileName: '專案會議-1104.m4a',
      coveredUntilMs: 724_000,
      durationMs: 2_490_000,
      percent: 29,
      heardLabel: '已聽到 12:04／41:30',
      partialRevision: 3,
      lines: [
        { segmentId: 's1', timeLabel: '0:00', speaker: null, text: '好，那我們開始。', partial: false },
        { segmentId: 's2', timeLabel: '12:04', speaker: null, text: '我覺得先跑完驗收比較保險……', partial: true },
      ],
    };
    const rows: readonly AsrQueueView[] = [
      {
        documentId: '1'.repeat(32),
        fileName: '專案會議-1104.m4a',
        mediaType: 'audio/mp4',
        byteLength: 1000,
        durationLabel: '41:30',
        userStatus: 'processing',
        statusText: '處理中',
        needsInstall: false,
        installPercent: null,
        interrupted: false,
        speakerCount: null,
        playbackUnavailable: false,
        canExport: false,
        errorMessage: '',
      },
      {
        documentId: '2'.repeat(32),
        fileName: '訪談-第二場.mp3',
        mediaType: 'audio/mpeg',
        byteLength: 1000,
        durationLabel: '28:12',
        userStatus: 'waiting',
        statusText: '等待中',
        needsInstall: false,
        installPercent: null,
        interrupted: false,
        speakerCount: null,
        playbackUnavailable: false,
        canExport: false,
        errorMessage: '',
      },
      {
        documentId: '3'.repeat(32),
        fileName: '課堂錄音-第3週.wav',
        mediaType: 'audio/wav',
        byteLength: MAX_PLAYBACK_BYTES + 1,
        durationLabel: '52:40',
        userStatus: 'done',
        statusText: '完成',
        needsInstall: false,
        installPercent: null,
        interrupted: false,
        speakerCount: 3,
        playbackUnavailable: true,
        canExport: true,
        errorMessage: '',
      },
      {
        documentId: '4'.repeat(32),
        fileName: '中斷的錄音.m4a',
        mediaType: 'audio/mp4',
        byteLength: 1000,
        durationLabel: '—',
        userStatus: 'needs-attention',
        statusText: '已中斷',
        needsInstall: false,
        installPercent: null,
        interrupted: true,
        speakerCount: null,
        playbackUnavailable: false,
        canExport: false,
        errorMessage: '',
      },
    ];

    const { fixture, queue } = setup({ liveCapture, rows });
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="asr-live-heard"]')?.textContent?.trim()).toBe(
      '已聽到 12:04／41:30',
    );
    const partialSection = el.querySelector('[data-testid="streaming-partial"]') as HTMLElement;
    expect(partialSection.dataset['coveredUntilMs']).toBe('724000');
    expect(partialSection.dataset['partialRevision']).toBe('3');
    const lines = [...el.querySelectorAll('[data-testid="asr-live-line"]')] as HTMLElement[];
    expect(lines.map((line) => line.dataset['partial'])).toEqual(['false', 'true']);
    expect(el.querySelector('[data-testid="asr-live-note"]')?.textContent).toContain(
      '灰色的是即時結果，整段完成後會再校正。',
    );

    const renderedRows = [
      ...el.querySelectorAll('[data-testid="asr-queue-row"]'),
    ] as HTMLElement[];
    expect(renderedRows.length).toBe(4);
    expect(
      renderedRows[2].querySelector('[data-testid="asr-row-speakers"]')?.textContent?.trim(),
    ).toBe('3 位說話者');
    expect(
      renderedRows[2].querySelector('[data-testid="asr-row-playback-note"]')?.textContent?.trim(),
    ).toBe('這種格式無法在這裡播放，逐字稿照常可看。');

    (renderedRows[2].querySelector('[data-testid="asr-row-view"]') as HTMLButtonElement).click();
    expect(queue.view).toHaveBeenCalledWith('3'.repeat(32));
    (renderedRows[2].querySelector('[data-testid="asr-row-export"]') as HTMLButtonElement).click();
    expect(queue.exportTxt).toHaveBeenCalledWith('3'.repeat(32));
    (renderedRows[3].querySelector('[data-testid="asr-row-restart"]') as HTMLButtonElement).click();
    expect(queue.restart).toHaveBeenCalledWith('4'.repeat(32));
  });
});
