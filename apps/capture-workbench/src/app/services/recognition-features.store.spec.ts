import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  RuntimeInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopInstallationService } from './desktop-installation.service';
import { FIRST_RUN_DISMISSED_STORAGE_KEY, RecognitionFeaturesStore } from './recognition-features.store';

describe('RecognitionFeaturesStore removeRequirement', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('uninstalls a ready requirement and reports it not installed before the list reloads', () => {
    const { store, runtime, pending, listed } = createHarness();
    expect(store.ocrReady()).toBe(true);

    store.removeRequirement('text-recognition');
    store.removeRequirement('text-recognition');
    expect(store.isRemoving('text-recognition')).toBe(true);
    expect(runtime.uninstallRequirement).toHaveBeenCalledTimes(1);
    expect(runtime.uninstallRequirement).toHaveBeenCalledWith('text-recognition');

    pending.next(requirement('text-recognition', 'installable', 144_000_000));
    pending.complete();
    TestBed.tick();

    expect(store.isRemoving('text-recognition')).toBe(false);
    expect(store.removalError('text-recognition')).toBeNull();
    expect(requirementStatus(store)).toBe('installable');
    expect(store.ocrReady()).toBe(false);
    expect(runtime.reload).toHaveBeenCalled();

    listed.set([requirement('text-recognition', 'installable', 144_000_000)]);
    store.requirementsResource.reload();
    TestBed.tick();
    expect(requirementStatus(store)).toBe('installable');
    expect(store.ocrReady()).toBe(false);

    store.removeRequirement('text-recognition');
    expect(runtime.uninstallRequirement).toHaveBeenCalledTimes(1);
  });

  it('does not call the runtime while that requirement is installing', () => {
    const { store, runtime, installation } = createHarness();
    installation.installationsByRequirement.set(
      new Map([['text-recognition', runningInstallation('running')]]),
    );

    store.removeRequirement('text-recognition');

    expect(runtime.uninstallRequirement).not.toHaveBeenCalled();
    expect(store.isRemoving('text-recognition')).toBe(false);
    expect(requirementStatus(store)).toBe('ready');
    expect(store.ocrReady()).toBe(true);
  });

  it('keeps the runtime status and shows a readable error when removal is refused', () => {
    const { store, runtime, pending } = createHarness();
    store.removeRequirement('text-recognition');
    pending.error(
      new Error('Capture Runtime request was rejected with HTTP 409.'),
    );
    TestBed.tick();

    expect(store.isRemoving('text-recognition')).toBe(false);
    expect(requirementStatus(store)).toBe('ready');
    expect(store.ocrReady()).toBe(true);
    expect(store.removalError('text-recognition')).toBe(
      '安裝或辨識還在進行，請稍後再移除',
    );
    expect(runtime.reload).not.toHaveBeenCalled();
  });

  it('lets a finished reinstall leave the not-installed overlay', () => {
    const { store, runtime, pending } = createHarness();
    store.removeRequirement('text-recognition');
    pending.next(requirement('text-recognition', 'installable', 144_000_000));
    pending.complete();
    TestBed.tick();
    expect(requirementStatus(store)).toBe('installable');

    store.installRequirement('text-recognition');
    TestBed.tick();

    expect(runtime.startInstallation).toHaveBeenCalled();
    expect(requirementStatus(store)).toBe('ready');
    expect(store.ocrReady()).toBe(true);
  });

  it('returns an empty list without throwing when model options fail to load', () => {
    const { store } = createHarness({
      getModelOptions: vi.fn(() => throwError(() => new Error('model options failed'))),
    });

    expect(store.modelOptionsResource.status()).toBe('error');
    expect(() => store.modelOptions()).not.toThrow();
    expect(store.modelOptions()).toEqual([]);
    expect(store.activeModelOption()).toBeNull();
    expect(store.modelSelectionRequired()).toBe(false);
  });

  it('returns an empty list without throwing when requirements fail to load', () => {
    const { store } = createHarness({
      getRequirements: vi.fn(() => throwError(() => new Error('requirements failed'))),
    });

    expect(store.requirementsResource.status()).toBe('error');
    expect(() => store.requirements()).not.toThrow();
    expect(store.requirements()).toEqual([]);
    expect(store.recognitionRequirements()).toEqual([]);
    expect(store.firstRunInstallableRequirements()).toEqual([]);
    expect(store.ocrReady()).toBe(false);
    expect(store.asrReady()).toBe(false);
  });
});

