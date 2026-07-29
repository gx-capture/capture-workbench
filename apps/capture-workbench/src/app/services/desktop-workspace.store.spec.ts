import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CaptureJobV1 } from '@gx-capture/capture-workbench';
import { of, Subject, throwError } from 'rxjs';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceStore } from './desktop-workspace.store';

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

const runningJob = job({
  captureId: 'capture-1',
  status: 'running',
  stage: 'extracting',
});
const completedJob = job({
  captureId: 'capture-1',
  status: 'completed',
  stage: 'completed',
});
const cancelledJob = job({
  captureId: 'capture-1',
  status: 'cancelled',
  stage: 'cancelled',
});
const raw = { sourceText: 'OCR text' };
const result = { targetText: 'translated text' };

describe('DesktopWorkspaceStore', () => {
  it('keeps WindowsML and Ollama installation behind one explicit setup action', () => {
    const library = libraryStub();
    const client = runtimeStub({
      getRequirements: vi.fn(() => of([
        {
          requirementId: 'windowsml-ocr',
          displayName: 'WindowsML OCR',
          status: 'installable',
          kind: 'engine',
          requiredFor: ['capture'],
          installStrategy: 'automatic',
        },
        {
          requirementId: 'ollama-runtime',
          displayName: 'Ollama',
          status: 'missing',
          kind: 'runtime',
          requiredFor: ['structuring'],
          installStrategy: 'winget',
        },
      ])),
    });

    const store = initializeStore(library, client);

    expect(store.state()).toBe('needs-setup');
    expect(store.coreMissing().map((item) => item.requirementId)).toEqual([
      'windowsml-ocr',
      'ollama-runtime',
    ]);
  });

  it('restores the exact ready message after readiness resources resolve', () => {
    const store = initializeStore(libraryStub(), runtimeStub());

    expect(store.state()).toBe('ready');
    expect(store.message()).toBe(
      'Capture Runtime 已準備完成，可以開始處理文件。',
    );
  });

  it('asks for Whisper only when an allowed audio source is selected', () => {
    const library = libraryStub();
    const client = runtimeStub({
      getRequirements: vi.fn(() => of([{
        requirementId: 'whisper-primary',
        displayName: 'Whisper',
        status: 'missing',
        kind: 'model',
        requiredFor: ['audio'],
        installStrategy: 'automatic',
      }])),
    });
    const store = initializeStore(library, client);

    store.addFiles([new File(['audio'], 'voice.wav', { type: 'audio/wav' })]);
    TestBed.tick();

    expect(store.state()).toBe('needs-setup');
    expect(store.coreMissing().map((item) => item.requirementId)).toEqual([
      'whisper-primary',
    ]);
    expect(store.message()).toBe('請先安裝缺少的本機處理需求。');
    expect(library.createSource).not.toHaveBeenCalled();
  });

  it('persists the runtime ID before terminal data and clears it only after DELETE', () => {
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      events.push(
        `library:${String(update['status'])}:${String(update['clearCaptureId'] ?? false)}`,
      );
      return of({ ...summary, ...update, updatedAtMs: 2 } as DesktopLibrarySummary);
    });
    const deleteCapture = vi.fn(() => {
      events.push('runtime:delete');
      return of(undefined);
    });
    const library = libraryStub({ updateCapture });
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedJob)),
      deleteCapture,
    });
    const store = initializeStore(library, client);

    store.retry(summary.documentId);
    TestBed.tick();

    const updates = captureUpdates(updateCapture);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'processing',
        captureId: 'capture-1',
      }),
      expect.objectContaining({
        status: 'persisting',
        captureId: 'capture-1',
      }),
      expect.objectContaining({
        status: 'completed',
        captureId: 'capture-1',
        raw,
        result,
      }),
      expect.objectContaining({
        status: 'completed',
        clearCaptureId: true,
      }),
    ]));
    expect(events.indexOf('library:completed:false')).toBeLessThan(
      events.indexOf('runtime:delete'),
    );
    expect(events.indexOf('runtime:delete')).toBeLessThan(
      events.indexOf('library:completed:true'),
    );
    expect(deleteCapture).toHaveBeenCalledWith('capture-1');
  });

  it('remembers repeated cancel clicks before create resolves and sends one independent request', () => {
    const created = new Subject<CaptureJobV1>();
    const cancelCapture = vi.fn(() => of(cancelledJob));
    const getCapture = vi.fn(() => of(completedJob));
    const library = libraryStub();
    const client = runtimeStub({
      createCapture: vi.fn(() => created),
      cancelCapture,
      getCapture,
    });
    const store = initializeStore(library, client);

    store.retry(summary.documentId);
    store.cancel(summary.documentId);
    store.cancel(summary.documentId);
    created.next(runningJob);
    created.complete();
    TestBed.tick();

    expect(cancelCapture).toHaveBeenCalledOnce();
    expect(cancelCapture).toHaveBeenCalledWith('capture-1');
    expect(getCapture).not.toHaveBeenCalled();
  });

  it('interrupts an in-flight poll and sends cancellation immediately', () => {
    const polled = new Subject<CaptureJobV1>();
    const cancelCapture = vi.fn(() => of(cancelledJob));
    const getCapture = vi.fn(() => polled);
    const client = runtimeStub({
      createCapture: vi.fn(() => of(runningJob)),
      cancelCapture,
      getCapture,
    });
    const store = initializeStore(libraryStub(), client);

    vi.useFakeTimers();
    try {
      store.retry(summary.documentId);
      vi.advanceTimersByTime(700);
      expect(getCapture).toHaveBeenCalledWith('capture-1');
      expect(cancelCapture).not.toHaveBeenCalled();

      store.cancel(summary.documentId);
      TestBed.tick();

      expect(cancelCapture).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an already-terminal runtime response win a cancel/complete race', () => {
    const created = new Subject<CaptureJobV1>();
    const cancelCapture = vi.fn(() => of(cancelledJob));
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => created),
      cancelCapture,
      deleteCapture,
    });
    const store = initializeStore(libraryStub(), client);

    store.retry(summary.documentId);
    store.cancel(summary.documentId);
    created.next(completedJob);
    created.complete();
    TestBed.tick();

    expect(cancelCapture).not.toHaveBeenCalled();
    expect(deleteCapture).toHaveBeenCalledWith('capture-1');
  });

  it('retains the capture ID and skips DELETE when cancellation fails', () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => of(runningJob)),
      cancelCapture: vi.fn(() =>
        throwError(() => new Error('cancel request failed'))),
      deleteCapture,
    });
    const store = initializeStore(libraryStub({ updateCapture }), client);

    store.retry(summary.documentId);
    store.cancel(summary.documentId);
    TestBed.tick();

    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
        errorCode: 'cancel_failed',
      }),
    );
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it.each([
    ['raw retrieval', {
      getRaw: vi.fn(() => throwError(() => new Error('raw failed'))),
    }],
    ['result retrieval', {
      getResult: vi.fn(() => throwError(() => new Error('result failed'))),
    }],
  ])('retains the runtime job when %s fails', (_case, runtimeOverride) => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedJob)),
      deleteCapture,
      ...runtimeOverride,
    });
    const store = initializeStore(libraryStub({ updateCapture }), client);

    store.retry(summary.documentId);
    TestBed.tick();

    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
        errorCode: 'capture_recovery_required',
      }),
    );
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it('retains the runtime job when the terminal library commit fails', () => {
    let terminalCommitAttempted = false;
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      if (update['status'] === 'completed' && !update['clearCaptureId']) {
        terminalCommitAttempted = true;
        return throwError(() => new Error('library commit failed'));
      }
      return of({ ...summary, ...update } as DesktopLibrarySummary);
    });
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedJob)),
      deleteCapture,
    });
    const store = initializeStore(libraryStub({ updateCapture }), client);

    store.retry(summary.documentId);
    TestBed.tick();

    expect(terminalCommitAttempted).toBe(true);
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
      }),
    );
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it('retains a recovery link when runtime DELETE fails after a successful commit', () => {
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      events.push(`library:${String(update['status'])}`);
      return of({ ...summary, ...update } as DesktopLibrarySummary);
    });
    const deleteCapture = vi.fn(() => {
      events.push('runtime:delete');
      return throwError(() => new Error('delete failed'));
    });
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedJob)),
      deleteCapture,
    });
    const store = initializeStore(libraryStub({ updateCapture }), client);

    store.retry(summary.documentId);
    TestBed.tick();

    expect(events.indexOf('library:completed')).toBeLessThan(
      events.indexOf('runtime:delete'),
    );
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
        errorCode: 'runtime_cleanup_failed',
      }),
    );
  });

  it('recovers persistence with the same runtime ID and never creates a new job', () => {
    const recovery = {
      ...summary,
      status: 'recovery_required',
      stage: 'completed',
      captureId: 'capture-recovery',
      errorCode: 'capture_recovery_required',
    } satisfies DesktopLibrarySummary;
    const createCapture = vi.fn(() => of(completedJob));
    const getCapture = vi.fn(() => of(job({
      ...completedJob,
      captureId: 'capture-recovery',
    })));
    const deleteCapture = vi.fn(() => of(undefined));
    const library = libraryStub({
      list: vi.fn(() => of([recovery])),
      get: vi.fn(() => of(recovery as DesktopLibraryDetail)),
    });
    const client = runtimeStub({ createCapture, getCapture, deleteCapture });
    const store = initializeStore(library, client);

    store.retry(recovery.documentId);
    TestBed.tick();

    expect(createCapture).not.toHaveBeenCalled();
    expect(getCapture).toHaveBeenCalledWith('capture-recovery');
    expect(deleteCapture).toHaveBeenCalledWith('capture-recovery');
  });

  it('retries only DELETE for a cleanup recovery and treats success as clearable', () => {
    const recovery = {
      ...summary,
      status: 'recovery_required',
      stage: 'completed',
      captureId: 'capture-cleanup',
      errorCode: 'runtime_cleanup_failed',
    } satisfies DesktopLibrarySummary;
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...recovery, ...update } as DesktopLibrarySummary));
    const createCapture = vi.fn(() => of(completedJob));
    const getCapture = vi.fn(() => of(completedJob));
    const deleteCapture = vi.fn(() => of(undefined));
    const library = libraryStub({
      list: vi.fn(() => of([recovery])),
      get: vi.fn(() => of(recovery as DesktopLibraryDetail)),
      updateCapture,
    });
    const client = runtimeStub({ createCapture, getCapture, deleteCapture });
    const store = initializeStore(library, client);

    store.retry(recovery.documentId);
    TestBed.tick();

    expect(createCapture).not.toHaveBeenCalled();
    expect(getCapture).not.toHaveBeenCalled();
    expect(deleteCapture).toHaveBeenCalledWith('capture-cleanup');
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'completed',
        clearCaptureId: true,
      }),
    );
  });
});

