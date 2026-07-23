import {
  Injector,
  Injectable,
  OnDestroy,
  inject,
  signal,
} from '@angular/core';
import { Subject } from 'rxjs';
import {
  type CaptureClient,
  type CaptureCompletedEvent,
  type CaptureFailedEvent,
  type CaptureFailureV1,
  type CaptureJobV1,
  type CapturePreprocessor,
  type CaptureStructuringCandidateV1,
  type CaptureStructuringProvider,
  type CaptureTaskView,
  type RawCaptureV1,
} from '../contracts';
import type {
  CaptureWorkflowContext,
  InternalCaptureTask,
  ResolvedCaptureWorkbenchConfig,
} from '../contracts/workbench';
import {
  classifyCaptureFile,
  validateStructuringCandidate,
} from '../capture-helpers';
import { CAPTURE_DOCUMENT_V1_CONTRACT } from '../capture-document-schema';
import {
  createCaptureJobPollResource,
  type CaptureJobPollResource,
} from './capture-job-poll-resource';
import {
  clampProgress,
  deepFreeze,
  failureFrom,
  hostReconciliationFailure,
  isAbortError,
  isTerminalTask,
  normalizeHostFailureMessage,
  retryUncertainResponse,
  runtimeProgressPercent,
  throwIfAborted,
} from './capture-workbench-store-helpers';
import { CaptureReconciliationService } from './capture-reconciliation.service';

@Injectable()
export class CaptureWorkflowService implements OnDestroy {
  private readonly injector = inject(Injector);
  private readonly lifecycleController = new AbortController();
  private readonly internalTasks = new Map<string, InternalCaptureTask>();
  private readonly captureIds = new Map<string, string>();
  private runningTasks = 0;
  private context?: CaptureWorkflowContext;
  private readonly reconciliation = inject(CaptureReconciliationService);
  private readonly taskState = signal<readonly CaptureTaskView[]>([]);

  readonly tasks = this.taskState.asReadonly();
  readonly events = new Subject<
    | { readonly type: 'completed'; readonly event: CaptureCompletedEvent }
    | { readonly type: 'failed'; readonly event: CaptureFailedEvent }
    | { readonly type: 'canceled'; readonly task: CaptureTaskView }
    | { readonly type: 'task-changed'; readonly task: CaptureTaskView }
  >();

  configure(context: CaptureWorkflowContext): void {
    this.context = context;
    this.reconciliation.configure({
      client: () => this.activeClient(),
      getTask: (taskId) =>
        this.taskState().find((task) => task.id === taskId),
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

  ngOnDestroy(): void {
    this.lifecycleController.abort();
    for (const task of this.internalTasks.values()) task.controller.abort();
    this.reconciliation.ngOnDestroy();
    this.events.complete();
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
      const sourceKind = classifyCaptureFile(file);
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
        controller,
      });
      this.taskState.update((tasks) => [...tasks, task]);
      this.emitTaskChanged(task);
    }
    this.drainQueue();
  }

  async cancel(taskId: string): Promise<void> {
    const current = this.taskState().find((task) => task.id === taskId);
    if (!current || isTerminalTask(current)) return;
    if (current.status === 'reconciliation_required') {
      await this.reconciliation.cancel(taskId);
      return;
    }
    const internal = this.internalTasks.get(taskId);
    if (!internal) return;
    internal.controller.abort();
    const captureId = this.captureIds.get(taskId);
    const client = this.activeClient();
    if (captureId && client)
      void client.cancelCapture(captureId).catch(() => undefined);
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

  reconcile(taskId: string): Promise<void> {
    return this.reconciliation.reconcile(taskId);
  }


  async remove(taskId: string): Promise<void> {
    const task = this.taskState().find((candidate) => candidate.id === taskId);
    if (!task || !isTerminalTask(task)) return;
    const client = this.activeClient();
    if (task.captureId && client) {
      try {
        await client.deleteCapture(task.captureId);
      } catch (error: unknown) {
        this.updateTask(taskId, {
          error: failureFrom(error, 'runtime', 'Unable to clear capture data.'),
        });
        return;
      }
    }
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
      void this.processTask(next.id).finally(() => {
        this.runningTasks -= 1;
        this.internalTasks.delete(next.id);
        this.drainQueue();
      });
    }
  }