function createHarness(
  runtimeOverrides: Partial<{
    getRequirements: ReturnType<typeof vi.fn>;
    getModelOptions: ReturnType<typeof vi.fn>;
  }> = {},
) {
  const listed = signal<readonly RuntimeRequirement[]>([
    requirement('text-recognition', 'ready', 144_000_000),
  ]);
  const pending = new Subject<RuntimeRequirement>();
  const runtime = {
    started: signal(true),
    getRequirements: vi.fn(() => of(listed())),
    getModelOptions: vi.fn(() => of([])),
    listInstallations: vi.fn(() => of([])),
    uninstallRequirement: vi.fn(() => pending.asObservable()),
    startInstallation: vi.fn(() => of(runningInstallation('completed'))),
    getInstallation: vi.fn(),
    cancelInstallation: vi.fn(() => of(runningInstallation('cancelled'))),
    reload: vi.fn(),
    ...runtimeOverrides,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopRuntimeClientService, useValue: runtime },
      RecognitionFeaturesStore,
    ],
  });
  const store = TestBed.inject(RecognitionFeaturesStore);
  const installation = TestBed.inject(DesktopInstallationService);
  TestBed.tick();
  return { store, runtime, pending, listed, installation };
}

function requirementStatus(store: RecognitionFeaturesStore): string | undefined {
  return store
    .requirements()
    .find((item) => item.requirementId === 'text-recognition')?.status;
}

