import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import {
  EMPTY,
  Observable,
  Subject,
  Subscription,
  catchError,
  concatMap,
  defer,
  endWith,
  finalize,
  ignoreElements,
  map,
  of,
  take,
  takeWhile,
  tap,
  throwError,
} from 'rxjs';
import {
  type CaptureClient,
  type CaptureCompletedEvent,
  type CaptureEventV2,
  type CaptureFailedEvent,
  type CaptureFailureV1,
  type CaptureJobV1,
  type CaptureOperationV2,
  type CommitStreamingStructuredResultRequest,
  type CapturePreprocessor,
  type PartialCaptureV2,
  type CaptureReviewV1,
  type ReportStreamingStructuringFailureRequest,
  type CaptureStructuringProvider,
  type CaptureTaskView,
  type RawCaptureV1,
  type StartStreamingCaptureRequest,
} from '../../../contracts';
import type { ResolvedCaptureWorkbenchConfig } from '../../../contracts/workbench';
import type {
  CaptureWorkflowContext,
  InternalCaptureTask,
} from '../capture-workbench-store/internal-contracts';
import { CaptureHelpersService } from '../../../capture-helpers';
import { CAPTURE_DOCUMENT_V1_CONTRACT } from '../../../capture-document-schema';
import { CaptureJobPollResourceService } from '../capture-job-poll-resource/capture-job-poll-resource';
import { CaptureWorkbenchStoreHelpers } from '../capture-workbench-store/capture-workbench-store-helpers';
import { CaptureReconciliationService } from '../capture-reconciliation/capture-reconciliation.service';

