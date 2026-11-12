import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { RuntimeInstallation, RuntimeRequirement } from '@gx-capture/capture-workbench-ui';
import { of, Subject } from 'rxjs';
import type { DesktopCaptureOptions, DesktopLibrarySummary } from '../contracts';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import { CaptureQueueStore } from './capture-queue.store';
import { DesktopLibraryService, type DesktopSourceSelection } from './desktop-library.service';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceCaptureService } from './desktop-workspace-capture.service';
import { isFeatureReady, type RecognitionFeature } from './desktop-workspace.selectors';
import { DesktopWorkspaceStore } from './desktop-workspace.store';
import { RecognitionFeaturesStore } from './recognition-features.store';

describe('CaptureQueueStore', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('keeps an imported file waiting while OCR is missing, then starts it when install finishes', async () => {
    const harness = configure({ ocrReady: false });
    harness.store.attach();
    TestBed.tick();

    harness.store.pageCountText.set('3');
    harness.store.importSelections({ rejected: [], selections: [selection('charge.pdf')] });
    TestBed.tick();

    expect(harness.library.importSelection).toHaveBeenCalledWith(
      selection('charge.pdf'),
      { pdfPageCount: 3 },
    );
    expect(harness.rows()[0]?.userStatus).toBe('waiting');
    expect(harness.rows()[0]?.needsInstall).toBe(true);
    expect(harness.runtime.createCapture).not.toHaveBeenCalled();

    harness.requirements.set([requirement('ready')]);
    TestBed.tick();
    await settle();

    expect(harness.runtime.createCapture).toHaveBeenCalledWith(
      'b'.repeat(32),
      expect.any(String),
      [1, 2, 3],
    );
  });

  it('starts a file at once when OCR is already ready', async () => {
    const harness = configure({ ocrReady: true });
    harness.store.attach();
    TestBed.tick();

    harness.store.importSelections({ rejected: [], selections: [selection('charge.pdf')] });
    TestBed.tick();
    await settle();

    expect(harness.runtime.createCapture).toHaveBeenCalledWith(
      'b'.repeat(32),
      expect.any(String),
      undefined,
    );
    expect(harness.rows()[0]?.userStatus).toBe('processing');
  });

  it('imports a valid image and refuses an unsupported file and an invalid page count', async () => {
    const harness = configure({ ocrReady: false });
    harness.store.attach();
    TestBed.tick();

    harness.store.pageCountText.set('0');
    harness.store.importSelections({ rejected: [], selections: [
      selection('notes.txt'),
      selection('range.pdf'),
      selection('scan.png'),
    ] });
    TestBed.tick();

    expect(harness.store.importError()).toContain('(1)');
    expect(harness.store.importError()).not.toContain('notes.txt');
    expect(harness.store.importError()).toContain(desktopMessages().ocrPageCountInvalid);
    expect(harness.library.importSelection).toHaveBeenCalledTimes(1);
    expect(harness.library.importSelection).toHaveBeenCalledWith(selection('scan.png'), undefined);
    expect(harness.library.discardSelections).toHaveBeenCalledWith([
      selection('notes.txt'), selection('range.pdf'),
    ]);
    expect(harness.rows().map((row) => row.fileName)).toEqual(['scan.png']);
  });

  it('cancels a running capture', async () => {
    const harness = configure({ ocrReady: true });
    harness.store.attach();
    TestBed.tick();
    harness.store.importSelections({ rejected: [], selections: [selection('charge.pdf')] });
    TestBed.tick();
    await settle();

    harness.store.cancel('b'.repeat(32));
    // The upload was still running, so its native cancel is asked for first.
    expect(harness.runtime.cancelUpload).toHaveBeenCalledTimes(1);
    // If the capture is created anyway, it is cancelled through the runtime.
    harness.created.next(runningJob());
    await settle();

    expect(harness.runtime.cancelCapture).toHaveBeenCalledWith('capture-1');
  });

  it('retries a failed file and restarts a file whose runtime job is gone', async () => {
    const harness = configure({ ocrReady: true });
    harness.docs.push(doc({ status: 'failed', documentId: 'c'.repeat(32), fileName: 'failed.pdf' }));
    harness.docs.push(doc({
      status: 'recovery_required',
      documentId: 'd'.repeat(32),
      fileName: 'lost.pdf',
      captureId: 'capture-lost',
      recoveryCode: 'capture_recovery_required',
    }));
    harness.store.attach();
    TestBed.tick();
    await settle();

    harness.store.retry('c'.repeat(32));
    await settle();
    expect(harness.runtime.createCapture).toHaveBeenCalledWith(
      'c'.repeat(32),
      expect.any(String),
      undefined,
    );
    expect(harness.runtime.getCapture).not.toHaveBeenCalled();

    harness.runtime.createCapture.mockClear();
    harness.store.restart('d'.repeat(32));
    await settle();

    expect(harness.library.updateCapture).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'd'.repeat(32),
      status: 'queued',
      clearCaptureId: true,
    }));
    expect(harness.runtime.getCapture).not.toHaveBeenCalled();
    expect(harness.runtime.createCapture).toHaveBeenCalledWith(
      'd'.repeat(32),
      expect.any(String),
      undefined,
    );
  });

  it('shows page progress from the live capture job', async () => {
    const harness = configure({ ocrReady: true, job: runningJob() });
    harness.store.attach();
    TestBed.tick();
    harness.store.importSelections({ rejected: [], selections: [selection('charge.pdf')] });
    TestBed.tick();

    expect(harness.rows()[0]?.userStatus).toBe('processing');
    expect(harness.rows()[0]?.progressText).toContain('第 9/12 頁');
    expect(harness.rows()[0]?.pageLabel).toBe('12');
  });

  it('drops a document the workspace deletes and lists one the workspace imports', async () => {
    const docs: DesktopLibrarySummary[] = [
      doc({ documentId: 'a'.repeat(32), fileName: 'kept.pdf', status: 'queued' }),
    ];
    const library = {
      discardSelections: vi.fn(() => of(undefined)),
      list: vi.fn(() => of([...docs])),
      get: vi.fn((documentId: string) => of(
        docs.find((item) => item.documentId === documentId) ?? docs[0],
      )),
      importSelection: vi.fn((selectionTokenInput: DesktopSourceSelection) => {
        const fileName = selectionTokenInput.fileName;
        const summary = doc({
          documentId: 'b'.repeat(32),
          fileName,
          mediaType: 'image/png',
          status: 'queued',
        });
        docs.unshift(summary);
        return of(summary);
      }),
      delete: vi.fn((documentId: string) => {
        const index = docs.findIndex((item) => item.documentId === documentId);
        if (index >= 0) docs.splice(index, 1);
        return of(undefined);
      }),
      updateCapture: vi.fn(() => of(docs[0])),
      droppedSources: vi.fn(() => of({ selections: [], rejected: [] })),
      selectSources: vi.fn(() => of({ selections: [], rejected: [] })),
    };
    const requirements = signal<readonly RuntimeRequirement[]>([requirement('installable')]);
    const runtime = {
      started: signal(true),
      ready: signal(true),
      error: signal<Error | undefined>(undefined),
      pdfPageNumbers: signal<readonly number[] | undefined>(undefined),
      ocrCompute: signal(null),
      reload: vi.fn(),
      getComputeStatus: vi.fn(() => of({ cudaAvailable: false, preferGpu: true })),
      getRequirements: vi.fn(() => of([...requirements()])),
      getModelOptions: vi.fn(() => of([])),
      createCapture: vi.fn(() => new Subject<DesktopCaptureOperation>()),
      getCapture: vi.fn(() => new Subject<DesktopCaptureOperation>()),
      cancelCapture: vi.fn(() => new Subject<DesktopCaptureOperation>()),
      getRaw: vi.fn(() => of(null)),
      getOcr: vi.fn(() => new Subject()),
      deleteCapture: vi.fn(() => of(undefined)),
      getResult: vi.fn(() => of(null)),
    };
    const features = {
      installing: signal(false),
      activeInstallation: signal<RuntimeInstallation | null>(null),
      activeModelInstallation: signal(null),
      installationPercent: signal(0),
      modelInstallationPercent: signal(0),
      modelInstallationPhase: signal(null),
      selectedModelOptionId: signal(null),
      requestedRequirements: signal(new Set<string>()),
      requirements,
      requirementsResource: {
        error: () => undefined,
        status: () => 'resolved' as const,
        value: requirements,
      },
      ocrReady: signal(false),
      asrReady: signal(false),
      speakersReady: signal(false),
      engines: signal([]),
      speechPack: signal(null),
      requestedMissing: signal([]),
      installableRequestedRequirements: signal([]),
      modelSelectionRequired: signal(false),
      activeModelOption: signal(null),
      message: signal(''),
      isFeatureReady: () => false,
      initialize: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopLibraryService, useValue: library },
        { provide: DesktopRuntimeClientService, useValue: runtime },
        { provide: RecognitionFeaturesStore, useValue: features },
        DesktopWorkspaceStore,
        DesktopWorkspaceCaptureService,
        CaptureQueueStore,
      ],
    });
    const workspace = TestBed.inject(DesktopWorkspaceStore);
    const queue = TestBed.inject(CaptureQueueStore);
    queue.attach();
    TestBed.tick();

    expect(queue.rows().map((row) => row.fileName)).toEqual(['kept.pdf']);

    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    workspace.delete('a'.repeat(32));
    TestBed.tick();
    expect(queue.rows().map((row) => row.fileName)).toEqual([]);

    workspace.addSelections({ rejected: [], selections: [selection('added.png')] });
    TestBed.tick();
    expect(queue.rows().map((row) => row.fileName)).toEqual(['added.png']);
    confirm.mockRestore();
  });
});