function requirement(
  requirementId: RuntimeRequirement['requirementId'],
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

function runningInstallation(
  status: RuntimeInstallation['status'],
): RuntimeInstallation {
  return {
    installationId: 'inst-ocr-1',
    requirementId: 'text-recognition',
    status,
    progress: status === 'completed' ? 1 : 0.4,
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
  };
}

describe('RecognitionFeaturesStore installation', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('retains a terminal model installation identity for UI and Tauri diagnostics', () => {
    const failedInstallation = {
      installationId: 'model-installation-1',
      optionId: 'qwen3.5-0.8b-v1',
      status: 'failed' as const,
      progress: 0.1,
      error: {
        code: 'installation_failed',
        message: 'Runtime model installation failed.',
        stage: 'runtime',
      },
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:01Z',
      completedAt: '2026-07-20T00:00:01Z',
    };
    const startModelInstallation = vi.fn(() => of(failedInstallation));
    const store = initializeFeatures(
      runtimeStub({ startModelInstallation }),
    );
    store.selectModelOption('qwen3.5-0.8b-v1');

    store.installSelectedModel();
    TestBed.tick();

    expect(startModelInstallation).toHaveBeenCalledWith({
      clientRequestId: expect.any(String),
      optionId: 'qwen3.5-0.8b-v1',
      consent: true,
    });
    expect(store.activeModelInstallation()).toEqual(failedInstallation);
    expect(store.installing()).toBe(false);
    expect(store.message()).toContain('installation_failed');
  });

  it('does not offer or start installation for unavailable catalog requirements', () => {
    const startInstallation = vi.fn();
    const store = initializeFeatures(
      runtimeStub({
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'text-recognition',
            displayName: 'Text recognition',
            status: 'unavailable',
            kind: 'text-recognition',
            requiredFor: ['capture'],
            installStrategy: 'none',
            detail: 'No catalog artifact is available.',
          },
        ])),
        startInstallation,
      }),
    );

    expect(store.ocrReady()).toBe(false);
    expect(store.installableRequestedRequirements()).toEqual([]);
    store.installRequirement('text-recognition');

    expect(startInstallation).not.toHaveBeenCalled();
  });

  it('remembers the first-run dismissal choice in localStorage', () => {
    localStorage.removeItem(FIRST_RUN_DISMISSED_STORAGE_KEY);
    try {
      initializeFeatures(
        runtimeStub({
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
            ]),
          ),
        }),
      );
      const features = TestBed.inject(RecognitionFeaturesStore);
      expect(features.showFirstRunCard()).toBe(true);

      features.dismissFirstRun();
      expect(features.showFirstRunCard()).toBe(false);
      expect(localStorage.getItem(FIRST_RUN_DISMISSED_STORAGE_KEY)).toBe('true');

      TestBed.resetTestingModule();
      const reloadedFeatures = initializeFeatures(
        runtimeStub({
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
            ]),
          ),
        }),
      );
      expect(reloadedFeatures.firstRunDismissed()).toBe(true);
      expect(reloadedFeatures.showFirstRunCard()).toBe(false);
    } finally {
      localStorage.removeItem(FIRST_RUN_DISMISSED_STORAGE_KEY);
    }
  });

  it('allows requirement installation while worker-owned OCR preflight is pending', () => {
    const startInstallation = vi.fn((request: { requirementId: string }) =>
      of({
        installationId: `install-${request.requirementId}`,
        requirementId: request.requirementId,
        status: 'completed' as const,
        progress: 1,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
        completedAt: '2026-07-20T00:00:00Z',
      }),
    );
    const store = initializeFeatures(
      runtimeStub({
        ocrCompute: signal(null),
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'text-recognition',
            displayName: 'Text recognition',
            status: 'installable',
            kind: 'text-recognition',
            requiredFor: ['capture'],
            installStrategy: 'runtime-catalog',
          },
        ])),
        startInstallation,
      }),
    );

    store.installRequirement('text-recognition');
    TestBed.tick();

    expect(startInstallation).toHaveBeenCalledWith({
      clientRequestId: expect.any(String),
      requirementId: 'text-recognition',
      consent: true,
    });
  });

  it('installs OCR before Whisper through one sequential consent action', () => {
    const startInstallation = vi.fn((request: { requirementId: string }) =>
      of({
        installationId: `install-${request.requirementId}`,
        requirementId: request.requirementId,
        status: 'completed' as const,
        progress: 1,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
        completedAt: '2026-07-20T00:00:00Z',
      }),
    );
    const store = initializeFeatures(
      runtimeStub({
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'speech-recognition',
            displayName: 'Speech recognition',
            status: 'installable',
            kind: 'speech-recognition',
            requiredFor: ['recording'],
            installStrategy: 'runtime-catalog',
          },
          {
            requirementId: 'text-recognition',
            displayName: 'Text recognition',
            status: 'installable',
            kind: 'text-recognition',
            requiredFor: ['capture'],
            installStrategy: 'runtime-catalog',
          },
        ])),
        startInstallation,
      }),
    );
    store.installRequirements(['speech-recognition', 'text-recognition']);
    TestBed.tick();

    expect(startInstallation.mock.calls.map(([request]) => request.requirementId)).toEqual([
      'text-recognition',
      'speech-recognition',
    ]);
  });

  it('downloads only the speech requirement the user picked, without asking for OCR', () => {
    const startInstallation = vi.fn((request: { requirementId: string }) =>
      of({
        installationId: `install-${request.requirementId}`,
        requirementId: request.requirementId,
        status: 'completed' as const,
        progress: 1,
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
        completedAt: '2026-11-01T00:00:00Z',
      }),
    );
    const requirement = (requirementId: string, status: string) => ({
      requirementId,
      displayName: requirementId,
      status,
      kind: requirementId,
      requiredFor: ['recording'],
      installStrategy: 'runtime-catalog',
      optional: true,
    });
    const store = initializeFeatures(
      runtimeStub({
        getRequirements: vi.fn(() => of([
          requirement('text-recognition', 'installable'),
          requirement('speaker-diarization', 'installable'),
          requirement('speech-recognition', 'installable'),
        ])),
        startInstallation,
      }),
    );

    expect(TestBed.inject(RecognitionFeaturesStore).speechPack().map((item) => item.requirementId)).toEqual([
      'speech-recognition',
      'speaker-diarization',
    ]);
    store.installRequirement('speaker-diarization');
    TestBed.tick();

    expect(startInstallation.mock.calls.map(([request]) => request.requirementId)).toEqual([
      'speaker-diarization',
    ]);
  });

  it('polls queued and running installations until the first terminal status', () => {
    const observedStatuses: string[] = [];
    const startInstallation = vi.fn(() => {
      observedStatuses.push('queued');
      return of({
        installationId: 'install-text-recognition',
        requirementId: 'text-recognition' as const,
        status: 'queued' as const,
        progress: 0,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
      });
    });
    const getInstallation = vi.fn(() => {
      const status = getInstallation.mock.calls.length === 1 ? 'running' : 'completed';
      observedStatuses.push(status);
      return of({
        installationId: 'install-text-recognition',
        requirementId: 'text-recognition' as const,
        status,
        progress: status === 'completed' ? 1 : 0.5,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
        ...(status === 'completed' ? { completedAt: '2026-07-20T00:00:00Z' } : {}),
      });
    });
    const store = initializeFeatures(
      runtimeStub({
        getRequirements: vi.fn(() => of([{
          requirementId: 'text-recognition',
          displayName: 'Text recognition',
          status: 'installable',
          kind: 'text-recognition',
          requiredFor: ['capture'],
          installStrategy: 'runtime-catalog',
        }])),
        startInstallation,
        getInstallation,
      }),
    );

    vi.useFakeTimers();
    try {
      store.installRequirement('text-recognition');
      expect(observedStatuses).toEqual(['queued']);

      vi.advanceTimersByTime(1_500);
      TestBed.tick();

      expect(observedStatuses).toEqual(['queued', 'running', 'completed']);
      expect(getInstallation).toHaveBeenCalledTimes(2);
      expect(store.installing()).toBe(false);
      expect(store.activeInstallation()?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports byte-based progress, cancels a running installation, and retries after cancellation or failure', () => {
    let attempt = 0;
    const startInstallation = vi.fn(() => {
      attempt += 1;
      return of({
        installationId: `install-speech-${attempt}`,
        requirementId: 'speech-recognition' as const,
        status: attempt === 1 ? ('running' as const) : ('completed' as const),
        progress: attempt === 1 ? 0.1 : 1,
        downloadedBytes: attempt === 1 ? 1_400_000_000 : 2_800_000_000,
        downloadBytes: 2_800_000_000,
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
        ...(attempt === 2 ? { completedAt: '2026-11-01T00:00:01Z' } : {}),
      });
    });
    const cancelInstallation = vi.fn((installationId: string) =>
      of({
        installationId,
        requirementId: 'speech-recognition' as const,
        status: 'cancelled' as const,
        progress: 0.5,
        downloadedBytes: 1_400_000_000,
        downloadBytes: 2_800_000_000,
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:01Z',
      }),
    );
    const getInstallation = vi.fn();
    const store = initializeFeatures(
      runtimeStub({
        getRequirements: vi.fn(() =>
          of([
            {
              requirementId: 'speech-recognition',
              displayName: 'Speech recognition',
              status: 'installable',
              kind: 'speech-recognition',
              requiredFor: ['recording'],
              installStrategy: 'runtime-catalog',
              downloadBytes: 2_800_000_000,
            },
          ]),
        ),
        startInstallation,
        cancelInstallation,
        getInstallation,
      }),
    );

    vi.useFakeTimers();
    try {
      store.installRequirement('speech-recognition');
      expect(store.installing()).toBe(true);
      expect(store.installationPercent()).toBe(50);

      store.cancelInstallation('install-speech-1');
      TestBed.tick();

      expect(cancelInstallation).toHaveBeenCalledWith('install-speech-1');
      expect(store.installing()).toBe(false);
      expect(store.installationFor('speech-recognition')?.status).toBe('cancelled');

      vi.advanceTimersByTime(1_500);
      expect(getInstallation).not.toHaveBeenCalled();

      store.retryInstallation('speech-recognition');
      TestBed.tick();

      expect(startInstallation).toHaveBeenCalledTimes(2);
      expect(store.installationFor('speech-recognition')?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the rest of a multi-requirement install when the user cancels', () => {
    const startInstallation = vi.fn((request: { requirementId: string }) =>
      of({
        installationId: `install-${request.requirementId}`,
        requirementId: request.requirementId,
        status: 'running' as const,
        progress: 0.1,
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
      }),
    );
    const cancelInstallation = vi.fn((installationId: string) =>
      of({
        installationId,
        requirementId: 'text-recognition' as const,
        status: 'cancelled' as const,
        progress: 0.1,
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:01Z',
      }),
    );
    const getInstallation = vi.fn();
    const store = initializeFeatures(
      runtimeStub({
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'text-recognition',
            displayName: 'Text recognition',
            status: 'installable',
            kind: 'text-recognition',
            requiredFor: ['capture'],
            installStrategy: 'runtime-catalog',
          },
          {
            requirementId: 'speech-recognition',
            displayName: 'Speech recognition',
            status: 'installable',
            kind: 'speech-recognition',
            requiredFor: ['recording'],
            installStrategy: 'runtime-catalog',
          },
        ])),
        startInstallation,
        cancelInstallation,
        getInstallation,
      }),
    );

    vi.useFakeTimers();
    try {
      store.installRequirements(['text-recognition', 'speech-recognition']);
      store.cancelInstallation('install-text-recognition');
      vi.advanceTimersByTime(3_000);
      TestBed.tick();

      expect(startInstallation.mock.calls.map(([request]) => request.requirementId)).toEqual([
        'text-recognition',
      ]);
      expect(getInstallation).not.toHaveBeenCalled();
      expect(store.installing()).toBe(false);
      expect(store.message()).not.toBe('安裝完成，正在重新檢查。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-attaches to a running installation on startup and resumes polling until completed', () => {
    const running = {
      installationId: 'install-reattach-1',
      requirementId: 'speech-recognition' as const,
      status: 'running' as const,
      progress: 0.25,
      downloadedBytes: 700_000_000,
      downloadBytes: 2_800_000_000,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    };
    const completed = {
      ...running,
      status: 'completed' as const,
      progress: 1,
      downloadedBytes: 2_800_000_000,
      completedAt: '2026-11-01T00:00:02Z',
    };
    const listInstallations = vi.fn(() => of([running]));
    const getInstallation = vi.fn(() => of(completed));

    vi.useFakeTimers();
    try {
      const store = initializeFeatures(
        runtimeStub({
          listInstallations,
          getInstallation,
        }),
      );

      expect(listInstallations).toHaveBeenCalledOnce();
      expect(store.installing()).toBe(true);
      expect(store.activeInstallation()?.installationId).toBe('install-reattach-1');
      expect(store.installationPercent()).toBe(25);

      vi.advanceTimersByTime(750);
      TestBed.tick();

      expect(getInstallation).toHaveBeenCalledWith('install-reattach-1');
      expect(store.installing()).toBe(false);
      expect(store.activeInstallation()?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last known progress with the hint while a status request fails, and clears it on the next answer', () => {
    const running = runningInstallation('running');
    const getInstallation = vi.fn()
      .mockReturnValueOnce(unreadable())
      .mockReturnValueOnce(of(runningInstallation('completed')));
    const store = initializeFeatures(
      runtimeStub({
        getRequirements: vi.fn(() => of([requirement('text-recognition', 'installable', 144_000_000)])),
        startInstallation: vi.fn(() => of(running)),
        getInstallation,
      }),
    );

    vi.useFakeTimers();
    try {
      store.installRequirement('text-recognition');
      vi.advanceTimersByTime(750);

      expect(getInstallation).toHaveBeenCalledTimes(1);
      expect(store.isProgressUnavailable('text-recognition')).toBe(true);
      expect(store.activeInstallation()?.status).toBe('running');
      expect(store.installing()).toBe(true);

      vi.advanceTimersByTime(1_000);
      TestBed.tick();

      expect(getInstallation).toHaveBeenCalledTimes(2);
      expect(store.isProgressUnavailable('text-recognition')).toBe(false);
      expect(store.activeInstallation()?.status).toBe('completed');
      expect(store.installing()).toBe(false);
      expect(store.message()).toBe(desktopMessages().recheck);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling through failures without giving up, with delays capped at 8 s', () => {
    const getInstallation = vi.fn((): Observable<RuntimeInstallation> => unreadable());
    const store = initializeFeatures(
      runtimeStub({
        getRequirements: vi.fn(() => of([requirement('text-recognition', 'installable', 144_000_000)])),
        startInstallation: vi.fn(() => of(runningInstallation('running'))),
        getInstallation,
      }),
    );

    vi.useFakeTimers();
    try {
      store.installRequirement('text-recognition');
      // The first request, retries after 1, 2 and 4 s, then one every 8 s from then on.
      vi.advanceTimersByTime(750 + 1_000 + 2_000 + 4_000 + 8_000 * 20);
      TestBed.tick();

      expect(getInstallation).toHaveBeenCalledTimes(1 + 3 + 20);
      expect(store.installing()).toBe(true);
      expect(store.message()).toBe('');
      expect(store.isProgressUnavailable('text-recognition')).toBe(true);
      expect(store.activeInstallation()?.status).toBe('running');

      getInstallation.mockImplementation(() => of(runningInstallation('completed')));
      vi.advanceTimersByTime(8_000);
      TestBed.tick();

      expect(store.isProgressUnavailable('text-recognition')).toBe(false);
      expect(store.activeInstallation()?.status).toBe('completed');
      expect(store.installing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['still running', 'running', 'completed'],
    ['ended', 'completed', 'completed'],
    ['no longer listed', null, null],
  ] as const)('re-attaches through the list when the runtime no longer knows the installation id (%s)', (_case, listed, final) => {
    const lost = runningInstallation('running');
    const found: RuntimeInstallation = {
      ...runningInstallation(listed ?? 'running'),
      installationId: 'inst-ocr-2',
    };
    const listInstallations = vi.fn()
      .mockReturnValueOnce(of([]))
      .mockReturnValueOnce(of(listed === null ? [] : [found]));
    const getInstallation = vi.fn((installationId: string): Observable<RuntimeInstallation> =>
      installationId === 'inst-ocr-2'
        ? of({ ...found, status: 'completed', progress: 1 })
        : throwError(() => new Error('Capture Runtime request was rejected with HTTP 404.')));
    const store = initializeFeatures(
      runtimeStub({
        getRequirements: vi.fn(() => of([requirement('text-recognition', 'installable', 144_000_000)])),
        startInstallation: vi.fn(() => of(lost)),
        getInstallation,
        listInstallations,
      }),
    );

    vi.useFakeTimers();
    try {
      store.installRequirement('text-recognition');
      vi.advanceTimersByTime(750);
      TestBed.tick();

      expect(listInstallations).toHaveBeenCalledTimes(2);
      if (listed === 'running') {
        expect(store.activeInstallation()?.installationId).toBe('inst-ocr-2');
        expect(store.installing()).toBe(true);
        vi.advanceTimersByTime(750);
        TestBed.tick();
        expect(getInstallation).toHaveBeenLastCalledWith('inst-ocr-2');
      }

      expect(store.installing()).toBe(false);
      expect(store.isProgressUnavailable('text-recognition')).toBe(false);
      expect(store.installationFor('text-recognition')?.status ?? null).toBe(final);
      expect(store.message()).toBe(final === 'completed' ? desktopMessages().recheck : '');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling a failing installation when the user cancels', () => {
    const running = runningInstallation('running');
    const getInstallation = vi.fn((): Observable<RuntimeInstallation> => unreadable());
    const store = initializeFeatures(
      runtimeStub({
        getRequirements: vi.fn(() => of([requirement('text-recognition', 'installable', 144_000_000)])),
        startInstallation: vi.fn(() => of(running)),
        getInstallation,
        cancelInstallation: vi.fn(() => of(runningInstallation('cancelled'))),
      }),
    );

    vi.useFakeTimers();
    try {
      store.installRequirement('text-recognition');
      vi.advanceTimersByTime(750 + 1_000);
      expect(getInstallation).toHaveBeenCalledTimes(2);
      expect(store.isProgressUnavailable('text-recognition')).toBe(true);

      store.cancelInstallation('inst-ocr-1');
      vi.advanceTimersByTime(60_000);
      TestBed.tick();

      expect(getInstallation).toHaveBeenCalledTimes(2);
      expect(store.isProgressUnavailable('text-recognition')).toBe(false);
      expect(store.installing()).toBe(false);
      expect(store.installationFor('text-recognition')?.status).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows each re-attached installation on its own while one keeps failing', () => {
    const textRunning = runningInstallation('running');
    const speechRunning: RuntimeInstallation = {
      ...textRunning,
      installationId: 'inst-speech-1',
      requirementId: 'speech-recognition',
    };
    let textAnswers = false;
    const getInstallation = vi.fn((installationId: string): Observable<RuntimeInstallation> => {
      if (installationId === 'inst-speech-1') {
        return of({ ...speechRunning, status: 'completed', progress: 1 });
      }
      return textAnswers ? of(runningInstallation('completed')) : unreadable();
    });

    vi.useFakeTimers();
    try {
      const store = initializeFeatures(
        runtimeStub({
          listInstallations: vi.fn(() => of([textRunning, speechRunning])),
          getInstallation,
        }),
      );
      // The text recognition job is listed first; its status requests keep failing.
      vi.advanceTimersByTime(750);
      TestBed.tick();

      expect(store.installationFor('speech-recognition')?.status).toBe('completed');
      expect(store.isProgressUnavailable('text-recognition')).toBe(true);
      expect(store.installationFor('text-recognition')?.status).toBe('running');
      expect(store.activeInstallation()?.installationId).toBe('inst-ocr-1');
      expect(store.installing()).toBe(true);

      vi.advanceTimersByTime(1_000 + 2_000 + 4_000 + 8_000 * 5);
      expect(store.installing()).toBe(true);

      textAnswers = true;
      vi.advanceTimersByTime(8_000);
      TestBed.tick();

      expect(store.installationFor('text-recognition')?.status).toBe('completed');
      expect(store.isProgressUnavailable('text-recognition')).toBe(false);
      expect(store.installing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling a model installation through failures with the hint, and clears it on recovery', () => {
    const runningModel = {
      installationId: 'model-inst-1',
      optionId: 'qwen3.5-0.8b-v1',
      status: 'running' as const,
      progress: 0.3,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    };
    const getModelInstallation = vi.fn()
      .mockReturnValueOnce(unreadable())
      .mockReturnValueOnce(unreadable())
      .mockReturnValueOnce(of({ ...runningModel, status: 'completed' as const, progress: 1 }));
    const store = initializeFeatures(
      runtimeStub({
        startModelInstallation: vi.fn(() => of(runningModel)),
        getModelInstallation,
      }),
    );

    vi.useFakeTimers();
    try {
      store.selectModelOption('qwen3.5-0.8b-v1');
      store.installSelectedModel();
      vi.advanceTimersByTime(750 + 1_000);

      expect(getModelInstallation).toHaveBeenCalledTimes(2);
      expect(store.modelProgressUnavailable()).toBe(true);
      expect(store.activeModelInstallation()?.status).toBe('running');

      vi.advanceTimersByTime(2_000);
      TestBed.tick();

      expect(store.modelProgressUnavailable()).toBe(false);
      expect(store.activeModelInstallation()?.status).toBe('completed');
      expect(store.installing()).toBe(false);
      expect(store.message()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the model installation and reloads the options when the runtime no longer knows it', () => {
    const runningModel = {
      installationId: 'model-inst-1',
      optionId: 'qwen3.5-0.8b-v1',
      status: 'running' as const,
      progress: 0.3,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    };
    const getModelOptions = vi.fn(() => of([]));
    const store = initializeFeatures(
      runtimeStub({
        getModelOptions,
        startModelInstallation: vi.fn(() => of(runningModel)),
        getModelInstallation: vi.fn(() =>
          throwError(() => new Error('Capture Runtime request was rejected with HTTP 404.'))),
      }),
    );
    const optionLoads = getModelOptions.mock.calls.length;

    vi.useFakeTimers();
    try {
      store.selectModelOption('qwen3.5-0.8b-v1');
      store.installSelectedModel();
      expect(store.activeModelInstallation()?.status).toBe('running');
      vi.advanceTimersByTime(750);
      TestBed.tick();

      expect(store.activeModelInstallation()).toBeNull();
      expect(store.modelProgressUnavailable()).toBe(false);
      expect(store.installing()).toBe(false);
      expect(store.message()).toBe('');
      expect(getModelOptions.mock.calls.length).toBeGreaterThan(optionLoads);
    } finally {
      vi.useRealTimers();
    }
  });
});

function unreadable(): Observable<never> {
  return throwError(() => new Error('Capture Runtime response could not be read.'));
}

function initializeFeatures(runtime: ReturnType<typeof runtimeStub>): RecognitionFeaturesStore {
  TestBed.configureTestingModule({
    providers: [{ provide: DesktopRuntimeClientService, useValue: runtime }],
  });
  const store = TestBed.inject(RecognitionFeaturesStore);
  store.initialize();
  TestBed.tick();
  return store;
}

function runtimeStub(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    started: signal(true),
    reload: vi.fn(),
    getRequirements: vi.fn(() => of([])),
    getModelOptions: vi.fn(() => of([])),
    listInstallations: vi.fn(() => of([])),
    startInstallation: vi.fn(),
    getInstallation: vi.fn(),
    cancelInstallation: vi.fn(),
    startModelInstallation: vi.fn(),
    getModelInstallation: vi.fn(),
  }, overrides);
}
