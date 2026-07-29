import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CaptureJobV1 } from '@gx-capture/capture-workbench';
import { EMPTY, of, Subject, throwError } from 'rxjs';
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
    const library = libraryStub({
      createSource: vi.fn(() =>
        of({
          ...summary,
          fileName: 'voice.wav',
          mediaType: 'audio/wav',
        }),
      ),
    });
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

    store.addSourcePaths([String.raw`C:\private\voice.wav`]);
    TestBed.tick();

    expect(store.state()).toBe('needs-setup');
    expect(store.coreMissing().map((item) => item.requirementId)).toEqual([
      'whisper-primary',
    ]);
    expect(store.message()).toBe('請先安裝缺少的本機處理需求。');
    expect(library.createSource).toHaveBeenCalledOnce();
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

  it.each(['processing', 'persisting'] as const)(
    'resumes a retained runtime job after restart from %s without creating a replacement',
    (status) => {
      const retained = {
        ...summary,
        status,
        stage: status === 'processing' ? 'extracting' : 'completed',
        captureId: 'capture-restart',
      } satisfies DesktopLibrarySummary;
      const terminal = job({
        ...completedJob,
        captureId: 'capture-restart',
      });
      const createCapture = vi.fn(() => of(completedJob));
      const getCapture = vi.fn(() => of(terminal));
      const deleteCapture = vi.fn(() => of(undefined));
      const library = libraryStub({
        list: vi.fn(() => of([retained])),
        get: vi.fn(() => of(retained as DesktopLibraryDetail)),
      });
      const store = initializeStore(
        library,
        runtimeStub({ createCapture, getCapture, deleteCapture }),
      );

      store.retry(retained.documentId);
      TestBed.tick();

      expect(createCapture).not.toHaveBeenCalled();
      expect(getCapture).toHaveBeenCalledWith('capture-restart');
      expect(deleteCapture).toHaveBeenCalledWith('capture-restart');
    },
  );

  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['canceled', 'cancelled'],
  ] as const)(
    'retries only cleanup after restart when %s terminal data is already committed',
    (status, stage) => {
      const retained = {
        ...summary,
        status,
        stage,
        captureId: 'capture-committed',
        errorCode: status === 'completed' ? undefined : 'terminal_error',
        errorMessage: status === 'completed' ? undefined : 'terminal evidence',
      } satisfies DesktopLibrarySummary;
      const createCapture = vi.fn(() => of(completedJob));
      const getCapture = vi.fn(() => of(completedJob));
      const getRaw = vi.fn(() => of(raw));
      const deleteCapture = vi.fn(() => of(undefined));
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...retained, ...update } as DesktopLibrarySummary));
      const store = initializeStore(
        libraryStub({
          list: vi.fn(() => of([retained])),
          get: vi.fn(() => of(retained as DesktopLibraryDetail)),
          updateCapture,
        }),
        runtimeStub({ createCapture, getCapture, getRaw, deleteCapture }),
      );

      store.retry(retained.documentId);
      TestBed.tick();

      expect(createCapture).not.toHaveBeenCalled();
      expect(getCapture).not.toHaveBeenCalled();
      expect(getRaw).not.toHaveBeenCalled();
      expect(deleteCapture).toHaveBeenCalledWith('capture-committed');
      expect(captureUpdates(updateCapture)).toContainEqual(
        expect.objectContaining({
          status,
          clearCaptureId: true,
          errorCode: retained.errorCode,
          errorMessage: retained.errorMessage,
        }),
      );
    },
  );

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

  it('persists optional raw data before deleting a canceled runtime job', () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const getRaw = vi.fn(() => of(raw));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({
        createCapture: vi.fn(() => of(cancelledJob)),
        getRaw,
        deleteCapture,
      }),
    );

    store.retry(summary.documentId);
    TestBed.tick();

    expect(getRaw).toHaveBeenCalledWith('capture-1');
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'canceled',
        captureId: 'capture-1',
        raw,
      }),
    );
    expect(deleteCapture).toHaveBeenCalledWith('capture-1');
  });

  it('retains a canceled runtime job when optional raw retrieval fails', () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({
        createCapture: vi.fn(() => of(cancelledJob)),
        getRaw: vi.fn(() => throwError(() => new Error('raw transport failed'))),
        deleteCapture,
      }),
    );

    store.retry(summary.documentId);
    TestBed.tick();

    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
        recoveryCode: 'capture_recovery_required',
      }),
    );
    expect(deleteCapture).not.toHaveBeenCalled();
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
        recoveryCode: 'cancel_failed',
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
        recoveryCode: 'capture_recovery_required',
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
        recoveryCode: 'runtime_cleanup_failed',
      }),
    );
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'canceled'],
  ] as const)(
    'keeps %s terminal evidence separate when runtime cleanup fails',
    (runtimeStatus, libraryStatus) => {
      const terminal = job({
        captureId: 'capture-terminal-error',
        status: runtimeStatus,
        stage: runtimeStatus,
        error: {
          code: 'terminal_error',
          message: 'terminal evidence',
        },
      });
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...summary, ...update } as DesktopLibrarySummary));
      const deleteCapture = vi.fn(() =>
        throwError(() => new Error('cleanup transport failed')));
      const store = initializeStore(
        libraryStub({ updateCapture }),
        runtimeStub({
          createCapture: vi.fn(() => of(terminal)),
          deleteCapture,
        }),
      );

      store.retry(summary.documentId);
      TestBed.tick();

      expect(captureUpdates(updateCapture)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: libraryStatus,
          captureId: 'capture-terminal-error',
          raw,
          errorCode: 'terminal_error',
          errorMessage: 'terminal evidence',
        }),
        expect.objectContaining({
          status: 'recovery_required',
          captureId: 'capture-terminal-error',
          errorCode: 'terminal_error',
          errorMessage: 'terminal evidence',
          recoveryCode: 'runtime_cleanup_failed',
          recoveryMessage: 'cleanup transport failed',
        }),
      ]));
    },
  );

  it.each([
    ['failed', 'failed'],
    ['canceled', 'cancelled'],
  ] as const)(
    'preserves %s terminal evidence when retrying cleanup after restart',
    (status, stage) => {
      const recovery = {
        ...summary,
        status: 'recovery_required',
        stage,
        captureId: 'capture-cleanup-terminal',
        errorCode: 'terminal_error',
        errorMessage: 'terminal evidence',
        recoveryCode: 'runtime_cleanup_failed',
        recoveryMessage: 'cleanup transport failed',
      } satisfies DesktopLibrarySummary;
      const createCapture = vi.fn(() => of(completedJob));
      const getCapture = vi.fn(() => of(completedJob));
      const getRaw = vi.fn(() => of(raw));
      const deleteCapture = vi.fn(() => of(undefined));
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...recovery, ...update } as DesktopLibrarySummary));
      const store = initializeStore(
        libraryStub({
          list: vi.fn(() => of([recovery])),
          get: vi.fn(() => of(recovery as DesktopLibraryDetail)),
          updateCapture,
        }),
        runtimeStub({ createCapture, getCapture, getRaw, deleteCapture }),
      );

      store.retry(recovery.documentId);
      TestBed.tick();

      expect(createCapture).not.toHaveBeenCalled();
      expect(getCapture).not.toHaveBeenCalled();
      expect(getRaw).not.toHaveBeenCalled();
      expect(deleteCapture).toHaveBeenCalledWith('capture-cleanup-terminal');
      expect(captureUpdates(updateCapture)).toContainEqual(
        expect.objectContaining({
          status,
          clearCaptureId: true,
          errorCode: 'terminal_error',
          errorMessage: 'terminal evidence',
        }),
      );
    },
  );

  it('keeps cleanup-only recovery durable when both post-commit library writes fail', () => {
    const terminal = job({
      captureId: 'capture-double-write',
      status: 'failed',
      stage: 'failed',
      error: {
        code: 'terminal_error',
        message: 'terminal evidence',
      },
    });
    let durable: DesktopLibrarySummary = summary;
    let clearWriteFailed = false;
    let recoveryWriteFailed = false;
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      if (
        update['clearCaptureId'] === true
        && update['status'] === 'failed'
        && !clearWriteFailed
      ) {
        clearWriteFailed = true;
        return throwError(() => new Error('clear link write failed'));
      }
      if (
        update['recoveryCode'] === 'runtime_cleanup_failed'
        && !recoveryWriteFailed
      ) {
        recoveryWriteFailed = true;
        return throwError(() => new Error('recovery metadata write failed'));
      }
      durable = applyDurableCaptureUpdate(durable, update);
      return of(durable);
    });
    const library = libraryStub({
      list: vi.fn(() => of([durable])),
      get: vi.fn(() => of(durable as DesktopLibraryDetail)),
      updateCapture,
    });
    const deleteCapture = vi.fn(() => of(undefined));
    const firstStore = initializeStore(
      library,
      runtimeStub({
        createCapture: vi.fn(() => of(terminal)),
        deleteCapture,
      }),
    );

    firstStore.retry(summary.documentId);
    TestBed.tick();

    expect(clearWriteFailed).toBe(true);
    expect(recoveryWriteFailed).toBe(true);
    expect(durable).toEqual(expect.objectContaining({
      status: 'recovery_required',
      stage: 'failed',
      captureId: 'capture-double-write',
      errorCode: 'terminal_error',
      errorMessage: 'terminal evidence',
      recoveryCode: 'runtime_cleanup_failed',
      recoveryMessage: 'recovery metadata write failed',
    }));

    TestBed.resetTestingModule();
    const createAfterRestart = vi.fn(() => of(completedJob));
    const getAfterRestart = vi.fn(() => of(completedJob));
    const getRawAfterRestart = vi.fn(() => of(raw));
    const restartedStore = initializeStore(
      library,
      runtimeStub({
        createCapture: createAfterRestart,
        getCapture: getAfterRestart,
        getRaw: getRawAfterRestart,
        deleteCapture,
      }),
    );

    restartedStore.retry(summary.documentId);
    TestBed.tick();

    expect(createAfterRestart).not.toHaveBeenCalled();
    expect(getAfterRestart).not.toHaveBeenCalled();
    expect(getRawAfterRestart).not.toHaveBeenCalled();
    expect(deleteCapture).toHaveBeenCalledTimes(2);
    expect(durable).toEqual(expect.objectContaining({
      status: 'failed',
      captureId: undefined,
      errorCode: 'terminal_error',
      errorMessage: 'terminal evidence',
      recoveryCode: undefined,
      recoveryMessage: undefined,
    }));
  });

  it('keeps cleanup-only recovery durable when retry cleanup writes fail twice', () => {
    let durable: DesktopLibrarySummary = {
      ...summary,
      status: 'recovery_required',
      stage: 'cancelled',
      captureId: 'capture-retry-double-write',
      errorCode: 'terminal_cancelled',
      errorMessage: 'canceled terminal evidence',
      recoveryCode: 'runtime_cleanup_failed',
      recoveryMessage: 'initial cleanup failure',
    };
    let clearWriteFailed = false;
    let recoveryWriteFailed = false;
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      if (update['clearCaptureId'] === true && !clearWriteFailed) {
        clearWriteFailed = true;
        return throwError(() => new Error('retry clear link write failed'));
      }
      if (
        update['recoveryCode'] === 'runtime_cleanup_failed'
        && !recoveryWriteFailed
      ) {
        recoveryWriteFailed = true;
        return throwError(() => new Error('retry recovery metadata write failed'));
      }
      durable = applyDurableCaptureUpdate(durable, update);
      return of(durable);
    });
    const library = libraryStub({
      list: vi.fn(() => of([durable])),
      get: vi.fn(() => of(durable as DesktopLibraryDetail)),
      updateCapture,
    });
    const createCapture = vi.fn(() => of(completedJob));
    const getCapture = vi.fn(() => of(completedJob));
    const getRaw = vi.fn(() => of(raw));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeStore(
      library,
      runtimeStub({ createCapture, getCapture, getRaw, deleteCapture }),
    );

    store.retry(summary.documentId);
    TestBed.tick();

    expect(clearWriteFailed).toBe(true);
    expect(recoveryWriteFailed).toBe(true);
    expect(createCapture).not.toHaveBeenCalled();
    expect(getCapture).not.toHaveBeenCalled();
    expect(getRaw).not.toHaveBeenCalled();
    expect(deleteCapture).toHaveBeenCalledOnce();
    expect(durable).toEqual(expect.objectContaining({
      status: 'recovery_required',
      stage: 'cancelled',
      captureId: 'capture-retry-double-write',
      errorCode: 'terminal_cancelled',
      errorMessage: 'canceled terminal evidence',
      recoveryCode: 'runtime_cleanup_failed',
      recoveryMessage: 'retry recovery metadata write failed',
    }));
  });

  it('recovers persistence with the same runtime ID and never creates a new job', () => {
    const recovery = {
      ...summary,
      status: 'recovery_required',
      stage: 'completed',
      captureId: 'capture-recovery',
      recoveryCode: 'capture_recovery_required',
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
      recoveryCode: 'runtime_cleanup_failed',
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
    selectSources: vi.fn(() => of<readonly string[]>([])),
    droppedSources: vi.fn(() => EMPTY),
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

function applyDurableCaptureUpdate(
  current: DesktopLibrarySummary,
  update: Record<string, unknown>,
): DesktopLibrarySummary {
  return {
    ...current,
    ...update,
    captureId: update['clearCaptureId'] === true
      ? undefined
      : typeof update['captureId'] === 'string'
        ? update['captureId']
        : current.captureId,
    errorCode: typeof update['errorCode'] === 'string' ? update['errorCode'] : undefined,
    errorMessage: typeof update['errorMessage'] === 'string' ? update['errorMessage'] : undefined,
    recoveryCode: typeof update['recoveryCode'] === 'string' ? update['recoveryCode'] : undefined,
    recoveryMessage: typeof update['recoveryMessage'] === 'string'
      ? update['recoveryMessage']
      : undefined,
  } as DesktopLibrarySummary;
}

function job(input: Record<string, unknown>): CaptureJobV1 {
  return input as unknown as CaptureJobV1;
}
