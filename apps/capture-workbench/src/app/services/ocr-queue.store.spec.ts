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
import { DesktopCaptureService, FAILED_DECISION_PAUSE_MS } from './desktop-capture.service';
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

  it('cancels a waiting document and refreshes its row', () => {
    const harness = configure({ ocrReady: false });
    const waiting = doc({});
    harness.docs.push(waiting);
    harness.store.attach();
    TestBed.tick();
    const capture = TestBed.inject(DesktopCaptureService);
    const cancelDocument = vi.spyOn(capture, 'cancelDocument$');

    harness.store.cancel(waiting.documentId);

    expect(cancelDocument).toHaveBeenCalledExactlyOnceWith(waiting.documentId, expect.anything());
    expect(harness.docs[0]).toMatchObject({
      status: 'canceled', stage: 'cancelled', captureId: undefined,
    });
    expect(harness.rows()[0]?.userStatus).toBe('cancelled');
    expect(harness.runtime.cancelCapture).not.toHaveBeenCalled();
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
    expect(harness.runtime.cancelCapture).not.toHaveBeenCalled();
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
    expect(harness.runtime.cancelCapture).not.toHaveBeenCalled();
    expect(harness.docs[0]).toBe(completed);
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

  it('waits for explicit retry after reload and restarts only after that read finds the capture gone', async () => {
    const harness = configure({ ocrReady: true });
    harness.docs.push(doc({ status: 'failed', documentId: 'c'.repeat(32), fileName: 'failed.pdf' }));
    harness.docs.push(doc({
      status: 'recovery_required',
      documentId: 'd'.repeat(32),
      fileName: 'recoverable.pdf',
      captureId: 'capture-1',
      recoveryCode: 'capture_recovery_required',
    }));
    harness.store.attach();
    TestBed.tick();
    await settle();
    expect(harness.runtime.getCapture).not.toHaveBeenCalled();

    harness.store.retry('c'.repeat(32));
    await settle();
    expect(harness.runtime.createCapture).toHaveBeenCalledWith(
      'c'.repeat(32),
      expect.any(String),
      undefined,
    );
    expect(harness.runtime.getCapture).not.toHaveBeenCalled();

    // Still linked to its capture: offered Retry, not shown as interrupted.
    expect(harness.rows().find((row) => row.documentId === 'd'.repeat(32))).toMatchObject({
      userStatus: 'needs-attention', interrupted: false,
    });

    harness.runtime.createCapture.mockClear();
    harness.runtime.getCapture.mockImplementationOnce(() =>
      throwError(() => 'Capture Runtime request was rejected with HTTP 404.'));
    harness.store.retry('d'.repeat(32));
    await settle();
    expect(harness.runtime.getCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
    expect(harness.runtime.createCapture).not.toHaveBeenCalled();
    // The runtime answered that it does not have the capture: the link is removed.
    const lostRow = harness.docs.find((stored) => stored.documentId === 'd'.repeat(32));
    expect(lostRow).toMatchObject({
      status: 'recovery_required', recoveryCode: 'capture_recovery_required',
    });
    expect(lostRow?.captureId).toBeUndefined();
    expect(harness.rows().find((row) => row.documentId === 'd'.repeat(32))).toMatchObject({
      userStatus: 'needs-attention', interrupted: true,
    });

    harness.store.restart('d'.repeat(32));
    await settle();

    expect(harness.library.updateCapture).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'd'.repeat(32),
      status: 'queued',
      clearCaptureId: true,
    }));
    expect(harness.runtime.getCapture).toHaveBeenCalledTimes(1);
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

  describe('with a document list older than the capture service\'s last write', () => {
    /** A waiting file whose capture ran and ended while no list reload was answered. */
    async function endedCaptureOverUnansweredListReloads() {
      const harness = configure({
        ocrReady: false,
        // The shortest capture: the runtime answers that it ended, here cancelled.
        operation: { ...runningOperation(), status: 'cancelled' },
      });
      harness.docs.push(doc({}));
      harness.store.attach();
      TestBed.tick();
      expect(harness.rows()[0]?.userStatus).toBe('waiting');
      const waitingList = harness.documents();

      harness.holdListReloads();
      harness.requirements.set([requirement('ready')]);
      TestBed.tick();
      await settle();
      expect(harness.runtime.createCapture).toHaveBeenCalledTimes(1);
      expect(harness.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
      expect(harness.docs[0]).toMatchObject({ status: 'canceled', captureId: undefined });
      return { harness, waitingList };
    }

    /** Anything that makes the queue look at its list again, here the requirements answering again. */
    async function lookAgain(harness: ReturnType<typeof configure>): Promise<void> {
      harness.requirements.set([requirement('ready')]);
      TestBed.tick();
      await settle();
    }

    it('does not start a second capture for a row that still says waiting', async () => {
      const { harness, waitingList } = await endedCaptureOverUnansweredListReloads();
      expect(harness.documents()).toBe(waitingList);

      await lookAgain(harness);

      expect(harness.runtime.createCapture).toHaveBeenCalledTimes(1);
      expect(harness.docs[0]).toMatchObject({ status: 'canceled', captureId: undefined });
      harness.answerListReloads();
      TestBed.tick();
      expect(harness.rows()[0]?.userStatus).toBe('cancelled');
    });

    it('does not read the deleted capture of a file whose row still says running', async () => {
      const { harness } = await endedCaptureOverUnansweredListReloads();
      // A list answer from while the capture ran arrives after it ended.
      harness.documents.set([doc({ status: 'processing', stage: 'extracting', captureId: 'capture-1' })]);

      await lookAgain(harness);

      expect(harness.runtime.getCapture).not.toHaveBeenCalled();
      expect(harness.runtime.createCapture).toHaveBeenCalledTimes(1);
      expect(harness.docs[0]).toMatchObject({ status: 'canceled', captureId: undefined });
    });
  });

  it('asks again for each of two files only after its own pause when their stored state cannot be read', () => {
    const harness = configure({ ocrReady: true });
    const first = doc({ documentId: '1'.repeat(32), createdAtMs: 1, status: 'processing', captureId: 'capture-first' });
    const second = doc({ documentId: '2'.repeat(32), createdAtMs: 2, status: 'processing', captureId: 'capture-second' });
    // The library lists the newest file first; the queue works in import order.
    harness.docs.push(second, first);
    const reads: Subject<DesktopLibrarySummary[]>[] = [];
    harness.library.list.mockImplementation(() => {
      const read = new Subject<DesktopLibrarySummary[]>();
      reads.push(read);
      return read;
    });
    const failRead = (index: number) => reads[index].error('Capture library index cannot be read.');
    const half = FAILED_DECISION_PAUSE_MS / 2;

    vi.useFakeTimers();
    try {
      harness.store.attach();
      TestBed.tick();
      // One read per file, the first file's first.
      expect(reads).toHaveLength(2);
      failRead(0);
      vi.advanceTimersByTime(half);
      failRead(1);
      TestBed.tick();
      expect(reads).toHaveLength(2);

      // The pause of the first file is over: only it is asked for again.
      vi.advanceTimersByTime(half);
      TestBed.tick();
      expect(reads).toHaveLength(3);
      failRead(2);

      // The pause of the second file is over: only it is asked for again, and its capture is recovered.
      vi.advanceTimersByTime(half);
      TestBed.tick();
      expect(reads).toHaveLength(4);
      reads[3].next([second, first]);
      reads[3].complete();
      expect(harness.runtime.getCapture).toHaveBeenCalledExactlyOnceWith('capture-second');

      vi.advanceTimersByTime(half);
      TestBed.tick();
      expect(reads).toHaveLength(5);
      reads[4].next([second, first]);
      reads[4].complete();
      expect(harness.runtime.getCapture).toHaveBeenLastCalledWith('capture-first');
    } finally {
      vi.useRealTimers();
    }
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
      readonly recoveryCode?: string;
    }) => {
      const index = docs.findIndex((item) => item.documentId === update.documentId);
      const current = index >= 0 ? docs[index] : undefined;
      const next: DesktopLibrarySummary = {
        ...(current ?? doc({ documentId: update.documentId })),
        status: update.status,
        recoveryCode: update.recoveryCode,
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
    getCapture: vi.fn((): Observable<DesktopCaptureOperation> => new Subject<DesktopCaptureOperation>()),
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
    documents,
    holdListReloads: (): void => {
      listReloadsAnswered = false;
    },
    answerListReloads: (): void => {
      listReloadsAnswered = true;
      refreshDocuments();
    },
    created,
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
