import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type {
  CaptureEvent,
  CaptureOperation,
  CaptureRequirementId,
  CaptureResult,
  PartialCapture,
  RuntimeInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { finalize, of, Subject, throwError, type Observable } from 'rxjs';
import type { DesktopLibraryExport, DesktopLibrarySummary } from '../contracts';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import { AsrQueueStore } from './asr-queue.store';
import { DesktopLibraryService, type DesktopSourceSelection } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopCaptureService, FAILED_DECISION_PAUSE_MS } from './desktop-capture.service';
import { DesktopFormattingService } from './desktop-formatting.service';
import { RuntimeStatusStore } from './runtime-status.store';
import { LibraryStore } from './library.store';
import { RecognitionFeaturesStore } from './recognition-features.store';

function requirement(
  requirementId: CaptureRequirementId,
  status: RuntimeRequirement['status'],
): RuntimeRequirement {
  return {
    requirementId,
    displayName: requirementId,
    status,
    kind: requirementId,
    requiredFor: ['capture'],
    installStrategy: 'runtime-catalog',
    detail: null,
    downloadBytes: 2_800_000_000,
  };
}

type StoredCaptureUpdate = Parameters<DesktopLibraryService['updateCapture']>[0];

function makeRecording(
  overrides: Partial<DesktopLibrarySummary> = {},
): DesktopLibrarySummary {
  return {
    documentId: 'a'.repeat(32),
    fileName: 'meeting.m4a',
    mediaType: 'audio/mp4',
    byteLength: 1024,
    createdAtMs: 100,
    updatedAtMs: 100,
    status: 'queued',
    ...overrides,
  };
}