  private async processTask(taskId: string): Promise<void> {
    const internal = this.internalTasks.get(taskId);
    const task = this.taskState().find((candidate) => candidate.id === taskId);
    const client = this.activeClient();
    if (!internal || !task || !client) {
      this.failTask(taskId, task?.fileName ?? 'Unknown file', {
        code: 'client_not_configured',
        message: 'Capture client is not configured.',
        stage: 'runtime',
      });
      return;
    }

    const config = this.resolvedConfig();
    const provider = this.activeStructuringProvider();
    const componentOwnsHostStructuring =
      config.structuringMode === 'host' &&
      config.hostStructuringOwner === 'component';
    if (componentOwnsHostStructuring && !provider) {
      this.failTask(taskId, task.fileName, {
        code: 'structuring_provider_not_configured',
        message: 'Host structuring provider is not configured.',
        stage: 'structuring',
      });
      return;
    }

    const signal = internal.controller.signal;
    try {
      this.updateTask(taskId, { stage: 'preprocessing', progress: 3 });
      const file = await this.preprocess(
        internal.file,
        task.sourceKind,
        signal,
      );
      throwIfAborted(signal);

      const createRequest = {
        clientRequestId: internal.clientRequestId,
        file,
        sourceKind: task.sourceKind,
        structuringMode: config.structuringMode,
        targetLanguage: config.targetLanguage,
        signal,
      } as const;
      let job = await retryUncertainResponse(
        () => client.createCapture(createRequest),
        signal,
      );
      this.captureIds.set(taskId, job.captureId);
      this.updateTask(taskId, {
        captureId: job.captureId,
        stage: job.stage,
        progress: runtimeProgressPercent(job.progress),
      });

      if (componentOwnsHostStructuring) {
        if (!provider) {
          throw new Error('Host structuring provider is not configured.');
        }
        job = await this.waitForJob(client, job, signal, true, taskId);
        if (job.stage === 'awaiting_structuring' && job.status === 'running') {
          const raw = await client.getRaw(job.captureId, signal);
          this.updateTask(taskId, {
            raw,
            stage: 'structuring',
            progress: Math.max(70, runtimeProgressPercent(job.progress)),
          });
          let candidate: CaptureStructuringCandidateV1 | undefined;
          try {
            const providerRaw = deepFreeze(structuredClone(raw));
            candidate = await provider.structure({
              raw: providerRaw,
              documentContract: CAPTURE_DOCUMENT_V1_CONTRACT,
              targetLanguage: config.targetLanguage,
              signal,
              reportProgress: (progress) =>
                this.updateTask(taskId, {
                  progress: 70 + clampProgress(progress) * 0.2,
                }),
            });
            const validationIssues = validateStructuringCandidate(
              candidate,
              raw,
            );
            if (validationIssues.length > 0) {
              throw new Error(
                `Invalid structured capture: ${validationIssues.join('; ')}`,
              );
            }
          } catch (error: unknown) {
            if (isAbortError(error)) throw error;
            const failure = failureFrom(
              error,
              'structuring',
              'Host structuring failed.',
            );
            try {
              job = await this.reconciliation.reportHostFailureAndReconcile(
                client,
                job.captureId,
                normalizeHostFailureMessage(failure.message),
                signal,
              );
            } catch (reconciliationError: unknown) {
              if (isAbortError(reconciliationError)) throw reconciliationError;
              this.requireReconciliation(
                taskId,
                hostReconciliationFailure(reconciliationError),
                raw,
              );
              return;
            }
          }

          if (
            candidate &&
            job.status === 'running' &&
            job.stage === 'awaiting_structuring'
          ) {
            try {
              job = await this.reconciliation.commitHostResultAndReconcile(
                client,
                job.captureId,
                candidate,
                signal,
              );
            } catch (reconciliationError: unknown) {
              if (isAbortError(reconciliationError)) throw reconciliationError;
              this.requireReconciliation(
                taskId,
                hostReconciliationFailure(reconciliationError),
                raw,
              );
              return;
            }
          }
        }
      }

      job = await this.waitForJob(client, job, signal, false, taskId);
      if (job.status === 'cancelled') {
        const canceledTask = this.updateTask(taskId, {
          status: 'canceled',
          stage: 'cancelled',
        });
        if (canceledTask) this.emitCanceled(canceledTask);
        return;
      }
      if (job.status === 'failed') {
        const raw = await this.tryGetRaw(client, job.captureId, signal);
        this.failTask(
          taskId,
          task.fileName,
          job.error ?? {
            code: 'capture_failed',
            message: 'Capture failed.',
            stage: job.stage,
          },
          raw,
        );
        return;
      }
      if (job.status !== 'completed') {
        throw new Error(
          `Capture ended in unexpected state: ${job.status}/${job.stage}`,
        );
      }

      const result = await client.getResult(job.captureId, signal);
      throwIfAborted(signal);
      const completedTask = this.updateTask(taskId, {
        status: 'completed',
        stage: 'completed',
        progress: 100,
        result,
      });
      if (completedTask)
        this.emitCompleted({ taskId, document: result });
    } catch (error: unknown) {
      if (isAbortError(error) || signal.aborted) {
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
        return;
      }
      const captureId = this.captureIds.get(taskId);
      const raw = captureId
        ? await this.tryGetRaw(client, captureId)
        : undefined;
      this.failTask(
        taskId,
        task.fileName,
        failureFrom(error, 'runtime', 'Capture failed.'),
        raw,
      );
    }
  }

  private async waitForJob(
    client: CaptureClient,
    initial: CaptureJobV1,
    signal: AbortSignal,
    stopForHost: boolean,
    taskId: string,
  ): Promise<CaptureJobV1> {
    if (
      initial.status !== 'queued' &&
      !(initial.status === 'running' &&
        !(stopForHost && initial.stage === 'awaiting_structuring'))
    ) {
      return initial;
    }

    const pollResource: CaptureJobPollResource =
      createCaptureJobPollResource({
        client,
        captureId: initial.captureId,
        pollIntervalMs: this.resolvedConfig().pollIntervalMs,
        signal,
        stopForHost,
        injector: this.injector,
        onJob: (job) =>
          this.updateTask(taskId, {
            stage: job.stage,
            progress: runtimeProgressPercent(job.progress),
          }),
      });
    try {
      return await pollResource.done;
    } finally {
      pollResource.destroy();
    }
  }


  private async preprocess(
    file: File,
    sourceKind: CaptureTaskView['sourceKind'],
    signal: AbortSignal,
  ): Promise<File> {
    const preprocessor = this.preprocessor();
    return preprocessor
      ? preprocessor.preprocess({ file, sourceKind, signal })
      : file;
  }

  private async tryGetRaw(
    client: CaptureClient,
    captureId: string,
    signal?: AbortSignal,
  ): Promise<RawCaptureV1 | undefined> {
    try {
      return await client.getRaw(captureId, signal);
    } catch {
      return undefined;
    }
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
    const failedTask = this.updateTask(taskId, {
      status: 'failed',
      ...(stage ? { stage } : {}),
      error,
      raw,
    });
    this.emitFailed({
      taskId,
      captureId: failedTask?.captureId,
      fileName,
      error,
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
      error,
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
