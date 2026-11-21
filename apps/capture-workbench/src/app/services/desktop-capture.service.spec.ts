import { signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { TestBed } from '@angular/core/testing';
import { RUNTIME_VERSION, type CaptureOcrProjection } from '@gx-capture/capture-runtime-client';
import type {
  CaptureOperation,
  CaptureRequirementId,
  OcrComputePreflight,
  PartialCapture,
} from '@gx-capture/capture-workbench-ui';
import { finalize, of, Subject, throwError, type Observable } from 'rxjs';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
import {
  DesktopCaptureService,
  FAILED_DECISION_PAUSE_MS,
  type DesktopCaptureHost,
} from './desktop-capture.service';
import { isCaptureLost } from './capture-operation-status';
import { DesktopLibraryService, type DesktopSourceSelection } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { LibraryStore } from './library.store';


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

const runningOperation = operation({
  captureId: 'capture-1',
  status: 'extracting',
});
const completedOperation = operation({
  captureId: 'capture-1',
  status: 'completed',
});
const cancelledOperation = operation({
  captureId: 'capture-1',
  status: 'cancelled',
});
const raw = { sourceText: 'OCR text' };
const result = { targetText: 'translated text' };
const failedOcrCaptureIds = new Set([
  'capture-terminal-error',
  'capture-double-write',
]);


describe('DesktopCaptureService', () => {
  it('persists the runtime ID before terminal data and clears it only after DELETE', async () => {
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      events.push(
        `library:${String(update['status'])}:${String(update['clearCaptureId'] ?? false)}`,
      );
      return of({ ...summary, ...update, updatedAtMs: 2 });
    });
    const deleteCapture = vi.fn(() => {
      events.push('runtime:delete');
      return of(undefined);
    });
    const library = libraryStub({
      list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary])),
      updateCapture,
    });
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedOperation)),
      deleteCapture,
    });
    const store = initializeCapture(library, client);

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(client.createCapture).toHaveBeenCalledWith(
      summary.documentId,
      expect.any(String),
      undefined,
    );
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

  it('reads OCR before the terminal atomic update and persists privacy-safe evidence', async () => {
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      events.push(`library:${String(update['status'])}:${String(update['clearCaptureId'] ?? false)}`);
      return of({ ...summary, ...update });
    });
    const getOcr = vi.fn((captureId: string) => {
      events.push(`runtime:ocr:${captureId}`);
      return of(ocrProjection(captureId, 'completed'));
    });
    const deleteCapture = vi.fn((captureId: string) => {
      events.push(`runtime:delete:${captureId}`);
      return of(undefined);
    });
    const store = initializeCapture(
      libraryStub({ updateCapture }),
      runtimeStub({ getOcr, deleteCapture }),
    );

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

    const terminalUpdate = captureUpdates(updateCapture).find(
      (update) => update['status'] === 'completed' && update['ocrEvidence'] !== undefined,
    );
    expect(terminalUpdate).toEqual(expect.objectContaining({
      captureId: 'capture-1',
      raw,
      result,
      ocrEvidence: expect.objectContaining({
        schemaVersion: 1,
        captureId: 'capture-1',
        status: 'completed',
        sourceSha256: 'a'.repeat(64),
        provenance: expect.objectContaining({ workerSha256: 'f'.repeat(64) }),
      }),
    }));
    expect(events.indexOf('runtime:ocr:capture-1')).toBeGreaterThan(
      events.indexOf('library:persisting:false'),
    );
    expect(events.indexOf('runtime:ocr:capture-1')).toBeLessThan(
      events.indexOf('library:completed:false'),
    );
    expect(events.indexOf('library:completed:false')).toBeLessThan(
      events.indexOf('runtime:delete:capture-1'),
    );
  });

  it('persists failed partial OCR pages and typed failures before cleanup', async () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update }));
    const getOcr = vi.fn((captureId: string) =>
      of(ocrProjection(captureId, 'failed')));
    const deleteCapture = vi.fn(() => of(undefined));
    const terminal = operation({
      captureId: 'capture-terminal-error',
      status: 'failed',
      error: { code: 'terminal_error', message: 'terminal evidence' },
    });
    const store = initializeCapture(
      libraryStub({ updateCapture }),
      runtimeStub({ createCapture: vi.fn(() => of(terminal)), getOcr, deleteCapture }),
    );

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

    const terminalUpdate = captureUpdates(updateCapture).find(
      (update) => update['status'] === 'failed' && update['ocrEvidence'] !== undefined,
    );
    expect(terminalUpdate).toEqual(expect.objectContaining({
      captureId: 'capture-terminal-error',
      raw,
      errorCode: 'terminal_error',
      ocrEvidence: expect.objectContaining({
        status: 'failed',
        pages: [expect.objectContaining({
          status: 'failed',
          failure: expect.objectContaining({ code: 'ocr_worker_failed' }),
        })],
      }),
    }));
    expect(getOcr).toHaveBeenCalledWith('capture-terminal-error');
    expect(deleteCapture).toHaveBeenCalledWith('capture-terminal-error');
  });

  it('retains a zero-page failed OCR projection as readable evidence', async () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update }));
    const base = ocrProjection('capture-zero-page', 'failed');
    const unavailableProvenance = {
      status: 'unavailable' as const,
      profileId: 'profile-1',
      profileSpecSha256: 'e'.repeat(64),
      reason: 'worker_crashed' as const,
    };
    const zeroPage: CaptureOcrProjection = {
      ...base,
      source: null,
      processedPageCount: 0,
      pages: [],
      provenance: unavailableProvenance,
      failure: { code: 'ocr_worker_failed', message: 'OCR failed' },
    };
    const terminal = operation({
      captureId: 'capture-zero-page',
      status: 'failed',
      error: { code: 'terminal_error', message: 'terminal evidence' },
    });
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeCapture(
      libraryStub({ updateCapture }),
      runtimeStub({
        createCapture: vi.fn(() => of(terminal)),
        getOcr: vi.fn(() => of(zeroPage)),
        deleteCapture,
      }),
    );

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'failed',
      captureId: 'capture-zero-page',
      ocrEvidence: expect.objectContaining({
        pageCount: 0,
        pages: [],
        provenance: expect.objectContaining({ status: 'unavailable' }),
      }),
    }));
    expect(deleteCapture).toHaveBeenCalledWith('capture-zero-page');
  });

  it.each<[string, () => Observable<unknown>]>([
    ['getOcr error', () => throwError(() => new Error('OCR transport failed'))],
    ['identity mismatch', () => of({
      ...ocrProjection('capture-identity-mismatch', 'completed'),
      contractSetSha256: 'b'.repeat(64),
    })],
    ['malformed projection', () => of({
      ...ocrProjection('capture-malformed', 'completed'),
      pages: [{}],
    })],
  ])('keeps the runtime operation for %s before terminal commit', async (_case, getOcrFactory) => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update }));
    const deleteCapture = vi.fn(() => of(undefined));
    const captureId = _case === 'getOcr error'
      ? 'capture-1'
      : _case === 'identity mismatch'
        ? 'capture-identity-mismatch'
        : 'capture-malformed';
    const terminal = operation({ captureId, status: 'completed' });
    const getOcr = vi.fn(getOcrFactory);
    const store = initializeCapture(
      libraryStub({ updateCapture }),
      runtimeStub({ createCapture: vi.fn(() => of(terminal)), getOcr, deleteCapture }),
    );

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'recovery_required',
      captureId,
    }));
    expect(captureUpdates(updateCapture).some(
      (update) => update['clearCaptureId'] === true && update['status'] !== 'processing',
    )).toBe(false);
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it('keeps the runtime operation when host OCR readiness lacks the worker identity', async () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update }));
    const getOcr = vi.fn(() => of(ocrProjection('capture-1', 'completed')));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeCapture(
      libraryStub({ updateCapture }),
      runtimeStub({
        ocrCompute: signal<OcrComputePreflight | null>({
          apiVersion: '2.0',
          schemaVersion: '1',
          service: 'capture-runtime',
          runtimeVersion: RUNTIME_VERSION,
          contractSetVersion: '2',
          contractSetSha256: 'a'.repeat(64),
          workerSha256: undefined,
          mode: 'gpu',
          adapterClass: 'dedicated',
          reasonCode: null,
          userNoticeRequired: false,
          noticeCode: null,
        }),
        getOcr,
        deleteCapture,
      }),
    );

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(getOcr).toHaveBeenCalledWith('capture-1');
    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'recovery_required',
      captureId: 'capture-1',
    }));
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it('uses an explicit native acceptance PDF page scope while keeping the default unbounded', () => {
    const createCapture = vi.fn(() => of(completedOperation));
    const store = initializeCapture(
      libraryStub({
        list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary])),
      }),
      runtimeStub({
        pdfPageNumbers: signal<readonly number[]>([1]),
        createCapture,
      }),
    );

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    TestBed.tick();

    expect(createCapture).toHaveBeenCalledWith(
      summary.documentId,
      expect.any(String),
      [1],
    );
  });

  it('publishes raw during structuring before the terminal result is committed', async () => {
    const structuringOperation = operation({
      captureId: 'capture-1',
      status: 'structuring',
    });
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update }));
    const getRaw = vi.fn(() => of(raw));
    const store = initializeCapture(
      libraryStub({ updateCapture }),
      runtimeStub({
        createCapture: vi.fn(() => of(structuringOperation)),
        getCapture: vi.fn(() => of(completedOperation)),
        getRaw,
      }),
    );

    vi.useFakeTimers();
    try {
      store.service.startDocument$(summary.documentId, store.host).subscribe();
      vi.advanceTimersByTime(700);
      TestBed.tick();
      vi.useRealTimers();
      await settleCaptureLifecycle();

      const updates = captureUpdates(updateCapture);
      const rawUpdates = updates.filter((update) => 'raw' in update);
      const resultIndex = updates.findIndex(
        (update) => update['status'] === 'completed' && 'result' in update,
      );

      expect(rawUpdates).toHaveLength(1);
      expect(rawUpdates[0]).toEqual(expect.objectContaining({
        documentId: summary.documentId,
        captureId: 'capture-1',
        status: 'processing',
        stage: 'structuring',
        raw,
      }));
      expect(rawUpdates[0]).not.toHaveProperty('result');
      expect(resultIndex).toBeGreaterThan(updates.indexOf(rawUpdates[0]));
      expect(updates[resultIndex]).toEqual(expect.objectContaining({
        status: 'completed',
        captureId: 'capture-1',
        result,
      }));
      expect(updates[resultIndex]).not.toHaveProperty('raw');
      expect(getRaw).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling at awaiting_structuring and durably commits OCR before runtime cleanup', async () => {
    const captureId = 'capture-ocr-first';
    const created = operation({ captureId, status: 'waiting_input' });
    const extracting = operation({ captureId, status: 'extracting' });
    const awaitingStructuring = operation({
      captureId,
      status: 'awaiting_structuring',
    });
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      const evidence = update['ocrEvidence'];
      if (
        evidence !== undefined
        && typeof evidence === 'object'
        && evidence !== null
        && (evidence as { status?: unknown }).status !== update['status']
      ) {
        return throwError(() => new Error('native OCR evidence status validation failed'));
      }
      return of({ ...summary, ...update }).pipe(
        finalize(() => {
          if (update['ocrEvidence'] !== undefined) {
            events.push('library:durable-awaiting-write:complete');
          }
          if (update['clearCaptureId'] === true && update['status'] === 'awaiting_confirmation') {
            events.push('library:clearCaptureId:complete');
          }
        }),
      );
    });
    const getCapture = vi.fn(() => {
      if (getCapture.mock.calls.length === 1) return of(extracting);
      if (getCapture.mock.calls.length === 2) return of(awaitingStructuring);
      return throwError(() => new Error('poll after awaiting_structuring is forbidden'));
    });
    const getRaw = vi.fn(() => of(raw).pipe(
      finalize(() => events.push('runtime:getRaw:complete')),
    ));
    const getOcr = vi.fn(() => of(ocrProjection(captureId, 'completed')).pipe(
      finalize(() => events.push('runtime:getOcr:complete')),
    ));
    const getResult = vi.fn(() => of({ operation: completedOperation, raw, result }));
    const deleteCapture = vi.fn(() => of(undefined).pipe(
      finalize(() => events.push('runtime:delete:complete')),
    ));
    const startModelInstallation = vi.fn();
    const store = initializeCapture(
      libraryStub({
        list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary])),
        updateCapture,
      }),
      runtimeStub({
        createCapture: vi.fn(() => of(created)),
        getCapture,
        getRaw,
        getOcr,
        getResult,
        deleteCapture,
        startModelInstallation,
      }),
    );

    vi.useFakeTimers();
    try {
      store.service.startDocument$(summary.documentId, store.host).subscribe();
      TestBed.tick();
      for (let index = 0; index < 3; index += 1) {
        vi.advanceTimersByTime(700);
        TestBed.tick();
        for (let microtask = 0; microtask < 5; microtask += 1) {
          await Promise.resolve();
        }
      }
      vi.useRealTimers();
      await settleCaptureLifecycle();

      const updates = captureUpdates(updateCapture);
      const evidenceUpdate = updates.find((update) => update['ocrEvidence'] !== undefined);
      expect(evidenceUpdate).toEqual(expect.objectContaining({
        documentId: summary.documentId,
        captureId,
        status: 'completed',
        stage: 'awaiting_structuring',
        raw,
        ocrEvidence: expect.objectContaining({
          schemaVersion: 1,
          captureId,
        }),
      }));
      const confirmationUpdate = updates.find(
        (update) => update['status'] === 'awaiting_confirmation' && update['clearCaptureId'] === true,
      );
      expect(confirmationUpdate).toEqual(expect.objectContaining({
        documentId: summary.documentId,
        status: 'awaiting_confirmation',
        stage: 'awaiting_structuring',
        clearCaptureId: true,
      }));
      expect(confirmationUpdate).not.toHaveProperty('captureId');
      expect(confirmationUpdate).not.toHaveProperty('ocrEvidence');
      expect(getCapture).toHaveBeenCalledTimes(2);
      expect(getRaw).toHaveBeenCalledOnce();
      expect(getOcr).toHaveBeenCalledOnce();
      expect(evidenceUpdate).not.toHaveProperty('result');
      expect(getResult).not.toHaveBeenCalled();
      expect(startModelInstallation).not.toHaveBeenCalled();
      expect(deleteCapture).toHaveBeenCalledOnce();
      expect(deleteCapture).toHaveBeenCalledWith(captureId);
      const rawIndex = events.indexOf('runtime:getRaw:complete');
      const ocrIndex = events.indexOf('runtime:getOcr:complete');
      const durableIndex = events.indexOf('library:durable-awaiting-write:complete');
      const deleteIndex = events.indexOf('runtime:delete:complete');
      const clearIndex = events.indexOf('library:clearCaptureId:complete');
      expect(rawIndex).toBeLessThan(ocrIndex);
      expect(ocrIndex).toBeLessThan(durableIndex);
      expect(durableIndex).toBeLessThan(deleteIndex);
      expect(deleteIndex).toBeLessThan(clearIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the runtime operation when awaiting OCR durability fails before cleanup', async () => {
    const captureId = 'capture-ocr-first-durable-failure';
    const created = operation({ captureId, status: 'waiting_input' });
    const extracting = operation({ captureId, status: 'extracting' });
    const awaitingStructuring = operation({
      captureId,
      status: 'awaiting_structuring',
    });
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      if (update['ocrEvidence'] !== undefined) {
        events.push('library:durable-awaiting-write:failed');
        return throwError(() => new Error('durable awaiting write failed'));
      }
      return of({ ...summary, ...update }).pipe(
        finalize(() => {
          if (update['clearCaptureId'] === true && update['status'] === 'awaiting_confirmation') {
            events.push('library:clearCaptureId:complete');
          }
        }),
      );
    });
    const getCapture = vi.fn(() => {
      if (getCapture.mock.calls.length === 1) return of(extracting);
      if (getCapture.mock.calls.length === 2) return of(awaitingStructuring);
      return throwError(() => new Error('poll after awaiting_structuring is forbidden'));
    });
    const getRaw = vi.fn(() => of(raw).pipe(
      finalize(() => events.push('runtime:getRaw:complete')),
    ));
    const getOcr = vi.fn(() => of(ocrProjection(captureId, 'completed')).pipe(
      finalize(() => events.push('runtime:getOcr:complete')),
    ));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeCapture(
      libraryStub({
        list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary])),
        updateCapture,
      }),
      runtimeStub({
        createCapture: vi.fn(() => of(created)),
        getCapture,
        getRaw,
        getOcr,
        deleteCapture,
      }),
    );

    vi.useFakeTimers();
    try {
      store.service.startDocument$(summary.documentId, store.host).subscribe();
      TestBed.tick();
      for (let index = 0; index < 3; index += 1) {
        vi.advanceTimersByTime(700);
        TestBed.tick();
        for (let microtask = 0; microtask < 5; microtask += 1) {
          await Promise.resolve();
        }
      }
      vi.useRealTimers();
      await settleCaptureLifecycle();

      const updates = captureUpdates(updateCapture);
      expect(getCapture).toHaveBeenCalledTimes(2);
      expect(getRaw).toHaveBeenCalledOnce();
      expect(getOcr).toHaveBeenCalledOnce();
      expect(events).toContain('library:durable-awaiting-write:failed');
      expect(events.indexOf('runtime:getRaw:complete')).toBeLessThan(
        events.indexOf('runtime:getOcr:complete'),
      );
      expect(events.indexOf('runtime:getOcr:complete')).toBeLessThan(
        events.indexOf('library:durable-awaiting-write:failed'),
      );
      expect(updates).toContainEqual(expect.objectContaining({
        documentId: summary.documentId,
        captureId,
        status: 'recovery_required',
      }));
      expect(updates.some(
        (update) => update['clearCaptureId'] === true && update['status'] !== 'processing',
      )).toBe(false);
      expect(deleteCapture).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['failed OCR projection', (captureId: string) => ocrProjection(captureId, 'failed')],
    ['completed projection with a failed page', (captureId: string) => ({
      ...ocrProjection(captureId, 'completed'),
      pages: [ocrProjection(captureId, 'failed').pages[0]],
    })],
  ] as const)(
    'fails closed at the OCR checkpoint for %s',
    async (_case, projectionFactory) => {
      const captureId = `capture-ocr-checkpoint-${_case.replace(/ /g, '-')}`;
      const created = operation({ captureId, status: 'waiting_input' });
      const extracting = operation({ captureId, status: 'extracting' });
      const awaitingStructuring = operation({
        captureId,
        status: 'awaiting_structuring',
      });
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...summary, ...update }));
      const getCapture = vi.fn(() => {
        if (getCapture.mock.calls.length === 1) return of(extracting);
        if (getCapture.mock.calls.length === 2) return of(awaitingStructuring);
        return throwError(() => new Error('poll after awaiting_structuring is forbidden'));
      });
      const getRaw = vi.fn(() => of(raw));
      const getOcr = vi.fn(() => of(projectionFactory(captureId)));
      const deleteCapture = vi.fn(() => of(undefined));
      const store = initializeCapture(
        libraryStub({
          list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary])),
          updateCapture,
        }),
        runtimeStub({
          createCapture: vi.fn(() => of(created)),
          getCapture,
          getRaw,
          getOcr,
          deleteCapture,
        }),
      );

      vi.useFakeTimers();
      try {
        store.service.startDocument$(summary.documentId, store.host).subscribe();
        TestBed.tick();
        for (let index = 0; index < 3; index += 1) {
          vi.advanceTimersByTime(700);
          TestBed.tick();
          for (let microtask = 0; microtask < 5; microtask += 1) {
            await Promise.resolve();
          }
        }
        vi.useRealTimers();
        await settleCaptureLifecycle();

        const updates = captureUpdates(updateCapture);
        expect(getCapture).toHaveBeenCalledTimes(2);
        expect(getRaw).toHaveBeenCalledOnce();
        expect(getOcr).toHaveBeenCalledOnce();
        expect(updates).toContainEqual(expect.objectContaining({
          documentId: summary.documentId,
          captureId,
          status: 'recovery_required',
        }));
        expect(updates.some((update) => update['status'] === 'awaiting_confirmation')).toBe(false);
        expect(updates.some(
          (update) => update['clearCaptureId'] === true && update['status'] !== 'processing',
        )).toBe(false);
        expect(deleteCapture).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['processing', 'persisting'] as const)(
    'resumes a retained runtime operation after restart from %s without creating a replacement',
    async (status) => {
      const retained = {
        ...summary,
        status,
        stage: status === 'processing' ? 'extracting' : 'completed',
        captureId: 'capture-restart',
      } satisfies DesktopLibrarySummary;
      const terminal = operation({
        ...completedOperation,
        captureId: 'capture-restart',
      });
      const createCapture = vi.fn(() => of(completedOperation));
      const getCapture = vi.fn(() => of(terminal));
      const deleteCapture = vi.fn(() => of(undefined));
      const library = libraryStub({
        list: vi.fn(() => of([retained])),
        get: vi.fn(() => of<DesktopLibraryDetail>(retained)),
      });
      const store = initializeCapture(
        library,
        runtimeStub({ createCapture, getCapture, deleteCapture }),
      );

      store.service.retry$(retained.documentId, store.host).subscribe();
      TestBed.tick();
      await settleCaptureLifecycle();

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
      const createCapture = vi.fn(() => of(completedOperation));
      const getCapture = vi.fn(() => of(completedOperation));
      const getRaw = vi.fn(() => of(raw));
      const deleteCapture = vi.fn(() => of(undefined));
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...retained, ...update }));
      const store = initializeCapture(
        libraryStub({
          list: vi.fn(() => of([retained])),
          get: vi.fn(() => of<DesktopLibraryDetail>(retained)),
          updateCapture,
        }),
        runtimeStub({ createCapture, getCapture, getRaw, deleteCapture }),
      );

      store.service.retry$(retained.documentId, store.host).subscribe();
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

  it.each(['application/pdf', 'audio/mpeg'])(
    'cancels a pending %s upload once and records a cancelled document',
    (mediaType) => {
      const pending = new Subject<CaptureOperation>();
      const createCapture = vi.fn((_documentId: string, _clientRequestId: string) => pending);
      const startRecordingCapture = vi.fn((_input: { clientRequestId: string }) => pending);
      const cancelUpload = vi.fn(() => of(undefined));
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...summary, mediaType, ...update }));
      const client = runtimeStub({ createCapture, startRecordingCapture, cancelUpload });
      const store = initializeCapture(libraryStub({
        get: vi.fn(() => of({ ...summary, mediaType })),
        list: vi.fn(() => of([{ ...summary, mediaType }])),
        updateCapture,
      }), client);

      store.service.startDocument$(summary.documentId, store.host).subscribe();
      const requestId = mediaType === 'audio/mpeg'
        ? startRecordingCapture.mock.calls[0][0].clientRequestId
        : createCapture.mock.calls[0][1];
      store.service.cancel(summary.documentId);
      store.service.cancel(summary.documentId);

      expect(cancelUpload).toHaveBeenCalledOnce();
      expect(cancelUpload).toHaveBeenCalledWith(requestId);
      pending.error(new Error('Upload was cancelled.'));
      TestBed.tick();

      expect(captureUpdates(updateCapture)).toContainEqual({
        documentId: summary.documentId,
        status: 'canceled',
        stage: 'cancelled',
        clearCaptureId: true,
      });
      expect(captureUpdates(updateCapture).some((update) => update['status'] === 'failed')).toBe(false);
      expect(store.service.busyIds().has(summary.documentId)).toBe(false);
      expect(client.cancelCapture).not.toHaveBeenCalled();
    },
  );

  it('remembers repeated cancel clicks before create resolves and sends one independent request', () => {
    const created = new Subject<CaptureOperation>();
    const cancelCapture = vi.fn(() => of(cancelledOperation));
    const getCapture = vi.fn(() => of(completedOperation));
    const library = libraryStub();
    const client = runtimeStub({
      createCapture: vi.fn(() => created),
      cancelCapture,
      getCapture,
    });
    const store = initializeCapture(library, client);

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    store.service.cancel(summary.documentId);
    store.service.cancel(summary.documentId);
    created.next(runningOperation);
    created.complete();
    TestBed.tick();

    expect(cancelCapture).toHaveBeenCalledOnce();
    expect(cancelCapture).toHaveBeenCalledWith('capture-1');
    expect(getCapture).not.toHaveBeenCalled();
  });

  it('interrupts an in-flight poll and sends cancellation immediately', () => {
    const polled = new Subject<CaptureOperation>();
    const cancelCapture = vi.fn(() => of(cancelledOperation));
    const getCapture = vi.fn(() => polled);
    const client = runtimeStub({
      createCapture: vi.fn(() => of(runningOperation)),
      cancelCapture,
      getCapture,
    });
    const store = initializeCapture(libraryStub(), client);

    vi.useFakeTimers();
    try {
      store.service.startDocument$(summary.documentId, store.host).subscribe();
      vi.advanceTimersByTime(700);
      expect(getCapture).toHaveBeenCalledWith('capture-1');
      expect(cancelCapture).not.toHaveBeenCalled();

      store.service.cancel(summary.documentId);
      TestBed.tick();

      expect(cancelCapture).toHaveBeenCalledOnce();
      expect(client.cancelUpload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['answers', (polled: Subject<CaptureOperation>) => {
      polled.next(operation({ captureId: 'capture-1', status: 'awaiting_structuring' }));
      polled.complete();
    }],
    ['is rejected', (polled: Subject<CaptureOperation>) => polled.error('Capture Runtime is unavailable.')],
  ] as const)(
    'stores what the cancel answered when a poll that was sent before it %s first',
    async (_reply, replyToPoll) => {
      let stored: DesktopLibrarySummary = summary;
      const polled = new Subject<CaptureOperation>();
      const cancelReply = new Subject<CaptureOperation>();
      const getCapture = vi.fn(() => polled);
      const cancelCapture = vi.fn(() => cancelReply);
      const store = initializeCapture(
        libraryStub({
          list: vi.fn(() => of([stored])),
          updateCapture: vi.fn((update: Record<string, unknown>) => {
            stored = applyDurableCaptureUpdate(stored, update);
            return of(stored);
          }),
        }),
        runtimeStub({ createCapture: vi.fn(() => of(runningOperation)), getCapture, cancelCapture }),
      );

      vi.useFakeTimers();
      try {
        store.service.startDocument$(summary.documentId, store.host).subscribe();
        vi.advanceTimersByTime(700);
      } finally {
        vi.useRealTimers();
      }
      expect(getCapture).toHaveBeenCalledTimes(1);
      store.service.cancel(summary.documentId);
      TestBed.tick();
      expect(cancelCapture).toHaveBeenCalledExactlyOnceWith('capture-1');

      replyToPoll(polled);
      TestBed.tick();
      await settleCaptureLifecycle();
      cancelReply.next(cancelledOperation);
      cancelReply.complete();
      TestBed.tick();
      await settleCaptureLifecycle();

      expect(getCapture).toHaveBeenCalledTimes(1);
      expect(stored).toMatchObject({ status: 'canceled', stage: 'cancelled', captureId: undefined });
    },
  );

  it('lets an already-terminal runtime response win a cancel/complete race', async () => {
    const created = new Subject<CaptureOperation>();
    const cancelCapture = vi.fn(() => of(cancelledOperation));
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => created),
      cancelCapture,
      deleteCapture,
    });
    const store = initializeCapture(libraryStub(), client);

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    store.service.cancel(summary.documentId);
    created.next(completedOperation);
    created.complete();
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(cancelCapture).not.toHaveBeenCalled();
    expect(deleteCapture).toHaveBeenCalledWith('capture-1');
  });

  it('persists optional raw data before deleting a canceled runtime operation', () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update }));
    const getRaw = vi.fn(() => of(raw));
    const getOcr = vi.fn(() => of(ocrProjection('capture-1', 'completed')));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeCapture(
      libraryStub({ updateCapture }),
      runtimeStub({
        createCapture: vi.fn(() => of(cancelledOperation)),
        getRaw,
        getOcr,
        deleteCapture,
      }),
    );

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    TestBed.tick();

    expect(getRaw).toHaveBeenCalledWith('capture-1');
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'canceled',
        captureId: 'capture-1',
        raw,
      }),
    );
    expect(getOcr).not.toHaveBeenCalled();
    expect(deleteCapture).toHaveBeenCalledWith('capture-1');
  });

  it('retains a canceled runtime operation when optional raw retrieval fails', () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update }));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeCapture(
      libraryStub({ updateCapture }),
      runtimeStub({
        createCapture: vi.fn(() => of(cancelledOperation)),
        getRaw: vi.fn(() => throwError(() => new Error('raw transport failed'))),
        deleteCapture,
      }),
    );

    store.service.startDocument$(summary.documentId, store.host).subscribe();
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
      of({ ...summary, ...update }));
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => of(runningOperation)),
      cancelCapture: vi.fn(() =>
        throwError(() => new Error('cancel request failed'))),
      deleteCapture,
    });
    const store = initializeCapture(libraryStub({ updateCapture }), client);

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    store.service.cancel(summary.documentId);
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
  ])('retains the runtime operation when %s fails', async (_case, runtimeOverride) => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update }));
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedOperation)),
      deleteCapture,
      ...runtimeOverride,
    });
    const store = initializeCapture(libraryStub({ updateCapture }), client);

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
        recoveryCode: 'capture_recovery_required',
      }),
    );
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it('retains the runtime operation when the terminal library commit fails', async () => {
    let terminalCommitAttempted = false;
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      if (update['status'] === 'completed' && !update['clearCaptureId']) {
        terminalCommitAttempted = true;
        return throwError(() => new Error('library commit failed'));
      }
      return of({ ...summary, ...update });
    });
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedOperation)),
      deleteCapture,
    });
    const store = initializeCapture(libraryStub({ updateCapture }), client);

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(terminalCommitAttempted).toBe(true);
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
      }),
    );
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'] as const)(
    'retains the durable %s capture across terminal and recovery write failures',
    async (terminalStatus) => {
      const captureId = `capture-terminal-recovery-write-failure-${terminalStatus}`;
      const terminal = operation({
        captureId,
        status: terminalStatus,
        ...(terminalStatus === 'failed'
          ? { error: { code: 'terminal_error', message: 'terminal evidence' } }
          : {}),
      });
      const durable = { ...summary };
      const terminalUpdates: Record<string, unknown>[] = [];
      const recoveryUpdates: Record<string, unknown>[] = [];
      const cleanupClearUpdates: Record<string, unknown>[] = [];
      let failTerminalWrite = true;
      let failRecoveryWrite = true;
      const updateCapture = vi.fn((update: Record<string, unknown>) => {
        if (
          (update['status'] === 'completed' || update['status'] === 'failed')
          && 'ocrEvidence' in update
        ) {
          terminalUpdates.push(update);
          if (failTerminalWrite) {
            failTerminalWrite = false;
            return throwError(() => new Error('terminal OCR commit failed'));
          }
        }
        if (update['status'] === 'recovery_required') {
          recoveryUpdates.push(update);
          if (failRecoveryWrite) {
            failRecoveryWrite = false;
            return throwError(() => new Error('recovery write failed'));
          }
        }
        if (
          update['clearCaptureId'] === true
          && update['status'] !== 'processing'
        ) {
          cleanupClearUpdates.push(update);
        }
        Object.assign(durable, applyDurableCaptureUpdate(durable, update));
        return of(durable);
      });
      const getOcr = vi.fn((id: string) => of(ocrProjection(id, terminalStatus)));
      const deleteCapture = vi.fn(() => of(undefined));
      const createCapture = vi.fn(() => of(terminal));
      const getCapture = vi.fn(() => of(terminal));
      const library = libraryStub({
        list: vi.fn(() => of([durable])),
        get: vi.fn(() => of<DesktopLibraryDetail>(durable)),
        updateCapture,
      });
      const store = initializeCapture(
        library,
        runtimeStub({ createCapture, getCapture, getOcr, deleteCapture }),
      );

      store.service.startDocument$(summary.documentId, store.host).subscribe();
      TestBed.tick();
      await settleCaptureLifecycle();

      expect(getOcr).toHaveBeenCalledWith(captureId);
      expect(terminalUpdates).toHaveLength(1);
      expect(terminalUpdates[0]).toEqual(expect.objectContaining({
        captureId,
        status: terminalStatus,
        ocrEvidence: expect.objectContaining({
          schemaVersion: 1,
          captureId,
          status: terminalStatus,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      }));
      expect(recoveryUpdates).toHaveLength(1);
      expect(deleteCapture).not.toHaveBeenCalled();
      expect(cleanupClearUpdates).toHaveLength(0);
      expect(durable).toEqual(expect.objectContaining({
        status: 'persisting',
        captureId,
      }));
      expect(store.service.busyIds().has(summary.documentId)).toBe(false);

      store.service.retry$(summary.documentId, store.host).subscribe();
      TestBed.tick();
      await settleCaptureLifecycle();

      expect(createCapture).toHaveBeenCalledOnce();
      expect(getCapture).toHaveBeenCalledWith(captureId);
    },
  );

  it('retains a recovery link when runtime DELETE fails after a successful commit', async () => {
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      events.push(`library:${String(update['status'])}`);
      return of({ ...summary, ...update });
    });
    const deleteCapture = vi.fn(() => {
      events.push('runtime:delete');
      return throwError(() => new Error('delete failed'));
    });
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedOperation)),
      deleteCapture,
    });
    const store = initializeCapture(libraryStub({ updateCapture }), client);

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

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
    async (runtimeStatus, libraryStatus) => {
      const terminal = operation({
        captureId: 'capture-terminal-error',
        status: runtimeStatus,
        error: {
          code: 'terminal_error',
          message: 'terminal evidence',
        },
      });
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...summary, ...update }));
      const deleteCapture = vi.fn(() =>
        throwError(() => new Error('cleanup transport failed')));
      const store = initializeCapture(
        libraryStub({ updateCapture }),
        runtimeStub({
          createCapture: vi.fn(() => of(terminal)),
          deleteCapture,
        }),
      );

      store.service.startDocument$(summary.documentId, store.host).subscribe();
      TestBed.tick();
      await settleCaptureLifecycle();

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
      const createCapture = vi.fn(() => of(completedOperation));
      const getCapture = vi.fn(() => of(completedOperation));
      const getRaw = vi.fn(() => of(raw));
      const deleteCapture = vi.fn(() => of(undefined));
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...recovery, ...update }));
      const store = initializeCapture(
        libraryStub({
          list: vi.fn(() => of([recovery])),
          get: vi.fn(() => of<DesktopLibraryDetail>(recovery)),
          updateCapture,
        }),
        runtimeStub({ createCapture, getCapture, getRaw, deleteCapture }),
      );

      store.service.retry$(recovery.documentId, store.host).subscribe();
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

  it('keeps cleanup-only recovery durable when both post-commit library writes fail', async () => {
    const terminal = operation({
      captureId: 'capture-double-write',
      status: 'failed',
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
      get: vi.fn(() => of<DesktopLibraryDetail>(durable)),
      updateCapture,
    });
    const deleteCapture = vi.fn(() => of(undefined));
    const firstStore = initializeCapture(
      library,
      runtimeStub({
        createCapture: vi.fn(() => of(terminal)),
        deleteCapture,
      }),
    );

    firstStore.service.startDocument$(summary.documentId, firstStore.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

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
    const createAfterRestart = vi.fn(() => of(completedOperation));
    const getAfterRestart = vi.fn(() => of(completedOperation));
    const getRawAfterRestart = vi.fn(() => of(raw));
    const restartedStore = initializeCapture(
      library,
      runtimeStub({
        createCapture: createAfterRestart,
        getCapture: getAfterRestart,
        getRaw: getRawAfterRestart,
        deleteCapture,
      }),
    );

    restartedStore.service.retry$(summary.documentId, restartedStore.host).subscribe();
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
      get: vi.fn(() => of<DesktopLibraryDetail>(durable)),
      updateCapture,
    });
    const createCapture = vi.fn(() => of(completedOperation));
    const getCapture = vi.fn(() => of(completedOperation));
    const getRaw = vi.fn(() => of(raw));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeCapture(
      library,
      runtimeStub({ createCapture, getCapture, getRaw, deleteCapture }),
    );

    store.service.retry$(summary.documentId, store.host).subscribe();
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

  it('recovers persistence with the same runtime ID and never creates a new operation', async () => {
    const recovery = {
      ...summary,
      status: 'recovery_required',
      stage: 'completed',
      captureId: 'capture-recovery',
      recoveryCode: 'capture_recovery_required',
    } satisfies DesktopLibrarySummary;
    const createCapture = vi.fn(() => of(completedOperation));
    const getCapture = vi.fn(() => of(operation({
      ...completedOperation,
      captureId: 'capture-recovery',
    })));
    const deleteCapture = vi.fn(() => of(undefined));
    const library = libraryStub({
      list: vi.fn(() => of([recovery])),
      get: vi.fn(() => of<DesktopLibraryDetail>(recovery)),
    });
    const client = runtimeStub({ createCapture, getCapture, deleteCapture });
    const store = initializeCapture(library, client);

    store.service.retry$(recovery.documentId, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

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
      of({ ...recovery, ...update }));
    const createCapture = vi.fn(() => of(completedOperation));
    const getCapture = vi.fn(() => of(completedOperation));
    const deleteCapture = vi.fn(() => of(undefined));
    const library = libraryStub({
      list: vi.fn(() => of([recovery])),
      get: vi.fn(() => of<DesktopLibraryDetail>(recovery)),
      updateCapture,
    });
    const client = runtimeStub({ createCapture, getCapture, deleteCapture });
    const store = initializeCapture(library, client);

    store.service.retry$(recovery.documentId, store.host).subscribe();
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

  it('imports the entire batch before waiting for the first capture', () => {
    const pending = new Subject<CaptureOperation>();
    const imported = vi.fn((input: DesktopSourceSelection) => of({
      ...summary, documentId: input.fileName === 'first.pdf' ? '1'.repeat(32) : '2'.repeat(32),
    }));
    const createCapture = vi.fn(() => pending);
    const store = initializeCapture(libraryStub({ importSelection: imported }), runtimeStub({ createCapture }));
    store.service.addSelections$([selection('first.pdf'), selection('second.pdf')], store.host).subscribe();
    TestBed.tick();
    expect(imported).toHaveBeenCalledTimes(2);
    expect(createCapture).toHaveBeenCalledTimes(1);
    // The second document waits for its turn: nothing else may start it.
    const lifecycle = store.service;
    expect(lifecycle.isDocumentClaimed('2'.repeat(32))).toBe(true);
    pending.complete();
  });

  it('starts the next document of a batch when the previous capture ends, and then holds none', () => {
    const firstCapture = new Subject<CaptureOperation>();
    const secondCapture = new Subject<CaptureOperation>();
    const imported = vi.fn((input: DesktopSourceSelection) => of({
      ...summary, documentId: input.fileName === 'first.pdf' ? '1'.repeat(32) : '2'.repeat(32),
    }));
    const createCapture = vi.fn()
      .mockReturnValueOnce(firstCapture)
      .mockReturnValueOnce(secondCapture);
    const store = initializeCapture(libraryStub({ importSelection: imported }), runtimeStub({ createCapture }));
    const lifecycle = store.service;
    store.service.addSelections$([selection('first.pdf'), selection('second.pdf')], store.host).subscribe();
    TestBed.tick();
    expect(createCapture).toHaveBeenCalledTimes(1);
    expect(createCapture).toHaveBeenNthCalledWith(1, '1'.repeat(32), expect.any(String), undefined);
    firstCapture.complete();
    TestBed.tick();
    expect(createCapture).toHaveBeenCalledTimes(2);
    expect(createCapture).toHaveBeenNthCalledWith(2, '2'.repeat(32), expect.any(String), undefined);
    secondCapture.complete();
    TestBed.tick();
    expect(lifecycle.isDocumentClaimed('1'.repeat(32))).toBe(false);
    expect(lifecycle.isDocumentClaimed('2'.repeat(32))).toBe(false);
  });

  it('does not reattach a finished recording from a document list read before it finished', async () => {
    const captureId = 'capture-recording-finished';
    // The only list the Workbench read while the recording ran.
    const running = {
      ...summary,
      fileName: 'fixture.mp3',
      mediaType: 'audio/mpeg',
      status: 'processing',
      stage: 'extracting',
      captureId,
    } satisfies DesktopLibrarySummary;
    const recording = (status: CaptureOperation['status']) =>
      operation({ captureId, status, kind: 'recording' });
    // Like the runtime: a deleted capture is not found.
    let deleted = false;
    const unlessDeleted = <T>(value: T): Observable<T> => deleted
      ? throwError(() => new Error('Capture Runtime request was rejected with HTTP 404.'))
      : of(value);
    const getCapture = vi.fn(() => unlessDeleted(recording('completed')));
    const deleteCapture = vi.fn(() => {
      deleted = true;
      return of(undefined);
    });
    // What the library stores, as against the list the caller holds.
    let stored: DesktopLibrarySummary = { ...running, status: 'queued', stage: 'uploading', captureId: undefined };
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      stored = applyDurableCaptureUpdate(stored, update);
      return of(stored);
    });
    const store = initializeCapture(
      libraryStub({ list: vi.fn(() => of([stored])), updateCapture }),
      runtimeStub({
        startRecordingCapture: vi.fn(() => of(recording('extracting'))),
        getCaptureEvents: vi.fn(() => unlessDeleted([])),
        getPartial: vi.fn(() => unlessDeleted(null)),
        getCapture,
        getResult: vi.fn(() => unlessDeleted({ operation: recording('completed'), raw, result })),
        deleteCapture,
      }),
    );

    store.service.startDocument$(running.documentId, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();
    expect(deleteCapture).toHaveBeenCalledExactlyOnceWith(captureId);
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({ status: 'completed', clearCaptureId: true }),
    );
    expect(stored).toMatchObject({ status: 'completed', captureId: undefined });
    const readsBeforeReattach = getCapture.mock.calls.length;
    const refreshDocuments = vi.spyOn(store.host, 'refreshDocuments');

    store.service.reattach$(running, store.host).subscribe();
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(getCapture).toHaveBeenCalledTimes(readsBeforeReattach);
    expect(captureUpdates(updateCapture).map((update) => update['status'])).not.toContain('recovery_required');
    expect(stored).toMatchObject({ status: 'completed', captureId: undefined });
    // The caller's list was outdated, so it is told to read it again.
    expect(refreshDocuments).toHaveBeenCalled();
  });

  it.each([
    ['is capturing', [{ ...summary, status: 'processing', captureId: 'capture-1' }]],
    ['has a result', [{ ...summary, status: 'completed' }]],
    ['was cancelled', [{ ...summary, status: 'canceled' }]],
    ['waits for its runtime cleanup', [{
      ...summary, status: 'recovery_required', stage: 'completed', captureId: 'capture-1',
      recoveryCode: 'runtime_cleanup_failed',
    }]],
    ['was deleted', []],
  ] satisfies [string, DesktopLibrarySummary[]][])(
    'does not start a document that no longer waits because it %s',
    (_reason, storedDocuments) => {
      const createCapture = vi.fn(() => of(completedOperation));
      const updateCapture = vi.fn(() => of(summary));
      const store = initializeCapture(
        libraryStub({ list: vi.fn(() => of(storedDocuments)), updateCapture }),
        runtimeStub({ createCapture }),
      );
      const refreshDocuments = vi.spyOn(store.host, 'refreshDocuments');

      store.service.startDocument$(summary.documentId, store.host).subscribe();
      TestBed.tick();

      expect(createCapture).not.toHaveBeenCalled();
      expect(updateCapture).not.toHaveBeenCalled();
      expect(refreshDocuments).toHaveBeenCalled();
    },
  );

  it.each([
    ['holds its result', [{ ...summary, status: 'completed' }]],
    ['holds an OCR result to confirm', [{ ...summary, status: 'awaiting_confirmation', hasRaw: true }]],
    ['waits in the queue', [{ ...summary, status: 'queued' }]],
    ['was deleted', []],
  ] satisfies [string, DesktopLibrarySummary[]][])(
    'does not start a capture on retry for a stored document that %s',
    (_state, storedDocuments) => {
      const createCapture = vi.fn(() => of(completedOperation));
      const updateCapture = vi.fn(() => of(summary));
      const store = initializeCapture(
        libraryStub({ list: vi.fn(() => of(storedDocuments)), updateCapture }),
        runtimeStub({ createCapture }),
      );
      const refreshDocuments = vi.spyOn(store.host, 'refreshDocuments');

      store.service.retry$(summary.documentId, store.host).subscribe();
      TestBed.tick();

      expect(createCapture).not.toHaveBeenCalled();
      expect(updateCapture).not.toHaveBeenCalled();
      expect(refreshDocuments).toHaveBeenCalled();
    },
  );

  it.each([
    ['failed', { ...summary, status: 'failed', errorCode: 'capture_failed' }],
    ['was cancelled', { ...summary, status: 'canceled' }],
    ['lost its capture', { ...summary, status: 'processing' }],
    ['needs recovery without a capture', { ...summary, status: 'recovery_required' }],
  ] satisfies [string, DesktopLibrarySummary][])(
    'starts a new capture on retry for a stored document that %s',
    (_state, storedDocument) => {
      const created = new Subject<CaptureOperation>();
      const createCapture = vi.fn(() => created);
      const store = initializeCapture(
        libraryStub({ list: vi.fn(() => of([storedDocument])) }),
        runtimeStub({ createCapture }),
      );

      store.service.retry$(summary.documentId, store.host).subscribe();
      TestBed.tick();

      expect(createCapture).toHaveBeenCalledTimes(1);
      created.complete();
    },
  );

  describe('a linked document that holds terminal data', () => {
    // Earlier versions stored a refused unlink of a recording with the last
    // event's stage, which need not be terminal.
    const cleanupRowWithLastEventStage = (evidence: Partial<DesktopLibrarySummary>) => ({
      ...summary,
      fileName: 'fixture.mp3',
      mediaType: 'audio/mpeg',
      status: 'recovery_required',
      stage: 'extracting',
      captureId: 'capture-kept',
      recoveryCode: 'runtime_cleanup_failed',
      recoveryMessage: 'Capture library index cannot be written.',
      ...evidence,
    } satisfies DesktopLibrarySummary);

    it.each([
      ['a cleanup row with a kept result', cleanupRowWithLastEventStage({ hasRaw: true }),
        { status: 'completed', stage: 'completed' }],
      ['a cleanup row with a stored terminal error',
        cleanupRowWithLastEventStage({ errorCode: 'speech_failed', errorMessage: 'no speech' }),
        { status: 'failed', stage: 'failed', errorCode: 'speech_failed', errorMessage: 'no speech' }],
      ['a cleanup row that does not say how its capture ended', cleanupRowWithLastEventStage({}),
        { status: 'recovery_required', stage: 'extracting', recoveryCode: 'runtime_cleanup_failed',
          recoveryMessage: 'Capture library index cannot be written.' }],
      ['a completed document that was never unlinked',
        { ...summary, status: 'completed', stage: 'completed', captureId: 'capture-kept', hasRaw: true },
        { status: 'completed', stage: 'completed' }],
      ['an OCR result to confirm that was never unlinked',
        { ...summary, status: 'awaiting_confirmation', stage: 'awaiting_structuring', captureId: 'capture-kept', hasRaw: true },
        { status: 'awaiting_confirmation', stage: 'awaiting_structuring' }],
    ] satisfies [string, DesktopLibrarySummary, Record<string, unknown>][])(
      'only cleans up %s, whose runtime capture is gone',
      (_row, storedDocument, written) => {
        let stored: DesktopLibrarySummary = storedDocument;
        const updateCapture = vi.fn((update: Record<string, unknown>) => {
          stored = applyDurableCaptureUpdate(stored, update);
          return of(stored);
        });
        // The runtime no longer knows the capture; the host answers its delete as done.
        const getCapture = vi.fn(() =>
          throwError(() => 'Capture Runtime request was rejected with HTTP 404.'));
        const deleteCapture = vi.fn(() => of(undefined));
        const createCapture = vi.fn(() => of(completedOperation));
        const store = initializeCapture(
          libraryStub({ list: vi.fn(() => of([stored])), updateCapture }),
          runtimeStub({ getCapture, deleteCapture, createCapture }),
        );

        store.service.reattach$(storedDocument, store.host).subscribe();
        TestBed.tick();

        expect(getCapture).not.toHaveBeenCalled();
        expect(deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-kept');
        expect(captureUpdates(updateCapture)).toEqual([
          expect.objectContaining({ documentId: summary.documentId, clearCaptureId: true, ...written }),
        ]);
        expect(captureUpdates(updateCapture)[0]).not.toHaveProperty('captureId');
        // Nothing marks the capture as lost, so no row offers a restart over the kept data.
        expect(stored.recoveryCode).not.toBe('capture_recovery_required');
        expect(isCaptureLost(stored)).toBe(false);
        expect(stored.captureId).toBeUndefined();

        store.service.restartLost$(summary.documentId, store.host).subscribe();
        TestBed.tick();
        expect(createCapture).not.toHaveBeenCalled();
        expect(updateCapture).toHaveBeenCalledTimes(1);
      },
    );
    it('still reads the runtime for a row stored as a lost capture, also when raw text is kept beside it', () => {
      // Such a row does not hold the terminal data of its capture: the raw text
      // can be that of an earlier capture, so nothing is restored from it.
      const lostRow = {
        ...summary, fileName: 'fixture.mp3', mediaType: 'audio/mpeg', status: 'recovery_required',
        stage: 'extracting', captureId: 'capture-lost', recoveryCode: 'capture_recovery_required', hasRaw: true,
      } satisfies DesktopLibrarySummary;
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of(applyDurableCaptureUpdate(lostRow, update)));
      const getCapture = vi.fn(() =>
        throwError(() => 'Capture Runtime request was rejected with HTTP 404.'));
      const deleteCapture = vi.fn(() => of(undefined));
      const store = initializeCapture(
        libraryStub({ list: vi.fn(() => of([lostRow])), updateCapture }),
        runtimeStub({ getCapture, deleteCapture }),
      );

      store.service.reattach$(lostRow, store.host).subscribe();
      TestBed.tick();

      expect(getCapture).toHaveBeenCalledExactlyOnceWith('capture-lost');
      expect(deleteCapture).not.toHaveBeenCalled();
      expect(captureUpdates(updateCapture)).toEqual([
        expect.objectContaining({
          status: 'recovery_required', captureId: 'capture-lost', recoveryCode: 'capture_recovery_required',
        }),
      ]);
    });

  });

  describe('the steps of a decision', () => {
    const lost = {
      ...summary, status: 'recovery_required', captureId: 'capture-lost', recoveryCode: 'capture_recovery_required',
    } satisfies DesktopLibrarySummary;

    /** A service whose reads of the stored document and whose library writes the test answers. */
    function decisionSteps(initiallyStored: DesktopLibrarySummary) {
      let storedDocument = initiallyStored;
      const reads: Subject<readonly DesktopLibrarySummary[]>[] = [];
      const writes: { readonly update: Record<string, unknown>; readonly answer: Subject<DesktopLibrarySummary> }[] = [];
      const list = vi.fn((): Observable<readonly DesktopLibrarySummary[]> => of([storedDocument]));
      const updateCapture = vi.fn((update: Record<string, unknown>) => {
        const answer = new Subject<DesktopLibrarySummary>();
        writes.push({ update, answer });
        return answer;
      });
      const createCapture = vi.fn(() => new Subject<CaptureOperation>());
      const getCapture = vi.fn(() => new Subject<CaptureOperation>());
      const store = initializeCapture(
        libraryStub({ list, updateCapture }),
        runtimeStub({ createCapture, getCapture }),
      );
      // Only the service reads without arguments; the host's own list answers at once.
      list.mockImplementation((...listArguments: unknown[]) => {
        if (listArguments.length > 0) return of([storedDocument]);
        const read = new Subject<readonly DesktopLibrarySummary[]>();
        reads.push(read);
        return read;
      });
      const failed = vi.fn();
      return {
        ...store,
        reads,
        writes,
        createCapture,
        getCapture,
        failed,
        /** The library stores the document differently from now on. */
        store: (document: DesktopLibrarySummary) => {
          storedDocument = document;
        },
        answerRead: (index: number) => {
          reads[index].next([storedDocument]);
          reads[index].complete();
        },
        answerWrite: (index: number) => {
          writes[index].answer.next(applyDurableCaptureUpdate(storedDocument, writes[index].update));
          writes[index].answer.complete();
        },
      };
    }
    const cancelled = { documentId: summary.documentId, status: 'canceled', stage: 'cancelled', clearCaptureId: true };

    it('releases the claim when the read is unsubscribed before it answers', () => {
      const steps = decisionSteps(summary);
      const subscription = steps.service.startDocument$(summary.documentId, steps.host).subscribe();
      expect(steps.service.isDocumentClaimed(summary.documentId)).toBe(true);

      subscription.unsubscribe();
      expect(steps.service.isDocumentClaimed(summary.documentId)).toBe(false);
      // An answer that still arrives starts nothing.
      steps.reads[0].next([summary]);
      expect(steps.writes).toEqual([]);
      expect(steps.createCapture).not.toHaveBeenCalled();
    });

    it('keeps a cancel across a failed read and applies it at the next decision', () => {
      const steps = decisionSteps(summary);
      steps.service.startDocument$(summary.documentId, steps.host).subscribe({ error: steps.failed });
      steps.service.cancel(summary.documentId);
      steps.reads[0].error('Capture library index cannot be read.');
      expect(steps.failed).toHaveBeenCalledTimes(1);
      expect(steps.service.isDocumentClaimed(summary.documentId)).toBe(false);
      expect(steps.writes).toEqual([]);

      steps.service.startDocument$(summary.documentId, steps.host).subscribe();
      steps.answerRead(1);

      expect(steps.createCapture).not.toHaveBeenCalled();
      expect(steps.writes.map((write) => write.update)).toEqual([cancelled]);
    });

    it('keeps a cancel across a failed cancel write and applies it at the next decision', () => {
      const steps = decisionSteps(summary);
      steps.service.startDocument$(summary.documentId, steps.host).subscribe({ error: steps.failed });
      steps.service.cancel(summary.documentId);
      steps.answerRead(0);
      expect(steps.writes.map((write) => write.update)).toEqual([cancelled]);
      // A second cancel while the write is in flight changes nothing.
      steps.service.cancel(summary.documentId);
      expect(steps.writes).toHaveLength(1);

      steps.writes[0].answer.error('Capture library index cannot be written.');
      expect(steps.failed).toHaveBeenCalledExactlyOnceWith('Capture library index cannot be written.');
      expect(steps.service.isDocumentClaimed(summary.documentId)).toBe(false);

      steps.service.startDocument$(summary.documentId, steps.host).subscribe();
      steps.answerRead(1);
      expect(steps.createCapture).not.toHaveBeenCalled();
      expect(steps.writes.map((write) => write.update)).toEqual([cancelled, cancelled]);
      steps.answerWrite(1);

      // Applied: a later start of the document, were it to wait again, is a start.
      steps.service.startDocument$(summary.documentId, steps.host).subscribe();
      steps.answerRead(2);
      expect(steps.writes[2].update).toEqual(expect.objectContaining({ status: 'processing' }));
    });

    it('drops a cancel that the stored document makes pointless', () => {
      const finished = { ...summary, status: 'completed' } satisfies DesktopLibrarySummary;
      const steps = decisionSteps(finished);
      steps.service.startDocument$(summary.documentId, steps.host).subscribe();
      steps.service.cancel(summary.documentId);
      steps.answerRead(0);
      expect(steps.writes).toEqual([]);

      // Nothing was left to cancel. Were the document to wait again, it would start.
      steps.store(summary);
      steps.service.startDocument$(summary.documentId, steps.host).subscribe();
      steps.answerRead(1);
      expect(steps.writes.map((write) => write.update['status'])).toEqual(['processing']);
    });


    it.each(['retry$', 'restartLost$'] as const)(
      'does not let an older cancel that was never applied cancel an explicit %s',
      (entry) => {
        const steps = decisionSteps(lost);
        steps.service.reattach$(lost, steps.host).subscribe({ error: steps.failed });
        steps.service.cancel(summary.documentId);
        steps.reads[0].error('Capture library index cannot be read.');

        steps.service[entry](summary.documentId, steps.host).subscribe();
        steps.answerRead(1);

        expect(steps.writes.map((write) => write.update['status'])).not.toContain('canceled');
        expect(steps.service.isDocumentClaimed(summary.documentId)).toBe(true);
      },
    );

    it('lets a cancel win that arrives while a restart clears the link', () => {
      const steps = decisionSteps(lost);
      steps.service.restartLost$(summary.documentId, steps.host).subscribe();
      steps.answerRead(0);
      expect(steps.writes.map((write) => write.update['status'])).toEqual(['queued']);

      steps.service.cancel(summary.documentId);
      steps.answerWrite(0);

      expect(steps.createCapture).not.toHaveBeenCalled();
      expect(steps.writes.map((write) => write.update)).toEqual([
        { documentId: summary.documentId, status: 'queued', stage: 'uploading', clearCaptureId: true },
        cancelled,
      ]);
    });

    it('releases the claim and starts nothing when a restart cannot clear the link', () => {
      const steps = decisionSteps(lost);
      steps.service.restartLost$(summary.documentId, steps.host).subscribe({ error: steps.failed });
      steps.answerRead(0);

      steps.writes[0].answer.error('Capture library index cannot be written.');

      expect(steps.failed).toHaveBeenCalledExactlyOnceWith('Capture library index cannot be written.');
      expect(steps.createCapture).not.toHaveBeenCalled();
      expect(steps.service.isDocumentClaimed(summary.documentId)).toBe(false);
    });

    describe('that ended in an error', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it.each([
        ['the read failed', (steps: ReturnType<typeof decisionSteps>) => {
          steps.service.startDocument$(summary.documentId, steps.host).subscribe({ error: steps.failed });
          steps.reads[0].error('Capture library index cannot be read.');
        }],
        ['the cancel write failed', (steps: ReturnType<typeof decisionSteps>) => {
          steps.service.startDocument$(summary.documentId, steps.host).subscribe({ error: steps.failed });
          steps.service.cancel(summary.documentId);
          steps.answerRead(0);
          steps.writes[0].answer.error('Capture library index cannot be written.');
        }],
      ] as const)('tells the queues to look again after a pause when %s', (_step, fail) => {
        const steps = decisionSteps(summary);
        const before = steps.service.failedDecisions();

        fail(steps);
        expect(steps.failed).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(FAILED_DECISION_PAUSE_MS - 1);
        expect(steps.service.failedDecisions()).toBe(before);

        vi.advanceTimersByTime(1);
        expect(steps.service.failedDecisions()).toBe(before + 1);
      });

      it('does not tell the queues to look again when a request was declined or a capture ended', () => {
        const finished = { ...summary, status: 'completed' } satisfies DesktopLibrarySummary;
        const steps = decisionSteps(finished);
        const before = steps.service.failedDecisions();

        steps.service.startDocument$(summary.documentId, steps.host).subscribe();
        steps.answerRead(0);
        vi.advanceTimersByTime(10 * FAILED_DECISION_PAUSE_MS);

        expect(steps.service.failedDecisions()).toBe(before);
      });
    });
  });

  describe('a cancel for a linked capture that is being recovered', () => {
    const running = { ...summary, status: 'processing', captureId: 'capture-1' } satisfies DesktopLibrarySummary;
    const notFound = 'Capture Runtime request was rejected with HTTP 404.';

    /** A recovery of `storedDocument`, whose first read of the stored document the test answers. */
    function recovery(
      storedDocument: DesktopLibrarySummary,
      runtime: Record<string, unknown>,
    ) {
      let stored = storedDocument;
      const listed = new Subject<readonly DesktopLibrarySummary[]>();
      const list = vi.fn((): Observable<readonly DesktopLibrarySummary[]> => of([stored]));
      const updateCapture = vi.fn((update: Record<string, unknown>) => {
        stored = applyDurableCaptureUpdate(stored, update);
        return of(stored);
      });
      const createCapture = vi.fn(() => of(completedOperation));
      const deleteCapture = vi.fn(() => of(undefined));
      const store = initializeCapture(
        libraryStub({ list, updateCapture }),
        runtimeStub({ createCapture, deleteCapture, ...runtime }),
      );
      list.mockImplementationOnce(() => listed);
      return {
        ...store,
        updateCapture,
        createCapture,
        deleteCapture,
        stored: () => stored,
        answerRead: () => {
          listed.next([stored]);
          listed.complete();
        },
      };
    }

    it.each([
      ['does not answer', (): Observable<CaptureOperation> => new Subject<CaptureOperation>()],
      ['is rejected', (): Observable<CaptureOperation> => throwError(() => notFound)],
      ['would say the capture runs', (): Observable<CaptureOperation> => of(runningOperation)],
    ] as const)(
      'is sent to the runtime first, also when a read of the capture %s',
      (_read, readCapture) => {
        const getCapture = vi.fn(readCapture);
        const cancelCapture = vi.fn(() => of(cancelledOperation));
        const { service, host, answerRead, stored, createCapture } =
          recovery(running, { getCapture, cancelCapture });

        service.reattach$(running, host).subscribe();
        service.cancel(summary.documentId);
        answerRead();
        TestBed.tick();

        expect(cancelCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
        expect(getCapture).not.toHaveBeenCalled();
        expect(createCapture).not.toHaveBeenCalled();
        expect(stored()).toMatchObject({ status: 'canceled', captureId: undefined });
      },
    );

    it('is sent at once when it arrives while the first read of the capture is held', () => {
      const getCapture = vi.fn((): Observable<CaptureOperation> => new Subject<CaptureOperation>());
      const cancelCapture = vi.fn(() => of(cancelledOperation));
      const { service, host, answerRead, stored } = recovery(running, { getCapture, cancelCapture });
      service.reattach$(running, host).subscribe();
      answerRead();
      expect(getCapture).toHaveBeenCalledTimes(1);
      expect(cancelCapture).not.toHaveBeenCalled();

      service.cancel(summary.documentId);
      TestBed.tick();

      expect(cancelCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
      expect(stored()).toMatchObject({ status: 'canceled', captureId: undefined });
    });

    it('keeps the result of a capture that had already ended when the cancel reached the runtime', async () => {
      const getCapture = vi.fn((): Observable<CaptureOperation> => new Subject<CaptureOperation>());
      // The runtime answers a cancel of an ended capture with the capture as it ended.
      const cancelCapture = vi.fn(() => of(completedOperation));
      const { service, host, answerRead, stored, deleteCapture } =
        recovery(running, { getCapture, cancelCapture });

      service.reattach$(running, host).subscribe();
      service.cancel(summary.documentId);
      answerRead();
      TestBed.tick();
      await settleCaptureLifecycle();

      expect(cancelCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
      expect(deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
      expect(stored()).toMatchObject({ status: 'completed', captureId: undefined });
    });

    it('keeps the link and marks the cancel as failed when the runtime rejects it', () => {
      const getCapture = vi.fn((): Observable<CaptureOperation> => new Subject<CaptureOperation>());
      const cancelCapture = vi.fn(() => throwError(() => 'Capture Runtime is unavailable.'));
      const { service, host, answerRead, stored, deleteCapture } =
        recovery(running, { getCapture, cancelCapture });

      service.reattach$(running, host).subscribe();
      service.cancel(summary.documentId);
      answerRead();
      TestBed.tick();

      expect(deleteCapture).not.toHaveBeenCalled();
      expect(stored()).toMatchObject({
        status: 'recovery_required', captureId: 'capture-1', recoveryCode: 'cancel_failed',
      });
      expect(service.isDocumentClaimed(summary.documentId)).toBe(false);
    });

    describe('for a recording', () => {
      const recordingDocument = {
        ...running, fileName: 'fixture.mp3', mediaType: 'audio/mpeg',
      } satisfies DesktopLibrarySummary;
      const recording = (status: CaptureOperation['status']) =>
        operation({ captureId: 'capture-1', status, kind: 'recording' });

      function recordingRecovery(cancelReply: CaptureOperation, laterRead: Observable<CaptureOperation>) {
        const calls: string[] = [];
        const called = <T>(name: string, reply: Observable<T>) => vi.fn(() => {
          calls.push(name);
          return reply;
        });
        const test = recovery(recordingDocument, {
          cancelCapture: called('cancel', of(cancelReply)),
          getCaptureEvents: called('events', of([])),
          getPartial: called('partial', of(null)),
          getCapture: called('capture', laterRead),
        });
        test.service.reattach$(recordingDocument, test.host).subscribe();
        test.service.cancel(summary.documentId);
        test.answerRead();
        TestBed.tick();
        return { ...test, calls };
      }

      it.each([
        ['cancelled', 'canceled'],
        ['completed', 'completed'],
        ['failed', 'failed'],
      ] as const)(
        'is sent first, and a capture it answers as %s is stored without another read',
        async (ended, storedStatus) => {
          // Any read after the cancel was answered would fail.
          const { calls, stored, deleteCapture } = recordingRecovery(
            recording(ended),
            throwError(() => 'Capture Runtime is unavailable.'),
          );
          await settleCaptureLifecycle();

          expect(calls).toEqual(['cancel']);
          expect(deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
          expect(stored()).toMatchObject({ status: storedStatus, stage: ended, captureId: undefined });
        },
      );

      it('goes on reading a capture that the cancel answers as still running', () => {
        const { calls, stored } = recordingRecovery(recording('extracting'), of(recording('cancelled')));

        expect(calls).toEqual(['cancel', 'events', 'partial', 'capture']);
        expect(stored()).toMatchObject({ status: 'canceled', captureId: undefined });
      });
    });

    it('is not sent for a document that holds its result: only the cleanup runs', () => {
      const cleanupRow = {
        ...summary, status: 'recovery_required', stage: 'completed', captureId: 'capture-1',
        recoveryCode: 'runtime_cleanup_failed',
      } satisfies DesktopLibrarySummary;
      const getCapture = vi.fn(() => of(runningOperation));
      const cancelCapture = vi.fn(() => of(cancelledOperation));
      const { service, host, answerRead, stored, deleteCapture } =
        recovery(cleanupRow, { getCapture, cancelCapture });

      service.reattach$(cleanupRow, host).subscribe();
      service.cancel(summary.documentId);
      answerRead();
      TestBed.tick();

      expect(cancelCapture).not.toHaveBeenCalled();
      expect(getCapture).not.toHaveBeenCalled();
      expect(deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
      expect(stored()).toMatchObject({ status: 'completed', captureId: undefined });
    });

    it('is kept when a start is declined because the stored document is linked, and sent by the recovery', () => {
      const getCapture = vi.fn((): Observable<CaptureOperation> => new Subject<CaptureOperation>());
      const cancelCapture = vi.fn(() => of(cancelledOperation));
      const { service, host, answerRead, stored, updateCapture } =
        recovery(running, { getCapture, cancelCapture });

      // The row still said waiting; the stored document is linked to a capture.
      service.startDocument$(summary.documentId, host).subscribe();
      service.cancel(summary.documentId);
      answerRead();
      expect(updateCapture).not.toHaveBeenCalled();
      expect(cancelCapture).not.toHaveBeenCalled();

      service.reattach$(running, host).subscribe();
      TestBed.tick();

      expect(cancelCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
      expect(getCapture).not.toHaveBeenCalled();
      expect(stored()).toMatchObject({ status: 'canceled', captureId: undefined });
    });

    describe.each([
      [
        'a one-shot capture',
        running,
        // A read that was answered before the cancel: the OCR result waited for its structuring.
        operation({ captureId: 'capture-1', status: 'awaiting_structuring' }),
        cancelledOperation,
      ],
      [
        'a recording',
        { ...running, fileName: 'fixture.mp3', mediaType: 'audio/mpeg' },
        operation({ captureId: 'capture-1', status: 'extracting', kind: 'recording' }),
        operation({ captureId: 'capture-1', status: 'cancelled', kind: 'recording' }),
      ],
    ] satisfies [string, DesktopLibrarySummary, CaptureOperation, CaptureOperation][])(
      'that arrives for %s while the first read of the capture is unanswered',
      (_kind, document, answeredBeforeTheCancel, cancelled) => {
        /** The first read of the capture and the cancel are both sent, and neither is answered. */
        function readAndCancelUnanswered() {
          const read = new Subject<CaptureOperation>();
          const cancelReply = new Subject<CaptureOperation>();
          // Any read after the first one would fail.
          const getCapture = vi.fn((): Observable<CaptureOperation> => throwError(() => notFound));
          getCapture.mockImplementationOnce(() => read);
          const cancelCapture = vi.fn(() => cancelReply);
          const test = recovery(document, {
            getCapture,
            cancelCapture,
            getCaptureEvents: vi.fn(() => of([])),
            getPartial: vi.fn(() => of(null)),
          });
          test.service.reattach$(document, test.host).subscribe();
          test.answerRead();
          expect(getCapture).toHaveBeenCalledTimes(1);
          test.service.cancel(summary.documentId);
          TestBed.tick();
          expect(cancelCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
          return {
            ...test,
            answerCaptureRead: () => { read.next(answeredBeforeTheCancel); read.complete(); },
            rejectCaptureRead: () => read.error(notFound),
            answerCancel: () => { cancelReply.next(cancelled); cancelReply.complete(); },
          };
        }

        it.each([
          ['the read answers before the cancel', ['answerCaptureRead', 'answerCancel']],
          ['the cancel answers before the read', ['answerCancel', 'answerCaptureRead']],
          ['the read is rejected before the cancel answers', ['rejectCaptureRead', 'answerCancel']],
        ] satisfies [string, ('answerCaptureRead' | 'rejectCaptureRead' | 'answerCancel')[]][])(
          'stores what the cancel answered when %s',
          async (_order, replies) => {
            const test = readAndCancelUnanswered();

            for (const reply of replies) {
              test[reply]();
              TestBed.tick();
              await settleCaptureLifecycle();
            }

            expect(test.stored()).toMatchObject({ status: 'canceled', stage: 'cancelled', captureId: undefined });
            expect(test.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
            expect(test.service.isDocumentClaimed(summary.documentId)).toBe(false);
          },
        );
      },
    );
  });

  describe('the live lines of an earlier capture', () => {
    const earlierLines = { captureId: 'capture-earlier', revision: 1, sourceText: 'earlier lines' } as PartialCapture;
    const lostDocument = {
      ...summary, status: 'recovery_required', captureId: 'capture-earlier', recoveryCode: 'capture_recovery_required',
    } satisfies DesktopLibrarySummary;
    const ENTRIES = ['startDocument$', 'retry$', 'restartLost$'] as const;

    function withEarlierLines(storedDocument: DesktopLibrarySummary) {
      const createCapture = vi.fn(() => new Subject<CaptureOperation>());
      const getCapture = vi.fn(() => new Subject<CaptureOperation>());
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of(applyDurableCaptureUpdate(storedDocument, update)));
      const store = initializeCapture(
        libraryStub({ list: vi.fn(() => of([storedDocument])), updateCapture }),
        runtimeStub({ createCapture, getCapture }),
      );
      store.service.streamingPartials.set(new Map([[summary.documentId, earlierLines]]));
      return { ...store, createCapture, getCapture };
    }

    it.each([
      ['a waiting document starts', 'startDocument$', { ...summary }],
      ['a failed document is captured again', 'retry$', { ...summary, status: 'failed' }],
      ['a document whose capture was lost is restarted', 'restartLost$', lostDocument],
    ] satisfies [string, (typeof ENTRIES)[number], DesktopLibrarySummary][])(
      'are cleared when %s',
      (_transition, entry, storedDocument) => {
        const { service, host, createCapture } = withEarlierLines(storedDocument);

        service[entry](summary.documentId, host).subscribe();
        TestBed.tick();

        expect(createCapture).toHaveBeenCalledTimes(1);
        expect(service.streamingPartials().has(summary.documentId)).toBe(false);
      },
    );

    it.each(ENTRIES)('are kept when %s is declined', (entry) => {
      const { service, host, createCapture } = withEarlierLines({ ...summary, status: 'completed' });

      service[entry](summary.documentId, host).subscribe();
      TestBed.tick();

      expect(createCapture).not.toHaveBeenCalled();
      expect(service.streamingPartials().get(summary.documentId)).toBe(earlierLines);
    });

    it('are kept when a retry resumes the capture they belong to', () => {
      const linked = { ...summary, status: 'processing', captureId: 'capture-earlier' } satisfies DesktopLibrarySummary;
      const { service, host, createCapture, getCapture } = withEarlierLines(linked);

      service.retry$(summary.documentId, host).subscribe();
      TestBed.tick();

      expect(getCapture).toHaveBeenCalledExactlyOnceWith('capture-earlier');
      expect(createCapture).not.toHaveBeenCalled();
      expect(service.streamingPartials().get(summary.documentId)).toBe(earlierLines);
    });
  });

  describe('every entry against every state of a document', () => {
    const STATES = [
      'its stored state is being read',
      'a capture runs for it',
      'its terminal writes are in flight',
      'a batch has scheduled it',
      'its cleanup is pending after a refused unlink',
    ] as const;
    type State = (typeof STATES)[number];
    const ENTRIES = ['startDocument$', 'reattach$', 'retry$', 'restartLost$', 'cancel', 'delete'] as const;
    type Entry = (typeof ENTRIES)[number];
    const CLAIMED: readonly State[] = STATES.slice(0, 4);

    /** What an entry did, counted from the moment the state was reached. */
    interface Effect {
      /** Reads of the stored document by the capture service. */
      readonly decisionReads: number;
      /** Statuses written to the library. */
      readonly writes: readonly string[];
      readonly capturesCreated: number;
      readonly captureReads: number;
      readonly runtimeCancels: number;
      readonly uploadCancels: number;
      readonly runtimeDeletes: number;
    }
    const NOTHING: Effect = {
      decisionReads: 0, writes: [], capturesCreated: 0, captureReads: 0,
      runtimeCancels: 0, uploadCancels: 0, runtimeDeletes: 0,
    };
    /** The one cell of a claimed state that does something, and the cells of the unclaimed cleanup state. */
    function expectedEffect(state: State, entry: Entry): Effect {
      if (state === 'a capture runs for it' && entry === 'cancel') {
        // The upload is still in flight: its native cancel is asked for.
        return { ...NOTHING, uploadCancels: 1 };
      }
      if (state !== 'its cleanup is pending after a refused unlink') return NOTHING;
      if (entry === 'cancel' || entry === 'delete') return NOTHING;
      // Start and restart are declined after the read; reattach and retry only clean up.
      return entry === 'startDocument$' || entry === 'restartLost$'
        ? { ...NOTHING, decisionReads: 1 }
        : { ...NOTHING, decisionReads: 1, runtimeDeletes: 1, writes: ['completed'] };
    }

    /** A document in the given state, over the real library store's delete guard. */
    function documentIn(state: State) {
      const pending = new Subject<never>();
      const batch = state === 'a batch has scheduled it';
      const documentId = batch ? '2'.repeat(32) : summary.documentId;
      const cleanupRow = {
        ...summary, status: 'recovery_required', stage: 'completed', captureId: 'capture-1',
        recoveryCode: 'runtime_cleanup_failed',
      } satisfies DesktopLibrarySummary;
      let stored: readonly DesktopLibrarySummary[] =
        state === 'its cleanup is pending after a refused unlink' ? [cleanupRow]
          : batch ? [{ ...summary, documentId: '1'.repeat(32) }, { ...summary, documentId }]
            : [summary];
      let decisionReads = 0;
      // Only the capture service reads without arguments; the list of the library store answers at once.
      const list = vi.fn((...listArguments: unknown[]): Observable<readonly DesktopLibrarySummary[]> => {
        if (listArguments.length > 0) return of(stored);
        decisionReads += 1;
        return state === 'its stored state is being read' ? pending : of(stored);
      });
      const writes: string[] = [];
      const updateCapture = vi.fn((update: Record<string, unknown>): Observable<DesktopLibrarySummary> => {
        writes.push(String(update['status']));
        stored = stored.map((item) => item.documentId === update['documentId']
          ? applyDurableCaptureUpdate(item, update)
          : item);
        return of(stored.find((item) => item.documentId === update['documentId']) ?? summary);
      });
      const importSelection = vi.fn((input: DesktopSourceSelection) => of({
        ...summary, documentId: input.fileName === 'first.pdf' ? '1'.repeat(32) : '2'.repeat(32),
      }));
      const createCapture = vi.fn((): Observable<CaptureOperation> =>
        state === 'its terminal writes are in flight' ? of(cancelledOperation) : pending);
      const getCapture = vi.fn(() => of(runningOperation));
      const cancelCapture = vi.fn(() => of(cancelledOperation));
      const cancelUpload = vi.fn(() => of(undefined));
      // In flight: the result is kept and the runtime cleanup that follows does not answer.
      const deleteCapture = vi.fn((): Observable<undefined> =>
        state === 'its terminal writes are in flight' ? pending : of(undefined));
      const store = initializeCapture(
        libraryStub({ list, updateCapture, importSelection }),
        runtimeStub({ createCapture, getCapture, cancelCapture, cancelUpload, deleteCapture }),
      );
      if (batch) {
        store.service.addSelections$([selection('first.pdf'), selection('second.pdf')], store.host).subscribe();
      } else if (state !== 'its cleanup is pending after a refused unlink') {
        store.service.startDocument$(documentId, store.host).subscribe();
      }
      const libraryStore = TestBed.inject(LibraryStore);
      TestBed.tick();
      const count = (): Effect => ({
        decisionReads,
        writes: [...writes],
        capturesCreated: createCapture.mock.calls.length,
        captureReads: getCapture.mock.calls.length,
        runtimeCancels: cancelCapture.mock.calls.length,
        uploadCancels: cancelUpload.mock.calls.length,
        runtimeDeletes: deleteCapture.mock.calls.length,
      });
      const before = count();
      return {
        ...store,
        documentId,
        libraryStore,
        list,
        updateCapture,
        cancelCapture,
        deleteCapture,
        /** What happened since the state was reached. */
        effect: (): Effect => {
          const now = count();
          return {
            decisionReads: now.decisionReads - before.decisionReads,
            writes: now.writes.slice(before.writes.length),
            capturesCreated: now.capturesCreated - before.capturesCreated,
            captureReads: now.captureReads - before.captureReads,
            runtimeCancels: now.runtimeCancels - before.runtimeCancels,
            uploadCancels: now.uploadCancels - before.uploadCancels,
            runtimeDeletes: now.runtimeDeletes - before.runtimeDeletes,
          };
        },
      };
    }

    it.each(STATES.flatMap((state) => ENTRIES.map((entry) => [state, entry] as const)))(
      'while %s, %s does what the state allows and no more',
      (state, entry) => {
        const { service, host, documentId, libraryStore, effect } = documentIn(state);
        expect(service.isDocumentClaimed(documentId)).toBe(CLAIMED.includes(state));
        // What an outdated row could ask for: it still shows a running capture.
        const row = { ...summary, documentId, status: 'processing', captureId: 'capture-1' } satisfies DesktopLibrarySummary;

        const actions: Record<Entry, () => void> = {
          'startDocument$': () => service.startDocument$(documentId, host).subscribe(),
          'reattach$': () => service.reattach$(row, host).subscribe(),
          'retry$': () => service.retry$(documentId, host).subscribe(),
          'restartLost$': () => service.restartLost$(documentId, host).subscribe(),
          cancel: () => service.cancel(documentId),
          // The delete of the library is offered through this guard alone.
          delete: () => expect(libraryStore.canDelete(documentId)).toBe(false),
        };
        actions[entry]();
        TestBed.tick();
        libraryStore.refreshDocuments();
        TestBed.tick();

        expect(effect()).toEqual(expectedEffect(state, entry));
        // A claim outlasts every entry; the cleanup state is never claimed afterwards.
        expect(service.isDocumentClaimed(documentId)).toBe(CLAIMED.includes(state));
        // Deletion stays refused in every state: by the claim, or by the link of the cleanup row
        // until a reattach or retry has removed it.
        const unlinked = !CLAIMED.includes(state) && (entry === 'reattach$' || entry === 'retry$');
        expect(libraryStore.canDelete(documentId)).toBe(unlinked);
      },
    );

    it('offers deletion again once a decision that held the document has declined', () => {
      const { service, host, documentId, libraryStore, list } =
        documentIn('its cleanup is pending after a refused unlink');
      const finished = { ...summary, status: 'completed' } satisfies DesktopLibrarySummary;
      const listed = new Subject<readonly DesktopLibrarySummary[]>();
      list.mockImplementation((...listArguments: unknown[]) =>
        listArguments.length > 0 ? of([finished]) : listed);
      libraryStore.refreshDocuments();
      TestBed.tick();
      expect(libraryStore.canDelete(documentId)).toBe(true);

      // Held by nothing but the pending read of the stored document.
      service.startDocument$(documentId, host).subscribe();
      expect(libraryStore.canDelete(documentId)).toBe(false);

      listed.next([finished]);
      TestBed.tick();
      expect(libraryStore.canDelete(documentId)).toBe(true);
    });

    it('keeps the result when a cancel arrives while the terminal writes are in flight', () => {
      const { service, documentId, updateCapture, cancelCapture, deleteCapture } =
        documentIn('its terminal writes are in flight');
      expect(deleteCapture).toHaveBeenCalledTimes(1);
      const writesBefore = updateCapture.mock.calls.length;

      service.cancel(documentId);
      TestBed.tick();

      expect(cancelCapture).not.toHaveBeenCalled();
      expect(updateCapture).toHaveBeenCalledTimes(writesBefore);
      expect(service.isDocumentClaimed(documentId)).toBe(true);
    });
  });


  describe('a claimed document', () => {
    it('is claimed from the subscription to an entry on, not by calling it, and free again when the request is declined', () => {
      const listed = new Subject<readonly DesktopLibrarySummary[]>();
      const list = vi.fn((): Observable<readonly DesktopLibrarySummary[]> => of([summary]));
      const store = initializeCapture(libraryStub({ list }), runtimeStub());
      list.mockImplementation(() => listed);
      const readsBefore = list.mock.calls.length;
      expect(store.service.isDocumentClaimed(summary.documentId)).toBe(false);

      // The entries are cold: calling one claims, reads and writes nothing.
      const request$ = store.service.startDocument$(summary.documentId, store.host);
      expect(store.service.isDocumentClaimed(summary.documentId)).toBe(false);
      expect(list).toHaveBeenCalledTimes(readsBefore);

      request$.subscribe();
      expect(store.service.isDocumentClaimed(summary.documentId)).toBe(true);
      expect(list).toHaveBeenCalledTimes(readsBefore + 1);

      listed.next([{ ...summary, status: 'completed' }]);
      expect(store.service.isDocumentClaimed(summary.documentId)).toBe(false);
    });

    it('is free again when the read of its stored state fails', () => {
      const list = vi.fn((): Observable<readonly DesktopLibrarySummary[]> => of([summary]));
      const store = initializeCapture(libraryStub({ list }), runtimeStub());
      list.mockImplementation(() => throwError(() => 'Capture library index cannot be read.'));
      const failed = vi.fn();

      store.service.reattach$({ ...summary, status: 'processing', captureId: 'capture-1' }, store.host)
        .subscribe({ error: failed });

      expect(failed).toHaveBeenCalledExactlyOnceWith('Capture library index cannot be read.');
      expect(store.service.isDocumentClaimed(summary.documentId)).toBe(false);
    });

    it('ignores a cancel when nothing is claimed', () => {
      const cancelCapture = vi.fn(() => of(cancelledOperation));
      const cancelUpload = vi.fn(() => of(undefined));
      const updateCapture = vi.fn(() => of(summary));
      const store = initializeCapture(
        libraryStub({ updateCapture }),
        runtimeStub({ cancelCapture, cancelUpload }),
      );

      store.service.cancel(summary.documentId);
      TestBed.tick();

      expect(cancelCapture).not.toHaveBeenCalled();
      expect(cancelUpload).not.toHaveBeenCalled();
      expect(updateCapture).not.toHaveBeenCalled();
    });

    it.each([
      ['the start of a waiting document', 'startDocument$', { ...summary }, ['canceled']],
      ['the retry of a failed document', 'retry$', { ...summary, status: 'failed' }, ['canceled']],
      ['the restart of a document whose capture was lost', 'restartLost$', {
        ...summary, status: 'recovery_required', captureId: 'capture-lost', recoveryCode: 'capture_recovery_required',
      }, ['queued', 'canceled']],
    ] satisfies [string, 'startDocument$' | 'retry$' | 'restartLost$', DesktopLibrarySummary, string[]][])(
      'lets a cancel win while %s is being decided',
      (_decision, entry, storedDocument, writtenStatuses) => {
        const listed = new Subject<readonly DesktopLibrarySummary[]>();
        const list = vi.fn((): Observable<readonly DesktopLibrarySummary[]> => of([storedDocument]));
        const updateCapture = vi.fn((update: Record<string, unknown>) =>
          of(applyDurableCaptureUpdate(storedDocument, update)));
        const createCapture = vi.fn(() => of(completedOperation));
        const getCapture = vi.fn(() => of(runningOperation));
        const store = initializeCapture(
          libraryStub({ list, updateCapture }),
          runtimeStub({ createCapture, getCapture }),
        );
        list.mockImplementation(() => listed);

        store.service[entry](summary.documentId, store.host).subscribe();
        store.service.cancel(summary.documentId);
        // The read was sent before the cancel.
        listed.next([storedDocument]);
        listed.complete();
        TestBed.tick();

        expect(createCapture).not.toHaveBeenCalled();
        expect(getCapture).not.toHaveBeenCalled();
        const updates = captureUpdates(updateCapture);
        expect(updates.map((update) => update['status'])).toEqual(writtenStatuses);
        expect(updates[updates.length - 1]).toEqual({
          documentId: summary.documentId, status: 'canceled', stage: 'cancelled', clearCaptureId: true,
        });
        expect(store.service.isDocumentClaimed(summary.documentId)).toBe(false);
      },
    );

    it('cancels through the runtime a capture whose recovery was being decided', () => {
      const running = { ...summary, status: 'processing', captureId: 'capture-1' } satisfies DesktopLibrarySummary;
      const listed = new Subject<readonly DesktopLibrarySummary[]>();
      const list = vi.fn((): Observable<readonly DesktopLibrarySummary[]> => of([running]));
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of(applyDurableCaptureUpdate(running, update)));
      const createCapture = vi.fn(() => of(completedOperation));
      const getCapture = vi.fn(() => of(runningOperation));
      const cancelCapture = vi.fn(() => of(cancelledOperation));
      const store = initializeCapture(
        libraryStub({ list, updateCapture }),
        runtimeStub({ createCapture, getCapture, cancelCapture }),
      );
      list.mockImplementation(() => listed);

      store.service.reattach$(running, store.host).subscribe();
      store.service.cancel(summary.documentId);
      listed.next([running]);
      listed.complete();
      TestBed.tick();

      expect(createCapture).not.toHaveBeenCalled();
      expect(cancelCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
      const updates = captureUpdates(updateCapture);
      expect(updates[updates.length - 1]).toEqual(
        expect.objectContaining({ status: 'canceled', clearCaptureId: true }),
      );
    });

  });

  describe('restart', () => {
    const restartOf = (storedDocuments: DesktopLibrarySummary[]) => {
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of(applyDurableCaptureUpdate(storedDocuments[0] ?? summary, update)));
      const created = new Subject<CaptureOperation>();
      const createCapture = vi.fn(() => created);
      const getCapture = vi.fn(() => of(runningOperation));
      const deleteCapture = vi.fn(() => of(undefined));
      const store = initializeCapture(
        libraryStub({ list: vi.fn(() => of(storedDocuments)), updateCapture }),
        runtimeStub({ createCapture, getCapture, deleteCapture }),
      );
      const refreshDocuments = vi.spyOn(store.host, 'refreshDocuments');
      store.service.restartLost$(summary.documentId, store.host).subscribe();
      TestBed.tick();
      return { updateCapture, createCapture, getCapture, deleteCapture, refreshDocuments, created };
    };

    it.each([
      ['was interrupted without a capture', { ...summary, status: 'processing' }],
      ['lost its capture', {
        ...summary, status: 'recovery_required', captureId: 'capture-lost', recoveryCode: 'capture_recovery_required',
      }],
    ] satisfies [string, DesktopLibrarySummary][])(
      'clears the link and starts again for a stored document that %s',
      (_state, storedDocument) => {
        const { updateCapture, createCapture, getCapture, created } = restartOf([storedDocument]);

        expect(captureUpdates(updateCapture)[0]).toEqual({
          documentId: summary.documentId, status: 'queued', stage: 'uploading', clearCaptureId: true,
        });
        expect(createCapture).toHaveBeenCalledTimes(1);
        expect(getCapture).not.toHaveBeenCalled();
        created.complete();
      },
    );

    it.each([
      ['holds its result', [{ ...summary, status: 'completed' }]],
      ['waits for its runtime cleanup', [{
        ...summary, status: 'recovery_required', stage: 'completed', captureId: 'capture-1',
        recoveryCode: 'runtime_cleanup_failed',
      }]],
      ['is linked to a capture that may still run', [{ ...summary, status: 'processing', captureId: 'capture-1' }]],
      ['waits in the queue', [{ ...summary }]],
      ['was deleted', []],
    ] satisfies [string, DesktopLibrarySummary[]][])(
      'leaves a stored document that %s as it is',
      (_state, storedDocuments) => {
        const { updateCapture, createCapture, getCapture, deleteCapture, refreshDocuments } =
          restartOf(storedDocuments);

        expect(updateCapture).not.toHaveBeenCalled();
        expect(createCapture).not.toHaveBeenCalled();
        expect(getCapture).not.toHaveBeenCalled();
        expect(deleteCapture).not.toHaveBeenCalled();
        expect(refreshDocuments).toHaveBeenCalled();
      },
    );
  });

  it('decides once per document while its stored state is being read', () => {
    const listed = new Subject<readonly DesktopLibrarySummary[]>();
    const list = vi.fn((): Observable<readonly DesktopLibrarySummary[]> => of([summary]));
    const created = new Subject<CaptureOperation>();
    const createCapture = vi.fn(() => created);
    const store = initializeCapture(libraryStub({ list }), runtimeStub({ createCapture }));
    list.mockImplementation(() => listed);
    const readsBefore = list.mock.calls.length;

    store.service.startDocument$(summary.documentId, store.host).subscribe();
    store.service.startDocument$(summary.documentId, store.host).subscribe();
    store.service.startDocument$(summary.documentId, store.host).subscribe();
    expect(list).toHaveBeenCalledTimes(readsBefore + 1);

    listed.next([summary]);
    expect(createCapture).toHaveBeenCalledTimes(1);
    expect(store.service.isDocumentClaimed(summary.documentId)).toBe(true);
    created.complete();
  });
});

function initializeCapture(
  library: ReturnType<typeof libraryStub>,
  client: ReturnType<typeof runtimeStub>,
) {
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: client },
    ],
  });
  const service = TestBed.inject(DesktopCaptureService);
  const documents = TestBed.runInInjectionContext(() =>
    rxResource<readonly DesktopLibrarySummary[], boolean>({
      defaultValue: [],
      params: () => true,
      stream: ({ abortSignal }) => library.list('', '', abortSignal),
    }),
  );
  const selectedId = signal<string | null>(null);
  const selected = TestBed.runInInjectionContext(() =>
    rxResource<DesktopLibraryDetail | null, string | undefined>({
      defaultValue: null,
      params: () => selectedId() ?? undefined,
      stream: ({ params, abortSignal }) => library.get(params, abortSignal),
    }),
  );
  const host: DesktopCaptureHost = {
    selectedId,
    requestedRequirements: signal<ReadonlySet<CaptureRequirementId>>(new Set()),
    requirements: () => [],
    documents: () => documents.value(),
    selected: () => selected.value(),
    refreshDocuments: () => documents.reload(),
    reloadDocumentState: (documentId) => {
      documents.reload();
      if (selectedId() === documentId) selected.reload();
    },
    setMessage: vi.fn(),
    identifySpeakers: () => false,
  };
  TestBed.tick();
  return { service, host };
}

function selection(fileName: string): DesktopSourceSelection {
  return { selectionToken: fileName.padEnd(32, '0'), fileName, byteLength: 16, mediaType: 'application/pdf' };
}

function libraryStub(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    // The library stores the document the tests capture, waiting.
    list: vi.fn((_search: string, _filter: string, _signal: AbortSignal) =>
      of<readonly DesktopLibrarySummary[]>([summary])),
    get: vi.fn((_documentId: string, _signal: AbortSignal) => of<DesktopLibraryDetail>(summary)),
    updateCapture: vi.fn(() => of(summary)),
  }, overrides);
}

