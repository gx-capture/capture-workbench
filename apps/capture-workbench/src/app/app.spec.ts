import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  convertToParamMap,
  provideRouter,
  Router,
  withComponentInputBinding,
} from '@angular/router';
import { RUNTIME_VERSION, type CaptureOcrProjection } from '@gx-capture/capture-runtime-client';
import type {
  CaptureOperation,
  OcrComputePreflight,
  CaptureRequirementId,
  RuntimeInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { defer, EMPTY, NEVER, of, Subject, throwError, type Observable } from 'rxjs';
import { App } from './app';
import { appRoutes } from './app.routes';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from './contracts';
import { HistoryListPage } from './history/history-list-page';
import { setDesktopLocale } from './i18n/desktop-messages';
import {
  isFeatureReady,
  type RecognitionFeature,
  selectFeatureMissing,
  selectInstallableRequirements,
  selectRecognitionRequirements,
  selectSpeechPack,
} from './services/recognition-requirements';
import { AsrQueueStore } from './services/asr-queue.store';
import { DesktopLibraryService, type DesktopSourceSelection, type DesktopSourceSelectionBatch } from './services/desktop-library.service';
import { DesktopRuntimeClientService } from './services/desktop-runtime-client.service';
import { DiagnosticsStore } from './services/diagnostics.store';
import { OcrQueueStore } from './services/ocr-queue.store';
import { RuntimeStatusStore } from './services/runtime-status.store';
import { SpeechGpuSettingsStore } from './services/speech-gpu-settings.store';
import { LibraryStore } from './services/library.store';
import { RecognitionFeaturesStore } from './services/recognition-features.store';

describe('App shell and recognition pages', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('starts the workspace once and lists the four pages in Traditional Chinese', async () => {
    const { fixture, store } = await renderShell('/');

    expect(store.reload).toHaveBeenCalledTimes(1);
    const links = [
      ...fixture.nativeElement.querySelectorAll('[data-testid="shell-nav"] ul a'),
    ] as HTMLAnchorElement[];
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      '文件轉文字',
      '錄音轉逐字稿',
      '紀錄',
      '設定',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/ocr',
      '/asr',
      '/history',
      '/settings',
    ]);
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="runtime-status"]')
        ?.getAttribute('href'),
    ).toBe('/settings/diagnostics');
  });

  it('opens document to text by default and marks its link as the current page', async () => {
    const { fixture } = await renderShell('/');

    expect(TestBed.inject(Router).url).toBe('/ocr');
    expect(
      fixture.nativeElement.querySelector('[data-testid="page-ocr"] h1')
        ?.textContent,
    ).toContain('文件轉文字');
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="nav-ocr"]')
        ?.getAttribute('aria-current'),
    ).toBe('page');
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="nav-asr"]')
        ?.getAttribute('aria-current'),
    ).toBeNull();
  });

  it('shows the first-run recognition card on /ocr with nested speaker option, combined download size, and dismiss action', async () => {
    const { fixture, features } = await renderShell('/ocr', {
      requirements: [
        makeRequirement('text-recognition', 'installable', 144_000_000),
        makeRequirement('speech-recognition', 'installable', 2_800_000_000),
        makeRequirement('speaker-diarization', 'installable', 300_000_000),
      ],
    });

    const card = fixture.nativeElement.querySelector(
      '[data-testid="first-run-card"]',
    ) as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('要安裝哪些辨識功能？');
    expect(
      card.querySelector('[data-testid="first-run-size-ocr"]')?.textContent,
    ).toContain('約 144 MB');
    expect(
      card.querySelector('[data-testid="first-run-size-asr"]')?.textContent,
    ).toContain('約 2.8 GB');
    expect(
      card.querySelector('[data-testid="first-run-size-speakers"]')
        ?.textContent,
    ).toContain('約 300 MB');

    const installBtn = card.querySelector(
      '[data-testid="first-run-install"]',
    ) as HTMLButtonElement;
    expect(installBtn.textContent?.trim()).toBe('安裝所選（約 144 MB）');

    const speakersCheckbox = card.querySelector(
      '[data-testid="first-run-checkbox-speakers"]',
    ) as HTMLInputElement;
    speakersCheckbox.checked = true;
    speakersCheckbox.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(installBtn.textContent?.trim()).toBe('安裝所選（約 3.2 GB）');
    installBtn.click();
    expect(features.installFirstRunSelection).toHaveBeenCalledWith(
      expect.arrayContaining([
        'text-recognition',
        'speech-recognition',
        'speaker-diarization',
      ]),
    );

    const dismissBtn = card.querySelector(
      '[data-testid="first-run-dismiss"]',
    ) as HTMLButtonElement;
    dismissBtn.click();
    fixture.detectChanges();

    expect(features.dismissFirstRun).toHaveBeenCalledTimes(1);
    expect(
      fixture.nativeElement.querySelector('[data-testid="first-run-card"]'),
    ).toBeNull();
  });

  it('shows the ASR install panel in place of the intake drop zone when speech recognition is missing, and unlocks when ready', async () => {
    const { fixture, features } = await renderShell('/asr', {
      requirements: [
        makeRequirement('speech-recognition', 'installable', 2_800_000_000),
        makeRequirement('speaker-diarization', 'installable', 300_000_000),
      ],
    });

    const page = fixture.nativeElement.querySelector(
      '[data-testid="page-asr"]',
    ) as HTMLElement;
    expect(page.querySelector('h1')?.textContent).toContain('錄音轉逐字稿');
    expect(
      page.querySelector('[data-testid="asr-install-panel"]'),
    ).not.toBeNull();
    expect(page.querySelector('[data-testid="asr-dropzone"]')).toBeNull();

    const cards = [
      ...page.querySelectorAll('[data-testid="engine-card"]'),
    ] as HTMLElement[];
    expect(cards.map((c) => c.dataset['requirementId'])).toEqual([
      'speech-recognition',
      'speaker-diarization',
    ]);
    const installButton = cards[0].querySelector(
      '[data-testid="engine-card-install"]',
    ) as HTMLButtonElement;
    expect(installButton.textContent?.trim()).toBe('安裝（約 2.8 GB）');
    installButton.click();
    expect(features.installRequirement).toHaveBeenCalledWith('speech-recognition');

    features.requirements.set([
      makeRequirement('speech-recognition', 'ready', 2_800_000_000),
      makeRequirement('speaker-diarization', 'installable', 300_000_000),
    ]);
    fixture.detectChanges();

    expect(page.querySelector('[data-testid="asr-install-panel"]')).toBeNull();
    expect(page.querySelector('[data-testid="asr-dropzone"]')).not.toBeNull();
    expect(
      page.querySelector('[data-testid="asr-choose-files"]')?.textContent?.trim(),
    ).toBe('選擇檔案');
  });

  it('redirects /settings to /settings/engines and renders expandable recognition engine rows with install, cancel, and retry actions', async () => {
    const { fixture, features } = await renderShell('/settings', {
      requirements: [
        makeRequirement('text-recognition', 'ready', 144_000_000),
        makeRequirement('speech-recognition', 'installable', 2_800_000_000),
        makeRequirement('speaker-diarization', 'installable', 300_000_000),
      ],
    });

    expect(TestBed.inject(Router).url).toBe('/settings/engines');
    const page = fixture.nativeElement.querySelector(
      '[data-testid="page-settings"]',
    ) as HTMLElement;
    expect(page.querySelector('h1')?.textContent).toContain('設定');
    expect(page.querySelector('h2')?.textContent).toContain('辨識功能');
    const ocrRow = page.querySelector(
      '[data-testid="engine-row"][data-requirement-id="text-recognition"]',
    ) as HTMLElement;
    expect(
      ocrRow.querySelector('[data-testid="engine-row-remove"]')?.textContent?.trim(),
    ).toBe('移除');

    const headers = [
      ...page.querySelectorAll('[data-testid="engines-table"] thead th'),
    ].map((th) => th.textContent?.trim());
    expect(headers).toEqual(['功能', '狀態', '大小', '動作']);
    // The purpose is a second line under the feature name, not a column of its own.
    expect(
      ocrRow.querySelector('[data-testid="engine-row-purpose"]')?.textContent?.trim(),
    ).toBe('讀出掃描檔與照片的文字');

    const speechRow = () =>
      page.querySelector(
        '[data-testid="engine-row"][data-requirement-id="speech-recognition"]',
      ) as HTMLElement;
    expect(speechRow().querySelector('[data-testid="engine-row-remove"]')).toBeNull();
    expect(
      speechRow()
        .querySelector('[data-testid="engine-row-install"]')
        ?.textContent?.trim(),
    ).toBe('安裝（約 2.8 GB）');

    const toggleBtn = speechRow().querySelector(
      '[data-testid="engine-row-toggle"]',
    ) as HTMLButtonElement;
    toggleBtn.click();
    fixture.detectChanges();

    const detailsRow = page.querySelector(
      '[data-testid="engine-row-details"][data-requirement-id="speech-recognition"]',
    ) as HTMLElement;
    expect(detailsRow).not.toBeNull();
    expect(detailsRow.textContent).toContain('TEA-ASR 1.1');

    features.installations.set({
      'speech-recognition': {
        installationId: 'inst-asr-1',
        requirementId: 'speech-recognition',
        status: 'running',
        progress: 0.1,
        downloadedBytes: 1_400_000_000,
        downloadBytes: 2_800_000_000,
        createdAt: '2026-11-03T00:00:00Z',
        updatedAt: '2026-11-03T00:00:00Z',
      },
    });
    fixture.detectChanges();

    expect(
      speechRow().querySelector('[data-testid="engine-row-progress"]')
        ?.textContent,
    ).toContain('正在下載 50%');
    const cancelBtn = speechRow().querySelector(
      '[data-testid="engine-row-cancel"]',
    ) as HTMLButtonElement;
    cancelBtn.click();
    expect(features.cancelInstallation).toHaveBeenCalledWith('inst-asr-1');

    features.installations.set({
      'speech-recognition': {
        installationId: 'inst-asr-1',
        requirementId: 'speech-recognition',
        status: 'cancelled',
        progress: 0.5,
        downloadedBytes: 1_400_000_000,
        downloadBytes: 2_800_000_000,
        createdAt: '2026-11-03T00:00:00Z',
        updatedAt: '2026-11-03T00:00:00Z',
      },
    });
    fixture.detectChanges();

    const retryBtn = speechRow().querySelector(
      '[data-testid="engine-row-retry"]',
    ) as HTMLButtonElement;
    expect(retryBtn?.textContent?.trim()).toBe('再試一次');
    retryBtn.click();
    expect(features.retryInstallation).toHaveBeenCalledWith(
      'speech-recognition',
    );
  });

  it('keeps history on its route and sends unknown paths home', async () => {
    expect(appRoutes.find((route) => route.path === 'history')?.component).toBe(
      HistoryListPage,
    );
    expect(appRoutes.some((route) => route.path === 'workspace')).toBe(false);
    await renderShell('/no-such-page');

    expect(TestBed.inject(Router).url).toBe('/ocr');
  });

  it('shows the runtime state at the bottom of the navigation', async () => {
    const { fixture, store } = await renderShell('/');
    const status = () =>
      fixture.nativeElement.querySelector(
        '[data-testid="runtime-status"]',
      ) as HTMLElement;

    expect(status().dataset['state']).toBe('starting');
    expect(status().getAttribute('href')).toBe('/settings/diagnostics');
    expect(status().getAttribute('aria-label')).toBeNull();
    expect(status().querySelector('.sr-only')?.textContent).toBe('診斷');
    expect(status().querySelector('[aria-live="polite"]')?.textContent).toContain('尚未就緒');
    expect(status().textContent).toContain('尚未就緒');

    store.state.set('ready');
    fixture.detectChanges();
    expect(status().dataset['state']).toBe('ready');
    expect(status().textContent).toContain('已就緒');
    expect(status().querySelector('[aria-live="polite"]')?.textContent).toContain('已就緒');
  });
});