@Injectable()
export class CaptureWorkflowService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly lifecycleController = new AbortController();
  private readonly internalTasks = new Map<string, InternalCaptureTask>();
  private readonly captureIds = new Map<string, string>();
  private readonly taskSubscriptions = new Map<string, Subscription>();
  private readonly reviewSubjects = new Map<string, Subject<CaptureReviewV1>>();
  private runningTasks = 0;
  private context?: CaptureWorkflowContext;
  private readonly reconciliation = inject(CaptureReconciliationService);
  private readonly pollResourceService = inject(CaptureJobPollResourceService);
  private readonly captureHelpers = inject(CaptureHelpersService);
  private readonly helpers = inject(CaptureWorkbenchStoreHelpers);
  private readonly taskState = signal<readonly CaptureTaskView[]>([]);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.lifecycleController.abort();
      for (const task of this.internalTasks.values()) task.controller.abort();
      for (const subscription of this.taskSubscriptions.values())
        subscription.unsubscribe();
      for (const subject of this.reviewSubjects.values()) subject.complete();
      this.reviewSubjects.clear();
      this.taskSubscriptions.clear();
      this.events.complete();
    });
  }

  readonly tasks = this.taskState.asReadonly();
  readonly events = new Subject<
    | { readonly type: 'review-required'; readonly task: CaptureTaskView }
    | { readonly type: 'completed'; readonly event: CaptureCompletedEvent }
    | { readonly type: 'failed'; readonly event: CaptureFailedEvent }
    | { readonly type: 'canceled'; readonly task: CaptureTaskView }
    | { readonly type: 'task-changed'; readonly task: CaptureTaskView }
  >();

  configure(context: CaptureWorkflowContext): void {
    this.context = context;
    this.reconciliation.configure({
      client: () => this.activeClient(),
      getTask: (taskId) => this.taskState().find((task) => task.id === taskId),
      updateTask: (taskId, patch) => this.updateTask(taskId, patch),
      requireReconciliation: (taskId, error, raw) =>
        this.requireReconciliation(taskId, error, raw),
      failTask: (taskId, fileName, error, raw, stage) =>
        this.failTask(taskId, fileName, error, raw, stage),
      emitCompleted: (event) => this.emitCompleted(event),
      emitCanceled: (task) => this.emitCanceled(task),
      tryGetRaw: (client, captureId, signal) =>
        this.tryGetRaw(client, captureId, signal),
    });
  }

  private resolvedConfig(): ResolvedCaptureWorkbenchConfig {
    if (!this.context) throw new Error('Capture workflow is not configured.');
    return this.context.config();
  }

  private preprocessor(): CapturePreprocessor | null {
    return this.context?.preprocessor() ?? null;
  }

  enqueueFiles(files: readonly File[]): void {
    for (const file of this.resolvedConfig().multiple
      ? files
      : files.slice(0, 1)) {
      const sourceKind = this.captureHelpers.classifyCaptureFile(file);
      if (
        !sourceKind ||
        !this.resolvedConfig().enabledSources.includes(sourceKind)
      ) {
        this.addRejectedTask(file, sourceKind ?? 'pdf');
        continue;
      }
      const id = crypto.randomUUID();
      const controller = new AbortController();
      const task: CaptureTaskView = {
        id,
        fileName: file.name,
        sourceKind,
        status: 'queued',
        stage: 'queued',
        progress: 0,
      };
      this.internalTasks.set(id, {
        file,
        clientRequestId: crypto.randomUUID(),
        confirmRequestId: crypto.randomUUID(),
        controller,
      });
      this.taskState.update((tasks) => [...tasks, task]);
      this.emitTaskChanged(task);
    }
    this.drainQueue();
  }

  cancel(taskId: string): void {
    const current = this.taskState().find((task) => task.id === taskId);
    if (!current || this.helpers.isTerminalTask(current)) return;
    if (current.status === 'reconciliation_required') {
      this.reconciliation.cancel(taskId).subscribe({ error: () => undefined });
      return;
    }
    const internal = this.internalTasks.get(taskId);
    if (!internal) return;
    internal.controller.abort();
    this.reviewSubjects.get(taskId)?.complete();
    const captureId = this.captureIds.get(taskId);
    const client = this.activeClient();
    if (captureId && client) {
      const streamingClient = asStreamingClient(client);
      defer(() =>
        streamingClient
          ? streamingClient.cancelStreamingCapture(captureId)
          : client.cancelCapture(captureId),
      ).subscribe({ error: () => undefined });
    }
    const canceledTask = this.updateTask(taskId, {
      status: 'canceled',
      stage: 'cancelled',
    });
    if (canceledTask) this.emitCanceled(canceledTask);
    if (current.status === 'queued') {
      this.internalTasks.delete(taskId);
      this.drainQueue();
    }
  }

  updateReview(taskId: string, segmentId: string, reviewedText: string): void {
    const task = this.taskState().find((candidate) => candidate.id === taskId);
    if (task?.status !== 'awaiting_confirmation' || !task.raw) return;
    const original = task.raw.segments.find(
      (segment) => segment.segmentId === segmentId,
    );
    if (!original) return;
    const current = task.review ?? { reviewVersion: 1 as const, edits: [] };
    const edits = (current.edits ?? []).filter(
      (edit) => edit.segmentId !== segmentId,
    );
    if (reviewedText !== original.text) {
      edits.push({ segmentId, reviewedText });
    }
    this.updateTask(taskId, {
      review: { reviewVersion: 1, edits },
      error: undefined,
    });
  }

  confirm(taskId: string): void {
    const task = this.taskState().find((candidate) => candidate.id === taskId);
    if (task?.status !== 'awaiting_confirmation' || !task.raw) return;
    const review = task.review ?? { reviewVersion: 1 as const, edits: [] };
    const issues = this.helpers.validateCaptureReview(task.raw, review);
    if (issues.length > 0) {
      this.updateTask(taskId, {
        error: {
          code: 'invalid_review',
          message: issues.join('; '),
          stage: 'structuring',
        },
      });
      return;
    }
    const subject = this.reviewSubjects.get(taskId);
    if (!subject) return;
    const accepted = this.updateTask(taskId, {
      status: 'processing',
      stage: 'structuring',
      progress: Math.max(72, task.progress),
      error: undefined,
    });
    if (accepted) subject.next(review);
    subject.complete();
  }

  reconcile(taskId: string): void {
    this.reconciliation.reconcile(taskId).subscribe({ error: () => undefined });
  }

  remove(taskId: string): void {
    const task = this.taskState().find((candidate) => candidate.id === taskId);
    if (!task || !this.helpers.isTerminalTask(task)) return;
    const client = this.activeClient();
    if (task.captureId && client) {
      const streamingClient = asStreamingClient(client);
      defer(() =>
        streamingClient
          ? streamingClient.deleteStreamingCapture(task.captureId as string)
          : client.deleteCapture(task.captureId as string),
      )
        .pipe(
          catchError((error: unknown) => {
            this.updateTask(taskId, {
              error: this.helpers.failureFrom(
                error,
                'runtime',
                'Unable to clear capture data.',
              ),
            });
            return EMPTY;
          }),
        )
        .subscribe({
          complete: () => this.removeTask(taskId),
        });
      return;
    }
    this.removeTask(taskId);
  }

  private removeTask(taskId: string): void {
    this.taskState.update((tasks) =>
      tasks.filter((candidate) => candidate.id !== taskId),
    );
    this.internalTasks.delete(taskId);
    this.captureIds.delete(taskId);
  }

  private drainQueue(): void {
    while (this.runningTasks < this.resolvedConfig().concurrency) {
      const next = this.taskState().find((task) => task.status === 'queued');
      if (!next) return;
      this.runningTasks += 1;
      this.updateTask(next.id, {
        status: 'processing',
        stage: 'uploading',
        progress: 1,
      });
      const subscription = this.processTask(next.id)
        .pipe(
          catchError((error: unknown) => {
            const task = this.taskState().find(
              (candidate) => candidate.id === next.id,
            );
            if (task) {
              this.failTask(
                next.id,
                task.fileName,
                this.helpers.failureFrom(error, 'runtime', 'Capture failed.'),
              );
            }
            return EMPTY;
          }),
          finalize(() => {
            this.runningTasks -= 1;
            this.internalTasks.delete(next.id);
            this.taskSubscriptions.delete(next.id);
            this.drainQueue();
          }),
        )
        .subscribe();
      this.taskSubscriptions.set(next.id, subscription);
    }
  }

  private processTask(taskId: string): Observable<void> {
    const internal = this.internalTasks.get(taskId);
    const task = this.taskState().find((candidate) => candidate.id === taskId);
    const client = this.activeClient();
    if (!internal || !task || !client) {
      return defer(() => {
        this.failTask(taskId, task?.fileName ?? 'Unknown file', {
          code: 'client_not_configured',
          message: 'Capture client is not configured.',
          stage: 'runtime',
        });
        return of(undefined);
      });
    }

    const config = this.resolvedConfig();
    const provider = this.activeStructuringProvider();
    const componentOwnsHostStructuring =
      config.structuringMode === 'host' &&
      config.hostStructuringOwner === 'component';
    if (config.reviewBeforeCommit && config.structuringMode !== 'host') {
      return defer(() => {
        this.failTask(taskId, task.fileName, {
          code: 'review_requires_host_structuring',
          message: 'OCR review requires host structuring mode.',
          stage: 'structuring',
        });
        return of(undefined);
      });
    }
    if (componentOwnsHostStructuring && !provider) {
      return defer(() => {
        this.failTask(taskId, task.fileName, {
          code: 'structuring_provider_not_configured',
          message: 'Host structuring provider is not configured.',
          stage: 'structuring',
        });
        return of(undefined);
      });
    }
    if (
      config.reviewBeforeCommit &&
      !componentOwnsHostStructuring &&
      !client.confirmCapture
    ) {
      return defer(() => {
        this.failTask(taskId, task.fileName, {
          code: 'review_confirmation_not_supported',
          message:
            'The capture client does not support OCR review confirmation.',
          stage: 'structuring',
        });
        return of(undefined);
      });
    }

    const signal = internal.controller.signal;
    const streamingClient = asStreamingClient(client);
    if (streamingClient) {
      return this.processStreamingTask(
        streamingClient,
        internal,
        task,
        config,
        provider,
        componentOwnsHostStructuring,
        signal,
        taskId,
      ).pipe(
        catchError((error: unknown) =>
          this.handleProcessError(error, client, task, signal, taskId),
        ),
      );
    }
    const process$ = this.preprocess(
      internal.file,
      task.sourceKind,
      signal,
    ).pipe(
      tap(() => this.helpers.throwIfAborted(signal)),
      concatMap((file) => {
        this.updateTask(taskId, { stage: 'uploading', progress: 5 });
        const request = {
          clientRequestId: internal.clientRequestId,
          file,
          sourceKind: task.sourceKind,
          structuringMode: config.structuringMode,
          targetLanguage: config.targetLanguage,
          signal,
        } as const;
        return this.helpers.retryUncertainResponse(
          () => client.createCapture(request),
          signal,
        );
      }),
      tap((job) => {
        this.captureIds.set(taskId, job.captureId);
        this.updateTask(taskId, {
          captureId: job.captureId,
          stage: job.stage,
          progress: this.helpers.runtimeProgressPercent(job.progress),
        });
      }),
      concatMap((job) =>
        componentOwnsHostStructuring
          ? this.processHostStructuring(
              client,
              provider as CaptureStructuringProvider,
              job,
              task,
              config,
              signal,
              taskId,
            )
          : config.reviewBeforeCommit
            ? this.processClientReview(client, job, signal, taskId)
            : of(job),
      ),
      concatMap((job) => this.waitForJob(client, job, signal, false, taskId)),
      concatMap((job) => this.settleJob(client, task, job, signal, taskId)),
    );

    return process$.pipe(
      catchError((error: unknown) =>
        this.handleProcessError(error, client, task, signal, taskId),
      ),
    );
  }

  private processHostStructuring(
    client: CaptureClient,
    provider: CaptureStructuringProvider,
    initial: CaptureJobV1,
    task: CaptureTaskView,
    config: ResolvedCaptureWorkbenchConfig,
    signal: AbortSignal,
    taskId: string,
  ): Observable<CaptureJobV1> {
    return this.waitForJob(client, initial, signal, true, taskId).pipe(
      concatMap((job) => {
        if (
          !(job.stage === 'awaiting_structuring' && job.status === 'running')
        ) {
          return of(job);
        }
        return client.getRaw(job.captureId, signal).pipe(
          concatMap((raw) =>
            this.awaitReview(taskId, raw, config, job.progress).pipe(
              concatMap((review) =>
                defer(() =>
                  provider.structure({
                    raw: this.helpers.deepFreeze(structuredClone(raw)),
                    review,
                    documentContract: CAPTURE_DOCUMENT_V1_CONTRACT,
                    targetLanguage: config.targetLanguage,
                    signal,
                    reportProgress: (progress) =>
                      this.updateTask(taskId, {
                        progress:
                          70 + this.helpers.clampProgress(progress) * 0.2,
                      }),
                  }),
                ).pipe(
                  map((candidate) => {
                    const validationIssues =
                      this.captureHelpers.validateStructuringCandidate(
                        candidate,
                        raw,
                      );
                    if (validationIssues.length > 0) {
                      throw new Error(
                        `Invalid structured capture: ${validationIssues.join('; ')}`,
                      );
                    }
                    return { job, raw, candidate } as const;
                  }),
                  catchError((error: unknown) => {
                    if (this.helpers.isAbortError(error))
                      return throwError(() => error);
                    const failure = this.helpers.failureFrom(
                      error,
                      'structuring',
                      'Host structuring failed.',
                    );
                    return this.reconciliation
                      .reportHostFailureAndReconcile(
                        client,
                        job.captureId,
                        this.helpers.normalizeHostFailureMessage(
                          failure.message,
                        ),
                        signal,
                      )
                      .pipe(
                        map((reconciledJob) => ({
                          job: reconciledJob,
                          raw,
                          candidate: undefined,
                        })),
                        catchError((reconciliationError: unknown) => {
                          if (this.helpers.isAbortError(reconciliationError))
                            return throwError(() => reconciliationError);
                          this.requireReconciliation(
                            taskId,
                            this.helpers.hostReconciliationFailure(
                              reconciliationError,
                            ),
                            raw,
                          );
                          return EMPTY;
                        }),
                      );
                  }),
                ),
              ),
            ),
          ),
          concatMap(({ job: reconciledJob, candidate }) => {
            if (
              !candidate ||
              reconciledJob.status !== 'running' ||
              reconciledJob.stage !== 'awaiting_structuring'
            ) {
              return of(reconciledJob);
            }
            return this.reconciliation
              .commitHostResultAndReconcile(
                client,
                reconciledJob.captureId,
                candidate,
                signal,
              )
              .pipe(
                catchError((reconciliationError: unknown) => {
                  if (this.helpers.isAbortError(reconciliationError))
                    return throwError(() => reconciliationError);
                  this.requireReconciliation(
                    taskId,
                    this.helpers.hostReconciliationFailure(reconciliationError),
                    this.taskState().find(
                      (candidateTask) => candidateTask.id === taskId,
                    )?.raw,
                  );
                  return EMPTY;
                }),
              );
          }),
        );
      }),
    );
  }

  private processClientReview(
    client: CaptureClient,
    initial: CaptureJobV1,
    signal: AbortSignal,
    taskId: string,
  ): Observable<CaptureJobV1> {
    return this.waitForJob(client, initial, signal, true, taskId).pipe(
      concatMap((job) => {
        if (
          !(job.stage === 'awaiting_structuring' && job.status === 'running')
        ) {
          return of(job);
        }
        return client.getRaw(job.captureId, signal).pipe(
          concatMap((raw) =>
            this.awaitReview(taskId, raw, this.resolvedConfig(), job.progress),
          ),
          concatMap((review) => {
            const internal = this.internalTasks.get(taskId);
            const confirmCapture = client.confirmCapture;
            if (!internal || !confirmCapture) {
              return throwError(
                () => new Error('Capture client confirmation is unavailable.'),
              );
            }
            return confirmCapture.call(
              client,
              job.captureId,
              { clientRequestId: internal.confirmRequestId, review },
              signal,
            );
          }),
        );
      }),
    );
  }

  private awaitReview(
    taskId: string,
    raw: RawCaptureV1,
    config: ResolvedCaptureWorkbenchConfig,
    runtimeProgress: number,
  ): Observable<CaptureReviewV1> {
    const emptyReview: CaptureReviewV1 = { reviewVersion: 1, edits: [] };
    if (!config.reviewBeforeCommit) {
      this.updateTask(taskId, {
        raw,
        stage: 'structuring',
        progress: Math.max(
          70,
          this.helpers.runtimeProgressPercent(runtimeProgress),
        ),
      });
      return of(emptyReview);
    }
    const subject = new Subject<CaptureReviewV1>();
    this.reviewSubjects.set(taskId, subject);
    const task = this.updateTask(taskId, {
      status: 'awaiting_confirmation',
      stage: 'awaiting_structuring',
      progress: Math.max(
        70,
        this.helpers.runtimeProgressPercent(runtimeProgress),
      ),
      raw,
      review: emptyReview,
      error: undefined,
    });
    if (task) this.events.next({ type: 'review-required', task });
    return subject.pipe(
      take(1),
      finalize(() => {
        this.reviewSubjects.delete(taskId);
      }),
    );
  }

  private settleJob(
    client: CaptureClient,
    task: CaptureTaskView,
    job: CaptureJobV1,
    signal: AbortSignal,
    taskId: string,
  ): Observable<void> {
    if (job.status === 'cancelled') {
      return defer(() => {
        const canceledTask = this.updateTask(taskId, {
          status: 'canceled',
          stage: 'cancelled',
        });
        if (canceledTask) this.emitCanceled(canceledTask);
        return of(undefined);
      });
    }
    if (job.status === 'failed') {
      return this.tryGetRaw(client, job.captureId, signal).pipe(
        tap((raw) =>
          this.failTask(
            taskId,
            task.fileName,
            job.error
              ? this.helpers.redactFailure(job.error)
              : {
                  code: 'capture_failed',
                  message: 'Capture failed.',
                  stage: job.stage,
                },
            raw,
          ),
        ),
        map(() => undefined),
      );
    }
    if (job.status !== 'completed') {
      return throwError(
        () =>
          new Error(
            `Capture ended in unexpected state: ${job.status}/${job.stage}`,
          ),
      );
    }
    return client.getResult(job.captureId, signal).pipe(
      tap((result) => {
        this.helpers.throwIfAborted(signal);
        const completedTask = this.updateTask(taskId, {
          status: 'completed',
          stage: 'completed',
          progress: 100,
          result,
        });
        if (completedTask) {
          this.emitCompleted({
            taskId,
            document: result,
            review: completedTask.review,
          });
        }
      }),
      map(() => undefined),
    );
  }

  private processStreamingTask(
    client: StreamingClient,
    internal: InternalCaptureTask,
    task: CaptureTaskView,
    config: ResolvedCaptureWorkbenchConfig,
    provider: CaptureStructuringProvider | null,
    componentOwnsHostStructuring: boolean,
    signal: AbortSignal,
    taskId: string,
  ): Observable<void> {
    return this.preprocess(internal.file, task.sourceKind, signal).pipe(
      tap(() => this.helpers.throwIfAborted(signal)),
      concatMap((file) => {
        this.updateTask(taskId, { stage: 'uploading', progress: 5 });
        const request: StartStreamingCaptureRequest = {
          clientRequestId: internal.clientRequestId,
          file,
          sourceKind: task.sourceKind,
          structuringMode: config.structuringMode,
          targetLanguage: config.targetLanguage,
          signal,
        };
        return this.helpers.retryUncertainResponse(
          () => client.startStreamingCapture(request),
          signal,
        );
      }),
      tap((operation) => {
        this.captureIds.set(taskId, operation.captureId);
        this.applyStreamingOperation(taskId, operation);
      }),
      concatMap((operation) => {
        if (componentOwnsHostStructuring) {
          if (!provider) {
            return throwError(
              () => new Error('Host structuring provider is not configured.'),
            );
          }
          return this.processStreamingHostStructuring(
            client,
            provider,
            operation,
            config,
            signal,
            taskId,
          );
        }
        if (config.reviewBeforeCommit) {
          return throwError(
            () =>
              new Error(
                'Review confirmation is not supported by the v2 streaming contract.',
              ),
          );
        }
        return of(operation);
      }),
      concatMap((operation) =>
        this.waitForStreamingOperation(client, operation, signal, false, taskId),
      ),
      concatMap((operation) =>
        this.settleStreaming(client, task, operation, signal, taskId),
      ),
    );
  }

  private processStreamingHostStructuring(
    client: StreamingClient,
    provider: CaptureStructuringProvider,
    initial: CaptureOperationV2,
    config: ResolvedCaptureWorkbenchConfig,
    signal: AbortSignal,
    taskId: string,
  ): Observable<CaptureOperationV2> {
    return this.waitForStreamingOperation(client, initial, signal, true, taskId).pipe(
      concatMap((operation) => {
        if (operation.status !== 'awaiting_structuring') return of(operation);
        return client.getStreamingPartial(operation.captureId, signal).pipe(
          map((partial) => partialToRaw(partial)),
          concatMap((raw) =>
            this.awaitReview(taskId, raw, config, operation.progress ?? 0).pipe(
              concatMap((review) =>
                defer(() =>
                  provider.structure({
                    raw: this.helpers.deepFreeze(structuredClone(raw)),
                    review,
                    documentContract: CAPTURE_DOCUMENT_V1_CONTRACT,
                    targetLanguage: config.targetLanguage,
                    signal,
                    reportProgress: (progress) =>
                      this.updateTask(taskId, {
                        progress: 70 + this.helpers.clampProgress(progress) * 0.2,
                      }),
                  }),
                ).pipe(
                  map((candidate) => {
                    const issues = this.captureHelpers.validateStructuringCandidate(
                      candidate,
                      raw,
                    );
                    if (issues.length > 0) {
                      throw new Error(`Invalid structured capture: ${issues.join('; ')}`);
                    }
                    return { candidate } as const;
                  }),
                  catchError((error: unknown) => {
                    if (this.helpers.isAbortError(error)) return throwError(() => error);
                    const failure = this.helpers.failureFrom(
                      error,
                      'structuring',
                      'Host structuring failed.',
                    );
                    return client
                      .reportStreamingStructuringFailure(
                        operation.captureId,
                        streamingFailure(failure),
                        signal,
                      )
                      .pipe(map((reported) => ({ operation: reported } as const)));
                  }),
                ),
              ),
            ),
          ),
          concatMap((outcome) => {
            if ('operation' in outcome) return of(outcome.operation);
            const request: CommitStreamingStructuredResultRequest = {
              clientRequestId: crypto.randomUUID(),
              candidate: outcome.candidate,
            };
            return client.commitStreamingStructuredResult(
              operation.captureId,
              request,
              signal,
            );
          }),
        );
      }),
    );
  }

  private waitForStreamingOperation(
    client: StreamingClient,
    initial: CaptureOperationV2,
    signal: AbortSignal,
    stopForHost: boolean,
    taskId: string,
  ): Observable<CaptureOperationV2> {
    if (
      isTerminalStreamingOperation(initial) ||
      (stopForHost && initial.status === 'awaiting_structuring')
    ) {
      return of(initial);
    }
    return client.captureEvents(initial.captureId, {
      signal,
      lastEventId: initial.lastEventSequence,
    }).pipe(
      tap((event) => this.applyStreamingEvent(taskId, event)),
      takeWhile(
        (event) => !(stopForHost && event.stage === 'awaiting_structuring'),
        true,
      ),
      ignoreElements(),
      endWith(undefined),
      concatMap(() => client.getStreamingCapture(initial.captureId, signal)),
    );
  }

  private settleStreaming(
    client: StreamingClient,
    task: CaptureTaskView,
    operation: CaptureOperationV2,
    signal: AbortSignal,
    taskId: string,
  ): Observable<void> {
    if (operation.status === 'cancelled') {
      return defer(() => {
        const canceledTask = this.updateTask(taskId, {
          status: 'canceled',
          stage: 'cancelled',
        });
        if (canceledTask) this.emitCanceled(canceledTask);
        return of(undefined);
      });
    }
    if (operation.status === 'failed') {
      return this.tryGetRaw(client, operation.captureId, signal).pipe(
        tap((raw) =>
          this.failTask(
            taskId,
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
          ),
        ),
        map(() => undefined),
      );
    }
    if (operation.status !== 'completed') {
      return throwError(
        () => new Error(`Capture ended in unexpected state: ${operation.status}`),
      );
    }
    return client.getStreamingResult(operation.captureId, signal).pipe(
      tap((result) => {
        const completedTask = this.updateTask(taskId, {
          status: 'completed',
          stage: 'completed',
          progress: 100,
          raw: result.raw,
          result: result.result,
        });
        if (completedTask) {
          this.emitCompleted({
            taskId,
            document: result.result,
            review: completedTask.review,
          });
        }
      }),
      map(() => undefined),
    );
  }

  private applyStreamingEvent(taskId: string, event: CaptureEventV2): void {
    const progress =
      event.progress === undefined || event.progress === null
        ? undefined
        : this.helpers.runtimeProgressPercent(event.progress);
    const patch: Partial<CaptureTaskView> = progress === undefined
      ? { stage: streamingStage(event.stage) }
      : { stage: streamingStage(event.stage), progress };
    this.updateTask(taskId, patch);
  }

  private applyStreamingOperation(taskId: string, operation: CaptureOperationV2): void {
    this.updateTask(taskId, {
      captureId: operation.captureId,
      stage: streamingStage(operation.status),
      progress:
        operation.progress === undefined || operation.progress === null
          ? 0
          : this.helpers.runtimeProgressPercent(operation.progress),
    });
  }

  private handleProcessError(
    error: unknown,
    client: CaptureClient,
    task: CaptureTaskView,
    signal: AbortSignal,
    taskId: string,
  ): Observable<void> {
    if (this.helpers.isAbortError(error) || signal.aborted) {
      return defer(() => {
        if (
          this.taskState().find((candidate) => candidate.id === taskId)
            ?.status !== 'canceled'
        ) {
          const canceledTask = this.updateTask(taskId, {
            status: 'canceled',
            stage: 'cancelled',
          });
          if (canceledTask) this.emitCanceled(canceledTask);
        }
        return of(undefined);
      });
    }
    const captureId = this.captureIds.get(taskId);
    return (captureId ? this.tryGetRaw(client, captureId) : of(undefined)).pipe(
      tap((raw) =>
        this.failTask(
          taskId,
          task.fileName,
          this.helpers.failureFrom(error, 'runtime', 'Capture failed.'),
          raw,
        ),
      ),
      map(() => undefined),
    );
  }

  private waitForJob(
    client: CaptureClient,
    initial: CaptureJobV1,
    signal: AbortSignal,
    stopForHost: boolean,
    taskId: string,
  ): Observable<CaptureJobV1> {
    if (
      initial.status !== 'queued' &&
      !(
        initial.status === 'running' &&
        !(stopForHost && initial.stage === 'awaiting_structuring')
      )
    ) {
      return of(initial);
    }

    return defer(() => {
      const pollResource = this.pollResourceService.create({
        client,
        captureId: initial.captureId,
        pollIntervalMs: this.resolvedConfig().pollIntervalMs,
        signal,
        stopForHost,
        onJob: (job) =>
          this.updateTask(taskId, {
            stage: job.stage,
            progress: this.helpers.runtimeProgressPercent(job.progress),
          }),
      });
      return pollResource.terminal$.pipe(
        finalize(() => pollResource.destroy()),
      );
    });
  }

  private preprocess(
    file: File,
    sourceKind: CaptureTaskView['sourceKind'],
    signal: AbortSignal,
  ): Observable<File> {
    const preprocessor = this.preprocessor();
    return defer(() =>
      preprocessor
        ? preprocessor.preprocess({ file, sourceKind, signal })
        : of(file),
    );
  }

  private tryGetRaw(
    client: CaptureClient,
    captureId: string,
    signal?: AbortSignal,
  ): Observable<RawCaptureV1 | undefined> {
    const streamingClient = asStreamingClient(client);
    if (streamingClient) {
      return defer(() => streamingClient.getStreamingPartial(captureId, signal)).pipe(
        map((partial) => partialToRaw(partial)),
        catchError(() => of(undefined)),
      );
    }
    return defer(() => client.getRaw(captureId, signal)).pipe(
      catchError(() => of(undefined)),
    );
  }

  private activeClient(): CaptureClient | null {
    return this.context?.client() ?? null;
  }

  private activeStructuringProvider(): CaptureStructuringProvider | null {
    return this.context?.structuringProvider() ?? null;
  }

  private addRejectedTask(
    file: File,
    sourceKind: CaptureTaskView['sourceKind'],
  ): void {
    const id = crypto.randomUUID();
    const error: CaptureFailureV1 = {
      code: 'unsupported_source',
      message: `Unsupported capture source: ${file.name}`,
      stage: 'input',
    };
    const task: CaptureTaskView = {
      id,
      fileName: file.name,
      sourceKind,
      status: 'failed',
      progress: 0,
      error,
    };
    this.taskState.update((tasks) => [...tasks, task]);
    this.emitTaskChanged(task);
    this.emitFailed({ taskId: id, fileName: file.name, error });
  }

  private failTask(
    taskId: string,
    fileName: string,
    error: CaptureFailureV1,
    raw?: RawCaptureV1,
    stage?: CaptureTaskView['stage'],
  ): void {
    const safeError = this.helpers.redactFailure(error);
    const failedTask = this.updateTask(taskId, {
      status: 'failed',
      ...(stage ? { stage } : {}),
      error: safeError,
      raw,
    });
    this.emitFailed({
      taskId,
      captureId: failedTask?.captureId,
      fileName,
      error: safeError,
      raw,
    });
  }

  private requireReconciliation(
    taskId: string,
    error: CaptureFailureV1,
    raw?: RawCaptureV1,
  ): void {
    this.updateTask(taskId, {
      status: 'reconciliation_required',
      error: this.helpers.redactFailure(error),
      raw,
    });
  }

  private updateTask(
    id: string,
    patch: Partial<CaptureTaskView>,
  ): CaptureTaskView | undefined {
    let updated: CaptureTaskView | undefined;
    this.taskState.update((tasks) =>
      tasks.map((task) => {
        if (task.id !== id) return task;
        updated = { ...task, ...patch };
        return updated;
      }),
    );
    if (updated) this.emitTaskChanged(updated);
    return updated;
  }

  private emitCompleted(event: CaptureCompletedEvent): void {
    this.events.next({ type: 'completed', event });
  }

  private emitFailed(event: CaptureFailedEvent): void {
    this.events.next({ type: 'failed', event });
  }

  private emitCanceled(task: CaptureTaskView): void {
    this.events.next({ type: 'canceled', task });
  }

  private emitTaskChanged(task: CaptureTaskView): void {
    this.events.next({ type: 'task-changed', task });
  }
}

