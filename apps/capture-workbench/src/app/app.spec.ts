import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  withComponentInputBinding,
} from '@angular/router';
import type {
  CaptureRequirementId,
  RuntimeInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { App } from './app';
import { appRoutes } from './app.routes';
import { HistoryPage } from './history/history-page';
import { setDesktopLocale } from './i18n/desktop-messages';
import {
  isFeatureReady,
  type RecognitionFeature,
  selectFeatureMissing,
  selectInstallableRequirements,
  selectRecognitionEngines,
  selectSpeechPack,
} from './services/desktop-workspace.selectors';
import { DesktopWorkspaceStore } from './services/desktop-workspace.store';
import { RecognitionFeaturesStore } from './services/recognition-features.store';

describe('App shell and recognition pages', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('starts the workspace once and lists the four pages in Traditional Chinese', async () => {
    const { fixture, store } = await renderShell('/');

    expect(store.initialize).toHaveBeenCalledTimes(1);
    const links = [
      ...fixture.nativeElement.querySelectorAll('[data-testid="shell-nav"] a'),
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
        makeRequirement('windowsml-ocr', 'installable', 144_000_000),
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
        'windowsml-ocr',
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
    expect(page.querySelector('a[href="/history"]')).toBeNull();

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
    expect(features.installUnit).toHaveBeenCalledWith('speech-recognition');

    features.requirements.set([
      makeRequirement('speech-recognition', 'ready', 2_800_000_000),
      makeRequirement('speaker-diarization', 'installable', 300_000_000),
    ]);
    fixture.detectChanges();

    expect(page.querySelector('[data-testid="asr-install-panel"]')).toBeNull();
    const link = page.querySelector('a[href="/history"]');
    expect(link?.textContent?.trim()).toBe('前往紀錄加入錄音');
  });

  it('redirects /settings to /settings/engines and renders expandable recognition engine rows with install, cancel, and retry actions', async () => {
    const { fixture, features } = await renderShell('/settings', {
      requirements: [
        makeRequirement('windowsml-ocr', 'ready', 144_000_000),
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
      '[data-testid="engine-row"][data-requirement-id="windowsml-ocr"]',
    ) as HTMLElement;
    expect(
      ocrRow.querySelector('[data-testid="engine-row-remove"]')?.textContent?.trim(),
    ).toBe('移除');

    const headers = [
      ...page.querySelectorAll('[data-testid="engines-table"] thead th'),
    ].map((th) => th.textContent?.trim());
    expect(headers).toEqual(['功能', '狀態', '大小', '用途', '動作']);

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

  it('keeps the existing workspace on the history route and sends unknown paths home', async () => {
    expect(appRoutes.find((route) => route.path === 'history')?.component).toBe(
      HistoryPage,
    );
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
    expect(status().textContent).toContain('尚未就緒');

    store.state.set('ready');
    fixture.detectChanges();
    expect(status().dataset['state']).toBe('ready');
    expect(status().textContent).toContain('已就緒');
  });
});

const FIRST_RUN_UNIT_IDS: readonly CaptureRequirementId[] = [
  'windowsml-ocr',
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
    kind: 'runtime',
    requiredFor: ['capture'],
    installStrategy: 'automatic',
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
      makeRequirement('windowsml-ocr', 'ready', 144_000_000),
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
    installations,
    installing,
    firstRunDismissed,
    engines: computed(() => selectRecognitionEngines(requirements())),
    speechPack: computed(() => selectSpeechPack(requirements())),
    firstRunInstallableUnits: computed(() =>
      selectInstallableRequirements(requirements(), FIRST_RUN_UNIT_IDS),
    ),
    showFirstRunCard: computed(
      () =>
        !firstRunDismissed() &&
        selectInstallableRequirements(requirements(), FIRST_RUN_UNIT_IDS).length > 0,
    ),
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
    installUnit: vi.fn(),
    installUnits: vi.fn(),
    installFirstRunSelection: vi.fn(),
    isRemoving: () => false,
    removalError: () => null,
    removeUnit: vi.fn(),
    cancelInstallation: vi.fn(),
    retryInstallation: vi.fn(),
    dismissFirstRun: vi.fn(() => {
      firstRunDismissed.set(true);
    }),
  };

  const store = {
    state: signal<'starting' | 'ready' | 'error'>('starting'),
    initialize: vi.fn(),
    allDocuments: signal([]),
    refreshDocuments: () => undefined,
  };

  await TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes, withComponentInputBinding()),
      { provide: DesktopWorkspaceStore, useValue: store },
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