function configure(options: { readonly ocrReady: boolean; readonly job?: DesktopCaptureOperation }) {
  const docs: DesktopLibrarySummary[] = [];
  const documents = signal<readonly DesktopLibrarySummary[]>([]);
  const created = new Subject<DesktopCaptureOperation>();
  const requirements = signal<readonly RuntimeRequirement[]>([
    requirement(options.ocrReady ? 'ready' : 'installable'),
  ]);
  const refreshDocuments = (): void => {
    documents.set([...docs]);
  };
  const library = {
    list: vi.fn(() => of([...docs])),
    discardSelections: vi.fn(() => of(undefined)),
    importSelection: vi.fn((input: DesktopSourceSelection, captureOptions?: DesktopCaptureOptions) => {
      const fileName = input.fileName;
      const summary = doc({ fileName, mediaType: input.mediaType,
        ...(captureOptions ? { captureOptions } : {}),
        documentId: fileName === 'scan.png' ? 'e'.repeat(32) : 'b'.repeat(32),
      });
      docs.unshift(summary);
      return of(summary);
    }),
    get: vi.fn(() => of(docs[0])),
    updateCapture: vi.fn((update: {
      readonly documentId: string;
      readonly status: DesktopLibrarySummary['status'];
      readonly clearCaptureId?: boolean;
      readonly captureId?: string;
      readonly stage?: string;
    }) => {
      const index = docs.findIndex((item) => item.documentId === update.documentId);
      const current = index >= 0 ? docs[index] : undefined;
      const next: DesktopLibrarySummary = {
        ...(current ?? doc({ documentId: update.documentId })),
        status: update.status,
        ...(update.stage === undefined ? {} : { stage: update.stage }),
        ...(update.clearCaptureId
          ? { captureId: undefined }
          : update.captureId
            ? { captureId: update.captureId }
            : {}),
      };
      if (index >= 0) docs[index] = next;
      else docs.unshift(next);
      return of(next);
    }),
  };
  const runtime = {
    started: signal(true),
    ready: signal(true),
    pdfPageNumbers: signal<readonly number[] | undefined>(undefined),
    ocrCompute: signal(null),
    createCapture: vi.fn(() => options.job ? of(options.job) : created),
    getCapture: vi.fn(() => new Subject<DesktopCaptureOperation>()),
    cancelCapture: vi.fn(() => new Subject<DesktopCaptureOperation>()),
    cancelUpload: vi.fn(() => of(undefined)),
    getRaw: vi.fn(() => of(null)),
    getOcr: vi.fn(() => new Subject()),
    deleteCapture: vi.fn(() => of(undefined)),
    getResult: vi.fn(() => of(null)),
  };
  const features = {
    requirements,
    isFeatureReady: (feature: RecognitionFeature) => isFeatureReady(requirements(), feature),
    installUnit: vi.fn(),
    activeInstallation: signal<RuntimeInstallation | null>(null),
    requestedRequirements: signal(new Set<string>()),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: runtime },
      { provide: RecognitionFeaturesStore, useValue: features },
      { provide: DesktopWorkspaceStore, useValue: { allDocuments: documents, refreshDocuments } },
      DesktopWorkspaceCaptureService,
      CaptureQueueStore,
    ],
  });
  return {
    store: TestBed.inject(CaptureQueueStore),
    library,
    runtime,
    requirements,
    docs,
    created,
    rows: () => TestBed.inject(CaptureQueueStore).rows(),
  };
}

