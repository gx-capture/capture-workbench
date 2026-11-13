import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type {
  CaptureOperation,
  CaptureRequirementId,
  PartialCapture,
  RuntimeInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { finalize, of, Subject, type Observable } from 'rxjs';
import type { DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { AsrQueueStore } from './asr-queue.store';
import { DesktopLibraryService, type DesktopSourceSelection } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceCaptureService } from './desktop-workspace-capture.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';
import { DesktopWorkspaceStore } from './desktop-workspace.store';
import { RecognitionFeaturesStore } from './recognition-features.store';

function requirement(
  requirementId: CaptureRequirementId,
  status: RuntimeRequirement['status'],
): RuntimeRequirement {
  return {
    requirementId,
    displayName: requirementId,
    status,
    kind: 'runtime',
    requiredFor: ['capture'],
    installStrategy: 'automatic',
    detail: null,
    downloadBytes: 2_800_000_000,
  };
}

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
    const streamingOperations = signal<ReadonlyMap<string, CaptureOperation>>(new Map());
    const streamingPartials = signal<ReadonlyMap<string, PartialCapture>>(new Map());
    const ready = signal(true);
    const runtime = {
      ready,
      ocrCompute: signal(null),
      startStreamingCapture: vi.fn(() => new Subject<CaptureOperation>()),
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
      updateCapture: vi.fn(() => of(makeRecording({ status: 'canceled' }))),
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
      streamingOperations,
      streamingPartials,
      hasActiveCapture: vi.fn((id: string) => busyIds().has(id)),
      startDocument$: vi.fn(() => startDocSubject),
      reattach$: vi.fn((): Observable<void> => of(undefined)),
      retry$: vi.fn(() => of(undefined)),
      restartLost$: vi.fn(() => of(undefined)),
      cancel: vi.fn(),
    };

    const workspace = {
      allDocuments: docs,
      selectedId,
      selected: () => null,
      message: signal(''),
      refreshDocuments: vi.fn(),
      select: vi.fn((id: string) => selectedId.set(id)),
    };

    const features = {
      requirements,
      requestedRequirements: signal<ReadonlySet<CaptureRequirementId>>(new Set()),
      installationFor: vi.fn((): RuntimeInstallation | null => null),
      installUnit: vi.fn(),
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
        { provide: DesktopWorkspaceStore, useValue: workspace },
        { provide: DesktopLibraryService, useValue: library },
        { provide: DesktopRuntimeClientService, useValue: runtime },
        options.realCapture
          ? DesktopWorkspaceCaptureService
          : { provide: DesktopWorkspaceCaptureService, useValue: capture },
        { provide: RecognitionFeaturesStore, useValue: features },
        { provide: DesktopWorkspaceFormattingService, useValue: formatting },
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
      streamingOperations,
      streamingPartials,
      library,
      capture,
      workspace,
      features,
      formatting,
      router,
    };
  }

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

  it('supports cancel on queued & running rows, retry, restart, view in /history, and txt export', () => {
    const queuedDoc = makeRecording({ documentId: '1'.repeat(32), status: 'queued' });
    const doneDoc = makeRecording({ documentId: '2'.repeat(32), status: 'completed' });
    const { store, library, capture, workspace, formatting, router } = setup({
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
    expect(workspace.select).toHaveBeenCalledWith(doneDoc.documentId);
    expect(router.navigateByUrl).toHaveBeenCalledWith('/history');

    store.exportTxt(doneDoc.documentId);
    expect(library.export).toHaveBeenCalledWith(doneDoc.documentId, 'text');
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

    expect(runtime.startStreamingCapture).toHaveBeenCalledExactlyOnceWith({
      documentId: document.documentId,
      clientRequestId: expect.any(String),
      structuringMode: 'runtime',
      spokenLanguage: 'ja',
      identifySpeakers: true,
    });
  });

  it('reattaches once per capture id after a 404 and allows explicit retry and restart', () => {
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
    recovery.error({ status: 404, message: 'Capture not found' });
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

  it('clears a previous partial before starting a queued recording', () => {
    const document = makeRecording();
    const { store, capture, streamingPartials } = setup({ initialDocs: [document] });
    streamingPartials.set(new Map([[document.documentId, {
      captureId: 'previous', revision: 1, sourceText: 'old transcript',
    } as PartialCapture]]));
    capture.startDocument$.mockImplementation(() => {
      expect(streamingPartials().has(document.documentId)).toBe(false);
      return new Subject<void>();
    });

    store.attach();
    TestBed.tick();
    expect(capture.startDocument$).toHaveBeenCalledTimes(1);
    expect(streamingPartials().has(document.documentId)).toBe(false);
  });

  it.each(['retry', 'restart'] as const)('clears the previous partial on explicit %s', (action) => {
    const document = makeRecording({ status: 'recovery_required', captureId: 'old' });
    const { store, streamingPartials } = setup({ initialDocs: [document] });
    streamingPartials.set(new Map([[document.documentId, {
      captureId: 'old', revision: 1, sourceText: 'old transcript',
    } as PartialCapture]]));

    store[action](document.documentId);
    expect(streamingPartials().has(document.documentId)).toBe(false);
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
});