const FIRST_RUN_REQUIREMENT_IDS: readonly CaptureRequirementId[] = [
  'text-recognition',
  'speech-recognition',
  'speaker-diarization',
];

function makeRequirement(
  requirementId: CaptureRequirementId,
  status: RuntimeRequirement['status'],
  downloadBytes: number,
): RuntimeRequirement {
  return {
    requirementId,
    displayName: requirementId,
    status,
    kind: requirementId,
    requiredFor: ['capture'],
    installStrategy: 'runtime-catalog',
    detail: null,
    downloadBytes,
  };
}

async function renderShell(
  url: string,
  options: { readonly requirements?: readonly RuntimeRequirement[] } = {},
) {
  const requirements = signal<readonly RuntimeRequirement[]>(
    options.requirements ?? [
      makeRequirement('text-recognition', 'ready', 144_000_000),
      makeRequirement('speech-recognition', 'ready', 2_800_000_000),
      makeRequirement('speaker-diarization', 'ready', 300_000_000),
    ],
  );
  const installations = signal<
    Partial<Record<CaptureRequirementId, RuntimeInstallation>>
  >({});
  const installing = signal(false);
  const firstRunDismissed = signal(false);

  const features = {
    requirements,
    requestedRequirements: signal<ReadonlySet<CaptureRequirementId>>(new Set()),
    installations,
    installing,
    firstRunDismissed,
    recognitionRequirements: computed(() => selectRecognitionRequirements(requirements())),
    speechPack: computed(() => selectSpeechPack(requirements())),
    firstRunInstallableRequirements: computed(() =>
      selectInstallableRequirements(requirements(), FIRST_RUN_REQUIREMENT_IDS),
    ),
    showFirstRunCard: computed(
      () =>
        !firstRunDismissed() &&
        selectInstallableRequirements(requirements(), FIRST_RUN_REQUIREMENT_IDS).length > 0,
    ),
    startingRequirementId: signal<CaptureRequirementId | null>(null),
    isProgressUnavailable: () => false,
    activeInstallation: computed(() => {
      const values = Object.values(installations()).filter(
        (item): item is RuntimeInstallation => item !== undefined,
      );
      return values[0] ?? null;
    }),
    isFeatureReady: (feature: RecognitionFeature) =>
      isFeatureReady(requirements(), feature),
    missingFor: (feature: RecognitionFeature) =>
      selectFeatureMissing(requirements(), feature),
    installationFor: (requirementId: CaptureRequirementId) =>
      installations()[requirementId] ?? null,
    installRequirement: vi.fn(),
    installRequirements: vi.fn(),
    installFirstRunSelection: vi.fn(),
    isRemoving: () => false,
    removalError: () => null,
    removeRequirement: vi.fn(),
    cancelInstallation: vi.fn(),
    retryInstallation: vi.fn(),
    dismissFirstRun: vi.fn(() => {
      firstRunDismissed.set(true);
    }),
  };

  const store = {
    state: signal<'starting' | 'ready' | 'error'>('starting'),
    message: signal(''),
    reload: vi.fn(),
  };

  await TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes, withComponentInputBinding()),
      { provide: RuntimeStatusStore, useValue: store },
      { provide: DesktopLibraryService, useValue: { droppedSources: () => EMPTY } },
      {
        provide: LibraryStore,
        useValue: {
          allDocuments: signal([]),
          selectedId: signal<string | null>(null),
          selected: signal(null),
          refreshDocuments: vi.fn(),
          applyDocumentState: vi.fn(),
        },
      },
      { provide: RecognitionFeaturesStore, useValue: features },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  await TestBed.inject(Router).navigateByUrl(url);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, store, features };
}