function runtimeStub(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    ready: signal(true),
    started: signal(true),
    ocrCompute: signal<OcrComputePreflight | null>({
      apiVersion: '2.0',
      schemaVersion: '1',
      service: 'capture-runtime',
      runtimeVersion: RUNTIME_VERSION,
      contractSetVersion: '2',
      contractSetSha256: 'a'.repeat(64),
      workerSha256: 'f'.repeat(64),
      mode: 'gpu',
      adapterClass: 'dedicated',
      reasonCode: null,
      userNoticeRequired: false,
      noticeCode: null,
    }),
    pdfPageNumbers: signal<readonly number[] | undefined>(undefined),
    cancelUpload: vi.fn(() => of(undefined)),
    createCapture: vi.fn(() => of(completedOperation)),
    getCapture: vi.fn(() => of(completedOperation)),
    cancelCapture: vi.fn(() => of(cancelledOperation)),
    getRaw: vi.fn(() => of(raw)),
    getResult: vi.fn(() => of({ operation: completedOperation, raw, result })),
    getOcr: vi.fn((captureId: string) => of(ocrProjection(
      captureId,
      failedOcrCaptureIds.has(captureId) ? 'failed' : 'completed',
    ))),
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
  };
}

function operation(
  input: Pick<CaptureOperation, 'captureId' | 'status'> & Partial<CaptureOperation>,
): CaptureOperation {
  return {
    protocolVersion: '2',
    ingestionId: 'ingestion-1',
    kind: 'pdf',
    partialRevision: 0,
    lastEventSequence: 0,
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
    source: {
      sha256: 'a'.repeat(64),
      fileName: 'fixture.pdf',
      mediaType: 'application/pdf',
      bytes: 12,
    },
    ...input,
  };
}

