import { Injectable, OnDestroy } from '@angular/core';
import {
  type CaptureClient,
  type CaptureCompletedEvent,
  type CaptureFailureV1,
  type CaptureJobV1,
  type CaptureStructuringCandidateV1,
  type CaptureTaskView,
  type RawCaptureV1,
} from '../contracts';
import type { CaptureReconciliationContext } from '../contracts/workbench';
import {
  HOST_PROVIDER_FAILURE_CODE,
  HOST_RECONCILIATION_FAILURE_CODE,
} from '../constants';
import {
  HostReconciliationUnavailableError,
  hostReconciliationFailure,
  isAbortError,
  isAwaitingHostStructuring,
  isTerminalCaptureJob,
} from './capture-workbench-store-helpers';

@Injectable()
export class CaptureReconciliationService implements OnDestroy {
  private readonly lifecycleController = new AbortController();
  private readonly reconciliationTasks = new Set<string>();
  private context?: CaptureReconciliationContext;

  configure(context: CaptureReconciliationContext): void {
    this.context = context;
  }

  ngOnDestroy(): void {
    this.lifecycleController.abort();
    this.reconciliationTasks.clear();
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
  ): Promise<RawCaptureV1 | undefined> {
    return this.context?.tryGetRaw(client, captureId, signal) ?? Promise.resolve(undefined);
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.getTask(taskId);
    if (task) await this.cancelReconciliationRequiredTask(task);
  }

  async reconcile(taskId: string): Promise<void> {
    const task = this.getTask(taskId);
    const client = this.activeClient();
    if (
      !task ||
      task.status !== 'reconciliation_required' ||
      !task.captureId ||
      !client ||
      this.reconciliationTasks.has(taskId)
    ) {
      return;
    }

    this.reconciliationTasks.add(taskId);
    try {
      let job: CaptureJobV1;
      try {
        job = await client.getCapture(
          task.captureId,
          this.lifecycleController.signal,
        );
      } catch (error: unknown) {
        if (isAbortError(error)) return;
        this.requireReconciliation(
          taskId,
          hostReconciliationFailure(error),
          task.raw,
        );
        return;
      }
      if (isTerminalCaptureJob(job)) {
        await this.settleConfirmedJob(task, client, job);
        return;
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
    } finally {
      this.reconciliationTasks.delete(taskId);
    }
  }

  async commitHostResultAndReconcile(
    client: CaptureClient,
    captureId: string,
    candidate: CaptureStructuringCandidateV1,
    signal: AbortSignal,
  ): Promise<CaptureJobV1> {
    const request = {
      clientRequestId: crypto.randomUUID(),
      candidate,
    } as const;
    try {
      return await client.commitStructuredResult(captureId, request, signal);
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
    }

    const afterFirstError = await this.tryGetCaptureForReconciliation(
      client,
      captureId,
      signal,
    );
    if (afterFirstError && !isAwaitingHostStructuring(afterFirstError))
      return afterFirstError;

    try {
      return await client.commitStructuredResult(captureId, request, signal);
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
    }

    const afterRetryError = await this.tryGetCaptureForReconciliation(
      client,
      captureId,
      signal,
    );
    if (afterRetryError && !isAwaitingHostStructuring(afterRetryError))
      return afterRetryError;

    return this.reportHostFailureAndReconcile(
      client,
      captureId,
      'Host structured result could not be committed.',
      signal,
    );
  }

  async reportHostFailureAndReconcile(
    client: CaptureClient,
    captureId: string,
    message: string,
    signal: AbortSignal,
  ): Promise<CaptureJobV1> {
    try {
      const reported = await client.reportStructuringFailure(
        captureId,
        { code: HOST_PROVIDER_FAILURE_CODE, message },
        signal,
      );
      if (isTerminalCaptureJob(reported)) return reported;
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      const current = await this.tryGetCaptureForReconciliation(
        client,
        captureId,
        signal,
      );
      if (current && isTerminalCaptureJob(current)) return current;
    }

    let cancelled: CaptureJobV1 | undefined;
    try {
      cancelled = await client.cancelCapture(captureId, signal);
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
    }

    const confirmed = await this.tryGetCaptureForReconciliation(
      client,
      captureId,
      signal,
    );
    if (confirmed && isTerminalCaptureJob(confirmed)) return confirmed;
    if (cancelled && isTerminalCaptureJob(cancelled)) return cancelled;
    throw new HostReconciliationUnavailableError();
  }

  private async tryGetCaptureForReconciliation(
    client: CaptureClient,
    captureId: string,
    signal: AbortSignal,
  ): Promise<CaptureJobV1 | undefined> {
    try {
      return await client.getCapture(captureId, signal);
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return undefined;
    }
  }

  private async cancelReconciliationRequiredTask(
    task: CaptureTaskView,
  ): Promise<void> {
    const client = this.activeClient();
    if (!client || !task.captureId || this.reconciliationTasks.has(task.id))
      return;

    this.reconciliationTasks.add(task.id);
    try {
      let cancelled: CaptureJobV1 | undefined;
      try {
        cancelled = await client.cancelCapture(
          task.captureId,
          this.lifecycleController.signal,
        );
      } catch (error: unknown) {
        if (isAbortError(error)) return;
      }

      let confirmed: CaptureJobV1 | undefined;
      try {
        confirmed = await client.getCapture(
          task.captureId,
          this.lifecycleController.signal,
        );
      } catch (error: unknown) {
        if (isAbortError(error)) return;
      }

      const terminal =
        confirmed && isTerminalCaptureJob(confirmed)
          ? confirmed
          : cancelled && isTerminalCaptureJob(cancelled)
            ? cancelled
            : undefined;
      if (terminal) {
        await this.settleConfirmedJob(task, client, terminal);
        return;
      }
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
    } finally {
      this.reconciliationTasks.delete(task.id);
    }
  }

  private async settleConfirmedJob(
    task: CaptureTaskView,
    client: CaptureClient,
    job: CaptureJobV1,
  ): Promise<void> {
    if (job.status === 'cancelled') {
      const canceledTask = this.updateTask(task.id, {
        status: 'canceled',
        stage: 'cancelled',
        error: undefined,
      });
      if (canceledTask) this.emitCanceled(canceledTask);
      return;
    }
    if (job.status === 'failed') {
      const raw = task.raw ?? (await this.tryGetRaw(client, job.captureId));
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
      return;
    }
    if (job.status !== 'completed') return;

    try {
      const result = await client.getResult(
        job.captureId,
        this.lifecycleController.signal,
      );
      const completedTask = this.updateTask(task.id, {
        status: 'completed',
        stage: 'completed',
        progress: 100,
        error: undefined,
        result,
      });
      if (completedTask)
        this.emitCompleted({ taskId: task.id, document: result });
    } catch (error: unknown) {
      if (isAbortError(error)) return;
      this.requireReconciliation(
        task.id,
        hostReconciliationFailure(error),
        task.raw,
      );
    }
  }
}
