import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CaptureEventV2, CaptureOperationV2 } from '@gx-capture/capture-workbench';
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

const source = {
  sha256: 'a'.repeat(64),
  fileName: 'fixture.pdf',
  mediaType: 'application/pdf',
  bytes: 12,
};
const runningOperation: CaptureOperationV2 = {
  protocolVersion: '2',
  captureId: 'capture-1',
  ingestionId: 'ingestion-1',
  kind: 'pdf',
  status: 'extracting',
  progress: 0.5,
  partialRevision: 0,
  lastEventSequence: 0,
  source,
  createdAt: '2026-07-20T00:00:00Z',
  updatedAt: '2026-07-20T00:00:00Z',
};
const completedOperation: CaptureOperationV2 = {
  ...runningOperation,
  status: 'completed',
  progress: 1,
  partialRevision: 1,
  lastEventSequence: 1,
  updatedAt: '2026-07-20T00:00:01Z',
  completedAt: '2026-07-20T00:00:01Z',
};
const cancelledOperation: CaptureOperationV2 = {
  ...runningOperation,
  status: 'cancelled',
  updatedAt: '2026-07-20T00:00:01Z',
  completedAt: '2026-07-20T00:00:01Z',
};
const partial = {
  protocolVersion: '2' as const,
  captureId: 'capture-1',
  source,
  revision: 1,
  coveredUntilMs: 1,
  sourceText: 'OCR text',
  updatedAt: '2026-07-20T00:00:00Z',
};
const raw = { sourceText: 'OCR text' };
const result = { targetText: 'translated text' };
const terminalResult = {
  operation: completedOperation,
  raw,
  result,
};