function requirement(status: RuntimeRequirement['status']): RuntimeRequirement {
  return {
    requirementId: 'windowsml-ocr',
    displayName: '文字辨識',
    status,
    kind: 'runtime',
    requiredFor: ['capture'],
    installStrategy: 'automatic',
    detail: null,
    downloadBytes: 144_000_000,
  };
}

function doc(partial: Partial<DesktopLibrarySummary>): DesktopLibrarySummary {
  return {
    documentId: 'b'.repeat(32),
    fileName: 'charge.pdf',
    mediaType: 'application/pdf',
    byteLength: 8,
    createdAtMs: 1,
    updatedAtMs: 1,
    status: 'queued',
    stage: 'uploading',
    ...partial,
  };
}

function runningJob(): DesktopCaptureOperation {
  return {
    protocolVersion: '2',
    captureId: 'capture-1',
    ingestionId: 'ingestion-1',
    status: 'running',
    stage: 'extracting',
    progress: 0.75,
    pagesDone: 9,
    pagesTotal: 12,
    partialRevision: 0,
    lastEventSequence: 0,
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
  } as DesktopCaptureOperation;
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
}

function selection(fileName: string): DesktopSourceSelection {
  return { selectionToken: fileName.padEnd(32, '0'), fileName, byteLength: 16,
    mediaType: fileName.endsWith('.png') ? 'image/png' : fileName.endsWith('.wav') ? 'audio/wav' : fileName.endsWith('.txt') ? 'text/plain' : 'application/pdf' };
}
