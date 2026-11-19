import { TestBed } from '@angular/core/testing';
import type {
  CaptureClient,
  CaptureTaskView,
} from '../contracts';
import { defaultIfEmpty, firstValueFrom, of, Subject, throwError } from 'rxjs';
import type { CaptureReconciliationContext } from './internal-contracts';
import { CaptureWorkbenchStoreHelpers } from './capture-workbench-store-helpers';
import { CaptureReconciliationService } from './capture-reconciliation.service';
import {
  RAW,
  fakeClient,
  streamingEvent,
  streamingOperation,
  streamingResult,
} from '../testing/capture-test-support';

describe('CaptureReconciliationService', () => {
  let service: CaptureReconciliationService;
  let task: CaptureTaskView;
  let context: CaptureReconciliationContext;
  let currentTask: CaptureTaskView;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [CaptureReconciliationService, CaptureWorkbenchStoreHelpers],
    }).compileComponents();
    service = TestBed.inject(CaptureReconciliationService);
    task = {
      id: 'task-1',
      fileName: 'scan.pdf',
      sourceKind: 'pdf',
      status: 'reconciliation_required',
      stage: 'structuring',
      progress: 80,
      captureId: 'capture-1',
      raw: RAW,
      error: {
        code: 'host_reconciliation_unavailable',
        message: 'Unknown terminal state.',
        stage: 'structuring',
        retryable: true,
      },
    };
    currentTask = task;
  });

  function configure(client: CaptureClient): {
    readonly requireReconciliation: ReturnType<typeof vi.fn>;
    readonly emitCompleted: ReturnType<typeof vi.fn>;
    readonly emitCanceled: ReturnType<typeof vi.fn>;
  } {
    const requireReconciliation = vi.fn();
    const emitCompleted = vi.fn();
    const emitCanceled = vi.fn();
    context = {
      client: () => client,
      getTask: () => currentTask,
      updateTask: (_taskId, patch) => {
        currentTask = { ...currentTask, ...patch };
        return currentTask;
      },
      requireReconciliation: (taskId, error, raw) => {
        requireReconciliation(taskId, error, raw);
        currentTask = { ...currentTask, status: 'reconciliation_required', error, raw };
      },
      failTask: (taskId, fileName, error, raw, stage) => {
        currentTask = {
          ...currentTask,
          status: 'failed',
          fileName,
          error,
          raw,
          ...(stage ? { stage } : {}),
        };
      },
      emitCompleted,
      emitCanceled,
    };
    service.configure(context);
    return { requireReconciliation, emitCompleted, emitCanceled };
  }

  it('reconciles a v2 terminal snapshot to a completed task', async () => {
    const client = fakeClient({
      getCapture: vi.fn(() => of(streamingOperation('completed'))),
      getResult: vi.fn(() => of(streamingResult())),
    });
    const { emitCompleted } = configure(client);

    await firstValueFrom(
      service.reconcile('task-1').pipe(defaultIfEmpty(undefined)),
    );

    expect(currentTask.status).toBe('completed');
    expect(currentTask.result).toBe(streamingResult().result);
    expect(client.getResult).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(emitCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', document: streamingResult().result }),
    );
  });

  it('waits on v2 SSE and resumes from the snapshot event sequence', async () => {
    const events = new Subject<ReturnType<typeof streamingEvent>>();
    const getCapture = vi
      .fn<NonNullable<CaptureClient['getCapture']>>()
      .mockReturnValueOnce(of(streamingOperation('extracting', 0.3)))
      .mockReturnValueOnce(of(streamingOperation('completed')));
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(() =>
      events.asObservable(),
    );
    const client = fakeClient({ getCapture, captureEvents });
    configure(client);

    const settled = firstValueFrom(service.reconcile('task-1'));
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());
    events.next(streamingEvent('checkpoint', 'extracting'));
    expect(currentTask.progress).toBe(80);
    events.next(streamingEvent('completed', 'completed'));
    await settled;

    expect(captureEvents).toHaveBeenCalledWith(
      'capture-1',
      expect.objectContaining({
        lastEventId: 1,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(currentTask.progress).toBe(100);
    expect(currentTask.status).toBe('completed');
  });

  it('reloads the snapshot and reconnects SSE after resync_required', async () => {
    const firstEvents = new Subject<ReturnType<typeof streamingEvent>>();
    const secondEvents = new Subject<ReturnType<typeof streamingEvent>>();
    let streamIndex = 0;
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(() =>
      (streamIndex++ === 0 ? firstEvents : secondEvents).asObservable(),
    );
    const resyncedOperation = {
      ...streamingOperation('extracting', 0.4),
      lastEventSequence: 7,
    };
    const getCapture = vi
      .fn<NonNullable<CaptureClient['getCapture']>>()
      .mockReturnValueOnce(of(streamingOperation('extracting', 0.2)))
      .mockReturnValueOnce(of(resyncedOperation))
      .mockReturnValueOnce(of(streamingOperation('completed')));
    const client = fakeClient({ captureEvents, getCapture });
    configure(client);

    const settled = firstValueFrom(service.reconcile('task-1'));
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());

    firstEvents.next(streamingEvent('resync_required', 'resync'));
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledTimes(2));

    expect(client.getCapture).toHaveBeenCalledTimes(2);
    expect(client.getPartial).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(captureEvents).toHaveBeenNthCalledWith(
      2,
      'capture-1',
      expect.objectContaining({ lastEventId: 7 }),
    );

    secondEvents.next(streamingEvent('completed', 'completed'));
    await settled;

    expect(client.getCapture).toHaveBeenCalledTimes(3);
    expect(currentTask.status).toBe('completed');
  });

  it('confirms a lost v2 commit response through the v2 snapshot', async () => {
    const client = fakeClient({
      commitStructure: vi.fn(() =>
        throwError(() => new Error('response lost')),
      ),
      getCapture: vi.fn(() => of(streamingOperation('completed'))),
    });
    configure(client);

    const operation = await firstValueFrom(
      service.commitHostResultAndReconcile(
        client,
        'capture-1',
        { ...streamingResult().result },
        new AbortController().signal,
      ),
    );

    expect(operation.status).toBe('completed');
    expect(client.commitStructure).toHaveBeenCalledOnce();
    expect(client.getCapture).toHaveBeenCalledOnce();
  });

  it('cancels a reconciliation-required v2 capture and emits cancellation after confirmation', async () => {
    const client = fakeClient({
      cancelCapture: vi.fn(() => of(streamingOperation('cancelled'))),
    });
    const { emitCanceled } = configure(client);

    await firstValueFrom(service.cancel('task-1'));

    expect(currentTask.status).toBe('canceled');
    expect(emitCanceled).toHaveBeenCalledWith(currentTask);
    expect(client.cancelCapture).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
  });

  it('reconciles a lost v2 failure report to the runtime failed state', async () => {
    const failed = {
      ...streamingOperation('failed'),
      error: {
        code: 'host_provider_failed',
        message: 'Provider failed.',
        stage: 'structuring' as const,
      },
    };
    const reportStructuringFailure = vi.fn<
      NonNullable<CaptureClient['reportStructuringFailure']>
    >(() => throwError(() => new Error('response lost')));
    const getCapture = vi.fn<
      NonNullable<CaptureClient['getCapture']>
    >(() => of(failed));
    const client = fakeClient({
      reportStructuringFailure,
      getCapture,
    });
    configure(client);

    const operation = await firstValueFrom(
      service.reportHostFailureAndReconcile(
        client,
        'capture-1',
        'Provider failed.',
        new AbortController().signal,
      ),
    );

    expect(operation.status).toBe('failed');
    expect(getCapture).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(client.cancelCapture).not.toHaveBeenCalled();
  });

  it('retries an unresolved v2 commit with the same idempotency key', async () => {
    const commitStructure = vi
      .fn<NonNullable<CaptureClient['commitStructure']>>()
      .mockReturnValueOnce(of(streamingOperation('awaiting_structuring')))
      .mockReturnValueOnce(of(streamingOperation('completed')));
    const client = fakeClient({ commitStructure });
    configure(client);

    const operation = await firstValueFrom(
      service.commitHostResultAndReconcile(
        client,
        'capture-1',
        { ...streamingResult().result },
        new AbortController().signal,
      ),
    );

    expect(operation.status).toBe('completed');
    expect(commitStructure).toHaveBeenCalledTimes(2);
    expect(commitStructure.mock.calls[1]?.[1]).toBe(
      commitStructure.mock.calls[0]?.[1],
    );
  });

  it('cancels and confirms a nonterminal v2 failure-report outcome', async () => {
    const reportStructuringFailure = vi.fn<
      NonNullable<CaptureClient['reportStructuringFailure']>
    >(() => of(streamingOperation('awaiting_structuring')));
    const cancelCapture = vi.fn<
      NonNullable<CaptureClient['cancelCapture']>
    >(() => of(streamingOperation('cancelled')));
    const client = fakeClient({
      reportStructuringFailure,
      cancelCapture,
    });
    configure(client);

    const operation = await firstValueFrom(
      service.reportHostFailureAndReconcile(
        client,
        'capture-1',
        'Provider failed.',
        new AbortController().signal,
      ),
    );

    expect(operation.status).toBe('cancelled');
    expect(cancelCapture).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
  });

  it('keeps reconciliation required when the v2 operation is still nonterminal', async () => {
    const client = fakeClient({
      getCapture: vi.fn(() => of(streamingOperation('extracting'))),
    });
    const { requireReconciliation } = configure(client);

    await firstValueFrom(
      service.reconcile('task-1').pipe(defaultIfEmpty(undefined)),
    );

    expect(requireReconciliation).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        code: 'host_reconciliation_unavailable',
        stage: 'runtime',
        retryable: true,
      }),
      RAW,
    );
    expect(currentTask.status).toBe('reconciliation_required');
    expect(client.captureEvents).toHaveBeenCalledWith(
      'capture-1',
      expect.objectContaining({ lastEventId: 1 }),
    );
  });
});