function ocrProjection(
  captureId: string,
  status: 'completed' | 'failed',
): CaptureOcrProjection {
  const provenance = {
    status: 'resolved' as const,
    engine: 'text-recognition' as const,
    model: 'ppocrv6-traditional-multilingual',
    modelDigest: `sha256:${'d'.repeat(64)}`,
    device: 'RTX4060',
    profileId: 'profile-1',
    profileSpecSha256: 'e'.repeat(64),
  };
  const page = status === 'completed'
    ? {
      page: 1,
      status: 'recognized' as const,
      raster: { width: 1200, height: 800, scale: 1, coordinateSystem: 'pixel' as const },
      text: 'OCR text',
      boxes: [{
        polygon: [
          { x: 100, y: 120 },
          { x: 220, y: 120 },
          { x: 220, y: 160 },
          { x: 100, y: 160 },
        ],
        text: 'OCR text',
        confidence: 0.875,
      }],
      confidence: 0.875,
      provenance,
    }
    : {
      page: 1,
      status: 'failed' as const,
      raster: { width: 1200, height: 800, scale: 1, coordinateSystem: 'pixel' as const },
      provenance,
      failure: { code: 'ocr_worker_failed', message: 'worker failed' },
    };
  return {
    apiVersion: '2.0',
    schemaVersion: '3',
    captureId,
    status,
    source: {
      sha256: 'a'.repeat(64),
      fileName: 'fixture.pdf',
      mediaType: 'application/pdf',
      bytes: 12,
    },
    pages: [page],
    processedPageCount: 1,
    runtimeVersion: RUNTIME_VERSION,
    contractSetSha256: 'a'.repeat(64),
    provenance,
    ...(status === 'failed'
      ? { failure: { code: 'ocr_worker_failed', message: 'worker failed' } }
      : {}),
    createdAt: '2026-07-20T00:00:00Z',
  };
}

async function settleCaptureLifecycle(): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 25));
  await Promise.resolve();
}
