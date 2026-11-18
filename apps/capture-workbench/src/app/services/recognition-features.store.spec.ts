import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  RuntimeInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { of, Subject, throwError } from 'rxjs';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopInstallationService } from './desktop-installation.service';
import { FIRST_RUN_DISMISSED_STORAGE_KEY, RecognitionFeaturesStore } from './recognition-features.store';

describe('RecognitionFeaturesStore removeRequirement', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('uninstalls a ready requirement and reports it not installed before the list reloads', () => {
    const { store, runtime, pending, listed } = createHarness();
    expect(store.ocrReady()).toBe(true);

    store.removeRequirement('windowsml-ocr');
    store.removeRequirement('windowsml-ocr');
    expect(store.isRemoving('windowsml-ocr')).toBe(true);
    expect(runtime.uninstallRequirement).toHaveBeenCalledTimes(1);
    expect(runtime.uninstallRequirement).toHaveBeenCalledWith('windowsml-ocr');

    pending.next(requirement('windowsml-ocr', 'installable', 144_000_000));
    pending.complete();
    TestBed.tick();

    expect(store.isRemoving('windowsml-ocr')).toBe(false);
    expect(store.removalError('windowsml-ocr')).toBeNull();
    expect(requirementStatus(store)).toBe('installable');
    expect(store.ocrReady()).toBe(false);
    expect(runtime.reload).toHaveBeenCalled();

    listed.set([requirement('windowsml-ocr', 'installable', 144_000_000)]);
    store.requirementsResource.reload();
    TestBed.tick();
    expect(requirementStatus(store)).toBe('installable');
    expect(store.ocrReady()).toBe(false);

    store.removeRequirement('windowsml-ocr');
    expect(runtime.uninstallRequirement).toHaveBeenCalledTimes(1);
  });

  it('does not call the runtime while that requirement is installing', () => {
    const { store, runtime, installation } = createHarness();
    installation.installationsByRequirement.set(
      new Map([['windowsml-ocr', runningInstallation('running')]]),
    );

    store.removeRequirement('windowsml-ocr');

    expect(runtime.uninstallRequirement).not.toHaveBeenCalled();
    expect(store.isRemoving('windowsml-ocr')).toBe(false);
    expect(requirementStatus(store)).toBe('ready');
    expect(store.ocrReady()).toBe(true);
  });

  it('keeps the runtime status and shows a readable error when removal is refused', () => {
    const { store, runtime, pending } = createHarness();
    store.removeRequirement('windowsml-ocr');
    pending.error(
      new Error('Capture Runtime request was rejected with HTTP 409.'),
    );
    TestBed.tick();

    expect(store.isRemoving('windowsml-ocr')).toBe(false);
    expect(requirementStatus(store)).toBe('ready');
    expect(store.ocrReady()).toBe(true);
    expect(store.removalError('windowsml-ocr')).toBe(
      '安裝或辨識還在進行，請稍後再移除',
    );
    expect(runtime.reload).not.toHaveBeenCalled();
  });

  it('lets a finished reinstall leave the not-installed overlay', () => {
    const { store, runtime, pending } = createHarness();
    store.removeRequirement('windowsml-ocr');
    pending.next(requirement('windowsml-ocr', 'installable', 144_000_000));
    pending.complete();
    TestBed.tick();
    expect(requirementStatus(store)).toBe('installable');

    store.installRequirement('windowsml-ocr');
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
    requirement('windowsml-ocr', 'ready', 144_000_000),
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
    .find((item) => item.requirementId === 'windowsml-ocr')?.status;
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
    kind: 'runtime',
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
    requirementId: 'windowsml-ocr',
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
            requirementId: 'windowsml-ocr',
            displayName: 'WindowsML OCR',
            status: 'unavailable',
            kind: 'engine',
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
    store.installRequirement('windowsml-ocr');

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
                requirementId: 'windowsml-ocr',
                displayName: 'WindowsML OCR',
                status: 'installable',
                kind: 'engine',
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
                requirementId: 'windowsml-ocr',
                displayName: 'WindowsML OCR',
                status: 'installable',
                kind: 'engine',
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
            requirementId: 'windowsml-ocr',
            displayName: 'WindowsML OCR',
            status: 'installable',
            kind: 'engine',
            requiredFor: ['capture'],
            installStrategy: 'runtime-catalog',
          },
        ])),
        startInstallation,
      }),
    );

    store.installRequirement('windowsml-ocr');
    TestBed.tick();

    expect(startInstallation).toHaveBeenCalledWith({
      clientRequestId: expect.any(String),
      requirementId: 'windowsml-ocr',
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
            kind: 'model',
            requiredFor: ['audio'],
            installStrategy: 'runtime-catalog',
          },
          {
            requirementId: 'windowsml-ocr',
            displayName: 'WindowsML OCR',
            status: 'installable',
            kind: 'engine',
            requiredFor: ['capture'],
            installStrategy: 'runtime-catalog',
          },
        ])),
        startInstallation,
      }),
    );
    store.installRequirements(['speech-recognition', 'windowsml-ocr']);
    TestBed.tick();

    expect(startInstallation.mock.calls.map(([request]) => request.requirementId)).toEqual([
      'windowsml-ocr',
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
      kind: 'engine',
      requiredFor: ['audio'],
      installStrategy: 'runtime-catalog',
      optional: true,
    });
    const store = initializeFeatures(
      runtimeStub({
        getRequirements: vi.fn(() => of([
          requirement('windowsml-ocr', 'installable'),
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
        installationId: 'install-windowsml-ocr',
        requirementId: 'windowsml-ocr' as const,
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
        installationId: 'install-windowsml-ocr',
        requirementId: 'windowsml-ocr' as const,
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
          requirementId: 'windowsml-ocr',
          displayName: 'WindowsML OCR',
          status: 'installable',
          kind: 'engine',
          requiredFor: ['capture'],
          installStrategy: 'runtime-catalog',
        }])),
        startInstallation,
        getInstallation,
      }),
    );

    vi.useFakeTimers();
    try {
      store.installRequirement('windowsml-ocr');
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
              kind: 'engine',
              requiredFor: ['audio'],
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
        requirementId: 'windowsml-ocr' as const,
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
            requirementId: 'windowsml-ocr',
            displayName: 'WindowsML OCR',
            status: 'installable',
            kind: 'engine',
            requiredFor: ['capture'],
            installStrategy: 'runtime-catalog',
          },
          {
            requirementId: 'speech-recognition',
            displayName: 'Speech recognition',
            status: 'installable',
            kind: 'engine',
            requiredFor: ['audio'],
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
      store.installRequirements(['windowsml-ocr', 'speech-recognition']);
      store.cancelInstallation('install-windowsml-ocr');
      vi.advanceTimersByTime(3_000);
      TestBed.tick();

      expect(startInstallation.mock.calls.map(([request]) => request.requirementId)).toEqual([
        'windowsml-ocr',
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
});

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
