import { DestroyRef, Injectable, inject } from '@angular/core';
import {
  EMPTY,
  Observable,
  catchError,
  concatMap,
  defer,
  endWith,
  finalize,
  fromEvent,
  ignoreElements,
  map,
  of,
  switchMap,
  takeUntil,
  takeWhile,
  tap,
  throwError,
  type OperatorFunction,
} from 'rxjs';
import {
  type CaptureClient,
  type CaptureCompletedEvent,
  type CaptureFailureV1,
  type CaptureOperationV2,
  type CaptureEventV2,
  type CaptureStructuringCandidateV1,
  type CaptureTaskView,
  type PartialCaptureV2,
  type RawCaptureV1,
} from '../../../contracts';
import type { CaptureReconciliationContext } from '../capture-workbench-store/internal-contracts';
import {
  HOST_PROVIDER_FAILURE_CODE,
  HOST_RECONCILIATION_FAILURE_CODE,
} from '../../../constants';
import {
  HostReconciliationUnavailableError,
  CaptureWorkbenchStoreHelpers,
} from '../capture-workbench-store/capture-workbench-store-helpers';

const MAX_STREAMING_RESYNC_RECONNECTS = 3;

@Injectable()
export class CaptureReconciliationService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly lifecycleController = new AbortController();
  private readonly reconciliationTasks = new Set<string>();
  private readonly helpers = inject(CaptureWorkbenchStoreHelpers);
  private context?: CaptureReconciliationContext;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.lifecycleController.abort();
      this.reconciliationTasks.clear();
    });
  }

  configure(context: CaptureReconciliationContext): void {
    this.context = context;
  }

  private getTask(taskId: string): CaptureTaskView | undefined {
    return this.context?.getTask(taskId);
  }

  private activeStreamingClient(): StreamingClient | null {
    const client = this.context?.client() ?? null;
    return client ? asStreamingClient(client) ?? null : null;
  }

  private updateTask(
    taskId: string,
    patch: Partial<CaptureTaskView>,
  ): CaptureTaskView | undefined {
    return this.context?.updateTask(taskId, patch);
  }

  private requireReconciliation(
    taskId: string,
    error: CaptureFailureV1,
    raw?: RawCaptureV1,
  ): void {
    this.context?.requireReconciliation(taskId, error, raw);
  }

  private failTask(
    taskId: string,
    fileName: string,
    error: CaptureFailureV1,
    raw?: RawCaptureV1,
    stage?: CaptureTaskView['stage'],
  ): void {
    this.context?.failTask(taskId, fileName, error, raw, stage);
  }

  private emitCompleted(event: CaptureCompletedEvent): void {
    this.context?.emitCompleted(event);
  }

  private emitCanceled(task: CaptureTaskView): void {
    this.context?.emitCanceled(task);
  }

  private tryGetRaw(
    client: StreamingClient,
    captureId: string,
    signal?: AbortSignal,
  ): Observable<RawCaptureV1 | undefined> {
    return defer(() => client.getStreamingPartial(captureId, signal)).pipe(
      map((partial) => this.helpers.partialCaptureToRaw(partial)),
      catchError(() => of(undefined)),
    );
  }

  cancel(taskId: string): Observable<void> {
    return defer((): Observable<void> => {
      const task = this.getTask(taskId);
      return task ? this.cancelReconciliationRequiredTask(task) : EMPTY;
    });
  }

  reconcile(taskId: string): Observable<void> {
    return defer(() => {
      const task = this.getTask(taskId);
      const client = this.activeStreamingClient();
      if (
        !task ||
        task.status !== 'reconciliation_required' ||
        !task.captureId ||
        !client ||
        this.reconciliationTasks.has(taskId)
      ) {
        return EMPTY;
      }

      this.reconciliationTasks.add(taskId);
      return this.confirmOperation(client, task.captureId, taskId).pipe(
        switchMap((operation) => {
          if (this.helpers.isTerminalStreamingOperation(operation)) {
            return this.settleConfirmedOperation(task, client, operation);
          }
          this.requireReconciliation(
            taskId,
            this.unknownTerminalState(operation),
            task.raw,
          );
          return EMPTY;
        }),
        catchError((error: unknown) => {
          if (this.helpers.isAbortError(error)) return EMPTY;
          this.requireReconciliation(
            taskId,
            this.helpers.hostReconciliationFailure(error),
            task.raw,
          );
          return EMPTY;
        }),
        releaseReconciliationTask(this.reconciliationTasks, taskId),
      );
    });
  }

  commitHostResultAndReconcile(
    client: CaptureClient,
    captureId: string,
    candidate: CaptureStructuringCandidateV1,
    signal: AbortSignal,
  ): Observable<CaptureOperationV2> {
    const streamingClient = asStreamingClient(client);
    if (!streamingClient) {
      return throwError(() => new Error('Streaming capture client is unavailable.'));
    }
    const request = {
      clientRequestId: crypto.randomUUID(),
      candidate,
    } as const;

    return this.commitAttempt(streamingClient, captureId, request, signal).pipe(
      switchMap((first): Observable<CaptureOperationV2> =>
        this.helpers.isAwaitingHostStructuring(first)
          ? this.commitAttempt(streamingClient, captureId, request, signal)
          : of(first),
      ),
      switchMap((second) =>
        this.helpers.isAwaitingHostStructuring(second)
          ? this.reportHostFailureAndReconcile(
              streamingClient,
              captureId,
              'Host structured result could not be committed.',
              signal,
            )
          : of(second),
      ),
    );
  }

  reportHostFailureAndReconcile(
    client: CaptureClient,
    captureId: string,
    message: string,
    signal: AbortSignal,
  ): Observable<CaptureOperationV2> {
    const streamingClient = asStreamingClient(client);
    if (!streamingClient) {
      return throwError(() => new Error('Streaming capture client is unavailable.'));
    }
    return this.reportAttempt(
      streamingClient,
      captureId,
      message,
      signal,
    ).pipe(
      switchMap((reported) =>
        this.helpers.isTerminalStreamingOperation(reported)
          ? of(reported)
          : this.cancelAndConfirm(streamingClient, captureId, signal),
      ),
    );
  }

  private commitAttempt(
    client: StreamingClient,
    captureId: string,
    request: {
      readonly clientRequestId: string;
      readonly candidate: CaptureStructuringCandidateV1;
    },
    signal: AbortSignal,
  ): Observable<CaptureOperationV2> {
    return defer(() =>
      client.commitStreamingStructuredResult(captureId, request, signal),
    ).pipe(
      catchError((error: unknown) => {
        if (this.helpers.isAbortError(error)) return throwError(() => error);
        return client.getStreamingCapture(captureId, signal);
      }),
    );
  }

  private reportAttempt(
    client: StreamingClient,
    captureId: string,
    message: string,
    signal: AbortSignal,
  ): Observable<CaptureOperationV2> {
    return defer(() =>
      client.reportStreamingStructuringFailure(
        captureId,
        { code: HOST_PROVIDER_FAILURE_CODE, message },
        signal,
      ),
    ).pipe(
      catchError((error: unknown) => {
        if (this.helpers.isAbortError(error)) return throwError(() => error);
        return client.getStreamingCapture(captureId, signal);
      }),
    );
  }

  private confirmOperation(
    client: StreamingClient,
    captureId: string,
    taskId?: string,
  ): Observable<CaptureOperationV2> {
    const signal = this.lifecycleController.signal;
    return client.getStreamingCapture(captureId, signal).pipe(
      switchMap((initial) =>
        this.waitForTerminal(client, initial, signal, taskId, true),
      ),
    );
  }

  private waitForTerminal(
    client: StreamingClient,
    initial: CaptureOperationV2,
    signal: AbortSignal,
    taskId?: string,
    stopForHost = false,
    reconnectAttempt = 0,
  ): Observable<CaptureOperationV2> {
    if (this.helpers.isTerminalStreamingOperation(initial)) return of(initial);
    let resyncRequired = false;
    return client
      .captureEvents(initial.captureId, {
        signal,
        lastEventId: initial.lastEventSequence,
      })
      .pipe(
        tap((event) => {
          resyncRequired = isResyncRequiredEvent(event);
          if (taskId && !resyncRequired) this.applyStreamingEvent(taskId, event);
        }),
        takeWhile(
          (event) => !isResyncRequiredEvent(event)
            && !this.helpers.isTerminalStreamingEvent(event)
            && !(stopForHost && event.stage === 'awaiting_structuring'),
          true,
        ),
        ignoreElements(),
        endWith(undefined),
        concatMap(() => this.reloadStreamingSnapshot$(
          client,
          initial.captureId,
          signal,
          taskId,
          resyncRequired,
        )),
        concatMap((snapshot) => {
          if (
            this.helpers.isTerminalStreamingOperation(snapshot) ||
            (stopForHost && snapshot.status === 'awaiting_structuring')
          ) {
            return of(snapshot);
          }
          if (!resyncRequired) return of(snapshot);
          if (reconnectAttempt >= MAX_STREAMING_RESYNC_RECONNECTS) {
            return throwError(
              () => new Error('Capture event stream exceeded the resync recovery limit.'),
            );
          }
          return this.waitForTerminal(
            client,
            snapshot,
            signal,
            taskId,
            stopForHost,
            reconnectAttempt + 1,
          );
        }),
        takeUntil(fromEvent(signal, 'abort')),
      );
  }

  private reloadStreamingSnapshot$(
    client: StreamingClient,
    captureId: string,
    signal: AbortSignal,
    taskId: string | undefined,
    includePartial: boolean,
  ): Observable<CaptureOperationV2> {
    return client.getStreamingCapture(captureId, signal).pipe(
      tap((operation) => {
        if (taskId) this.applyStreamingOperation(taskId, operation);
      }),
      concatMap((operation) => {
        if (!includePartial || !taskId) return of(operation);
        return client.getStreamingPartial(captureId, signal).pipe(
          tap((partial) => this.applyStreamingPartial(taskId, partial)),
          map(() => operation),
          catchError(() => of(operation)),
        );
      }),
    );
  }

  private cancelAndConfirm(
    client: StreamingClient,
    captureId: string,
    signal: AbortSignal,
  ): Observable<CaptureOperationV2> {
    return defer(() => client.cancelStreamingCapture(captureId, signal)).pipe(
      catchError((error: unknown) => {
        if (this.helpers.isAbortError(error)) return throwError(() => error);
        return client.getStreamingCapture(captureId, signal);
      }),
      switchMap((operation) =>
        this.waitForTerminal(client, operation, signal),
      ),
      switchMap((operation) =>
        this.helpers.isTerminalStreamingOperation(operation)
          ? of(operation)
          : throwError(() => new HostReconciliationUnavailableError()),
      ),
    );
  }

  private cancelReconciliationRequiredTask(
    task: CaptureTaskView,
  ): Observable<void> {
    const client = this.activeStreamingClient();
    if (!client || !task.captureId || this.reconciliationTasks.has(task.id))
      return EMPTY;

    this.reconciliationTasks.add(task.id);
    const signal = this.lifecycleController.signal;
    return this.cancelAndConfirm(client, task.captureId, signal).pipe(
      switchMap((terminal) => this.settleOrRequire(task, client, terminal)),
      catchError((error: unknown) => {
        if (this.helpers.isAbortError(error)) return EMPTY;
        this.requireReconciliation(
          task.id,
          this.helpers.hostReconciliationFailure(error),
          task.raw,
        );
        return EMPTY;
      }),
      releaseReconciliationTask(this.reconciliationTasks, task.id),
      map(() => undefined),
    );
  }

  private settleOrRequire(
    task: CaptureTaskView,
    client: StreamingClient,
    operation: CaptureOperationV2,
  ): Observable<void> {
    if (!this.helpers.isTerminalStreamingOperation(operation)) {
      this.requireReconciliation(
        task.id,
        this.unknownTerminalState(operation),
        task.raw,
      );
      return EMPTY;
    }
    return this.settleConfirmedOperation(task, client, operation);
  }

  private unknownTerminalState(operation: CaptureOperationV2): CaptureFailureV1 {
    return {
      code: HOST_RECONCILIATION_FAILURE_CODE,
      message: `Capture runtime is still ${operation.status}; check again or cancel it.`,
      stage: operation.status === 'awaiting_structuring' ? 'structuring' : 'runtime',
      retryable: true,
    };
  }

  private applyStreamingEvent(taskId: string, event: CaptureEventV2): void {
    this.updateTask(taskId, {
      stage: this.helpers.streamingStage(event.stage),
    });
  }

  private applyStreamingOperation(taskId: string, operation: CaptureOperationV2): void {
    this.updateTask(taskId, {
      stage: this.helpers.streamingStage(operation.status),
      ...(operation.progress === undefined || operation.progress === null
        ? {}
        : { progress: this.helpers.runtimeProgressPercent(operation.progress) }),
    });
  }

  private applyStreamingPartial(taskId: string, partial: PartialCaptureV2): void {
    try {
      this.updateTask(taskId, {
        raw: this.helpers.partialCaptureToRaw(partial),
      });
    } catch {
      // A resync snapshot may arrive before the partial has all extraction fields.
    }
  }

  private settleConfirmedOperation(
    task: CaptureTaskView,
    client: StreamingClient,
    operation: CaptureOperationV2,
  ): Observable<void> {
    if (operation.status === 'cancelled') {
      const canceledTask = this.updateTask(task.id, {
        status: 'canceled',
        stage: 'cancelled',
        error: undefined,
      });
      if (canceledTask) this.emitCanceled(canceledTask);
      return of(undefined);
    }
    if (operation.status === 'failed') {
      return (task.raw
        ? of(task.raw)
        : this.tryGetRaw(client, operation.captureId)
      ).pipe(
        map((raw) => {
          this.failTask(
            task.id,
            task.fileName,
            operation.error
              ? {
                  code: operation.error.code,
                  message: operation.error.message,
                  stage: operation.error.stage ?? undefined,
                  retryable: operation.error.retryable ?? undefined,
                }
              : {
                  code: 'capture_failed',
                  message: 'Capture failed.',
                  stage: 'runtime',
                },
            raw,
            operation.error?.stage === 'structuring' ? 'structuring' : 'failed',
          );
        }),
      );
    }
    if (operation.status !== 'completed') return EMPTY;

    return client
      .getStreamingResult(operation.captureId, this.lifecycleController.signal)
      .pipe(
        map((result) => {
          const completedTask = this.updateTask(task.id, {
            status: 'completed',
            stage: 'completed',
            progress: 100,
            error: undefined,
            raw: result.raw,
            result: result.result,
          });
          if (completedTask) {
            this.emitCompleted({
              taskId: task.id,
              document: result.result,
              review: completedTask.review,
            });
          }
        }),
        catchError((error: unknown) => {
          if (this.helpers.isAbortError(error)) return EMPTY;
          this.requireReconciliation(
            task.id,
            this.helpers.hostReconciliationFailure(error),
            task.raw,
          );
          return EMPTY;
        }),
      );
  }
}

function isResyncRequiredEvent(event: CaptureEventV2): boolean {
  return event.eventType === 'resync_required';
}

function releaseReconciliationTask<T>(
  tasks: Set<string>,
  taskId: string,
): OperatorFunction<T, T> {
  return finalize(() => tasks.delete(taskId));
}

type StreamingClient = CaptureClient &
  Required<
    Pick<
      CaptureClient,
      | 'captureEvents'
      | 'getStreamingCapture'
      | 'cancelStreamingCapture'
      | 'getStreamingPartial'
      | 'getStreamingResult'
      | 'commitStreamingStructuredResult'
      | 'reportStreamingStructuringFailure'
    >
  >;

function asStreamingClient(client: CaptureClient): StreamingClient | undefined {
  return typeof client.captureEvents === 'function' &&
    typeof client.getStreamingCapture === 'function' &&
    typeof client.cancelStreamingCapture === 'function' &&
    typeof client.getStreamingPartial === 'function' &&
    typeof client.getStreamingResult === 'function' &&
    typeof client.commitStreamingStructuredResult === 'function' &&
    typeof client.reportStreamingStructuringFailure === 'function'
    ? (client as StreamingClient)
    : undefined;
}
