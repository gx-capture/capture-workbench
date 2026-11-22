import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CaptureOperation } from '@gx-capture/capture-workbench-ui';
import { provideRouter } from '@angular/router';
import { of, Subject, type Observable } from 'rxjs';
import { App } from '../app';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
import { DesktopCaptureService } from './desktop-capture.service';
import { DesktopLibraryService, type DesktopSourceSelection, type DesktopSourceSelectionBatch } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { LibraryStore } from './library.store';
import { RecognitionFeaturesStore } from './recognition-features.store';

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

describe('LibraryStore', () => {
  function setupDeletion() {
    const response = new Subject<void>();
    const deleteDocument = vi.fn(() => response);
    const list = vi.fn((): Observable<readonly DesktopLibrarySummary[]> => of([summary]));
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopLibraryService, useValue: { list, delete: deleteDocument } },
        { provide: DesktopRuntimeClientService, useValue: { started: signal(true) } },
      ],
    });
    const store = TestBed.inject(LibraryStore);
    const capture = TestBed.inject(DesktopCaptureService);
    const forget = vi.spyOn(capture, 'forgetDeletedDocument');
    TestBed.tick();
    list.mockClear();
    return { store, capture, response, deleteDocument, list, forget };
  }

  it.each(['acknowledgement', 'unsubscription'])('claims from subscription until %s', (settlement) => {
    const { store, capture, response, deleteDocument, list, forget } = setupDeletion();
    const deletion = store.delete(summary.documentId);
    expect(capture.isDocumentClaimed(summary.documentId)).toBe(false);
    expect(deleteDocument).not.toHaveBeenCalled();

    const subscription = deletion.subscribe();
    expect(capture.isDocumentClaimed(summary.documentId)).toBe(true);
    expect(store.canDelete(summary.documentId)).toBe(false);
    store.delete(summary.documentId).subscribe();
    expect(deleteDocument).toHaveBeenCalledExactlyOnceWith(summary.documentId);

    if (settlement === 'acknowledgement') {
      list.mockReturnValue(of([]));
      response.next();
      response.complete();
      expect(forget).toHaveBeenCalledExactlyOnceWith(summary.documentId);
      expect(store.allDocuments()).toEqual([]);
    } else {
      subscription.unsubscribe();
      expect(response.observed).toBe(false);
      expect(forget).not.toHaveBeenCalled();
      expect(store.canDelete(summary.documentId)).toBe(true);
    }
    expect(capture.isDocumentClaimed(summary.documentId)).toBe(false);
  });

  it.each([
    ['row present', [summary]],
    ['list read failed', null],
    ['list read completed without a list', 'no list'],
  ] as const)('preserves the delete error when %s', (_outcome, documents) => {
    const { store, capture, response, list, forget } = setupDeletion();
    const verification = new Subject<readonly DesktopLibrarySummary[]>();
    list.mockReturnValueOnce(verification);
    const deletionFailed = new Error('Host deletion failed');
    const error = vi.fn();
    store.delete(summary.documentId).subscribe({ error });
    response.error(deletionFailed);

    expect(list).toHaveBeenCalledTimes(1);
    expect(capture.isDocumentClaimed(summary.documentId)).toBe(true);
    expect(error).not.toHaveBeenCalled();
    if (documents === null) verification.error(new Error('Library list failed'));
    else if (documents === 'no list') verification.complete();
    else verification.next(documents);

    expect(error).toHaveBeenCalledExactlyOnceWith(deletionFailed);
    expect(capture.isDocumentClaimed(summary.documentId)).toBe(false);
    expect(verification.observed).toBe(false);
    expect(forget).not.toHaveBeenCalled();
    expect(store.allDocuments()).toEqual([summary]);
  });

  it('treats a delete error whose document is gone as a deletion, without replacing a newer list', () => {
    const { store, capture, response, list, forget } = setupDeletion();
    const imported = { ...summary, documentId: 'b'.repeat(32), fileName: 'imported.pdf' } satisfies DesktopLibrarySummary;
    const deletion = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
    store.delete(summary.documentId).subscribe(deletion);
    // A refresh while the delete runs already lists a newly imported document.
    list.mockReturnValueOnce(of([summary, imported]));
    store.refreshDocuments();
    TestBed.tick();
    expect(store.allDocuments()).toEqual([summary, imported]);

    // The read after the error was taken before that import.
    const verification = new Subject<readonly DesktopLibrarySummary[]>();
    list.mockReturnValueOnce(verification);
    list.mockReturnValue(of([imported]));
    response.error(new Error('Capture library source cannot be deleted.'));
    expect(capture.isDocumentClaimed(summary.documentId)).toBe(true);
    verification.next([]);

    // The row is gone and the host removes the files it left at a later start.
    expect(deletion.error).not.toHaveBeenCalled();
    expect(deletion.next).toHaveBeenCalledOnce();
    expect(deletion.complete).toHaveBeenCalledOnce();
    expect(forget).toHaveBeenCalledExactlyOnceWith(summary.documentId);
    expect(store.allDocuments()).toEqual([imported]);
    expect(capture.isDocumentClaimed(summary.documentId)).toBe(false);
    TestBed.tick();
    // A refresh follows, as after an acknowledged delete.
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('offers deletion only for a document that is neither claimed nor linked to a runtime capture', () => {
    const free = { ...summary, documentId: '1'.repeat(32), status: 'completed' } satisfies DesktopLibrarySummary;
    const claimed = { ...summary, documentId: '2'.repeat(32) } satisfies DesktopLibrarySummary;
    const linked = {
      ...summary, documentId: '3'.repeat(32), status: 'recovery_required', captureId: 'capture-1',
      recoveryCode: 'runtime_cleanup_failed',
    } satisfies DesktopLibrarySummary;
    const busy = { ...summary, documentId: '4'.repeat(32), status: 'processing' } satisfies DesktopLibrarySummary;
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopLibraryService, useValue: { list: () => of([free, claimed, linked, busy]) } },
        { provide: DesktopRuntimeClientService, useValue: { started: signal(true) } },
        {
          provide: DesktopCaptureService,
          useValue: {
            busyIds: signal(new Set([busy.documentId])),
            // A capture runs, a batch scheduled one, or a decision reads the stored document.
            isDocumentClaimed: (documentId: string) => documentId === claimed.documentId,
          },
        },
      ],
    });
    const store = TestBed.inject(LibraryStore);
    TestBed.tick();

    expect(store.canDelete(free.documentId)).toBe(true);
    expect(store.canDelete(claimed.documentId)).toBe(false);
    expect(store.canDelete(linked.documentId)).toBe(false);
    expect(store.canDelete(busy.documentId)).toBe(false);
    expect(store.canDelete('5'.repeat(32))).toBe(false);
  });

  it('refreshes the selected document after processing and runtime ID updates', () => {
    const pendingCapture = new Subject<CaptureOperation>();
    const list = vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary]));
    const get = vi.fn(() => of<DesktopLibraryDetail>(summary));
    const library = libraryStub({ list, get });
    initializeShell(
      library,
      runtimeStub({ createCapture: vi.fn(() => pendingCapture) }),
    );
    TestBed.inject(LibraryStore).selectedId.set(summary.documentId);
    TestBed.tick();
    const beforeCapture = list.mock.calls.length;
    const detailBeforeCapture = get.mock.calls.length;

    library.dropped.next({ rejected: [], selections: [selection(summary.fileName)] });
    TestBed.tick();

    expect(list.mock.calls.length).toBeGreaterThan(beforeCapture);
    // The import alone refreshes the list; only the processing update reloads the selected detail.
    expect(get.mock.calls.length).toBeGreaterThan(detailBeforeCapture);
    const detailBeforeRuntimeId = get.mock.calls.length;
    const operation: CaptureOperation = {
      protocolVersion: '2',
      captureId: 'capture-1',
      ingestionId: 'ingestion-1',
      kind: 'pdf',
      status: 'cancelled',
      partialRevision: 0,
      lastEventSequence: 0,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    };
    pendingCapture.next(operation);
    pendingCapture.complete();
    TestBed.tick();

    expect(library.updateCapture).toHaveBeenCalledWith(expect.objectContaining({
      documentId: summary.documentId,
      captureId: operation.captureId,
      status: 'processing',
    }));
    expect(get.mock.calls.length).toBeGreaterThan(detailBeforeRuntimeId);
  });
});