describe('App native drops', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('allows an OCR-ready import when host structuring is unavailable', () => {
    const importSelection = vi.fn(() => of(summary));
    const startInstallation = vi.fn();
    const startModelInstallation = vi.fn();
    const { store, drop } = renderDropShell(
      libraryStub({ importSelection }),
      runtimeStub({
        startInstallation,
        startModelInstallation,
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'text-recognition',
            displayName: 'Text recognition',
            status: 'ready',
            kind: 'text-recognition',
            requiredFor: ['capture'],
            installStrategy: 'none',
          },
          {
            requirementId: 'structuring-runtime',
            displayName: 'Ollama',
            status: 'unavailable',
            kind: 'structuring-runtime',
            requiredFor: ['structuring'],
            installStrategy: 'none',
          },
        ])),
        getModelOptions: vi.fn(() => of([{
          optionId: 'qwen3.5-0.8b-v1',
          displayName: 'Qwen 3.5 0.8B',
          modelReference: 'qwen3.5:0.8b',
          expectedDigest: null,
          downloadBytes: null,
          profileId: 'qwen3.5-0.8b-structure-v1',
          profileSpecSha256: 'b'.repeat(64),
          status: 'not-installed' as const,
        }])),
      }),
    );

    expect(store.state()).toBe('ready');
    expect(TestBed.inject(RecognitionFeaturesStore).ocrReady()).toBe(true);
    expect(TestBed.inject(RecognitionFeaturesStore).requestedMissing()).toEqual([]);

    drop({ rejected: [], selections: [selection('scan.pdf')] });
    TestBed.tick();

    expect(startInstallation).not.toHaveBeenCalled();
    expect(startModelInstallation).not.toHaveBeenCalled();
    expect(importSelection).toHaveBeenCalledWith(selection('scan.pdf'));
  });

  it('asks for Whisper only when an allowed audio source is selected', () => {
    const voiceDoc: DesktopLibrarySummary = {
      ...summary,
      fileName: 'voice.wav',
      mediaType: 'audio/wav',
    };
    // The host lists a document once its import has answered; the batch's
    // turn reads the stored document before it checks the requirements.
    let imported: readonly DesktopLibrarySummary[] = [];
    const library = libraryStub({
      importSelection: vi.fn(() => defer(() => {
        imported = [voiceDoc];
        return of(voiceDoc);
      })),
      list: vi.fn(() => defer(() => of(imported))),
    });
    const client = runtimeStub({
      getRequirements: vi.fn(() => of([{
        requirementId: 'speech-recognition',
        displayName: 'Speech recognition',
        status: 'missing',
        kind: 'speech-recognition',
        requiredFor: ['recording'],
        installStrategy: 'runtime-catalog',
      }])),
    });
    const { store, drop } = renderDropShell(library, client);
    expect(TestBed.inject(RecognitionFeaturesStore).requestedMissing()).toEqual([]);
    expect(store.message()).toBe('');

    drop({ rejected: [], selections: [selection('voice.wav')] });
    TestBed.tick();

    expect(store.state()).toBe('ready');
    expect(TestBed.inject(RecognitionFeaturesStore).requestedMissing().map((item) => item.requirementId)).toEqual([
      'speech-recognition',
    ]);
    expect(store.message()).toBe('處理錄音需要先下載台灣語音轉文字（TEA-ASR 1.1）。');
    expect(library.importSelection).toHaveBeenCalledOnce();
  });

  it('never asks an ASR-only user for OCR and transcribes recordings when OCR is not installed', () => {
    const audioDoc: DesktopLibrarySummary = {
      ...summary,
      fileName: 'interview.wav',
      mediaType: 'audio/wav',
    };
    const startRecordingCapture = vi.fn(() => of(completedOperation));
    const getResult = vi.fn(() =>
      of({ operation: completedOperation, raw, result }),
    );
    const deleteCapture = vi.fn(() => of(undefined));
    const startInstallation = vi.fn();
    const stored = storedDocuments([]);
    const library = libraryStub({
      importSelection: vi.fn(() => stored.import(audioDoc)),
      list: stored.list,
      updateCapture: stored.updateCapture,
      get: vi.fn(() => of<DesktopLibraryDetail>(audioDoc)),
    });
    const client = runtimeStub({
      ocrCompute: signal(null),
      getRequirements: vi.fn(() =>
        of([
          {
            requirementId: 'text-recognition',
            displayName: 'Text recognition',
            status: 'installable',
            kind: 'text-recognition',
            requiredFor: ['capture'],
            installStrategy: 'runtime-catalog',
            downloadBytes: 144_000_000,
          },
          {
            requirementId: 'speech-recognition',
            displayName: 'Speech recognition',
            status: 'ready',
            kind: 'speech-recognition',
            requiredFor: ['recording'],
            installStrategy: 'runtime-catalog',
            downloadBytes: 2_800_000_000,
          },
        ]),
      ),
      startInstallation,
      startRecordingCapture,
      getResult,
      deleteCapture,
    });
    const { store, drop } = renderDropShell(library, client);

    expect(store.state()).toBe('ready');
    expect(TestBed.inject(RecognitionFeaturesStore).asrReady()).toBe(true);
    expect(TestBed.inject(RecognitionFeaturesStore).ocrReady()).toBe(false);

    drop({ rejected: [], selections: [selection('interview.wav')] });
    TestBed.tick();

    expect(startInstallation).not.toHaveBeenCalled();
    expect(TestBed.inject(RecognitionFeaturesStore).requestedRequirements().has('text-recognition')).toBe(false);
    expect(startRecordingCapture).toHaveBeenCalledOnce();
    expect(getResult).toHaveBeenCalledWith(completedOperation.captureId);
  });

  it('streams a newly imported recording before the cached library list includes it', () => {
    const audioDoc: DesktopLibrarySummary = {
      ...summary,
      fileName: 'interview.wav',
      mediaType: 'audio/wav',
    };
    const startRecordingCapture = vi.fn(() => of(completedOperation));
    const createCapture = vi.fn(() => of(completedOperation));
    // The host lists the document once its import has answered, but the
    // Workbench's cached list (the library store's read, which passes an
    // abort signal) has not reloaded since: its reloads stay unanswered, and
    // only the admission's reads of the stored documents see the recording.
    let imported = false;
    const stored = storedDocuments([]);
    const library = libraryStub({
      importSelection: vi.fn(() => defer(() => {
        imported = true;
        return stored.import(audioDoc);
      })),
      list: vi.fn((...args: [query?: string, status?: string, abortSignal?: AbortSignal]):
        Observable<readonly DesktopLibrarySummary[]> => {
        if (!imported) return of([]);
        return args[2] ? NEVER : stored.list();
      }),
      updateCapture: stored.updateCapture,
      get: vi.fn(() => of<DesktopLibraryDetail>(audioDoc)),
    });
    const client = runtimeStub({
      getRequirements: vi.fn(() =>
        of([
          {
            requirementId: 'speech-recognition',
            displayName: 'Speech recognition',
            status: 'ready',
            kind: 'speech-recognition',
            requiredFor: ['recording'],
            installStrategy: 'runtime-catalog',
            downloadBytes: 2_800_000_000,
          },
        ]),
      ),
      startRecordingCapture,
      createCapture,
      getResult: vi.fn(() => of({ operation: completedOperation, raw, result })),
      deleteCapture: vi.fn(() => of(undefined)),
    });
    const { drop } = renderDropShell(library, client);

    drop({ rejected: [], selections: [selection('interview.wav')] });
    TestBed.tick();

    expect(startRecordingCapture).toHaveBeenCalledOnce();
    expect(startRecordingCapture).toHaveBeenCalledWith(expect.objectContaining({ documentId: audioDoc.documentId }));
    // No reload answered: the list shows the row from what the capture's writes returned.
    expect(TestBed.inject(LibraryStore).allDocuments().map((item) => item.documentId)).toEqual([audioDoc.documentId]);
    expect(createCapture).not.toHaveBeenCalled();
  });

  it('routes native drop batches to OCR on /ocr, ASR on /asr, and imports them on history', () => {
    const dropped = new Subject<DesktopSourceSelectionBatch>();
    const ocrQueue = { importSelections: vi.fn() };
    const asrQueue = { importSelections: vi.fn() };
    const resolveOcrQueue = vi.fn(() => ocrQueue);
    const resolveAsrQueue = vi.fn(() => asrQueue);
    TestBed.configureTestingModule({ providers: [
      { provide: OcrQueueStore, useFactory: resolveOcrQueue },
      { provide: AsrQueueStore, useFactory: resolveAsrQueue },
    ] });
    const library = libraryStub({ droppedSources: vi.fn(() => dropped) });
    const runtime = runtimeStub();
    const { fixture, reloadOrder, route } = renderDropShell(library, runtime, dropped, '/ocr?source=drop#intake');
    expect(reloadOrder()).toEqual(['watch', 'runtime', 'compute', 'features', 'library']);
    expect(runtime.listInstallations).toHaveBeenCalledOnce();

    TestBed.inject(DiagnosticsStore).reconnect();
    TestBed.tick();
    expect(library.droppedSources).toHaveBeenCalledOnce();
    expect(reloadOrder()).toEqual([
      'watch', 'runtime', 'compute', 'features', 'library',
      'runtime', 'compute', 'features', 'library',
    ]);
    expect(runtime.listInstallations).toHaveBeenCalledTimes(2);
    expect(resolveOcrQueue).not.toHaveBeenCalled();
    expect(resolveAsrQueue).not.toHaveBeenCalled();

    const batch = { selections: [selection('chosen.pdf')], rejected: [] };
    dropped.next(batch);
    expect(ocrQueue.importSelections).toHaveBeenCalledWith(batch);
    expect(resolveAsrQueue).not.toHaveBeenCalled();
    expect(library.importSelection).not.toHaveBeenCalled();
    route.url = '/asr#intake';
    const recordingBatch = { selections: [selection('chosen.wav')], rejected: [] };
    dropped.next(recordingBatch);
    expect(asrQueue.importSelections).toHaveBeenCalledWith(recordingBatch);
    expect(library.importSelection).not.toHaveBeenCalled();
    route.url = '/history';
    dropped.next(batch);
    expect(library.importSelection).toHaveBeenCalledWith(batch.selections[0]);
    fixture.destroy();
    expect(dropped.observed).toBe(false);
  });

  it('starts the documents imported before the restart one at a time, without any page visit', () => {
    const waiting = (documentId: string, fileName: string, mediaType: string, createdAtMs: number) =>
      ({ ...summary, documentId, fileName, mediaType, createdAtMs }) satisfies DesktopLibrarySummary;
    const stored = storedDocuments([
      waiting('1'.repeat(32), 'first.pdf', 'application/pdf', 1),
      waiting('2'.repeat(32), 'second.wav', 'audio/wav', 2),
      waiting('3'.repeat(32), 'third.pdf', 'application/pdf', 3),
    ]);
    const library = libraryStub({ list: stored.list, updateCapture: stored.updateCapture });
    const createCapture = vi.fn(() => new Subject<CaptureOperation>());
    const startRecordingCapture = vi.fn(() => new Subject<CaptureOperation>());
    const runtime = runtimeStub({
      createCapture,
      startRecordingCapture,
      getRequirements: vi.fn(() => of(['text-recognition', 'speech-recognition'].map((requirementId) => ({
        requirementId, displayName: requirementId, status: 'ready', kind: requirementId,
        requiredFor: ['capture'], installStrategy: 'runtime-catalog',
      })))),
    });

    renderDropShell(library, runtime);

    expect(createCapture.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['1'.repeat(32)]);
    expect(startRecordingCapture).not.toHaveBeenCalled();

    // Visiting both queue pages starts nothing more.
    TestBed.inject(OcrQueueStore).attach();
    TestBed.inject(AsrQueueStore).attach();
    TestBed.tick();

    expect(createCapture).toHaveBeenCalledOnce();
    expect(startRecordingCapture).not.toHaveBeenCalled();
  });

  it('asks the runtime once, when it is first ready, to delete the capture of every linked row', () => {
    const linked = { ...summary, status: 'processing', captureId: 'capture-earlier-run' } satisfies DesktopLibrarySummary;
    const library = libraryStub({ list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([linked, summary])) });
    const runtime = runtimeStub({ ready: signal(false) });
    renderDropShell(library, runtime);
    expect(runtime.deleteCapture).not.toHaveBeenCalled();

    runtime.ready.set(true);
    TestBed.tick();
    runtime.ready.set(false);
    TestBed.tick();
    runtime.ready.set(true);
    TestBed.tick();

    expect(runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-earlier-run');
    expect(library.updateCapture).not.toHaveBeenCalled();
  });

  it('discards a refused batch when the runtime is unavailable', () => {
    const library = libraryStub();
    const runtime = runtimeStub();
    const { store, drop } = renderDropShell(library, runtime);
    runtime.ready.set(false);
    expect(store.state()).toBe('ready');
    drop({ selections: [selection('first.pdf')], rejected: [] });
    expect(library.discardSelections).toHaveBeenCalledWith([selection('first.pdf')]);
    expect(library.importSelection).not.toHaveBeenCalled();

    runtime.ready.set(true);
    runtime.error.set(new Error('runtime unavailable'));
    expect(store.state()).toBe('error');
    drop({ selections: [selection('second.pdf')], rejected: [] });
    expect(library.discardSelections).toHaveBeenNthCalledWith(2, [selection('second.pdf')]);
    expect(library.importSelection).not.toHaveBeenCalled();
  });
});

