import { Router } from '@angular/router';
import { AsrQueueStore } from './asr-queue.store';
import { OcrQueueStore } from './ocr-queue.store';
import { RUNTIME_VERSION } from '@gx-capture/capture-runtime-client';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CaptureOcrProjection } from '@gx-capture/capture-runtime-client';
import type { CaptureOperation, OcrComputePreflight } from '@gx-capture/capture-workbench-ui';
import { EMPTY, of, Subject, throwError } from 'rxjs';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
import { DesktopLibraryService, type DesktopSourceSelection } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopCaptureService } from './desktop-capture.service';
import { DesktopWorkspaceStore } from './desktop-workspace.store';
import {
  FIRST_RUN_DISMISSED_STORAGE_KEY,
  RecognitionFeaturesStore,
} from './recognition-features.store';

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

const completedOperation = operation({
  captureId: 'capture-1',
  status: 'completed',
});
const raw = { sourceText: 'OCR text' };
const result = { targetText: 'translated text' };

describe('DesktopWorkspaceStore', () => {
  it.each(['installable', 'unavailable'] as const)(
    'keeps the shell ready with a %s OCR requirement',
    (status) => {
      const store = initializeStore(
        libraryStub(),
        runtimeStub({
          ...(status === 'installable' ? { ocrCompute: signal(null) } : {}),
          getRequirements: vi.fn(() => of([
            {
              requirementId: 'windowsml-ocr',
              displayName: 'WindowsML OCR',
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

    expect(store.message()).toBe('Bearer [redacted]');
    expect(store.message()).not.toContain('secret-token');
  });

  it('does not require Ollama for OCR readiness', () => {
    const library = libraryStub();
    const client = runtimeStub({
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
      'windowsml-ocr',
    ]);
  });

  it('allows an OCR-ready import when host structuring is unavailable', () => {
    const importSelection = vi.fn(() => of(summary));
    const startInstallation = vi.fn();
    const startModelInstallation = vi.fn();
    const store = initializeStore(
      libraryStub({ importSelection }),
      runtimeStub({
        startInstallation,
        startModelInstallation,
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'windowsml-ocr',
            displayName: 'WindowsML OCR',
            status: 'ready',
            kind: 'engine',
            requiredFor: ['capture'],
            installStrategy: 'none',
          },
          {
            requirementId: 'ollama-runtime',
            displayName: 'Ollama',
            status: 'unavailable',
            kind: 'runtime',
            requiredFor: ['structuring'],
            installStrategy: 'none',
          },
        ])),
        getModelOptions: vi.fn(() => of([{
          optionId: 'qwen3.5-0.8b-v1',
          displayName: 'Qwen 3.5 0.8B',
          modelReference: 'qwen3.5:0.8b',
          expectedDigest: null,
          expectedBytes: null,
          profileId: 'capture-workbench-qwen3.5-0.8b-structure-v1',
          profileSpecSha256: 'b'.repeat(64),
          status: 'not-installed' as const,
        }])),
      }),
    );

    expect(store.state()).toBe('ready');
    expect(TestBed.inject(RecognitionFeaturesStore).ocrReady()).toBe(true);
    expect(TestBed.inject(RecognitionFeaturesStore).requestedMissing()).toEqual([]);

    store.addSelections({ rejected: [], selections: [selection('scan.pdf')] });
    TestBed.tick();

    expect(startInstallation).not.toHaveBeenCalled();
    expect(startModelInstallation).not.toHaveBeenCalled();
    expect(importSelection).toHaveBeenCalledWith(selection('scan.pdf'));
  });

  it('clears the status message once the runtime is ready', () => {
    const store = initializeStore(libraryStub(), runtimeStub());

    expect(store.state()).toBe('ready');
    expect(store.message()).toBe('');
  });

  it('asks for Whisper only when an allowed audio source is selected', () => {
    const library = libraryStub({
      importSelection: vi.fn(() =>
        of({
          ...summary,
          fileName: 'voice.wav',
          mediaType: 'audio/wav',
        }),
      ),
    });
    const client = runtimeStub({
      getRequirements: vi.fn(() => of([{
        requirementId: 'speech-recognition',
        displayName: 'Speech recognition',
        status: 'missing',
        kind: 'model',
        requiredFor: ['audio'],
        installStrategy: 'runtime-catalog',
      }])),
    });
    const store = initializeStore(library, client);

    store.addSelections({ rejected: [], selections: [selection('voice.wav')] });
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
    const startStreamingCapture = vi.fn(() => of(completedOperation));
    const getStreamingResult = vi.fn(() =>
      of({ operation: completedOperation, raw, result }),
    );
    const deleteStreamingCapture = vi.fn(() => of(undefined));
    const startInstallation = vi.fn();
    const library = libraryStub({
      importSelection: vi.fn(() => of(audioDoc)),
      list: vi.fn(() => of([audioDoc])),
      get: vi.fn(() => of(audioDoc as DesktopLibraryDetail)),
    });
    const client = runtimeStub({
      ocrCompute: signal(null),
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
          {
            requirementId: 'speech-recognition',
            displayName: 'Speech recognition',
            status: 'ready',
            kind: 'engine',
            requiredFor: ['audio'],
            installStrategy: 'runtime-catalog',
            downloadBytes: 2_800_000_000,
          },
        ]),
      ),
      startInstallation,
      startStreamingCapture,
      getStreamingResult,
      deleteStreamingCapture,
    });
    const store = initializeStore(library, client);

    expect(store.state()).toBe('ready');
    expect(TestBed.inject(RecognitionFeaturesStore).asrReady()).toBe(true);
    expect(TestBed.inject(RecognitionFeaturesStore).ocrReady()).toBe(false);

    store.addSelections({ rejected: [], selections: [selection('interview.wav')] });
    TestBed.tick();

    expect(startInstallation).not.toHaveBeenCalled();
    expect(TestBed.inject(RecognitionFeaturesStore).requestedRequirements().has('windowsml-ocr')).toBe(false);
    expect(startStreamingCapture).toHaveBeenCalledOnce();
  });

  it('streams a newly imported recording before the library list includes it', () => {
    const audioDoc: DesktopLibrarySummary = {
      ...summary,
      fileName: 'interview.wav',
      mediaType: 'audio/wav',
    };
    const startStreamingCapture = vi.fn(() => of(completedOperation));
    const createCapture = vi.fn(() => of(completedOperation));
    const library = libraryStub({
      importSelection: vi.fn(() => of(audioDoc)),
      list: vi.fn(() => of([])),
      get: vi.fn(() => of(audioDoc as DesktopLibraryDetail)),
    });
    const client = runtimeStub({
      getRequirements: vi.fn(() =>
        of([
          {
            requirementId: 'speech-recognition',
            displayName: 'Speech recognition',
            status: 'ready',
            kind: 'engine',
            requiredFor: ['audio'],
            installStrategy: 'runtime-catalog',
            downloadBytes: 2_800_000_000,
          },
        ]),
      ),
      startStreamingCapture,
      createCapture,
      getStreamingResult: vi.fn(() => of({ operation: completedOperation, raw, result })),
      deleteStreamingCapture: vi.fn(() => of(undefined)),
    });
    const store = initializeStore(library, client);

    store.addSelections({ rejected: [], selections: [selection('interview.wav')] });
    TestBed.tick();

    expect(startStreamingCapture).toHaveBeenCalledOnce();
    expect(createCapture).not.toHaveBeenCalled();
  });

  it('remembers the first-run dismissal choice in localStorage', () => {
    localStorage.removeItem(FIRST_RUN_DISMISSED_STORAGE_KEY);
    try {
      initializeStore(
        libraryStub(),
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
      const reloadedStore = initializeStore(
        libraryStub(),
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
      const reloadedFeatures = TestBed.inject(RecognitionFeaturesStore);
      expect(reloadedFeatures.firstRunDismissed()).toBe(true);
      expect(reloadedFeatures.showFirstRunCard()).toBe(false);
      expect(reloadedStore.state()).toBe('ready');
    } finally {
      localStorage.removeItem(FIRST_RUN_DISMISSED_STORAGE_KEY);
    }
  });

  it('routes native drop batches to OCR on /ocr, ASR on /asr, and imports them on history', () => {
    const dropped = new Subject<{ selections: readonly DesktopSourceSelection[]; rejected: [] }>();
    const ocrQueue = { importSelections: vi.fn() };
    const asrQueue = { importSelections: vi.fn() };
    const router = { url: '/ocr' };
    TestBed.configureTestingModule({ providers: [
      { provide: Router, useValue: router },
      { provide: OcrQueueStore, useValue: ocrQueue },
      { provide: AsrQueueStore, useValue: asrQueue },
    ] });
    const library = libraryStub({ droppedSources: vi.fn(() => dropped) });
    initializeStore(library, runtimeStub());
    const batch = { selections: [selection('chosen.pdf')], rejected: [] as [] };
    dropped.next(batch);
    expect(ocrQueue.importSelections).toHaveBeenCalledWith(batch);
    expect(library.importSelection).not.toHaveBeenCalled();
    router.url = '/asr';
    const recordingBatch = { selections: [selection('chosen.wav')], rejected: [] as [] };
    dropped.next(recordingBatch);
    expect(asrQueue.importSelections).toHaveBeenCalledWith(recordingBatch);
    expect(library.importSelection).not.toHaveBeenCalled();
    router.url = '/history';
    dropped.next(batch);
    expect(library.importSelection).toHaveBeenCalledWith(batch.selections[0]);
  });

  it('imports the entire batch before waiting for the first capture', () => {
    const pending = new Subject<CaptureOperation>();
    const imported = vi.fn((input: DesktopSourceSelection) => of({
      ...summary, documentId: input.fileName === 'first.pdf' ? '1'.repeat(32) : '2'.repeat(32),
    }));
    const createCapture = vi.fn(() => pending);
    const store = initializeStore(libraryStub({ importSelection: imported }), runtimeStub({ createCapture }));
    store.addSelections({ selections: [selection('first.pdf'), selection('second.pdf')], rejected: [] });
    TestBed.tick();
    expect(imported).toHaveBeenCalledTimes(2);
    expect(createCapture).toHaveBeenCalledTimes(1);
    // The second document waits for its turn: nothing else may start it.
    const lifecycle = TestBed.inject(DesktopCaptureService);
    expect(lifecycle.hasActiveCapture('2'.repeat(32))).toBe(true);
    pending.complete();
  });

  it('starts the next document of a batch when the previous capture ends, and then holds none', () => {
    const captures = [new Subject<CaptureOperation>(), new Subject<CaptureOperation>()];
    const imported = vi.fn((input: DesktopSourceSelection) => of({
      ...summary, documentId: input.fileName === 'first.pdf' ? '1'.repeat(32) : '2'.repeat(32),
    }));
    let started = 0;
    const createCapture = vi.fn(() => captures[started++]);
    const store = initializeStore(libraryStub({ importSelection: imported }), runtimeStub({ createCapture }));
    const lifecycle = TestBed.inject(DesktopCaptureService);
    store.addSelections({ selections: [selection('first.pdf'), selection('second.pdf')], rejected: [] });
    TestBed.tick();
    expect(createCapture).toHaveBeenCalledTimes(1);
    captures[0].complete();
    TestBed.tick();
    expect(createCapture).toHaveBeenCalledTimes(2);
    captures[1].complete();
    TestBed.tick();
    expect(lifecycle.hasActiveCapture('1'.repeat(32))).toBe(false);
    expect(lifecycle.hasActiveCapture('2'.repeat(32))).toBe(false);
  });

  it('discards a refused batch when the runtime is unavailable', () => {
    const library = libraryStub();
    const runtime = runtimeStub();
    const store = initializeStore(library, runtime);
    runtime.ready.set(false);
    store.addSelections({ selections: [selection('first.pdf')], rejected: [] });
    expect(library.discardSelections).toHaveBeenCalledWith([selection('first.pdf')]);
  });

  it('refreshes the selected document after processing and runtime ID updates', () => {
    const pendingCapture = new Subject<CaptureOperation>();
    const list = vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary]));
    const store = initializeStore(
      libraryStub({ list }),
      runtimeStub({ createCapture: vi.fn(() => pendingCapture) }),
    );
    store.select(summary.documentId);
    TestBed.tick();
    const beforeCapture = list.mock.calls.length;

    store.addSelections({ rejected: [], selections: [selection(summary.fileName)] });
    TestBed.tick();

    expect(list.mock.calls.length).toBeGreaterThan(beforeCapture);
    pendingCapture.complete();
  });
});