describe('DesktopWorkspaceStore', () => {
  it('retains a terminal model installation identity for UI and Tauri diagnostics', () => {
    const failedInstallation = {
      installationId: 'model-installation-1',
      optionId: 'qwen3.5-0.8b-v1',
      status: 'failed' as const,
      progress: 0.1,
      error: {
        code: 'installation_failed',
        message: 'Runtime model installation failed.',
        stage: 'runtime',
      },
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:01Z',
      completedAt: '2026-07-20T00:00:01Z',
    };
    const startModelInstallation = vi.fn(() => of(failedInstallation));
    const store = initializeStore(
      libraryStub(),
      runtimeStub({ startModelInstallation }),
    );
    store.selectModelOption('qwen3.5-0.8b-v1');

    store.installSelectedModel();
    TestBed.tick();

    expect(startModelInstallation).toHaveBeenCalledWith({
      clientRequestId: expect.any(String),
      optionId: 'qwen3.5-0.8b-v1',
      consent: true,
    });
    expect(store.activeModelInstallation()).toEqual(failedInstallation);
    expect(store.installing()).toBe(false);
    expect(store.message()).toContain('installation_failed');
  });

  it('does not offer or start installation for unavailable catalog requirements', () => {
    const startInstallation = vi.fn();
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'windowsml-ocr',
            displayName: 'WindowsML OCR',
            status: 'unavailable',
            kind: 'engine',
            requiredFor: ['capture'],
            installStrategy: 'none',
            detail: 'No catalog artifact is available.',
          },
        ])),
        startInstallation,
      }),
    );

    expect(store.state()).toBe('needs-setup');
    expect(store.installableCoreRequirements()).toEqual([]);
    store.installCoreRequirements();

    expect(startInstallation).not.toHaveBeenCalled();
  });

  it('redacts bearer credentials from runtime errors shown to the host UI', () => {
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        getRequirements: vi.fn(() =>
          throwError(() => new Error('Bearer secret-token')),
        ),
      }),
    );

    expect(store.message()).toBe('Bearer [redacted]');
    expect(store.message()).not.toContain('secret-token');
  });

  it('installs OCR before Whisper through one sequential consent action', () => {
    const startInstallation = vi.fn((request: { requirementId: string }) =>
      of({
        installationId: `install-${request.requirementId}`,
        requirementId: request.requirementId,
        status: 'completed' as const,
        progress: 1,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
        completedAt: '2026-07-20T00:00:00Z',
      }),
    );
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'whisper-primary',
            displayName: 'Whisper',
            status: 'installable',
            kind: 'model',
            requiredFor: ['audio'],
            installStrategy: 'runtime-catalog',
          },
          {
            requirementId: 'windowsml-ocr',
            displayName: 'WindowsML OCR',
            status: 'installable',
            kind: 'engine',
            requiredFor: ['capture'],
            installStrategy: 'runtime-catalog',
          },
        ])),
        startInstallation,
      }),
    );
    store.requestedRequirements.set(new Set(['whisper-primary']));

    store.installCoreRequirements();
    TestBed.tick();

    expect(startInstallation.mock.calls.map(([request]) => request.requirementId)).toEqual([
      'windowsml-ocr',
      'whisper-primary',
    ]);
  });

  it('polls queued and running installations until the first terminal status', () => {
    const observedStatuses: string[] = [];
    const startInstallation = vi.fn(() => {
      observedStatuses.push('queued');
      return of({
        installationId: 'install-windowsml-ocr',
        requirementId: 'windowsml-ocr' as const,
        status: 'queued' as const,
        progress: 0,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
      });
    });
    const getInstallation = vi.fn(() => {
      const status = getInstallation.mock.calls.length === 1 ? 'running' : 'completed';
      observedStatuses.push(status);
      return of({
        installationId: 'install-windowsml-ocr',
        requirementId: 'windowsml-ocr' as const,
        status,
        progress: status === 'completed' ? 1 : 0.5,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
        ...(status === 'completed' ? { completedAt: '2026-07-20T00:00:00Z' } : {}),
      });
    });
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        getRequirements: vi.fn(() => of([{
          requirementId: 'windowsml-ocr',
          displayName: 'WindowsML OCR',
          status: 'installable',
          kind: 'engine',
          requiredFor: ['capture'],
          installStrategy: 'runtime-catalog',
        }])),
        startInstallation,
        getInstallation,
      }),
    );

    vi.useFakeTimers();
    try {
      store.installCoreRequirements();
      expect(observedStatuses).toEqual(['queued']);

      vi.advanceTimersByTime(1_500);
      TestBed.tick();

      expect(observedStatuses).toEqual(['queued', 'running', 'completed']);
      expect(getInstallation).toHaveBeenCalledTimes(2);
      expect(store.installing()).toBe(false);
      expect(store.activeInstallation()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

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
    const deleteStreamingCapture = vi.fn(() => {
      events.push('runtime:delete');
      return of(undefined);
    });
    const library = libraryStub({ updateCapture });
    const client = runtimeStub({
      startStreamingCapture: vi.fn(() => of(completedOperation)),
      deleteStreamingCapture,
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
    expect(deleteStreamingCapture).toHaveBeenCalledWith('capture-1');
  });

  it('reloads the snapshot and reconnects after a desktop resync_required event', () => {
    const firstEvents = new Subject<readonly CaptureEventV2[]>();
    const secondEvents = new Subject<readonly CaptureEventV2[]>();
    const getStreamingEvents = vi
      .fn()
      .mockReturnValueOnce(firstEvents)
      .mockReturnValueOnce(secondEvents);
    const resyncedOperation = {
      ...runningOperation,
      progress: 0.7,
      lastEventSequence: 7,
    };
    const getStreamingCapture = vi
      .fn()
      .mockReturnValueOnce(of(resyncedOperation))
      .mockReturnValueOnce(of(completedOperation));
    const resyncEvent: CaptureEventV2 = {
      protocolVersion: '2',
      eventId: 'capture-1/7',
      sequence: 7,
      captureId: 'capture-1',
      kind: 'pdf',
      eventType: 'resync_required',
      stage: 'resync',
      partialRevision: 1,
      createdAt: '2026-07-20T00:00:01Z',
    };
    const completedEvent: CaptureEventV2 = {
      ...resyncEvent,
      eventId: 'capture-1/8',
      sequence: 8,
      eventType: 'completed',
      stage: 'completed',
      progress: 1,
    };
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        startStreamingCapture: vi.fn(() => of(runningOperation)),
        getStreamingEvents,
        getStreamingCapture,
      }),
    );

    store.retry(summary.documentId);
    TestBed.tick();
    expect(getStreamingEvents).toHaveBeenCalledWith('capture-1', 0);

    firstEvents.next([resyncEvent]);
    firstEvents.complete();
    TestBed.tick();

    expect(getStreamingCapture).toHaveBeenCalledTimes(1);
    expect(store.partialFor(summary.documentId)).toEqual(partial);
    expect(getStreamingEvents).toHaveBeenNthCalledWith(2, 'capture-1', 7);

    secondEvents.next([completedEvent]);
    secondEvents.complete();
    TestBed.tick();

    expect(getStreamingCapture).toHaveBeenCalledTimes(2);
    expect(getStreamingEvents).toHaveBeenCalledTimes(2);
  });

  it('reloads the snapshot and reconnects after a nonterminal desktop SSE completion', () => {
    const firstEvents = new Subject<readonly CaptureEventV2[]>();
    const secondEvents = new Subject<readonly CaptureEventV2[]>();
    const getStreamingEvents = vi
      .fn()
      .mockReturnValueOnce(firstEvents)
      .mockReturnValueOnce(secondEvents);
    const recoveredOperation = {
      ...runningOperation,
      progress: 0.7,
      lastEventSequence: 7,
    };
    const getStreamingCapture = vi
      .fn()
      .mockReturnValueOnce(of(recoveredOperation))
      .mockReturnValueOnce(of(completedOperation));
    const checkpointEvent: CaptureEventV2 = {
      protocolVersion: '2',
      eventId: 'capture-1/6',
      sequence: 6,
      captureId: 'capture-1',
      kind: 'pdf',
      eventType: 'checkpoint',
      stage: 'extracting',
      progress: 0.6,
      partialRevision: 1,
      createdAt: '2026-07-20T00:00:01Z',
    };
    const completedEvent: CaptureEventV2 = {
      ...checkpointEvent,
      eventId: 'capture-1/8',
      sequence: 8,
      eventType: 'completed',
      stage: 'completed',
      progress: 1,
    };
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        startStreamingCapture: vi.fn(() => of(runningOperation)),
        getStreamingEvents,
        getStreamingCapture,
      }),
    );

    store.retry(summary.documentId);
    TestBed.tick();
    firstEvents.next([checkpointEvent]);
    TestBed.tick();
    expect(getStreamingCapture).not.toHaveBeenCalled();
    expect(getStreamingEvents).toHaveBeenCalledTimes(1);
    expect(store.streamingProgressFor(summary.documentId)).toBe(0.6);
    firstEvents.complete();
    TestBed.tick();

    expect(getStreamingEvents).toHaveBeenNthCalledWith(2, 'capture-1', 7);
    secondEvents.next([completedEvent]);
    secondEvents.complete();
    TestBed.tick();

    expect(getStreamingCapture).toHaveBeenCalledTimes(2);
    expect(getStreamingEvents).toHaveBeenCalledTimes(2);
  });

  it('reloads the snapshot and reconnects after a recoverable desktop SSE error', () => {
    const secondEvents = new Subject<readonly CaptureEventV2[]>();
    const getStreamingEvents = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('stream reset')))
      .mockReturnValueOnce(secondEvents);
    const recoveredOperation = {
      ...runningOperation,
      progress: 0.7,
      lastEventSequence: 7,
    };
    const getStreamingCapture = vi
      .fn()
      .mockReturnValueOnce(of(recoveredOperation))
      .mockReturnValueOnce(of(completedOperation));
    const completedEvent: CaptureEventV2 = {
      protocolVersion: '2',
      eventId: 'capture-1/8',
      sequence: 8,
      captureId: 'capture-1',
      kind: 'pdf',
      eventType: 'completed',
      stage: 'completed',
      progress: 1,
      partialRevision: 1,
      createdAt: '2026-07-20T00:00:01Z',
    };
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        startStreamingCapture: vi.fn(() => of(runningOperation)),
        getStreamingEvents,
        getStreamingCapture,
      }),
    );

    store.retry(summary.documentId);
    TestBed.tick();
    expect(getStreamingEvents).toHaveBeenCalledWith('capture-1', 0);

    secondEvents.next([completedEvent]);
    secondEvents.complete();
    TestBed.tick();

    expect(getStreamingEvents).toHaveBeenCalledTimes(2);
    expect(getStreamingCapture).toHaveBeenCalledTimes(2);
  });

  it('keeps the v2 partial available while the terminal result is committed', () => {
    const structuringOperation: CaptureOperationV2 = {
      ...runningOperation,
      captureId: 'capture-1',
      status: 'structuring',
    };
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const getStreamingPartial = vi.fn(() => of(partial));
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({
        startStreamingCapture: vi.fn(() => of(structuringOperation)),
        getStreamingCapture: vi.fn(() => of(completedOperation)),
        getStreamingPartial,
      }),
    );

    vi.useFakeTimers();
    try {
      store.retry(summary.documentId);
      vi.advanceTimersByTime(700);
      TestBed.tick();

      const updates = captureUpdates(updateCapture);
      const rawUpdates = updates.filter((update) => 'raw' in update);
      const resultIndex = updates.findIndex(
        (update) => update['status'] === 'completed' && 'result' in update,
      );

      expect(rawUpdates).toHaveLength(1);
      expect(rawUpdates[0]).toEqual(expect.objectContaining({
        documentId: summary.documentId,
        captureId: 'capture-1',
        status: 'completed',
        raw,
        result,
      }));
      expect(resultIndex).toBe(updates.indexOf(rawUpdates[0]));
      expect(updates[resultIndex]).toEqual(expect.objectContaining({
        status: 'completed',
        captureId: 'capture-1',
        result,
      }));
      expect(getStreamingPartial).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['processing', 'persisting'] as const)(
    'resumes a retained runtime operation after restart from %s without creating a replacement',
    (status) => {
      const retained = {
        ...summary,
        status,
        stage: status === 'processing' ? 'extracting' : 'completed',
        captureId: 'capture-restart',
      } satisfies DesktopLibrarySummary;
      const terminal: CaptureOperationV2 = {
        ...completedOperation,
        captureId: 'capture-restart',
      };
      const startStreamingCapture = vi.fn(() => of(completedOperation));
      const getStreamingCapture = vi.fn(() => of(terminal));
      const deleteStreamingCapture = vi.fn(() => of(undefined));
      const library = libraryStub({
        list: vi.fn(() => of([retained])),
        get: vi.fn(() => of(retained as DesktopLibraryDetail)),
      });
      const store = initializeStore(
        library,
        runtimeStub({ startStreamingCapture, getStreamingCapture, deleteStreamingCapture }),
      );

      store.retry(retained.documentId);
      TestBed.tick();

      expect(startStreamingCapture).not.toHaveBeenCalled();
      expect(getStreamingCapture).toHaveBeenCalledWith('capture-restart');
      expect(deleteStreamingCapture).toHaveBeenCalledWith('capture-restart');
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
      const startStreamingCapture = vi.fn(() => of(completedOperation));
      const getStreamingCapture = vi.fn(() => of(completedOperation));
      const getStreamingPartial = vi.fn(() => of(partial));
      const deleteStreamingCapture = vi.fn(() => of(undefined));
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...retained, ...update } as DesktopLibrarySummary));
      const store = initializeStore(
        libraryStub({
          list: vi.fn(() => of([retained])),
          get: vi.fn(() => of(retained as DesktopLibraryDetail)),
          updateCapture,
        }),
        runtimeStub({ startStreamingCapture, getStreamingCapture, getStreamingPartial, deleteStreamingCapture }),
      );

      store.retry(retained.documentId);
      TestBed.tick();

      expect(startStreamingCapture).not.toHaveBeenCalled();
      expect(getStreamingCapture).not.toHaveBeenCalled();
      expect(getStreamingPartial).not.toHaveBeenCalled();
      expect(deleteStreamingCapture).toHaveBeenCalledWith('capture-committed');
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

  it('remembers repeated cancel clicks before streaming start resolves and sends one independent request', () => {
    const created = new Subject<CaptureOperationV2>();
    const cancelStreamingCapture = vi.fn(() => of(cancelledOperation));
    const getStreamingCapture = vi.fn(() => of(completedOperation));
    const library = libraryStub();
    const client = runtimeStub({
      startStreamingCapture: vi.fn(() => created),
      cancelStreamingCapture,
      getStreamingCapture,
    });
    const store = initializeStore(library, client);

    store.retry(summary.documentId);
    store.cancel(summary.documentId);
    store.cancel(summary.documentId);
    created.next(runningOperation);
    created.complete();
    TestBed.tick();

    expect(cancelStreamingCapture).toHaveBeenCalledOnce();
    expect(cancelStreamingCapture).toHaveBeenCalledWith('capture-1');
    expect(getStreamingCapture).toHaveBeenCalled();
  });

  it('persists one client request identity before create and retains it after transport failure', () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const startStreamingCapture = vi.fn(() =>
      throwError(() => new Error('create response was lost after commit')));
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({ startStreamingCapture }),
    );

    store.retry(summary.documentId);
    TestBed.tick();

    const updates = captureUpdates(updateCapture);
    const pending = updates.find((update) => update['status'] === 'processing');
    const recovery = updates.find((update) => update['status'] === 'recovery_required');
    expect(startStreamingCapture).toHaveBeenCalledOnce();
    expect(pending?.['recoveryCode']).toBe('capture_pending');
    expect(typeof pending?.['recoveryClientRequestId']).toBe('string');
    expect(recovery).toEqual(expect.objectContaining({
      status: 'recovery_required',
      clearCaptureId: false,
      recoveryCode: 'capture_recovery_required',
      recoveryClientRequestId: pending?.['recoveryClientRequestId'],
    }));
  });

  it('reconciles a pending create by request identity before deleting its private ingestion', () => {
    const pending = {
      ...summary,
      status: 'recovery_required' as const,
      stage: 'uploading',
      recoveryClientRequestId: 'capture-request-pending',
      recoveryIngestionId: 'ingestion-private',
    };
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...pending, ...update } as DesktopLibrarySummary));
    const getStreamingCaptureByClientRequest = vi.fn(() => of(null));
    const deleteStreamingIngestion = vi.fn(() => of(undefined));
    const startStreamingCapture = vi.fn();
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of([pending])),
        get: vi.fn(() => of(pending as DesktopLibraryDetail)),
        updateCapture,
      }),
      runtimeStub({
        startStreamingCapture,
        getStreamingCaptureByClientRequest,
        deleteStreamingIngestion,
      }),
    );

    store.retry(pending.documentId);
    TestBed.tick();

    expect(startStreamingCapture).not.toHaveBeenCalled();
    expect(getStreamingCaptureByClientRequest).toHaveBeenCalledWith(
      'capture-request-pending',
    );
    expect(deleteStreamingIngestion).toHaveBeenCalledWith('ingestion-private');
    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'failed',
      clearCaptureId: true,
      errorCode: 'capture_failed',
      recoveryClientRequestId: undefined,
      recoveryIngestionId: undefined,
    }));
  });

  it('reconciles a pending create only when the recovered capture correlates with the durable record', () => {
    const pending = {
      ...summary,
      status: 'recovery_required' as const,
      stage: 'uploading',
      recoveryClientRequestId: 'capture-request-matched',
      recoveryIngestionId: 'ingestion-private',
    };
    const matchedOperation = {
      ...runningOperation,
      captureId: 'capture-recovered',
      ingestionId: 'ingestion-private',
    } satisfies CaptureOperationV2;
    const getStreamingCaptureByClientRequest = vi.fn(() => of(matchedOperation));
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...pending, ...update } as DesktopLibrarySummary));
    const deleteStreamingIngestion = vi.fn();
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of([pending])),
        get: vi.fn(() => of(pending as DesktopLibraryDetail)),
        updateCapture,
      }),
      runtimeStub({
        getStreamingCaptureByClientRequest,
        getStreamingCapture: vi.fn(() => of(matchedOperation)),
        getStreamingEvents: vi.fn(() => of([])),
        deleteStreamingIngestion,
      }),
    );

    store.retry(pending.documentId);
    TestBed.tick();

    expect(getStreamingCaptureByClientRequest).toHaveBeenCalledWith(
      'capture-request-matched',
    );
    expect(deleteStreamingIngestion).not.toHaveBeenCalled();
    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'processing',
      captureId: 'capture-recovered',
      recoveryClientRequestId: undefined,
      recoveryIngestionId: undefined,
    }));
  });

  it('keeps pending recovery when the recovered capture has a different ingestion id', () => {
    const pending = {
      ...summary,
      status: 'recovery_required' as const,
      stage: 'uploading',
      recoveryClientRequestId: 'capture-request-mismatch',
      recoveryIngestionId: 'ingestion-private',
    };
    const mismatched = {
      ...runningOperation,
      captureId: 'capture-other',
      ingestionId: 'ingestion-other',
    } satisfies CaptureOperationV2;
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...pending, ...update } as DesktopLibrarySummary));
    const deleteStreamingIngestion = vi.fn();
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of([pending])),
        get: vi.fn(() => of(pending as DesktopLibraryDetail)),
        updateCapture,
      }),
      runtimeStub({
        getStreamingCaptureByClientRequest: vi.fn(() => of(mismatched)),
        deleteStreamingIngestion,
      }),
    );

    store.retry(pending.documentId);
    TestBed.tick();

    expect(deleteStreamingIngestion).not.toHaveBeenCalled();
    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'recovery_required',
      recoveryCode: 'capture_recovery_required',
      recoveryClientRequestId: 'capture-request-mismatch',
      recoveryIngestionId: 'ingestion-private',
    }));
  });

  it('keeps pending recovery when the recovered source metadata does not match', () => {
    const pending = {
      ...summary,
      status: 'recovery_required' as const,
      stage: 'uploading',
      recoveryClientRequestId: 'capture-request-source-mismatch',
      recoveryIngestionId: 'ingestion-private',
    };
    const mismatched = {
      ...runningOperation,
      captureId: 'capture-recovered',
      ingestionId: 'ingestion-private',
      source: { ...source, bytes: 13 },
    } satisfies CaptureOperationV2;
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...pending, ...update } as DesktopLibrarySummary));
    const deleteStreamingIngestion = vi.fn();
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of([pending])),
        get: vi.fn(() => of(pending as DesktopLibraryDetail)),
        updateCapture,
      }),
      runtimeStub({
        getStreamingCaptureByClientRequest: vi.fn(() => of(mismatched)),
        deleteStreamingIngestion,
      }),
    );

    store.retry(pending.documentId);
    TestBed.tick();

    expect(deleteStreamingIngestion).not.toHaveBeenCalled();
    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'recovery_required',
      recoveryCode: 'capture_recovery_required',
      recoveryClientRequestId: 'capture-request-source-mismatch',
      recoveryIngestionId: 'ingestion-private',
    }));
  });

  it('keeps pending recovery when the recovered operation violates the full v2 contract', () => {
    const pending = {
      ...summary,
      status: 'recovery_required' as const,
      stage: 'uploading',
      recoveryClientRequestId: 'capture-request-invalid-operation',
      recoveryIngestionId: 'ingestion-private',
    };
    const invalidOperation = {
      ...runningOperation,
      captureId: 'capture-recovered',
      ingestionId: 'ingestion-private',
      kind: undefined,
    } as unknown as CaptureOperationV2;
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...pending, ...update } as DesktopLibrarySummary));
    const deleteStreamingIngestion = vi.fn();
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of([pending])),
        get: vi.fn(() => of(pending as DesktopLibraryDetail)),
        updateCapture,
      }),
      runtimeStub({
        getStreamingCaptureByClientRequest: vi.fn(() => of(invalidOperation)),
        deleteStreamingIngestion,
      }),
    );

    store.retry(pending.documentId);
    TestBed.tick();

    expect(deleteStreamingIngestion).not.toHaveBeenCalled();
    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'recovery_required',
      recoveryCode: 'capture_recovery_required',
      recoveryClientRequestId: 'capture-request-invalid-operation',
      recoveryIngestionId: 'ingestion-private',
    }));
  });

  it('keeps pending recovery when the recovered kind does not match the durable media type', () => {
    const pending = {
      ...summary,
      status: 'recovery_required' as const,
      stage: 'uploading',
      recoveryClientRequestId: 'capture-request-kind-mismatch',
      recoveryIngestionId: 'ingestion-private',
    };
    const kindMismatch = {
      ...runningOperation,
      captureId: 'capture-recovered',
      ingestionId: 'ingestion-private',
      kind: 'audio',
    } satisfies CaptureOperationV2;
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...pending, ...update } as DesktopLibrarySummary));
    const deleteStreamingIngestion = vi.fn();
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of([pending])),
        get: vi.fn(() => of(pending as DesktopLibraryDetail)),
        updateCapture,
      }),
      runtimeStub({
        getStreamingCaptureByClientRequest: vi.fn(() => of(kindMismatch)),
        deleteStreamingIngestion,
      }),
    );

    store.retry(pending.documentId);
    TestBed.tick();

    expect(deleteStreamingIngestion).not.toHaveBeenCalled();
    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'recovery_required',
      recoveryCode: 'capture_recovery_required',
      recoveryClientRequestId: 'capture-request-kind-mismatch',
      recoveryIngestionId: 'ingestion-private',
    }));
  });

  it('retains pending create recovery when lookup or active-ingestion cleanup is uncertain', () => {
    const pending = {
      ...summary,
      status: 'recovery_required' as const,
      stage: 'uploading',
      recoveryClientRequestId: 'capture-request-uncertain',
      recoveryIngestionId: 'ingestion-private',
    };
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...pending, ...update } as DesktopLibrarySummary));
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of([pending])),
        get: vi.fn(() => of(pending as DesktopLibraryDetail)),
        updateCapture,
      }),
      runtimeStub({
        getStreamingCaptureByClientRequest: vi.fn(() => of(null)),
        deleteStreamingIngestion: vi.fn(() =>
          throwError(() => new Error('HTTP 409 active ingestion'))),
      }),
    );

    store.retry(pending.documentId);
    TestBed.tick();

    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'recovery_required',
      recoveryCode: 'capture_recovery_required',
      recoveryClientRequestId: 'capture-request-uncertain',
      recoveryIngestionId: 'ingestion-private',
    }));
  });

  it('interrupts an in-flight poll and sends cancellation immediately', () => {
    const polled = new Subject<CaptureOperationV2>();
    const cancelStreamingCapture = vi.fn(() => of(cancelledOperation));
    const getStreamingCapture = vi.fn(() => polled);
    const client = runtimeStub({
      startStreamingCapture: vi.fn(() => of(runningOperation)),
      cancelStreamingCapture,
      getStreamingCapture,
    });
    const store = initializeStore(libraryStub(), client);

    vi.useFakeTimers();
    try {
      store.retry(summary.documentId);
      vi.advanceTimersByTime(700);
      expect(getStreamingCapture).toHaveBeenCalledWith('capture-1');
      expect(cancelStreamingCapture).not.toHaveBeenCalled();

      store.cancel(summary.documentId);
      TestBed.tick();

      expect(cancelStreamingCapture).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an already-terminal runtime response win a cancel/complete race', () => {
    const created = new Subject<CaptureOperationV2>();
    const cancelStreamingCapture = vi.fn(() => of(cancelledOperation));
    const deleteStreamingCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      startStreamingCapture: vi.fn(() => created),
      cancelStreamingCapture,
      deleteStreamingCapture,
    });
    const store = initializeStore(libraryStub(), client);

    store.retry(summary.documentId);
    store.cancel(summary.documentId);
    created.next(completedOperation);
    created.complete();
    TestBed.tick();

    expect(cancelStreamingCapture).toHaveBeenCalledOnce();
    expect(deleteStreamingCapture).toHaveBeenCalledWith('capture-1');
  });

  it('clears a canceled v2 operation after terminal persistence', () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const getStreamingPartial = vi.fn(() => of(partial));
    const deleteStreamingCapture = vi.fn(() => of(undefined));
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({
        startStreamingCapture: vi.fn(() => of(cancelledOperation)),
        getStreamingCapture: vi.fn(() => of(cancelledOperation)),
        getStreamingPartial,
        deleteStreamingCapture,
      }),
    );

    store.retry(summary.documentId);
    TestBed.tick();

    expect(getStreamingPartial).toHaveBeenCalledWith('capture-1');
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'canceled',
        captureId: 'capture-1',
      }),
    );
    expect(deleteStreamingCapture).toHaveBeenCalledWith('capture-1');
  });

  it('retains a canceled runtime operation when optional partial retrieval fails', () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const deleteStreamingCapture = vi.fn(() => of(undefined));
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({
        startStreamingCapture: vi.fn(() => of(cancelledOperation)),
        getStreamingPartial: vi.fn(() => throwError(() => new Error('partial transport failed'))),
        deleteStreamingCapture,
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
    expect(deleteStreamingCapture).not.toHaveBeenCalled();
  });

  it.each([
    ['partial retrieval', {
      getStreamingPartial: vi.fn(() => throwError(() => new Error('partial failed'))),
    }],
    ['result retrieval', {
      getStreamingResult: vi.fn(() => throwError(() => new Error('result failed'))),
    }],
  ])('retains the runtime operation when %s fails', (_case, runtimeOverride) => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const deleteStreamingCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      startStreamingCapture: vi.fn(() => of(completedOperation)),
      deleteStreamingCapture,
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
    expect(deleteStreamingCapture).not.toHaveBeenCalled();
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
    const deleteStreamingCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      startStreamingCapture: vi.fn(() => of(completedOperation)),
      deleteStreamingCapture,
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
    expect(deleteStreamingCapture).not.toHaveBeenCalled();
  });

  it('retains a recovery link when runtime DELETE fails after a successful commit', () => {
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      events.push(`library:${String(update['status'])}`);
      return of({ ...summary, ...update } as DesktopLibrarySummary);
    });
    const deleteStreamingCapture = vi.fn(() => {
      events.push('runtime:delete');
      return throwError(() => new Error('delete failed'));
    });
    const client = runtimeStub({
      startStreamingCapture: vi.fn(() => of(completedOperation)),
      deleteStreamingCapture,
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
    const terminal: CaptureOperationV2 = {
      ...runningOperation,
      captureId: 'capture-terminal-error',
      status: runtimeStatus,
      error: {
        code: 'terminal_error',
        message: 'terminal evidence',
      },
    };
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...summary, ...update } as DesktopLibrarySummary));
    const deleteStreamingCapture = vi.fn(() =>
        throwError(() => new Error('cleanup transport failed')));
      const store = initializeStore(
        libraryStub({ updateCapture }),
        runtimeStub({
          startStreamingCapture: vi.fn(() => of(terminal)),
          getStreamingCapture: vi.fn(() => of(terminal)),
          deleteStreamingCapture,
        }),
      );

      store.retry(summary.documentId);
      TestBed.tick();

      expect(captureUpdates(updateCapture)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: libraryStatus,
          captureId: 'capture-terminal-error',
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
      const startStreamingCapture = vi.fn(() => of(completedOperation));
      const getStreamingCapture = vi.fn(() => of(completedOperation));
      const getStreamingPartial = vi.fn(() => of(partial));
      const deleteStreamingCapture = vi.fn(() => of(undefined));
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...recovery, ...update } as DesktopLibrarySummary));
      const store = initializeStore(
        libraryStub({
          list: vi.fn(() => of([recovery])),
          get: vi.fn(() => of(recovery as DesktopLibraryDetail)),
          updateCapture,
        }),
        runtimeStub({ startStreamingCapture, getStreamingCapture, getStreamingPartial, deleteStreamingCapture }),
      );

      store.retry(recovery.documentId);
      TestBed.tick();

      expect(startStreamingCapture).not.toHaveBeenCalled();
      expect(getStreamingCapture).not.toHaveBeenCalled();
      expect(getStreamingPartial).not.toHaveBeenCalled();
      expect(deleteStreamingCapture).toHaveBeenCalledWith('capture-cleanup-terminal');
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

  it('recovers persistence with the same runtime ID and never creates a new job', () => {
    const recovery = {
      ...summary,
      status: 'recovery_required',
      stage: 'completed',
      captureId: 'capture-recovery',
      recoveryCode: 'capture_recovery_required',
    } satisfies DesktopLibrarySummary;
    const startStreamingCapture = vi.fn(() => of(completedOperation));
    const recoveredOperation = {
      ...runningOperation,
      captureId: 'capture-recovery',
      lastEventSequence: 7,
    } satisfies CaptureOperationV2;
    const getStreamingCapture = vi
      .fn()
      .mockReturnValueOnce(of(recoveredOperation))
      .mockReturnValueOnce(of({
      ...completedOperation,
      captureId: 'capture-recovery',
      } satisfies CaptureOperationV2));
    const getStreamingEvents = vi.fn(() => of([]));
    const deleteStreamingCapture = vi.fn(() => of(undefined));
    const library = libraryStub({
      list: vi.fn(() => of([recovery])),
      get: vi.fn(() => of(recovery as DesktopLibraryDetail)),
    });
    const client = runtimeStub({
      startStreamingCapture,
      getStreamingCapture,
      getStreamingEvents,
      deleteStreamingCapture,
    });
    const store = initializeStore(library, client);

    store.retry(recovery.documentId);
    TestBed.tick();

    expect(startStreamingCapture).not.toHaveBeenCalled();
    expect(getStreamingCapture).toHaveBeenCalledWith('capture-recovery');
    expect(getStreamingEvents).toHaveBeenCalledWith('capture-recovery', 7);
    expect(deleteStreamingCapture).toHaveBeenCalledWith('capture-recovery');
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
    const startStreamingCapture = vi.fn(() => of(completedOperation));
    const getStreamingCapture = vi.fn(() => of(completedOperation));
    const deleteStreamingCapture = vi.fn(() => of(undefined));
    const library = libraryStub({
      list: vi.fn(() => of([recovery])),
      get: vi.fn(() => of(recovery as DesktopLibraryDetail)),
      updateCapture,
    });
    const client = runtimeStub({ startStreamingCapture, getStreamingCapture, deleteStreamingCapture });
    const store = initializeStore(library, client);

    store.retry(recovery.documentId);
    TestBed.tick();

    expect(startStreamingCapture).not.toHaveBeenCalled();
    expect(getStreamingCapture).not.toHaveBeenCalled();
    expect(deleteStreamingCapture).toHaveBeenCalledWith('capture-cleanup');
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'completed',
        clearCaptureId: true,
      }),
    );
  });

  it('deletes only the document UUID selected by the host action', () => {
    const first = {
      ...summary,
      documentId: '1'.repeat(32),
      status: 'completed',
      stage: 'completed',
    } satisfies DesktopLibrarySummary;
    const second = {
      ...summary,
      documentId: '2'.repeat(32),
      fileName: 'second.pdf',
      status: 'completed',
      stage: 'completed',
    } satisfies DesktopLibrarySummary;
    const deleteDocument = vi.fn(() => of(undefined));
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of([first, second])),
        delete: deleteDocument,
      }),
      runtimeStub(),
    );

    store.delete(second.documentId);

    expect(deleteDocument).toHaveBeenCalledOnce();
    expect(deleteDocument).toHaveBeenCalledWith(second.documentId);
    expect(deleteDocument).not.toHaveBeenCalledWith(first.documentId);
    confirm.mockRestore();
  });

  it('blocks direct deletion while a native capture is active', () => {
    const pendingCapture = new Subject<CaptureOperationV2>();
    const deleteDocument = vi.fn(() => of(undefined));
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const library = libraryStub({
      createSource: vi.fn(() => of(summary)),
      delete: deleteDocument,
    });
    const store = initializeStore(
      library,
      runtimeStub({ startStreamingCapture: vi.fn(() => pendingCapture) }),
    );

    store.addSourcePaths(['C:\\private\\active.pdf']);
    TestBed.tick();
    store.delete(summary.documentId);

    expect(deleteDocument).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    pendingCapture.complete();
    confirm.mockRestore();
  });

  it('refreshes the selected document after processing and runtime ID updates', () => {
    const pendingCapture = new Subject<CaptureOperationV2>();
    const list = vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary]));
    const store = initializeStore(
      libraryStub({ list }),
      runtimeStub({ startStreamingCapture: vi.fn(() => pendingCapture) }),
    );
    store.select(summary.documentId);
    TestBed.tick();
    const beforeCapture = list.mock.calls.length;

    store.retry(summary.documentId);
    TestBed.tick();

    expect(list.mock.calls.length).toBeGreaterThan(beforeCapture);
    pendingCapture.complete();
  });

  it('blocks direct deletion while a durable runtime capture id is retained', () => {
    const retained = {
      ...summary,
      status: 'recovery_required',
      captureId: 'capture-retained',
    } satisfies DesktopLibrarySummary;
    const deleteDocument = vi.fn(() => of(undefined));
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of([retained])),
        delete: deleteDocument,
      }),
      runtimeStub(),
    );

    store.delete(retained.documentId);

    expect(deleteDocument).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
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
  const defaultGetStreamingCapture = vi.fn(() => of(completedOperation));
  const client = {
    ready: signal(true),
    error: signal<Error | undefined>(undefined),
    reload: vi.fn(),
    getRequirements: vi.fn(() => of([])),
    getModelOptions: vi.fn(() => of([])),
    startInstallation: vi.fn(),
    getInstallation: vi.fn(),
    startModelInstallation: vi.fn(),
    getModelInstallation: vi.fn(),
    startStreamingCapture: vi.fn(() => of(completedOperation)),
    getStreamingCapture: defaultGetStreamingCapture,
    getStreamingCaptureByClientRequest: vi.fn(() => of(null)),
    getStreamingEvents: vi.fn(() => of([])),
    getStreamingPartial: vi.fn(() => of(partial)),
    getStreamingResult: vi.fn(() => of(terminalResult)),
    structureStreamingCapture: vi.fn(() => of(result)),
    cancelStreamingCapture: vi.fn(() => of(cancelledOperation)),
    deleteStreamingCapture: vi.fn(() => of(undefined)),
    deleteStreamingIngestion: vi.fn(() => of(undefined)),
  };
  return Object.assign(client, overrides);
}

function captureUpdates(
  updateCapture: ReturnType<typeof vi.fn>,
): readonly Record<string, unknown>[] {
  return updateCapture.mock.calls.map(
    ([update]) => update as Record<string, unknown>,
  );
}