function renderDropShell(
  library: ReturnType<typeof libraryStub>,
  runtime: ReturnType<typeof runtimeStub>,
  dropped = new Subject<DesktopSourceSelectionBatch>(),
  url = '/history',
) {
  const route = { url };
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      { provide: Router, useValue: route },
      { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({})) } },
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: runtime },
      DiagnosticsStore,
    ],
  }).overrideComponent(App, { set: { template: '' } });
  const subscribeToDrops = vi.fn(() => dropped);
  library.droppedSources.mockReturnValue(defer(subscribeToDrops));
  const compute = vi.spyOn(TestBed.inject(SpeechGpuSettingsStore), 'reload');
  const features = vi.spyOn(TestBed.inject(RecognitionFeaturesStore), 'initialize');
  const refresh = vi.spyOn(TestBed.inject(LibraryStore), 'refreshDocuments');
  const fixture = TestBed.createComponent(App);
  TestBed.tick();

  return {
    fixture,
    route,
    store: TestBed.inject(RuntimeStatusStore),
    drop: (batch: DesktopSourceSelectionBatch) => dropped.next(batch),
    reloadOrder: () => [
      { name: 'watch', calls: subscribeToDrops.mock.invocationCallOrder },
      { name: 'runtime', calls: runtime.reload.mock.invocationCallOrder },
      { name: 'compute', calls: compute.mock.invocationCallOrder },
      { name: 'features', calls: features.mock.invocationCallOrder },
      { name: 'library', calls: refresh.mock.invocationCallOrder },
    ].flatMap(({ name, calls }) => calls.map((order: number) => ({ name, order })))
      .sort((a, b) => a.order - b.order)
      .map(({ name }) => name),
  };
}

