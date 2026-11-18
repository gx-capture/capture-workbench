import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CaptureOperation } from '@gx-capture/capture-workbench-ui';
import { EMPTY, of, Subject, type Observable } from 'rxjs';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
import { DesktopLibraryService, type DesktopSourceSelection } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceStore } from './desktop-workspace.store';
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
    const store = initializeStore(
      libraryStub({ list, get }),
      runtimeStub({ createCapture: vi.fn(() => pendingCapture) }),
    );
    TestBed.inject(LibraryStore).selectedId.set(summary.documentId);
    TestBed.tick();
    const beforeCapture = list.mock.calls.length;
    const detailBeforeCapture = get.mock.calls.length;

    store.addSelections({ rejected: [], selections: [selection(summary.fileName)] });
    TestBed.tick();

    expect(list.mock.calls.length).toBeGreaterThan(beforeCapture);
    // The import alone refreshes the list; only the processing update reloads the selected detail.
    expect(get.mock.calls.length).toBeGreaterThan(detailBeforeCapture);
    pendingCapture.complete();
  });
});

function initializeStore(
  library: ReturnType<typeof libraryStub>,
  runtime: ReturnType<typeof runtimeStub>,
): DesktopWorkspaceStore {
  TestBed.configureTestingModule({
    providers: [
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
  });
  const store = TestBed.inject(DesktopWorkspaceStore);
  store.initialize();
  TestBed.tick();
  return store;
}

function libraryStub(overrides: {
  list: () => Observable<readonly DesktopLibrarySummary[]>;
  get: () => Observable<DesktopLibraryDetail>;
}) {
  return {
    ...overrides,
    droppedSources: () => EMPTY,
    importSelection: () => of(summary),
    updateCapture: () => of(summary),
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
  };
}

function selection(fileName: string): DesktopSourceSelection {
  return { selectionToken: fileName.padEnd(32, '0'), fileName, byteLength: 16,
    mediaType: fileName.endsWith('.png') ? 'image/png' : fileName.endsWith('.wav') ? 'audio/wav' : 'application/pdf' };
}
