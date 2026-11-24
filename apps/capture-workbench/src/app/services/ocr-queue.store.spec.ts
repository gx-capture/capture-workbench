import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { CaptureRequirementId, RuntimeInstallation, RuntimeRequirement } from '@gx-capture/capture-workbench-ui';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { App } from '../app';
import type { DesktopCaptureOptions, DesktopLibraryExport, DesktopLibrarySummary } from '../contracts';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import { OcrQueueStore } from './ocr-queue.store';
import { DesktopLibraryService, type DesktopSourceSelection, type DesktopSourceSelectionBatch } from './desktop-library.service';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopCaptureService, type DesktopCaptureHost } from './desktop-capture.service';
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

  it('stores an imported file waiting with its pages, asking for OCR while it is missing', async () => {
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

    harness.requirements.set([requirement('ready')]);
    TestBed.tick();
    await settle();

    // The admission of the capture service starts it, not the queue.
    expect(harness.rows()[0]).toMatchObject({ userStatus: 'waiting', needsInstall: false });
    expect(harness.runtime.createCapture).not.toHaveBeenCalled();
  });

  it('lists waiting files in import order, oldest first (#348)', async () => {
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

  it('cancels a waiting document and refreshes its row', () => {
    const harness = configure({ ocrReady: false });
    const waiting = doc({});
    harness.docs.push(waiting);
    harness.store.attach();
    TestBed.tick();
    const capture = TestBed.inject(DesktopCaptureService);
    const cancel = vi.spyOn(capture, 'cancel$');

    harness.store.cancel(waiting.documentId);

    expect(cancel).toHaveBeenCalledExactlyOnceWith(waiting.documentId, expect.anything());
    expect(harness.docs[0]).toMatchObject({
      status: 'canceled', stage: 'cancelled', captureId: undefined,
    });
    expect(harness.rows()[0]?.userStatus).toBe('cancelled');
    expect(harness.runtime.deleteCapture).not.toHaveBeenCalled();
    expect(harness.runtime.createCapture).not.toHaveBeenCalled();
  });

  it.each(['read', 'write'] as const)('shows a failed %s of a waiting cancel', (failure) => {
    const harness = configure({ ocrReady: false });
    const waiting = doc({});
    harness.docs.push(waiting);
    harness.store.attach();
    TestBed.tick();
    const error = new Error('Library unavailable');
    if (failure === 'read') harness.library.list.mockReturnValueOnce(throwError(() => error));
    else harness.library.updateCapture.mockReturnValueOnce(throwError(() => error));

    harness.store.cancel(waiting.documentId);

    expect(harness.store.importError()).toBe('Library unavailable');
    expect(harness.docs[0]).toBe(waiting);
    expect(harness.runtime.deleteCapture).not.toHaveBeenCalled();
    expect(harness.runtime.createCapture).not.toHaveBeenCalled();
  });

  it('preserves a completed document when its visible row still says waiting', () => {
    const harness = configure({ ocrReady: false });
    const waiting = doc({});
    harness.docs.push(waiting);
    harness.store.attach();
    TestBed.tick();
    const completed = { ...waiting, status: 'completed', hasRaw: true } satisfies DesktopLibrarySummary;
    harness.docs[0] = completed;
    harness.holdListReloads();
    expect(harness.documents()[0]).toBe(waiting);
    const refresh = vi.spyOn(TestBed.inject(LibraryStore), 'refreshDocuments');

    harness.store.cancel(waiting.documentId);

    expect(harness.library.list).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.library.updateCapture).not.toHaveBeenCalled();
    expect(harness.runtime.deleteCapture).not.toHaveBeenCalled();
    expect(harness.docs[0]).toBe(completed);
  });

  it('stores a failed file and an interrupted one waiting again only on the user’s Start again', async () => {
    const harness = configure({ ocrReady: true });
    harness.docs.push(doc({ status: 'failed', documentId: 'c'.repeat(32), fileName: 'failed.pdf' }));
    harness.docs.push(doc({
      status: 'recovery_required',
      documentId: 'd'.repeat(32),
      fileName: 'interrupted.pdf',
      captureId: 'capture-earlier-run',
      recoveryCode: 'capture_recovery_required',
    }));
    harness.store.attach();
    TestBed.tick();
    await settle();
    expect(harness.runtime.createCapture).not.toHaveBeenCalled();
    expect(harness.runtime.getCapture).not.toHaveBeenCalled();
    expect(harness.rows().find((row) => row.documentId === 'd'.repeat(32))).toMatchObject({
      userStatus: 'needs-attention', interrupted: true,
    });

    harness.store.startAgain('c'.repeat(32));
    await settle();
    expect(harness.docs.find((item) => item.documentId === 'c'.repeat(32))).toMatchObject({ status: 'queued' });

    harness.store.startAgain('d'.repeat(32));
    await settle();
    // The link of the earlier run is only an address for its cleanup: never read, deleted.
    expect(harness.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-earlier-run');
    expect(harness.runtime.getCapture).not.toHaveBeenCalled();
    expect(harness.docs.find((item) => item.documentId === 'd'.repeat(32)))
      .toMatchObject({ status: 'queued', captureId: undefined });
    // The capture service's admission starts them in their turn.
    expect(harness.runtime.createCapture).not.toHaveBeenCalled();
    expect(harness.rows().map((row) => row.userStatus)).toEqual(['waiting', 'waiting']);
  });

  it.each(['Start again', 'Cancel'] as const)('shows a failed %s on this page and clears it on the next action', async (action) => {
    const harness = configure({ ocrReady: true });
    const failed = doc({ status: action === 'Cancel' ? 'queued' : 'failed' });
    harness.docs.push(failed);
    harness.store.attach();
    TestBed.tick();
    const act = () => action === 'Start again'
      ? harness.store.startAgain(failed.documentId)
      : harness.store.cancel(failed.documentId);
    harness.library.list.mockReturnValueOnce(throwError(() => new Error('Capture library list failed.')));

    act();
    await settle();
    expect(harness.store.importError()).toBe('Capture library list failed.');

    act();
    expect(harness.store.importError()).toBe('');
  });

  describe('a start or a terminal write this run could not store', () => {
    /** The app shell's side of the admission, as `App` wires it. */
    function admit(harness: ReturnType<typeof configure>) {
      const libraryStore = TestBed.inject(LibraryStore);
      const host: DesktopCaptureHost = {
        selectedId: signal<string | null>(null),
        requestedRequirements: signal<ReadonlySet<CaptureRequirementId>>(new Set()),
        requirements: () => harness.requirements(),
        refreshDocuments: () => libraryStore.refreshDocuments(),
        applyDocumentState: (summary) => libraryStore.applyDocumentState(summary),
        setMessage: vi.fn(),
      };
      const admission = TestBed.inject(DesktopCaptureService).admitWaiting$(host, of(undefined)).subscribe();
      return { host, stop: () => admission.unsubscribe() };
    }

    it('shows the error of the admission’s failed read on the row it passed by; Start again clears it', async () => {
      const harness = configure({ ocrReady: true });
      const waiting = doc({});
      harness.docs.push(waiting);
      harness.store.attach();
      TestBed.tick();
      harness.library.list
        .mockReturnValueOnce(of([waiting]))
        .mockReturnValueOnce(throwError(() => new Error('Capture library list failed.')));

      const admission = admit(harness);
      await settle();

      expect(harness.rows()[0]).toMatchObject({
        userStatus: 'needs-attention', statusText: '需要處理', canStartAgain: true,
        failureReason: 'Capture library list failed.',
      });
      // On the row only: no page error line, no general message.
      expect(harness.store.importError()).toBe('');
      expect(admission.host.setMessage).not.toHaveBeenCalled();

      harness.store.startAgain(waiting.documentId);
      await settle();
      expect(harness.rows()[0]?.failureReason).toBeNull();
      expect(harness.rows()[0]?.userStatus).not.toBe('needs-attention');
      admission.stop();
    });

    it('shows the error of a failed terminal write on the interrupted row; Start again clears it', async () => {
      const harness = configure({ ocrReady: true });
      const waiting = doc({});
      harness.docs.push(waiting);
      harness.store.attach();
      TestBed.tick();
      const store = harness.library.updateCapture.getMockImplementation();
      if (!store) throw new Error('the library double stores writes');
      harness.library.updateCapture.mockImplementation((update) => update.status === 'failed'
        ? throwError(() => new Error('Capture library index cannot be written: the disk is full.'))
        : store(update));
      harness.runtime.createCapture.mockReturnValueOnce(throwError(() => new Error('Capture Runtime refused the capture.')));

      const admission = admit(harness);
      await settle();

      expect(harness.docs[0]?.status).toBe('processing');
      expect(harness.rows()[0]).toMatchObject({
        userStatus: 'needs-attention', statusText: '已中斷', interrupted: true, canStartAgain: true,
        failureReason: 'Capture library index cannot be written: the disk is full.',
      });
      expect(harness.store.importError()).toBe('');
      expect(admission.host.setMessage).not.toHaveBeenCalled();

      harness.library.updateCapture.mockImplementation(store);
      harness.store.startAgain(waiting.documentId);
      await settle();
      expect(harness.rows()[0]?.failureReason).toBeNull();
      expect(harness.rows()[0]?.interrupted).toBe(false);
      admission.stop();
    });
  });

  it('shows page progress from the live capture operation', async () => {
    const harness = configure({ ocrReady: true });
    harness.docs.push(doc({}));
    harness.store.attach();
    TestBed.tick();
    // Only an attempt of this run has a live operation.
    TestBed.inject(DesktopCaptureService).busyIds.set(new Set(['b'.repeat(32)]));
    TestBed.inject(DesktopCaptureService).oneShotOperations.set(new Map([['b'.repeat(32), runningOperation()]]));

    expect(harness.rows()[0]?.userStatus).toBe('processing');
    expect(harness.rows()[0]?.progressText).toContain('第 9/12 頁');
    expect(harness.rows()[0]?.pageLabel).toBe('12');
  });

  it('neither reads nor writes a linked row when the list loads', () => {
    const harness = configure({ ocrReady: true });
    harness.docs.push(
      doc({ documentId: '1'.repeat(32), status: 'processing', captureId: 'capture-a' }),
      doc({ documentId: '2'.repeat(32), status: 'awaiting_confirmation', hasRaw: true, captureId: 'capture-b' }),
      doc({ documentId: '3'.repeat(32), status: 'queued', captureId: 'capture-c' }),
    );
    harness.store.attach();
    TestBed.tick();

    expect(harness.runtime.getCapture).not.toHaveBeenCalled();
    expect(harness.runtime.createCapture).not.toHaveBeenCalled();
    expect(harness.runtime.deleteCapture).not.toHaveBeenCalled();
    expect(harness.library.updateCapture).not.toHaveBeenCalled();
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

function configure(options: { readonly ocrReady: boolean }) {
  const docs: DesktopLibrarySummary[] = [];
  const documents = signal<readonly DesktopLibrarySummary[]>([]);
  const requirements = signal<readonly RuntimeRequirement[]>([
    requirement(options.ocrReady ? 'ready' : 'installable'),
  ]);
  // A list reload answers at once, unless a test holds the answers back.
  let listReloadsAnswered = true;
  const refreshDocuments = (): void => {
    if (listReloadsAnswered) documents.set([...docs]);
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
        recoveryCode: undefined,
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
    createCapture: vi.fn((): Observable<DesktopCaptureOperation> => new Subject<DesktopCaptureOperation>()),
    getCapture: vi.fn((): Observable<DesktopCaptureOperation> => new Subject<DesktopCaptureOperation>()),
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
      {
        provide: LibraryStore,
        // Like a list whose reload has not answered: a write reaches it only through a reload.
        useValue: { allDocuments: documents, refreshDocuments, applyDocumentState: refreshDocuments, export: library.export },
      },
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
    documents,
    /** From now on the displayed list keeps what it shows: a reload does not answer. */
    holdListReloads: (): void => {
      listReloadsAnswered = false;
    },
    rows: () => TestBed.inject(OcrQueueStore).rows(),
  };
}

function requirement(status: RuntimeRequirement['status']): RuntimeRequirement {
  return {
    requirementId: 'text-recognition',
    displayName: '文字辨識',
    status,
    kind: 'text-recognition',
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
    kind: 'pdf',
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