const summary: DesktopLibrarySummary = {
  documentId: 'a'.repeat(32),
  fileName: 'fixture.pdf',
  mediaType: 'application/pdf',
  byteLength: 12,
  createdAtMs: 1,
  updatedAtMs: 1,
  status: 'queued',
  stage: 'uploading',
};

const completedOperation: CaptureOperation = {
  captureId: 'capture-1',
  status: 'completed',
  protocolVersion: '2',
  ingestionId: 'ingestion-1',
  kind: 'pdf',
  partialRevision: 0,
  lastEventSequence: 0,
  createdAt: '2026-07-20T00:00:00Z',
  updatedAt: '2026-07-20T00:00:00Z',
  source: {
    sha256: 'a'.repeat(64),
    fileName: 'fixture.pdf',
    mediaType: 'application/pdf',
    bytes: 12,
  },
};
const raw = { sourceText: 'OCR text' };
const result = { targetText: 'translated text' };

/** The library as the host stores it, as far as the admission reads it: status, stage and link. */
function storedDocuments(initial: readonly DesktopLibrarySummary[]) {
  const rows = new Map(initial.map((row) => [row.documentId, row]));
  return {
    rows,
    import: (row: DesktopLibrarySummary) => defer(() => {
      rows.set(row.documentId, row);
      return of(row);
    }),
    list: vi.fn(() => defer(() => of<readonly DesktopLibrarySummary[]>([...rows.values()].reverse()))),
    updateCapture: vi.fn((update: Parameters<DesktopLibraryService['updateCapture']>[0]) => defer(() => {
      const current = rows.get(update.documentId);
      if (!current) return throwError(() => new Error('Capture library document was not found.'));
      const next: DesktopLibrarySummary = {
        ...current,
        status: update.status,
        stage: update.stage,
        captureId: update.clearCaptureId ? undefined : update.captureId ?? current.captureId,
        hasRaw: current.hasRaw === true || update.raw !== undefined,
      };
      rows.set(update.documentId, next);
      return of(next);
    })),
  };
}