type StreamingClient = CaptureClient &
  Required<
    Pick<
      CaptureClient,
      | 'captureEvents'
      | 'startStreamingCapture'
      | 'getStreamingCapture'
      | 'cancelStreamingCapture'
      | 'getStreamingPartial'
      | 'getStreamingResult'
      | 'commitStreamingStructuredResult'
      | 'reportStreamingStructuringFailure'
      | 'deleteStreamingCapture'
    >
  >;

function asStreamingClient(client: CaptureClient): StreamingClient | undefined {
  return typeof client.captureEvents === 'function' &&
    typeof client.startStreamingCapture === 'function' &&
    typeof client.getStreamingCapture === 'function' &&
    typeof client.cancelStreamingCapture === 'function' &&
    typeof client.getStreamingPartial === 'function' &&
    typeof client.getStreamingResult === 'function' &&
    typeof client.commitStreamingStructuredResult === 'function' &&
    typeof client.reportStreamingStructuringFailure === 'function' &&
    typeof client.deleteStreamingCapture === 'function'
    ? client as StreamingClient
    : undefined;
}

function isTerminalStreamingOperation(operation: CaptureOperationV2): boolean {
  return (
    operation.status === 'completed' ||
    operation.status === 'failed' ||
    operation.status === 'cancelled'
  );
}

function streamingStage(stage: string): CaptureTaskView['stage'] {
  switch (stage) {
    case 'queued':
    case 'extracting':
    case 'awaiting_structuring':
    case 'structuring':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return stage;
    default:
      return 'preprocessing';
  }
}

function partialToRaw(partial: PartialCaptureV2): RawCaptureV1 {
  if (!partial.segments || !partial.sourceText || !partial.extractionEngine) {
    throw new Error('Streaming partial capture is not complete enough to structure.');
  }
  return {
    schemaVersion: '1',
    diagnosticOnly: true,
    source: partial.source,
    segments: partial.segments,
    sourceText: partial.sourceText,
    extractionEngine: partial.extractionEngine,
    createdAt: partial.updatedAt,
  };
}

function streamingFailure(
  failure: CaptureFailureV1,
): ReportStreamingStructuringFailureRequest {
  return {
    code: failure.code,
    message: failure.message,
  };
}