function initializeShell(
  library: ReturnType<typeof libraryStub>,
  runtime: ReturnType<typeof runtimeStub>,
): void {
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter([]),
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: runtime },
      {
        provide: RecognitionFeaturesStore,
        useValue: {
          installing: signal(false),
          requirements: signal([]),
          requirementsResource: {
            error: () => undefined,
            status: () => 'resolved' as const,
          },
          requestedRequirements: signal(new Set()),
          message: signal(''),
          initialize: vi.fn(),
        },
      },
    ],
  }).overrideComponent(App, { set: { template: '' } });
  TestBed.createComponent(App);
  TestBed.tick();
}

function libraryStub(overrides: {
  list: () => Observable<readonly DesktopLibrarySummary[]>;
  get: () => Observable<DesktopLibraryDetail>;
}) {
  const dropped = new Subject<DesktopSourceSelectionBatch>();
  return {
    ...overrides,
    dropped,
    droppedSources: () => dropped,
    importSelection: () => of(summary),
    updateCapture: vi.fn(() => of(summary)),
  };
}

function runtimeStub(overrides: { createCapture: () => Subject<CaptureOperation> }) {
  return {
    ...overrides,
    ready: signal(true),
    started: signal(true),
    error: signal<Error | undefined>(undefined),
    ocrCompute: signal(null),
    pdfPageNumbers: signal<readonly number[] | undefined>(undefined),
    reload: vi.fn(),
    getComputeStatus: () => of({ cudaAvailable: false, preferGpu: true }),
    getRaw: () => of(null),
    deleteCapture: () => of(undefined),
  };
}

function selection(fileName: string): DesktopSourceSelection {
  return { selectionToken: fileName.padEnd(32, '0'), fileName, byteLength: 16,
    mediaType: fileName.endsWith('.png') ? 'image/png' : fileName.endsWith('.wav') ? 'audio/wav' : 'application/pdf' };
}