function initializeStore(
  library: ReturnType<typeof libraryStub>,
  client: ReturnType<typeof runtimeStub>,
): DesktopWorkspaceStore {
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: client },
      DesktopWorkspaceStore,
    ],
  });
  const store = TestBed.inject(DesktopWorkspaceStore);
  store.initialize();
  TestBed.tick();
  return store;
}

function libraryStub(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([])),
    get: vi.fn(() => of<DesktopLibraryDetail>(summary)),
    createSource: vi.fn(() => of(summary)),
    updateCapture: vi.fn(() => of(summary)),
    export: vi.fn(),
    delete: vi.fn(() => of(undefined)),
  }, overrides);
}

function runtimeStub(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    ready: signal(true),
    error: signal<Error | undefined>(undefined),
    reload: vi.fn(),
    getRequirements: vi.fn(() => of([])),
    startInstallation: vi.fn(),
    getInstallation: vi.fn(),
    createCapture: vi.fn(() => of(completedJob)),
    getCapture: vi.fn(() => of(completedJob)),
    cancelCapture: vi.fn(() => of(cancelledJob)),
    getRaw: vi.fn(() => of(raw)),
    getResult: vi.fn(() => of(result)),
    deleteCapture: vi.fn(() => of(undefined)),
  }, overrides);
}

function captureUpdates(
  updateCapture: ReturnType<typeof vi.fn>,
): readonly Record<string, unknown>[] {
  return updateCapture.mock.calls.map(
    ([update]) => update as Record<string, unknown>,
  );
}

function job(input: Record<string, unknown>): CaptureJobV1 {
  return input as unknown as CaptureJobV1;
}