describe('AsrQueueStore', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('uses summary durations without loading completed recording details', () => {
    const document = makeRecording({
      status: 'completed', durationMs: 90_000, captureOptions: { identifySpeakers: false },
    });
    const { store, library, docs, recordingOperations } = setup({ initialDocs: [document] });
    store.attach();
    TestBed.tick();
    expect(store.rows()[0].durationLabel).toBe('1:30');
    expect(library.get).not.toHaveBeenCalled();

    recordingOperations.set(new Map([[document.documentId, {
      status: 'completed', durationMs: 800_000,
    } as CaptureOperation]]));
    docs.set([{ ...document, durationMs: 125_000, updatedAtMs: 200 }]);
    TestBed.tick();
    expect(store.rows()[0].durationLabel).toBe('2:05');
    expect(library.get).not.toHaveBeenCalled();
  });

  it('keeps the live operation duration while a recording is running', () => {
    const document = makeRecording({ status: 'processing', captureId: 'running', durationMs: 90_000 });
    const { store, library, recordingOperations } = setup({ initialDocs: [document] });
    recordingOperations.set(new Map([[document.documentId, {
      captureId: 'running', status: 'extracting', durationMs: 125_000,
    } as CaptureOperation]]));
    expect(store.rows()[0].durationLabel).toBe('2:05');
    expect(library.get).not.toHaveBeenCalled();
  });

  it('shows an unknown duration without fetching details when speaker identification is false', () => {
    const document = makeRecording({
      status: 'completed', captureOptions: { identifySpeakers: false },
    });
    const { store, library } = setup({ initialDocs: [document] });
    store.attach();
    TestBed.tick();
    expect(store.rows()[0].durationLabel).toBe('—');
    expect(library.get).not.toHaveBeenCalled();
  });

  it.each([true, undefined, null] as const)('loads speaker counts when identifySpeakers is %s', (identifySpeakers) => {
    const document = makeRecording({
      status: 'completed', durationMs: 90_000,
      ...(identifySpeakers === undefined ? {} : { captureOptions: { identifySpeakers } }),
    });
    const { store, library } = setup({ initialDocs: [document] });
    library.get.mockReturnValue(of({
      ...document,
      result: { speakers: [{ speakerId: 'one' }, { speakerId: 'two' }] },
    }));
    store.attach();
    TestBed.tick();
    expect(library.get).toHaveBeenCalledExactlyOnceWith(document.documentId);
    expect(store.rows()[0].speakerCount).toBe(2);
    expect(store.rows()[0].durationLabel).toBe('1:30');
  });

  function setup(options: {
    readonly speechStatus?: RuntimeRequirement['status'];
    readonly speakersStatus?: RuntimeRequirement['status'];
    readonly initialDocs?: readonly DesktopLibrarySummary[];
    readonly realCapture?: boolean;
  } = {}) {
    const docs = signal<readonly DesktopLibrarySummary[]>(options.initialDocs ?? []);
    const selectedId = signal<string | null>(null);
    const requirements = signal<readonly RuntimeRequirement[]>([
      requirement('speech-recognition', options.speechStatus ?? 'ready'),
      requirement('speaker-diarization', options.speakersStatus ?? 'installable'),
    ]);
    const busyIds = signal<ReadonlySet<string>>(new Set());
    const recordingOperations = signal<ReadonlyMap<string, CaptureOperation>>(new Map());
    const streamingPartials = signal<ReadonlyMap<string, PartialCapture>>(new Map());
    const ready = signal(true);
    const runtime = {
      ready,
      ocrCompute: signal(null),
      startRecordingCapture: vi.fn((): Observable<CaptureOperation> => new Subject<CaptureOperation>()),
      getCaptureEvents: vi.fn((): Observable<readonly CaptureEvent[]> => of([])),
      getPartial: vi.fn((): Observable<PartialCapture | null> => of(null)),
      getCapture: vi.fn<(captureId: string) => Observable<CaptureOperation>>(() => new Subject<CaptureOperation>()),
      getResult: vi.fn<(captureId: string) => Observable<CaptureResult>>(() => new Subject<CaptureResult>()),
      deleteCapture: vi.fn<(captureId: string) => Observable<void>>(() => of(undefined)),
    };

    const library = {
      selectSources: vi.fn(() => of({ selections: [], rejected: [] })),
      importSelection: vi.fn((selection: DesktopSourceSelection, captureOptions?: unknown) =>
        of({
          ...makeRecording({
            fileName: selection.fileName,
            mediaType: selection.mediaType,
            captureOptions: captureOptions as DesktopLibrarySummary['captureOptions'],
          }),
        })),
      discardSelections: vi.fn(() => of(undefined)),
      // What the library stores: the listed documents, unless a test keeps its own.
      list: vi.fn((): Observable<readonly DesktopLibrarySummary[]> => of(docs())),
      updateCapture: vi.fn<(update: StoredCaptureUpdate) => Observable<DesktopLibrarySummary>>(() =>
        of(makeRecording({ status: 'canceled' }))),
      get: vi.fn((documentId: string) =>
        of({
          ...(docs().find((d) => d.documentId === documentId) ?? makeRecording({ documentId })),
        })),
      export: vi.fn(() =>
        of({ fileName: 'meeting.txt', mediaType: 'text/plain', content: 'transcript' })),
    };

    const startDocSubject = new Subject<void>();
    const capture = {
      busyIds,
      recordingOperations,
      streamingPartials,
      isDocumentClaimed: vi.fn((id: string) => busyIds().has(id)),
      isDecisionPaused: vi.fn(() => false),
      failedDecisions: signal(0),
      startDocument$: vi.fn(() => startDocSubject),
      reattach$: vi.fn((): Observable<void> => of(undefined)),
      retry$: vi.fn(() => of(undefined)),
      restartLost$: vi.fn(() => of(undefined)),
      cancel: vi.fn(),
    };

    const runtimeStatus = { message: signal('') };
    const libraryStore = {
      allDocuments: docs,
      selectedId,
      selected: signal(null),
      get: library.get,
      refreshDocuments: vi.fn(),
      reloadDocumentState: vi.fn(),
      export: library.export,
    };

    const features = {
      requirements,
      requestedRequirements: signal<ReadonlySet<CaptureRequirementId>>(new Set()),
      installationFor: vi.fn((): RuntimeInstallation | null => null),
      installRequirement: vi.fn(),
    };

    const formatting = {
      downloadText: vi.fn(),
    };

    const router = {
      url: '/asr',
      navigateByUrl: vi.fn(() => Promise.resolve(true)),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: RuntimeStatusStore, useValue: runtimeStatus },
        { provide: LibraryStore, useValue: libraryStore },
        { provide: DesktopLibraryService, useValue: library },
        { provide: DesktopRuntimeClientService, useValue: runtime },
        options.realCapture
          ? DesktopCaptureService
          : { provide: DesktopCaptureService, useValue: capture },
        { provide: RecognitionFeaturesStore, useValue: features },
        { provide: DesktopFormattingService, useValue: formatting },
        { provide: Router, useValue: router },
      ],
    });

    const store = TestBed.inject(AsrQueueStore);
    return {
      store,
      runtime,
      docs,
      requirements,
      busyIds,
      recordingOperations,
      streamingPartials,
      library,
      capture,
      runtimeStatus,
      libraryStore,
      features,
      formatting,
      router,
    };
  }

  it.each(['ready', 'installable'] as const)('reports export failures and clears them on the next press with speech %s', (speechStatus) => {
    const { store, library, runtimeStatus, formatting } = setup({ speechStatus });
    const first = new Subject<DesktopLibraryExport>();
    const second = new Subject<DesktopLibraryExport>();
    library.export.mockReturnValueOnce(first).mockReturnValueOnce(second);
    store.exportTxt('recording');
    store.exportTxt('recording');
    expect(library.export).toHaveBeenCalledTimes(1);
    expect(store.exportBusyIds().has('recording')).toBe(true);
    first.error(new Error('private transcript'));
    expect(store.importError()).toBe(desktopMessages().exportFailed);
    expect(runtimeStatus.message()).toBe('');
    expect(store.exportBusyIds().has('recording')).toBe(false);
    store.exportTxt('recording');
    expect(store.importError()).toBe('');
    expect(library.export).toHaveBeenCalledTimes(2);
    second.next({ fileName: 'host.txt', content: 'saved text', mediaType: 'text/plain' });
    second.complete();
    expect(formatting.downloadText).toHaveBeenCalledWith('host.txt', 'saved text', 'text/plain');
    expect(store.importError()).toBe('');
  });

  it('uses recordings picker kind and snapshots spokenLanguage & identifySpeakers on import', () => {
    const { store, library } = setup({ speakersStatus: 'ready' });
    expect(store.spokenLanguage()).toBe('zh');

    store.setSpokenLanguage('ja');
    store.setIdentifySpeakers(true);
    store.chooseFiles();
    expect(library.selectSources).toHaveBeenCalledWith('recordings');

    const mp3: DesktopSourceSelection = {
      selectionToken: 't'.repeat(32),
      fileName: 'call.mp3',
      byteLength: 200,
      mediaType: 'audio/mpeg',
    };
    const pdf: DesktopSourceSelection = {
      selectionToken: 'p'.repeat(32),
      fileName: 'doc.pdf',
      byteLength: 200,
      mediaType: 'application/pdf',
    };

    store.importSelections({ selections: [mp3, pdf], rejected: [] });

    expect(library.importSelection).toHaveBeenCalledTimes(1);
    expect(library.importSelection).toHaveBeenCalledWith(mp3, {
      spokenLanguage: 'ja',
      identifySpeakers: true,
    });
    expect(library.discardSelections).toHaveBeenCalledWith([pdf]);
    expect(store.importError()).toContain('(1)');
  });

  it('keeps files queued while speech is not installed and starts oldest-first once ready', () => {
    const older = makeRecording({
      documentId: '1'.repeat(32),
      fileName: 'older.mp3',
      createdAtMs: 100,
      status: 'queued',
    });
    const newer = makeRecording({
      documentId: '2'.repeat(32),
      fileName: 'newer.mp3',
      createdAtMs: 200,
      status: 'queued',
    });
    const { store, requirements, capture } = setup({
      speechStatus: 'installable',
      initialDocs: [newer, older],
    });

    store.attach();
    TestBed.tick();

    expect(capture.startDocument$).not.toHaveBeenCalled();
    expect(store.rows().map((row) => row.fileName)).toEqual(['older.mp3', 'newer.mp3']);
    expect(store.rows()[0].needsInstall).toBe(true);

    requirements.set([
      requirement('speech-recognition', 'ready'),
      requirement('speaker-diarization', 'installable'),
    ]);
    TestBed.tick();

    expect(capture.startDocument$).toHaveBeenCalledTimes(1);
    expect(capture.startDocument$).toHaveBeenCalledWith(
      older.documentId,
      expect.anything(),
    );
  });

  it('continues importing after a failed selection and reports the error', () => {
    const { store, library, libraryStore } = setup();
    const first: DesktopSourceSelection = {
      selectionToken: '1'.repeat(32), fileName: 'first.mp3',
      byteLength: 200, mediaType: 'audio/mpeg',
    };
    const second = { ...first, selectionToken: '2'.repeat(32), fileName: 'second.mp3' };
    library.importSelection.mockReturnValueOnce(throwError(() => new Error('Import failed')));

    store.importSelections({
      selections: [first, second],
      rejected: [],
    });

    expect(library.importSelection).toHaveBeenCalledTimes(2);
    expect(library.importSelection).toHaveBeenNthCalledWith(2, second, {
      spokenLanguage: 'zh', identifySpeakers: false,
    });
    expect(store.importError()).toBe('Import failed');
    expect(libraryStore.refreshDocuments).toHaveBeenCalledTimes(1);
  });

  it('shows and starts equal-timestamp recordings in import order', () => {
    const first = makeRecording({ documentId: '1'.repeat(32), fileName: 'first.mp3' });
    const second = makeRecording({ documentId: '2'.repeat(32), fileName: 'second.mp3' });
    const { store, capture } = setup({ initialDocs: [second, first] });

    store.attach();
    TestBed.tick();

    expect(store.rows().map((row) => row.documentId)).toEqual([first.documentId, second.documentId]);
    expect(capture.startDocument$).toHaveBeenCalledExactlyOnceWith(first.documentId, expect.anything());
  });

  it.each(['success', 'failure'] as const)(
    'reserves a waiting cancellation until it settles with %s',
    (outcome) => {
      const running = makeRecording({ documentId: '1'.repeat(32), status: 'processing', captureId: 'active' });
      const waiting = makeRecording({ documentId: '2'.repeat(32), createdAtMs: 200 });
      const { store, library, capture, docs, busyIds } = setup({ initialDocs: [waiting, running] });
      const cancellation = new Subject<DesktopLibrarySummary>();
      library.updateCapture.mockReturnValue(cancellation);
      busyIds.set(new Set([running.documentId]));
      store.attach();
      TestBed.tick();

      store.cancel(waiting.documentId);
      docs.set([waiting, { ...running, status: 'completed' }]);
      busyIds.set(new Set());
      TestBed.tick();
      expect(capture.startDocument$).not.toHaveBeenCalled();
      store.cancel(waiting.documentId);
      expect(library.updateCapture).toHaveBeenCalledTimes(1);

      if (outcome === 'success') {
        cancellation.next({ ...waiting, status: 'canceled' });
        docs.set([{ ...waiting, status: 'canceled' }]);
        cancellation.complete();
        TestBed.tick();
        expect(capture.startDocument$).not.toHaveBeenCalled();
        // A later explicit retry is eligible again after the reservation is released.
      } else {
        cancellation.error(new Error('Cancel failed'));
      }
      docs.set([{ ...waiting, updatedAtMs: 300 }]);
      TestBed.tick();
      expect(capture.startDocument$).toHaveBeenCalledExactlyOnceWith(waiting.documentId, expect.anything());
    },
  );

  it('derives compact speaker install labels and delegates installation', () => {
    const { store, features, requirements } = setup();
    expect(store.optionalSpeakerInstall()).toEqual({
      installing: false, label: '安裝說話者辨識（約 2.8 GB）',
    });
    store.installSpeakers();
    expect(features.installRequirement).toHaveBeenCalledExactlyOnceWith('speaker-diarization');
    setDesktopLocale('en');
    expect(store.optionalSpeakerInstall()?.label).toBe('Install speaker identification (~2.8 GB)');
    requirements.set([requirement('speaker-diarization', 'ready')]);
    expect(store.optionalSpeakerInstall()).toBeNull();
  });

  it.each(['queued', 'running'] as const)('derives %s speaker installation progress from byte counts', (status) => {
    const { store, features } = setup();
    features.installationFor.mockReturnValue({
      installationId: 'speaker-install', requirementId: 'speaker-diarization',
      status, progress: 0.1, downloadedBytes: 25, downloadBytes: 100,
      createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z',
    });
    expect(store.optionalSpeakerInstall()).toEqual({
      installing: true, label: '正在安裝說話者辨識 25%',
    });
    setDesktopLocale('en');
    expect(store.optionalSpeakerInstall()?.label).toBe('Installing speaker identification 25%');
  });

  it('supports cancel on queued & running rows, retry, restart, view in /history, and txt export', () => {
    const queuedDoc = makeRecording({ documentId: '1'.repeat(32), status: 'queued' });
    const doneDoc = makeRecording({ documentId: '2'.repeat(32), status: 'completed' });
    const { store, library, capture, libraryStore, formatting, router } = setup({
      initialDocs: [queuedDoc, doneDoc],
    });

    store.cancel(queuedDoc.documentId);
    expect(library.updateCapture).toHaveBeenCalledWith({
      documentId: queuedDoc.documentId,
      status: 'canceled',
      stage: 'cancelled',
      clearCaptureId: true,
    });

    store.cancel('3'.repeat(32));
    expect(capture.cancel).toHaveBeenCalledWith('3'.repeat(32));

    store.retry(doneDoc.documentId);
    expect(capture.retry$).toHaveBeenCalledWith(doneDoc.documentId, expect.anything());

    store.restart(doneDoc.documentId);
    expect(capture.restartLost$).toHaveBeenCalledWith(doneDoc.documentId, expect.anything());

    store.view(doneDoc.documentId);
    expect(libraryStore.selectedId()).toBeNull();
    expect(router.navigateByUrl).toHaveBeenCalledWith(`/history/${doneDoc.documentId}`);

    store.exportTxt(doneDoc.documentId);
    expect(library.export).toHaveBeenCalledWith(doneDoc.documentId, 'text', '第 {page} 頁');
    expect(formatting.downloadText).toHaveBeenCalledWith('meeting.txt', 'transcript', 'text/plain');
  });

  it('starts through the public service API with the recording options saved at import', () => {
    const document = makeRecording({
      captureOptions: { spokenLanguage: 'ja', identifySpeakers: true },
    });
    const { store, runtime } = setup({
      initialDocs: [document], speakersStatus: 'ready', realCapture: true,
    });
    store.setSpokenLanguage('en');
    store.setIdentifySpeakers(false);

    store.attach();
    TestBed.tick();

    expect(runtime.startRecordingCapture).toHaveBeenCalledExactlyOnceWith({
      documentId: document.documentId,
      clientRequestId: expect.any(String),
      structuringMode: 'runtime',
      spokenLanguage: 'ja',
      identifySpeakers: true,
    });
  });

  it('reattaches once per capture id, also when the recovery has ended and the list changes, and passes explicit retry and restart on', () => {
    const document = makeRecording({ status: 'processing', captureId: 'lost' });
    const { store, capture, docs, busyIds } = setup({ initialDocs: [document] });
    const recovery = new Subject<void>();
    capture.reattach$.mockImplementation(() => {
      busyIds.set(new Set([document.documentId]));
      return recovery.pipe(finalize(() => busyIds.set(new Set())));
    });

    store.attach();
    TestBed.tick();
    expect(capture.reattach$).toHaveBeenCalledExactlyOnceWith(document, expect.anything());

    docs.set([{ ...document, status: 'recovery_required' }]);
    // The capture service stores a capture it cannot find with the document and completes.
    recovery.complete();
    TestBed.tick();
    // Further refreshes and busy changes must not retry the missing runtime capture.
    docs.set([{ ...document, status: 'recovery_required', updatedAtMs: 200 }]);
    busyIds.set(new Set());
    TestBed.tick();
    expect(capture.reattach$).toHaveBeenCalledTimes(1);

    store.retry(document.documentId);
    expect(capture.retry$).toHaveBeenCalledExactlyOnceWith(document.documentId, expect.anything());
    store.restart(document.documentId);
    TestBed.tick();
    expect(capture.restartLost$).toHaveBeenCalledExactlyOnceWith(document.documentId, expect.anything());
    expect(capture.reattach$).toHaveBeenCalledTimes(1);

    capture.reattach$.mockReturnValue(of(undefined));
    docs.set([{ ...document, captureId: 'replacement' }]);
    TestBed.tick();
    expect(capture.reattach$).toHaveBeenCalledTimes(2);
  });

  it('ignores late partials from an earlier capture of the same recording', () => {
    const document = makeRecording({ status: 'processing', captureId: 'current' });
    const { store, streamingPartials, busyIds, docs } = setup({ initialDocs: [document] });
    busyIds.set(new Set([document.documentId]));
    const stale = { captureId: 'previous', revision: 5, coveredUntilMs: 90_000,
      sourceText: 'old transcript' } as PartialCapture;
    streamingPartials.set(new Map([[document.documentId, stale]]));

    expect(store.liveCapture()?.lines).toEqual([]);
    expect(store.liveCapture()?.partialRevision).toBeNull();
    expect(store.liveCapture()?.coveredUntilMs).toBe(0);

    streamingPartials.set(new Map([[document.documentId, { ...stale, captureId: 'current' }]]));
    expect(store.liveCapture()?.lines[0].text).toBe('old transcript');
    expect(store.liveCapture()?.partialRevision).toBe(5);

    docs.set([{ ...document, captureId: undefined }]);
    expect(store.liveCapture()?.lines).toEqual([]);
    busyIds.set(new Set());
    expect(store.liveCapture()).toBeNull();
  });

  describe('with a document list older than the last library write', () => {
    const captureId = 'capture-recording';
    const notFound = 'Capture Runtime request was rejected with HTTP 404.';
    const recording = (status: CaptureOperation['status']) => ({
      protocolVersion: '2', captureId, ingestionId: 'ingestion-recording', kind: 'recording',
      status, partialRevision: 0, lastEventSequence: 0,
      createdAt: '2026-11-21T00:00:00Z', updatedAt: '2026-11-21T00:00:00Z',
    } as CaptureOperation);

    /**
     * The queue over the real capture service. The library stores what the
     * service writes; the queue's document list changes only when the test
     * sets it, as while the reload the service asked for has not answered.
     * The runtime forgets a deleted capture, and the capture ends when the
     * test says so.
     */
    function captureOverAnUnansweredListReload(options: { readonly failFirstUnlink?: boolean } = {}) {
      const queued = makeRecording({ captureOptions: { identifySpeakers: false } });
      const harness = setup({ initialDocs: [queued], realCapture: true });
      let stored = queued;
      let unlinkFailures = options.failFirstUnlink ? 1 : 0;
      const writes: StoredCaptureUpdate[] = [];
      harness.library.list.mockImplementation(() => of([stored]));
      harness.library.updateCapture.mockImplementation((update) => {
        // The unlink is the write that clears the link once the capture has ended.
        if (update.clearCaptureId && update.status !== 'processing' && unlinkFailures > 0) {
          unlinkFailures -= 1;
          return throwError(() => 'Capture library index cannot be written.');
        }
        writes.push(update);
        // Like the host: the link changes only when asked, the error and recovery fields always.
        stored = {
          ...stored,
          status: update.status,
          stage: update.stage,
          captureId: update.clearCaptureId ? undefined : update.captureId ?? stored.captureId,
          errorCode: update.errorCode,
          errorMessage: update.errorMessage,
          recoveryCode: update.recoveryCode,
          recoveryMessage: update.recoveryMessage,
          hasRaw: stored.hasRaw || update.raw !== undefined,
          updatedAtMs: stored.updatedAtMs + 1,
        };
        return of(stored);
      });
      let deleted = false;
      const ended = new Subject<CaptureOperation>();
      // Only the first start is answered: a second one would be a second capture.
      harness.runtime.startRecordingCapture.mockImplementationOnce(() => of(recording('extracting')));
      harness.runtime.getCapture
        .mockImplementation(() => deleted ? throwError(() => notFound) : of(recording('completed')))
        .mockImplementationOnce(() => ended);
      harness.runtime.getResult.mockImplementation(() => of({
        operation: recording('completed'),
        raw: { sourceText: 'transcript' },
        result: { targetText: 'transcript' },
      } as unknown as CaptureResult));
      harness.runtime.deleteCapture.mockImplementation(() => {
        deleted = true;
        return of(undefined);
      });
      return {
        ...harness,
        stored: () => stored,
        writes,
        /** The capture's status read answers with the end, ahead of any event that says so. */
        endCapture: (end: Partial<CaptureOperation> = { status: 'completed' }) => {
          ended.next({ ...recording('completed'), ...end });
          ended.complete();
        },
      };
    }

    it('does not read the deleted capture of a finished recording, which stays completed', () => {
      const { store, docs, runtime, libraryStore, stored, writes, endCapture } =
        captureOverAnUnansweredListReload();
      store.attach();
      TestBed.tick();
      // The last list answer before the capture ends: running, linked to its capture.
      expect(stored()).toMatchObject({ status: 'processing', captureId });
      docs.set([stored()]);
      TestBed.tick();
      libraryStore.refreshDocuments.mockClear();

      endCapture();
      // Busy cleared; the list still says the recording runs.
      TestBed.tick();

      expect(runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith(captureId);
      expect(runtime.getCapture).toHaveBeenCalledTimes(1);
      expect(writes.map((write) => write.status)).not.toContain('recovery_required');
      expect(stored()).toMatchObject({ status: 'completed', captureId: undefined, recoveryCode: undefined });
      // The outdated list is asked for again, and the row then shows the result.
      expect(libraryStore.refreshDocuments).toHaveBeenCalled();
      docs.set([stored()]);
      TestBed.tick();
      expect(store.rows()[0].userStatus).toBe('done');
      expect(runtime.getCapture).toHaveBeenCalledTimes(1);
    });

    it('keeps the cleanup state of a failed unlink and only retries the cleanup', () => {
      const { store, docs, runtime, stored, writes, endCapture } =
        captureOverAnUnansweredListReload({ failFirstUnlink: true });
      store.attach();
      TestBed.tick();
      docs.set([stored()]);
      TestBed.tick();

      endCapture();
      // The result is kept and the capture deleted, but the unlink was refused.
      expect(writes[writes.length - 1]).toMatchObject({
        status: 'recovery_required', captureId, recoveryCode: 'runtime_cleanup_failed',
      });
      TestBed.tick();

      // No read of the deleted capture, so nothing replaces the cleanup state
      // with a lost capture; the cleanup alone is retried and now succeeds.
      expect(runtime.getCapture).toHaveBeenCalledTimes(1);
      expect(writes.map((write) => write.recoveryCode)).not.toContain('capture_recovery_required');
      expect(runtime.deleteCapture).toHaveBeenCalledTimes(2);
      expect(stored()).toMatchObject({ status: 'completed', captureId: undefined, recoveryCode: undefined });
    });

    it('keeps a failed recording failed when its refused unlink is retried', () => {
      const { store, docs, stored, writes, endCapture } =
        captureOverAnUnansweredListReload({ failFirstUnlink: true });
      store.attach();
      TestBed.tick();
      docs.set([stored()]);
      TestBed.tick();

      // The status read says failed; the last event the Workbench read still said extracting.
      endCapture({ status: 'failed', error: { code: 'speech_failed', message: 'no speech' } });
      expect(writes[writes.length - 1]).toMatchObject({
        status: 'recovery_required', stage: 'failed', captureId,
        recoveryCode: 'runtime_cleanup_failed', errorCode: 'speech_failed',
      });
      TestBed.tick();

      expect(stored()).toMatchObject({
        status: 'failed', stage: 'failed', captureId: undefined,
        errorCode: 'speech_failed', recoveryCode: undefined,
      });
    });

    it('does not capture a finished recording again when retry is pressed on its outdated cleanup row', () => {
      const { store, docs, runtime, libraryStore, stored, endCapture } =
        captureOverAnUnansweredListReload({ failFirstUnlink: true });
      store.attach();
      TestBed.tick();
      docs.set([stored()]);
      TestBed.tick();
      endCapture();
      // The row shows the refused cleanup and offers retry.
      const cleanupRow = stored();
      expect(cleanupRow).toMatchObject({ status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed' });
      docs.set([cleanupRow]);
      TestBed.tick();
      // The queue's own retry of the cleanup succeeded; the list reload has not answered.
      expect(stored()).toMatchObject({ status: 'completed', captureId: undefined });
      expect(docs()[0]).toBe(cleanupRow);
      libraryStore.refreshDocuments.mockClear();

      store.retry(cleanupRow.documentId);

      expect(runtime.startRecordingCapture).toHaveBeenCalledTimes(1);
      expect(stored()).toMatchObject({ status: 'completed', captureId: undefined });
      expect(libraryStore.refreshDocuments).toHaveBeenCalled();
    });

    it.each(['retry', 'restart'] as const)(
      'leaves the live lines when %s is pressed for a recording whose capture runs',
      (action) => {
        const { store, docs, stored, library } = captureOverAnUnansweredListReload();
        store.attach();
        TestBed.tick();
        docs.set([stored()]);
        const service = TestBed.inject(DesktopCaptureService);
        service.streamingPartials.set(new Map([[stored().documentId, {
          captureId, revision: 1, coveredUntilMs: 1_000, sourceText: 'first line',
        } as PartialCapture]]));
        expect(store.liveCapture()?.lines.map((line) => line.text)).toEqual(['first line']);
        const readsBefore = library.list.mock.calls.length;

        // The capture service ignores the request: the document is claimed.
        store[action](stored().documentId);
        TestBed.tick();

        expect(library.list).toHaveBeenCalledTimes(readsBefore);
        expect(store.liveCapture()?.lines.map((line) => line.text)).toEqual(['first line']);
      },
    );

    it('does not start a second capture for a row that still says waiting', () => {
      const { store, runtime, libraryStore, stored, endCapture } =
        captureOverAnUnansweredListReload();
      store.attach();
      TestBed.tick();
      expect(runtime.startRecordingCapture).toHaveBeenCalledTimes(1);
      libraryStore.refreshDocuments.mockClear();

      // No list answer arrived while the capture ran: the row still says waiting.
      endCapture();
      TestBed.tick();

      expect(runtime.startRecordingCapture).toHaveBeenCalledTimes(1);
      expect(stored()).toMatchObject({ status: 'completed', captureId: undefined });
      expect(libraryStore.refreshDocuments).toHaveBeenCalled();
    });

    it('does not start a recording that was cancelled while it waited', () => {
      const waiting = makeRecording();
      const { store, docs, runtime, library, requirements } = setup({
        initialDocs: [waiting], speechStatus: 'installable', realCapture: true,
      });
      library.list.mockImplementation(() => of([{ ...waiting, status: 'canceled' as const }]));
      store.attach();
      TestBed.tick();

      store.cancel(waiting.documentId);
      // Speech becomes ready before the list reload answers.
      requirements.set([
        requirement('speech-recognition', 'ready'),
        requirement('speaker-diarization', 'installable'),
      ]);
      TestBed.tick();

      expect(docs()[0].status).toBe('queued');
      expect(runtime.startRecordingCapture).not.toHaveBeenCalled();
    });
  });

  describe('while the capture service reads the stored document', () => {
    /** The queue over the real capture service, whose reads of the library the test answers. */
    function decisionsTheTestAnswers(initialDocs: readonly DesktopLibrarySummary[]) {
      const harness = setup({ initialDocs, realCapture: true });
      const reads: Subject<readonly DesktopLibrarySummary[]>[] = [];
      harness.library.list.mockImplementation(() => {
        const read = new Subject<readonly DesktopLibrarySummary[]>();
        reads.push(read);
        return read;
      });
      return {
        ...harness,
        reads,
        service: TestBed.inject(DesktopCaptureService),
        answer: (read: Subject<readonly DesktopLibrarySummary[]>, documents: readonly DesktopLibrarySummary[]) => {
          read.next(documents);
          read.complete();
        },
      };
    }

    it('starts no recording while the recovery of another is being decided', () => {
      const interrupted = makeRecording({
        documentId: '1'.repeat(32), status: 'recovery_required', captureId: 'capture-interrupted',
        recoveryCode: 'cancel_failed', createdAtMs: 1,
      });
      const waiting = makeRecording({ documentId: '2'.repeat(32), createdAtMs: 2 });
      const { store, runtime, reads, service, answer } = decisionsTheTestAnswers([interrupted, waiting]);

      store.attach();
      TestBed.tick();
      // One read: the recovery's. The waiting recording is not even considered.
      expect(reads).toHaveLength(1);
      expect(service.isDocumentClaimed(interrupted.documentId)).toBe(true);

      answer(reads[0], [interrupted, waiting]);
      TestBed.tick();

      expect(runtime.getCapture).toHaveBeenCalledExactlyOnceWith('capture-interrupted');
      expect(service.busyIds().has(interrupted.documentId)).toBe(true);
      expect(reads).toHaveLength(1);
      expect(runtime.startRecordingCapture).not.toHaveBeenCalled();
    });

    it('lets a cancel win over a start that is being decided', () => {
      const waiting = makeRecording();
      const { store, runtime, library, reads, answer } = decisionsTheTestAnswers([waiting]);
      store.attach();
      TestBed.tick();
      expect(reads).toHaveLength(1);

      store.cancel(waiting.documentId);
      // The read was sent before the cancel: its answer still says waiting.
      answer(reads[0], [waiting]);
      TestBed.tick();

      expect(runtime.startRecordingCapture).not.toHaveBeenCalled();
      expect(library.updateCapture.mock.calls.map(([update]) => update)).toEqual([{
        documentId: waiting.documentId, status: 'canceled', stage: 'cancelled', clearCaptureId: true,
      }]);
    });

    it('tries a recovery again after the read of the stored document failed', () => {
      const running = makeRecording({ status: 'processing', captureId: 'capture-running' });
      const { store, docs, runtime, runtimeStatus, reads, answer } = decisionsTheTestAnswers([running]);
      store.attach();
      TestBed.tick();
      expect(reads).toHaveLength(1);

      vi.useFakeTimers();
      try {
        reads[0].error('Capture library index cannot be read.');
        expect(runtimeStatus.message()).toBe('Capture library index cannot be read.');
        expect(runtime.getCapture).not.toHaveBeenCalled();

        // The queue looks at its list again, within the pause of the recording: it does not ask.
        docs.set([{ ...running }]);
        TestBed.tick();
        expect(reads).toHaveLength(1);

        // After the pause the recovery is decided again: it was not given up.
        vi.advanceTimersByTime(FAILED_DECISION_PAUSE_MS);
        TestBed.tick();
        expect(reads).toHaveLength(2);
        answer(reads[1], [running]);

        expect(runtime.getCapture).toHaveBeenCalledExactlyOnceWith('capture-running');
      } finally {
        vi.useRealTimers();
      }
    });
    it('does not start a recording whose cancel was asked while a read that then failed was pending', () => {
      const waiting = makeRecording();
      const { store, docs, runtime, library, reads, answer } = decisionsTheTestAnswers([waiting]);
      store.attach();
      TestBed.tick();
      expect(reads).toHaveLength(1);

      store.cancel(waiting.documentId);
      vi.useFakeTimers();
      try {
        reads[0].error('Capture library index cannot be read.');
        expect(library.updateCapture).not.toHaveBeenCalled();

        // The queue looks at its list again after the pause, and the stored document still waits.
        docs.set([{ ...waiting }]);
        vi.advanceTimersByTime(FAILED_DECISION_PAUSE_MS);
        TestBed.tick();
      } finally {
        vi.useRealTimers();
      }
      expect(reads).toHaveLength(2);
      answer(reads[1], [waiting]);
      TestBed.tick();

      expect(runtime.startRecordingCapture).not.toHaveBeenCalled();
      expect(library.updateCapture.mock.calls.map(([update]) => update)).toEqual([{
        documentId: waiting.documentId, status: 'canceled', stage: 'cancelled', clearCaptureId: true,
      }]);
    });

    describe('after a read of the stored document failed', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it('looks again by itself after a pause, so the next waiting recording is not stranded', () => {
        const interrupted = makeRecording({
          documentId: '1'.repeat(32), status: 'recovery_required', captureId: 'capture-interrupted',
          recoveryCode: 'cancel_failed', createdAtMs: 1,
        });
        const waiting = makeRecording({ documentId: '2'.repeat(32), createdAtMs: 2 });
        const { store, runtime, reads, answer } = decisionsTheTestAnswers([interrupted, waiting]);
        // The runtime no longer knows the interrupted capture.
        runtime.getCapture.mockImplementation(() =>
          throwError(() => 'Capture Runtime request was rejected with HTTP 404.'));
        store.attach();
        TestBed.tick();
        expect(reads).toHaveLength(1);

        reads[0].error('Capture library index cannot be read.');
        TestBed.tick();
        // Not at once: a read that keeps failing must not be repeated in a loop.
        expect(reads).toHaveLength(1);

        vi.advanceTimersByTime(FAILED_DECISION_PAUSE_MS);
        TestBed.tick();
        // The recovery is decided again, without anyone refreshing the list.
        expect(reads).toHaveLength(2);
        answer(reads[1], [interrupted, waiting]);
        TestBed.tick();
        expect(runtime.getCapture).toHaveBeenCalledExactlyOnceWith('capture-interrupted');

        // The recovery ended (its capture is lost), and the waiting recording gets its turn.
        expect(reads).toHaveLength(3);
        answer(reads[2], [interrupted, waiting]);
        expect(runtime.startRecordingCapture).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ documentId: waiting.documentId }),
        );
      });

      it('repeats a read that keeps failing only once per pause', () => {
        const waiting = makeRecording();
        const { store, runtime, reads } = decisionsTheTestAnswers([waiting]);
        store.attach();
        TestBed.tick();

        reads[0].error('Capture library index cannot be read.');
        TestBed.tick();
        TestBed.tick();
        vi.advanceTimersByTime(FAILED_DECISION_PAUSE_MS - 1);
        TestBed.tick();
        expect(reads).toHaveLength(1);

        vi.advanceTimersByTime(1);
        TestBed.tick();
        expect(reads).toHaveLength(2);
        reads[1].error('Capture library index cannot be read.');
        TestBed.tick();
        vi.advanceTimersByTime(FAILED_DECISION_PAUSE_MS - 1);
        TestBed.tick();
        expect(reads).toHaveLength(2);

        vi.advanceTimersByTime(1);
        TestBed.tick();
        expect(reads).toHaveLength(3);
        expect(runtime.startRecordingCapture).not.toHaveBeenCalled();
      });
    });

  });
});
