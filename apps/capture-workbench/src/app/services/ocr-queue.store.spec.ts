import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { CaptureRequirementId, RuntimeInstallation, RuntimeRequirement } from '@gx-capture/capture-workbench-ui';
import { of, Subject } from 'rxjs';
import { App } from '../app';
import type { DesktopCaptureOptions, DesktopLibraryExport, DesktopLibrarySummary } from '../contracts';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import { OcrQueueStore } from './ocr-queue.store';
import { DesktopLibraryService, type DesktopSourceSelection, type DesktopSourceSelectionBatch } from './desktop-library.service';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopCaptureService } from './desktop-capture.service';
import { DesktopFormattingService } from './desktop-formatting.service';
import { isFeatureReady, type RecognitionFeature } from './recognition-requirements';
import { LibraryStore } from './library.store';
import { HistoryListStore } from './history-list.store';
import { RecognitionFeaturesStore } from './recognition-features.store';

describe('OcrQueueStore', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('ignores repeated exports and clears a visible export error when the next request starts', () => {
    const { store, docs, library } = configure({ ocrReady: false });
    docs.push(doc({ status: 'completed', hasRaw: true }));
    store.attach();
    TestBed.tick();
    const download = vi.spyOn(TestBed.inject(DesktopFormattingService), 'downloadText').mockImplementation(() => undefined);
    const first = new Subject<DesktopLibraryExport>();
    const second = new Subject<DesktopLibraryExport>();
    library.export.mockReturnValueOnce(first).mockReturnValueOnce(second);
    store.exportTxt(docs[0].documentId);
    store.exportTxt(docs[0].documentId);
    expect(library.export).toHaveBeenCalledTimes(1);
    expect(store.exportBusyIds().has(docs[0].documentId)).toBe(true);
    first.error(new Error('private OCR text'));
    expect(store.importError()).toBe(desktopMessages().exportFailed);
    expect(store.exportBusyIds().size).toBe(0);
    store.exportTxt(docs[0].documentId);
    expect(store.importError()).toBe('');
    expect(library.export).toHaveBeenCalledTimes(2);
    second.next({ fileName: 'host.txt', content: 'saved text', mediaType: 'text/plain' });
    second.complete();
    expect(download).toHaveBeenCalledWith('host.txt', 'saved text', 'text/plain');
    expect(store.importError()).toBe('');
  });

  it('exports OCR through the host with page headings and the host filename', () => {
    const { store, docs, library } = configure({ ocrReady: false });
    docs.push(doc({ status: 'completed', hasRaw: true }));
    store.attach();
    TestBed.tick();
    const download = vi.spyOn(TestBed.inject(DesktopFormattingService), 'downloadText').mockImplementation(() => undefined);
    store.exportTxt(docs[0].documentId);
    expect(library.export).toHaveBeenCalledWith(docs[0].documentId, 'text', '第 {page} 頁');
    expect(download).toHaveBeenCalledWith('host.txt', 'host text', 'text/plain');
    expect(library.get).not.toHaveBeenCalled();
  });

  it('keeps an imported file waiting while OCR is missing, then starts it when install finishes', async () => {
    const harness = configure({ ocrReady: false });
    harness.store.attach();
    TestBed.tick();

    harness.store.pageListText.set('1-3');
    harness.store.importSelections({ rejected: [], selections: [selection('charge.pdf')] });
    TestBed.tick();

    expect(harness.library.importSelection).toHaveBeenCalledWith(
      selection('charge.pdf'),
      { pdfPageNumbers: [1, 2, 3] },
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

  it('lists and starts waiting files in import order, oldest first (#348)', async () => {
    const harness = configure({ ocrReady: false });
    // The library lists newest first; first.pdf and second.png share a timestamp.
    harness.docs.push(
      doc({ documentId: 'c'.repeat(32), fileName: 'third.jpg', mediaType: 'image/jpeg', createdAtMs: 3 }),
      doc({ documentId: 'd'.repeat(32), fileName: 'second.png', mediaType: 'image/png', createdAtMs: 2 }),
      doc({ documentId: 'a'.repeat(32), fileName: 'first.pdf', createdAtMs: 2 }),
    );
    harness.store.attach();
    TestBed.tick();

    expect(harness.rows().map((row) => row.fileName)).toEqual(['first.pdf', 'second.png', 'third.jpg']);

    harness.requirements.set([requirement('ready')]);
    TestBed.tick();
    await settle();

    expect(harness.runtime.createCapture.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      'a'.repeat(32),
      'd'.repeat(32),
      'c'.repeat(32),
    ]);
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

  it('starts a waiting PDF with stored pdfPageNumbers or legacy pdfPageCount', async () => {
    const harness = configure({ ocrReady: false });
    harness.docs.push(
      doc({
        documentId: 'c'.repeat(32),
        fileName: 'gapped.pdf',
        createdAtMs: 1,
        captureOptions: { pdfPageNumbers: [3, 7] },
      }),
      doc({
        documentId: 'd'.repeat(32),
        fileName: 'legacy.pdf',
        createdAtMs: 2,
        captureOptions: { pdfPageCount: 2 },
      }),
    );
    harness.store.attach();
    TestBed.tick();

    harness.requirements.set([requirement('ready')]);
    TestBed.tick();
    await settle();

    expect(harness.runtime.createCapture).toHaveBeenNthCalledWith(
      1,
      'c'.repeat(32),
      expect.any(String),
      [3, 7],
    );
    expect(harness.runtime.createCapture).toHaveBeenNthCalledWith(
      2,
      'd'.repeat(32),
      expect.any(String),
      [1, 2],
    );
  });

  it('refuses the whole batch without touching importError while the page field is invalid', async () => {
    const harness = configure({ ocrReady: false });
    harness.store.attach();
    TestBed.tick();

    harness.store.pageListText.set('5-1');
    expect(harness.store.pageListInvalid()).toBe(true);
    expect(harness.store.pageListError()).toBe(desktopMessages().ocrPageSelectionInvalid);
    harness.store.importSelections({ rejected: [], selections: [
      selection('notes.txt'),
      selection('range.pdf'),
      selection('scan.png'),
    ] });
    TestBed.tick();

    expect(harness.store.importError()).toBe('');
    expect(harness.library.importSelection).not.toHaveBeenCalled();
    expect(harness.library.discardSelections).toHaveBeenCalledWith([
      selection('notes.txt'), selection('range.pdf'), selection('scan.png'),
    ]);
    expect(harness.rows()).toEqual([]);

    harness.store.pageListText.set('2, 5');
    expect(harness.store.pageListInvalid()).toBe(false);
    expect(harness.store.pageListError()).toBe('');
    harness.store.importSelections({ rejected: [], selections: [
      selection('notes.txt'),
      selection('scan.png'),
    ] });
    TestBed.tick();

    expect(harness.store.importError()).toContain('(1)');
    expect(harness.store.importError()).not.toContain('notes.txt');
    expect(harness.library.importSelection).toHaveBeenCalledTimes(1);
    expect(harness.library.importSelection).toHaveBeenCalledWith(selection('scan.png'), undefined);
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
    harness.created.next(runningOperation());
    await settle();

    expect(harness.runtime.cancelCapture).toHaveBeenCalledWith('capture-1');
  });

  it('retries a failed file and restarts a file whose runtime operation is gone', async () => {
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

  it('shows page progress from the live capture operation', async () => {
    const harness = configure({ ocrReady: true, operation: runningOperation() });
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
    const dropped = new Subject<DesktopSourceSelectionBatch>();
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
      droppedSources: vi.fn(() => dropped),
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
      requestedRequirements: signal<ReadonlySet<CaptureRequirementId>>(new Set()),
      requirements,
      requirementsResource: {
        error: () => undefined,
        status: () => 'resolved' as const,
        value: requirements,
      },
      ocrReady: signal(false),
      asrReady: signal(false),
      speakersReady: signal(false),
      recognitionRequirements: signal([]),
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
      imports: [App],
      providers: [
        { provide: DesktopLibraryService, useValue: library },
        { provide: DesktopRuntimeClientService, useValue: runtime },
        { provide: RecognitionFeaturesStore, useValue: features },
        provideRouter([]),
        DesktopCaptureService,
        OcrQueueStore,
      ],
    }).overrideComponent(App, { set: { template: '' } });
    TestBed.createComponent(App);
    const queue = TestBed.inject(OcrQueueStore);
    queue.attach();
    TestBed.tick();

    expect(queue.rows().map((row) => row.fileName)).toEqual(['kept.pdf']);

    const history = TestBed.inject(HistoryListStore);
    const row = history.rows()[0];
    if (!row) throw new Error('missing History row');
    history.askDelete(row);
    history.confirmDelete();
    TestBed.tick();
    expect(queue.rows().map((row) => row.fileName)).toEqual([]);

    dropped.next({ rejected: [], selections: [selection('added.png')] });
    TestBed.tick();
    expect(library.importSelection).toHaveBeenCalledWith(selection('added.png'));
    expect(queue.rows().map((row) => row.fileName)).toEqual(['added.png']);
  });
});

function configure(options: { readonly ocrReady: boolean; readonly operation?: DesktopCaptureOperation }) {
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
    export: vi.fn(() => of({ fileName: 'host.txt', content: 'host text', mediaType: 'text/plain' })),
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
    createCapture: vi.fn(() => options.operation ? of(options.operation) : created),
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
    installRequirement: vi.fn(),
    activeInstallation: signal<RuntimeInstallation | null>(null),
    requestedRequirements: signal(new Set<string>()),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: runtime },
      { provide: RecognitionFeaturesStore, useValue: features },
      { provide: LibraryStore, useValue: { allDocuments: documents, refreshDocuments, export: library.export } },
      DesktopCaptureService,
      OcrQueueStore,
    ],
  });
  return {
    store: TestBed.inject(OcrQueueStore),
    library,
    runtime,
    requirements,
    docs,
    created,
    rows: () => TestBed.inject(OcrQueueStore).rows(),
  };
}

function requirement(status: RuntimeRequirement['status']): RuntimeRequirement {
  return {
    requirementId: 'windowsml-ocr',
    displayName: '文字辨識',
    status,
    kind: 'runtime',
    requiredFor: ['capture'],
    installStrategy: 'runtime-catalog',
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

function runningOperation(): DesktopCaptureOperation {
  return {
    protocolVersion: '2',
    captureId: 'capture-1',
    ingestionId: 'ingestion-1',
    status: 'extracting',
    progress: 0.75,
    pagesDone: 9,
    pagesTotal: 12,
    partialRevision: 0,
    lastEventSequence: 0,
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
  };
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