function libraryStub(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([])),
    get: vi.fn(() => of<DesktopLibraryDetail>(summary)),
    discardSelections: vi.fn(() => of(undefined)),
    droppedSources: vi.fn((): Observable<DesktopSourceSelectionBatch> => EMPTY),
    importSelection: vi.fn(() => of(summary)),
    updateCapture: vi.fn(() => of(summary)),
  }, overrides);
}

function runtimeStub(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    ready: signal(true),
    started: signal(true),
    error: signal<Error | undefined>(undefined),
    ocrCompute: signal<OcrComputePreflight | null>({
      apiVersion: '2.0',
      schemaVersion: '1',
      service: 'capture-runtime',
      runtimeVersion: RUNTIME_VERSION,
      contractSetVersion: '2',
      contractSetSha256: 'a'.repeat(64),
      workerSha256: 'f'.repeat(64),
      mode: 'gpu',
      adapterClass: 'dedicated',
      reasonCode: null,
      userNoticeRequired: false,
      noticeCode: null,
    }),
    pdfPageNumbers: signal<readonly number[] | undefined>(undefined),
    reload: vi.fn(),
    getComputeStatus: vi.fn(() => of({ cudaAvailable: false, preferGpu: true })),
    getRequirements: vi.fn(() => of([])),
    getModelOptions: vi.fn(() => of([])),
    listInstallations: vi.fn(() => of([])),
    createCapture: vi.fn(() => of(completedOperation)),
    getCapture: vi.fn(() => of(completedOperation)),
    getRaw: vi.fn(() => of(raw)),
    getResult: vi.fn(() => of({ operation: completedOperation, raw, result })),
    getOcr: vi.fn((captureId: string) => of(ocrProjection(captureId))),
    deleteCapture: vi.fn(() => of(undefined)),
    getCaptureEvents: vi.fn(() => of([])),
    getPartial: vi.fn(() => of(null)),
  }, overrides);
}