function initializeStore(
  library: ReturnType<typeof libraryStub>,
  client: ReturnType<typeof runtimeStub>,
): DesktopWorkspaceStore {
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: client },
      DesktopWorkspaceStore,
    ],
  });
  const store = TestBed.inject(DesktopWorkspaceStore);
  store.initialize();
  TestBed.tick();
  return store;
}

function libraryStub(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([])),
    get: vi.fn(() => of<DesktopLibraryDetail>(summary)),
    discardSelections: vi.fn(() => of(undefined)),
    selectSources: vi.fn(() => of({ selections: [], rejected: [] })),
    droppedSources: vi.fn(() => EMPTY),
    importSelection: vi.fn(() => of(summary)),
    updateCapture: vi.fn(() => of(summary)),
    export: vi.fn(),
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
      contractSha256: 'a'.repeat(64),
      workerSha256: 'f'.repeat(64),
      mode: 'gpu-dml',
      adapterClass: 'dedicated',
      reasonCode: null,
      userNoticeRequired: false,
      noticeCode: null,
    }),
    pdfPageNumbers: signal<readonly number[] | undefined>(undefined),
    reload: vi.fn(),
    getComputeStatus: vi.fn(() => of({ cudaAvailable: false, preferGpu: true })),
    setPreferGpu: vi.fn(),
    getRequirements: vi.fn(() => of([])),
    getModelOptions: vi.fn(() => of([])),
    listInstallations: vi.fn(() => of([])),
    createCapture: vi.fn(() => of(completedOperation)),
    getCapture: vi.fn(() => of(completedOperation)),
    getRaw: vi.fn(() => of(raw)),
    getResult: vi.fn(() => of(result)),
    getOcr: vi.fn((captureId: string) => of(ocrProjection(captureId, 'completed'))),
    deleteCapture: vi.fn(() => of(undefined)),
  }, overrides);
}

