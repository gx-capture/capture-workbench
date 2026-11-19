import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RUNTIME_VERSION } from '@gx-capture/capture-runtime-client';
import type { OcrComputePreflight } from '@gx-capture/capture-workbench-ui';
import { of, throwError } from 'rxjs';
import type { DesktopLibrarySummary } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { LibraryStore } from './library.store';
import { RecognitionFeaturesStore } from './recognition-features.store';
import { RuntimeStatusStore } from './runtime-status.store';
import { SpeechGpuSettingsStore } from './speech-gpu-settings.store';

describe('RuntimeStatusStore', () => {
  it.each(['installable', 'unavailable'] as const)(
    'keeps the shell ready with a %s OCR requirement',
    (status) => {
      const store = initializeStore(
        libraryStub(),
        runtimeStub({
          ...(status === 'installable' ? { ocrCompute: signal(null) } : {}),
          getRequirements: vi.fn(() => of([
            {
              requirementId: 'text-recognition',
              displayName: 'Text recognition',
              status,
              kind: 'engine',
              requiredFor: ['capture'],
              installStrategy: status === 'installable' ? 'runtime-catalog' : 'none',
              ...(status === 'unavailable' ? { detail: 'No catalog artifact is available.' } : {}),
            },
          ])),
        }),
      );

      expect(store.state()).toBe('ready');
    },
  );

  it('redacts bearer credentials from runtime errors shown to the host UI', () => {
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        getRequirements: vi.fn(() =>
          throwError(() => new Error('Bearer secret-token')),
        ),
      }),
    );

    expect(store.state()).toBe('error');
    expect(store.message()).toBe('Bearer [redacted]');
    expect(store.message()).not.toContain('secret-token');
  });

  it('does not require Ollama for OCR readiness', () => {
    const library = libraryStub();
    const client = runtimeStub({
      getRequirements: vi.fn(() => of([
        {
          requirementId: 'text-recognition',
          displayName: 'Text recognition',
          status: 'installable',
          kind: 'engine',
          requiredFor: ['capture'],
          installStrategy: 'runtime-catalog',
        },
        {
          requirementId: 'ollama-runtime',
          displayName: 'Ollama',
          status: 'missing',
          kind: 'runtime',
          requiredFor: ['structuring'],
          installStrategy: 'winget',
        },
      ])),
    });

    const store = initializeStore(library, client);

    expect(store.state()).toBe('ready');
    expect(TestBed.inject(RecognitionFeaturesStore).missingFor('ocr').map((item) => item.requirementId)).toEqual([
      'text-recognition',
    ]);
  });

  it('clears the status message once the runtime is ready', () => {
    const runtime = runtimeStub();
    runtime.started.set(false);
    const store = initializeStore(libraryStub(), runtime);

    expect(store.state()).toBe('starting');
    expect(store.message()).toBe(desktopMessages().starting);

    runtime.started.set(true);
    TestBed.tick();

    expect(store.state()).toBe('ready');
    expect(store.message()).toBe('');
  });

  it('uses runtime, requirements, list, and selected-detail errors in precedence order', () => {
    const runtimeError = signal<Error | undefined>(undefined);
    const requirementsError = signal<Error | undefined>(undefined);
    const listError = signal<Error | undefined>(undefined);
    const detailError = signal<Error | undefined>(undefined);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DesktopRuntimeClientService,
          useValue: { error: runtimeError, started: signal(true) },
        },
        {
          provide: RecognitionFeaturesStore,
          useValue: {
            requirementsResource: { error: requirementsError, status: () => 'resolved' },
            message: signal(''),
          },
        },
        { provide: LibraryStore, useValue: { listError, detailError } },
        { provide: SpeechGpuSettingsStore, useValue: { error: signal(null) } },
      ],
    });
    const store = TestBed.inject(RuntimeStatusStore);

    detailError.set(new Error('selected detail failed'));
    TestBed.tick();
    expect(store.state()).toBe('ready');
    expect(store.message()).toBe('selected detail failed');

    listError.set(new Error('library list failed'));
    TestBed.tick();
    expect(store.state()).toBe('error');
    expect(store.message()).toBe('library list failed');

    requirementsError.set(new Error('requirements failed'));
    TestBed.tick();
    expect(store.message()).toBe('requirements failed');

    runtimeError.set(new Error('runtime failed'));
    TestBed.tick();
    expect(store.message()).toBe('runtime failed');
  });
});

function initializeStore(
  library: ReturnType<typeof libraryStub>,
  client: ReturnType<typeof runtimeStub>,
): RuntimeStatusStore {
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: client },
    ],
  });
  const store = TestBed.inject(RuntimeStatusStore);
  store.reload();
  TestBed.tick();
  return store;
}

function libraryStub() {
  return { list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([])) };
}

function runtimeStub(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    started: signal(true),
    error: signal<Error | undefined>(undefined),
    ocrCompute: signal<OcrComputePreflight | null>({
      apiVersion: '2.0',
      schemaVersion: '1',
      service: 'capture-runtime',
      runtimeVersion: RUNTIME_VERSION,
      contractSetVersion: '2',
      contractSha256: 'a'.repeat(64),
      workerSha256: 'f'.repeat(64),
      mode: 'gpu',
      adapterClass: 'dedicated',
      reasonCode: null,
      userNoticeRequired: false,
      noticeCode: null,
    }),
    reload: vi.fn(),
    getComputeStatus: vi.fn(() => of({ cudaAvailable: false, preferGpu: true })),
    getRequirements: vi.fn(() => of([])),
    getModelOptions: vi.fn(() => of([])),
    listInstallations: vi.fn(() => of([])),
  }, overrides);
}
