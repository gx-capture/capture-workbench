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
import { of, Subject, throwError, type Observable } from 'rxjs';
import type { DesktopLibraryExport, DesktopLibrarySummary } from '../contracts';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import { AsrQueueStore } from './asr-queue.store';
import { DesktopLibraryService, type DesktopSourceSelection } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopCaptureService } from './desktop-capture.service';
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
    const { store, library, recordingOperations, busyIds } = setup({ initialDocs: [document] });
    busyIds.set(new Set([document.documentId]));
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

  it('loads the speaker count of an earlier version’s row shown done, and offers its export', () => {
    const document = makeRecording({
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'completed', hasRaw: true,
    });
    const { store, library } = setup({ initialDocs: [document] });
    library.get.mockReturnValue(of({
      ...document,
      result: { speakers: [{ speakerId: 'one' }, { speakerId: 'two' }] },
    }));
    store.attach();
    TestBed.tick();

    expect(library.get).toHaveBeenCalledExactlyOnceWith(document.documentId);
    expect(store.rows()[0]).toMatchObject({ userStatus: 'done', speakerCount: 2, canExport: true });
  });

  it('loads the speaker count again when a completed recording is stored anew', () => {
    const document = makeRecording({ status: 'completed', durationMs: 90_000 });
    const { store, library, docs } = setup({ initialDocs: [document] });
    library.get.mockReturnValueOnce(of({ ...document, result: { speakers: [{ speakerId: 'one' }] } }));
    store.attach();
    TestBed.tick();
    expect(store.rows()[0].speakerCount).toBe(1);

    // Captured again in this run: the list shows the newer write, nothing else is told.
    const again = { ...document, updatedAtMs: 200 };
    library.get.mockReturnValueOnce(of({ ...again, result: { speakers: [{ speakerId: 'one' }, { speakerId: 'two' }] } }));
    docs.set([again]);
    TestBed.tick();

    expect(library.get).toHaveBeenCalledTimes(2);
    expect(store.rows()[0].speakerCount).toBe(2);
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

    const capture = {
      busyIds,
      cancellingIds: signal<ReadonlySet<string>>(new Set()),
      unstoredOutcomes: signal<ReadonlyMap<string, string | null>>(new Map()),
      recordingOperations,
      streamingPartials,
      startAgain$: vi.fn(() => of(undefined)),
      cancel$: vi.fn(() => of(undefined)),
    };

    const runtimeStatus = { message: signal('') };
    const libraryStore = {
      allDocuments: docs,
      selectedId,
      selected: signal(null),
      get: library.get,
      refreshDocuments: vi.fn(),
      applyDocumentState: vi.fn(),
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

  it('shows waiting files oldest first, asking for speech recognition while it is not installed', () => {
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
    const { store, requirements } = setup({
      speechStatus: 'installable',
      initialDocs: [newer, older],
    });

    store.attach();
    TestBed.tick();

    expect(store.rows().map((row) => row.fileName)).toEqual(['older.mp3', 'newer.mp3']);
    expect(store.rows()[0].needsInstall).toBe(true);

    requirements.set([
      requirement('speech-recognition', 'ready'),
      requirement('speaker-diarization', 'installable'),
    ]);
    TestBed.tick();

    expect(store.rows().map((row) => [row.fileName, row.userStatus, row.needsInstall])).toEqual([
      ['older.mp3', 'waiting', false],
      ['newer.mp3', 'waiting', false],
    ]);
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

  it('shows equal-timestamp recordings in import order', () => {
    const first = makeRecording({ documentId: '1'.repeat(32), fileName: 'first.mp3' });
    const second = makeRecording({ documentId: '2'.repeat(32), fileName: 'second.mp3' });
    const { store } = setup({ initialDocs: [second, first] });

    store.attach();
    TestBed.tick();

    expect(store.rows().map((row) => row.documentId)).toEqual([first.documentId, second.documentId]);
  });

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

  it('supports cancel on queued & running rows, start again, view in /history, and txt export', () => {
    const queuedDoc = makeRecording({ documentId: '1'.repeat(32), status: 'queued' });
    const doneDoc = makeRecording({ documentId: '2'.repeat(32), status: 'completed' });
    const { store, library, capture, libraryStore, formatting, router, busyIds } = setup({
      initialDocs: [queuedDoc, doneDoc],
    });

    store.cancel(queuedDoc.documentId);
    expect(capture.cancel$).toHaveBeenCalledExactlyOnceWith(queuedDoc.documentId, expect.anything());
    expect(library.updateCapture).not.toHaveBeenCalled();

    busyIds.set(new Set(['3'.repeat(32)]));
    store.cancel('3'.repeat(32));
    expect(capture.cancel$).toHaveBeenLastCalledWith('3'.repeat(32), expect.anything());

    store.startAgain(doneDoc.documentId);
    expect(capture.startAgain$).toHaveBeenCalledWith(doneDoc.documentId, expect.anything());

    store.view(doneDoc.documentId);
    expect(libraryStore.selectedId()).toBeNull();
    expect(router.navigateByUrl).toHaveBeenCalledWith(`/history/${doneDoc.documentId}`);

    store.exportTxt(doneDoc.documentId);
    expect(library.export).toHaveBeenCalledWith(doneDoc.documentId, 'text', '第 {page} 頁');
    expect(formatting.downloadText).toHaveBeenCalledWith('meeting.txt', 'transcript', 'text/plain');
  });

  it.each(['Start again', 'Cancel'] as const)('shows a failed %s on this page and clears it on the next action', (action) => {
    const document = makeRecording({ status: 'failed' });
    const { store, capture, runtimeStatus } = setup({ initialDocs: [document] });
    const act = () => action === 'Start again' ? store.startAgain(document.documentId) : store.cancel(document.documentId);
    const entry = action === 'Start again' ? capture.startAgain$ : capture.cancel$;
    entry.mockReturnValueOnce(throwError(() => new Error('Capture library list failed.')));

    act();
    expect(store.importError()).toBe('Capture library list failed.');
    expect(runtimeStatus.message()).toBe('');

    act();
    expect(store.importError()).toBe('');
  });

  it('shows the live card only for the recording this run captures', () => {
    const document = makeRecording({ status: 'processing', captureId: 'capture-1' });
    const { store, streamingPartials, busyIds } = setup({ initialDocs: [document] });
    streamingPartials.set(new Map([[document.documentId, {
      captureId: 'capture-1', revision: 5, coveredUntilMs: 90_000, sourceText: 'live transcript',
    } as PartialCapture]]));
    expect(store.liveCapture()).toBeNull();

    busyIds.set(new Set([document.documentId]));
    expect(store.liveCapture()?.lines[0].text).toBe('live transcript');
    expect(store.liveCapture()?.partialRevision).toBe(5);

    busyIds.set(new Set());
    expect(store.liveCapture()).toBeNull();
  });

  it.each(['canceled', 'completed'] as const)('preserves a stored %s recording when its row still says waiting', (status) => {
    const waiting = makeRecording();
    const { store, docs, library, libraryStore } = setup({
      initialDocs: [waiting], realCapture: true,
    });
    library.list.mockImplementation(() => of([{ ...waiting, status }]));
    store.attach();
    TestBed.tick();

    libraryStore.refreshDocuments.mockClear();
    store.cancel(waiting.documentId);

    expect(library.updateCapture).not.toHaveBeenCalled();
    expect(libraryStore.refreshDocuments).toHaveBeenCalledOnce();
    expect(docs()[0].status).toBe('queued');
  });
});
