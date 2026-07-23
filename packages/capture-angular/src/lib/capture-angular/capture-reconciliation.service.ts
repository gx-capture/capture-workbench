import { DestroyRef, Injectable, inject } from '@angular/core';
import {
  EMPTY,
  Observable,
  catchError,
  defer,
  finalize,
  map,
  mergeMap,
  of,
  switchMap,
  throwError,
  type OperatorFunction,
} from 'rxjs';
import {
  type CaptureClient,
  type CaptureCompletedEvent,
  type CaptureFailureV1,
  type CaptureJobV1,
  type CaptureStructuringCandidateV1,
  type CaptureTaskView,
  type RawCaptureV1,
} from '../contracts';
import type { CaptureReconciliationContext } from './internal-contracts';
import {
  HOST_PROVIDER_FAILURE_CODE,
  HOST_RECONCILIATION_FAILURE_CODE,
} from '../constants';
import {
  HostReconciliationUnavailableError,
  CaptureWorkbenchStoreHelpers,
} from './capture-workbench-store-helpers';

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

  private activeClient(): CaptureClient | null {
    return this.context?.client() ?? null;
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
    client: CaptureClient,
    captureId: string,
    signal?: AbortSignal,
  ): Observable<RawCaptureV1 | undefined> {
    return this.context?.tryGetRaw(client, captureId, signal) ?? of(undefined);
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
      const client = this.activeClient();
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
      return client
        .getCapture(task.captureId, this.lifecycleController.signal)
        .pipe(
          catchError((error: unknown) => {
            if (this.helpers.isAbortError(error)) return EMPTY;
            this.requireReconciliation(
              taskId,
              this.helpers.hostReconciliationFailure(error),
              task.raw,
            );
            return EMPTY;
          }),
          switchMap((job) => {
            if (this.helpers.isTerminalCaptureJob(job)) {
              return this.settleConfirmedJob(task, client, job);
            }
            this.requireReconciliation(
              taskId,
              {
                code: HOST_RECONCILIATION_FAILURE_CODE,
                message: `Capture runtime is still ${job.status}/${job.stage}; check again or cancel it.`,
                stage: job.stage,
                retryable: true,
              },
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
  ): Observable<CaptureJobV1> {
    const request = {
      clientRequestId: crypto.randomUUID(),
      candidate,
    } as const;

    return this.commitAttempt(client, captureId, request, signal).pipe(
      switchMap(
        (first): Observable<CommitOutcome> =>
          first.job && !this.helpers.isAwaitingHostStructuring(first.job)
            ? of(first)
            : this.commitAttempt(client, captureId, request, signal),
      ),
      switchMap((second) =>
        second.job && !this.helpers.isAwaitingHostStructuring(second.job)
          ? of(second.job)
          : this.reportHostFailureAndReconcile(
              client,
              captureId,
              'Host structured result could not be committed.',
              signal,
            ),
      ),
    );
  }

  reportHostFailureAndReconcile(
    client: CaptureClient,
    captureId: string,
    message: string,
    signal: AbortSignal,
  ): Observable<CaptureJobV1> {
    return client
      .reportStructuringFailure(
        captureId,
        { code: HOST_PROVIDER_FAILURE_CODE, message },
        signal,
      )
      .pipe(
        catchError((error: unknown) => {
          if (this.helpers.isAbortError(error)) return throwError(() => error);
          return this.tryGetCaptureForReconciliation(client, captureId, signal);
        }),
        switchMap((reported) => {
          if (reported && this.helpers.isTerminalCaptureJob(reported))
            return of(reported);
          return client.cancelCapture(captureId, signal).pipe(
            catchError((error: unknown) => {
              if (this.helpers.isAbortError(error))
                return throwError(() => error);
              return of(undefined);
            }),
            switchMap((cancelled) =>
              this.tryGetCaptureForReconciliation(
                client,
                captureId,
                signal,
              ).pipe(
                map((confirmed) =>
                  confirmed && this.helpers.isTerminalCaptureJob(confirmed)
                    ? confirmed
                    : cancelled && this.helpers.isTerminalCaptureJob(cancelled)
                      ? cancelled
                      : undefined,
                ),
                mergeMap((terminal) =>
                  terminal
                    ? of(terminal)
                    : throwError(
                        () => new HostReconciliationUnavailableError(),
                      ),
                ),
              ),
            ),
          );
        }),
      );
  }

  private commitAttempt(
    client: CaptureClient,
    captureId: string,
    request: {
      readonly clientRequestId: string;
      readonly candidate: CaptureStructuringCandidateV1;
    },
    signal: AbortSignal,
  ): Observable<{ readonly job?: CaptureJobV1 }> {
    return client.commitStructuredResult(captureId, request, signal).pipe(
      map((job) => ({ job })),
      catchError((error: unknown) => {
        if (this.helpers.isAbortError(error)) return throwError(() => error);
        return this.tryGetCaptureForReconciliation(
          client,
          captureId,
          signal,
        ).pipe(map((job) => ({ job })));
      }),
    );
  }

  private tryGetCaptureForReconciliation(
    client: CaptureClient,
    captureId: string,
    signal: AbortSignal,
  ): Observable<CaptureJobV1 | undefined> {
    return client.getCapture(captureId, signal).pipe(
      catchError((error: unknown) => {
        if (this.helpers.isAbortError(error)) return throwError(() => error);
        return of(undefined);
      }),
    );
  }

  private cancelReconciliationRequiredTask(
    task: CaptureTaskView,
  ): Observable<void> {
    const client = this.activeClient();
    if (!client || !task.captureId || this.reconciliationTasks.has(task.id))
      return EMPTY;

    this.reconciliationTasks.add(task.id);
    const signal = this.lifecycleController.signal;
    return client.cancelCapture(task.captureId, signal).pipe(
      catchError((error: unknown) => {
        if (this.helpers.isAbortError(error)) return EMPTY;
        return of(undefined);
      }),
      switchMap((cancelled) =>
        client.getCapture(task.captureId as string, signal).pipe(
          catchError((error: unknown) => {
            if (this.helpers.isAbortError(error)) return EMPTY;
            return of(undefined);
          }),
          map((confirmed) =>
            confirmed && this.helpers.isTerminalCaptureJob(confirmed)
              ? confirmed
              : cancelled && this.helpers.isTerminalCaptureJob(cancelled)
                ? cancelled
                : undefined,
          ),
        ),
      ),
      switchMap((terminal) => {
        if (terminal) return this.settleConfirmedJob(task, client, terminal);
        this.requireReconciliation(
          task.id,
          {
            code: HOST_RECONCILIATION_FAILURE_CODE,
            message:
              'Cancellation was requested, but the runtime terminal state is still unknown.',
            stage: task.stage ?? 'structuring',
            retryable: true,
          },
          task.raw,
        );
        return EMPTY;
      }),
      releaseReconciliationTask(this.reconciliationTasks, task.id),
      map(() => undefined),
    );
  }

  private settleConfirmedJob(
    task: CaptureTaskView,
    client: CaptureClient,
    job: CaptureJobV1,
  ): Observable<void> {
    if (job.status === 'cancelled') {
      const canceledTask = this.updateTask(task.id, {
        status: 'canceled',
        stage: 'cancelled',
        error: undefined,
      });
      if (canceledTask) this.emitCanceled(canceledTask);
      return of(undefined);
    }
    if (job.status === 'failed') {
      return (
        task.raw ? of(task.raw) : this.tryGetRaw(client, job.captureId)
      ).pipe(
        map((raw) => {
          this.failTask(
            task.id,
            task.fileName,
            job.error ?? {
              code: 'capture_failed',
              message: 'Capture failed.',
              stage: job.stage,
            },
            raw,
            job.stage,
          );
        }),
      );
    }
    if (job.status !== 'completed') return EMPTY;

    return client
      .getResult(job.captureId, this.lifecycleController.signal)
      .pipe(
        map((result) => {
          const completedTask = this.updateTask(task.id, {
            status: 'completed',
            stage: 'completed',
            progress: 100,
            error: undefined,
            result,
          });
          if (completedTask)
            this.emitCompleted({ taskId: task.id, document: result });
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

function releaseReconciliationTask<T>(
  tasks: Set<string>,
  taskId: string,
): OperatorFunction<T, T> {
  return finalize(() => tasks.delete(taskId));
}

interface CommitOutcome {
  readonly job?: CaptureJobV1;
}
