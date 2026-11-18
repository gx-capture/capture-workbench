import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CaptureOperation } from '@gx-capture/capture-workbench-ui';
import { provideRouter } from '@angular/router';
import { of, Subject, type Observable } from 'rxjs';
import { App } from '../app';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
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