function ocrProjection(captureId: string): CaptureOcrProjection {
  const provenance = {
    status: 'resolved' as const,
    engine: 'text-recognition' as const,
    model: 'ppocrv6-traditional-multilingual',
    modelDigest: `sha256:${'d'.repeat(64)}`,
    device: 'RTX4060',
    profileId: 'profile-1',
    profileSpecSha256: 'e'.repeat(64),
  };
  return {
    apiVersion: '2.0',
    schemaVersion: '3',
    captureId,
    status: 'completed',
    source: {
      sha256: 'a'.repeat(64),
      fileName: 'fixture.pdf',
      mediaType: 'application/pdf',
      bytes: 12,
    },
    pages: [{
      page: 1,
      status: 'recognized' as const,
      raster: { width: 1200, height: 800, scale: 1, coordinateSystem: 'pixel' as const },
      text: 'OCR text',
      boxes: [{
        polygon: [
          { x: 100, y: 120 },
          { x: 220, y: 120 },
          { x: 220, y: 160 },
          { x: 100, y: 160 },
        ],
        text: 'OCR text',
        confidence: 0.875,
      }],
      confidence: 0.875,
      provenance,
    }],
    processedPageCount: 1,
    runtimeVersion: RUNTIME_VERSION,
    contractSetSha256: 'a'.repeat(64),
    provenance,
    createdAt: '2026-07-20T00:00:00Z',
  };
}

function selection(fileName: string): DesktopSourceSelection {
  return { selectionToken: fileName.padEnd(32, '0'), fileName, byteLength: 16,
    mediaType: fileName.endsWith('.png') ? 'image/png' : fileName.endsWith('.wav') ? 'audio/wav' : 'application/pdf' };
}