function operation(input: Record<string, unknown>): CaptureOperation {
  return {
    protocolVersion: '2',
    ingestionId: 'ingestion-1',
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
    ...input,
  } as unknown as CaptureOperation;
}

function ocrProjection(
  captureId: string,
  status: 'completed' | 'failed',
): CaptureOcrProjection {
  const provenance = {
    status: 'resolved' as const,
    engine: 'windowsml-ocr' as const,
    model: 'ppocrv6-traditional-multilingual',
    modelDigest: `sha256:${'d'.repeat(64)}`,
    device: 'RTX4060',
    profileId: 'profile-1',
    profileSpecSha256: 'e'.repeat(64),
  };
  const page = status === 'completed'
    ? {
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
    }
    : {
      page: 1,
      status: 'failed' as const,
      raster: { width: 1200, height: 800, scale: 1, coordinateSystem: 'pixel' as const },
      provenance,
      failure: { code: 'ocr_worker_failed', message: 'worker failed' },
    };
  return {
    apiVersion: '2.0',
    schemaVersion: '3',
    captureId,
    status,
    source: {
      sha256: 'a'.repeat(64),
      fileName: 'fixture.pdf',
      mediaType: 'application/pdf',
      bytes: 12,
    },
    pages: [page],
    pageCount: 1,
    runtimeVersion: RUNTIME_VERSION,
    contractSha256: 'a'.repeat(64),
    provenance,
    ...(status === 'failed'
      ? { failure: { code: 'ocr_worker_failed', message: 'worker failed' } }
      : {}),
    createdAt: '2026-07-20T00:00:00Z',
  } as CaptureOcrProjection;
}

function selection(fileName: string): DesktopSourceSelection {
  return { selectionToken: fileName.padEnd(32, '0'), fileName, byteLength: 16,
    mediaType: fileName.endsWith('.png') ? 'image/png' : fileName.endsWith('.wav') ? 'audio/wav' : 'application/pdf' };
}
