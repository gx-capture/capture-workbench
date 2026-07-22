import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  CAPTURE_CLIENT,
  CAPTURE_PREPROCESSOR,
  CAPTURE_RUNTIME_MAJOR,
  CAPTURE_STRUCTURING_PROVIDER,
  type CaptureClient,
  type CaptureCompletedEvent,
  type CaptureStructuringCandidateV1,
  type CaptureFailedEvent,
  type CaptureFailureV1,
  type CaptureJobV1,
  type CapturePreprocessor,
  type CaptureStructuringProvider,
  type CaptureTaskView,
  type CaptureWorkbenchConfig,
  type RawCaptureV1,
  type RuntimeInstallationV1,
  type RuntimeReadyV1,
  type RuntimeRequirementV1,
} from '../contracts';
import {
  assertCaptureRuntimeCompatible,
  captureAccept,
  classifyCaptureFile,
  serializeCaptureDocument,
  serializeRawCapture,
  validateStructuringCandidate,
} from '../capture-helpers';
import { CAPTURE_DOCUMENT_V1_CONTRACT } from '../capture-document-schema';

interface ResolvedCaptureWorkbenchConfig {
  readonly enabledSources: readonly ('pdf' | 'image' | 'audio')[];
  readonly structuringMode: 'runtime' | 'host';
  readonly outputMode: 'json' | 'text';
  readonly multiple: boolean;
  readonly targetLanguage?: string;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly showRuntimeSetup: boolean;
  readonly hostStructuringOwner: 'component' | 'client';
  readonly hostManagedHandshake: boolean;
  readonly width: string;
  readonly height: string;
  readonly density: 'compact' | 'comfortable';
  readonly compatibleRuntimeMajor: number;
}

interface RuntimeViewState {
  readonly status:
    | 'idle'
    | 'checking'
    | 'ready'
    | 'needs-setup'
    | 'incompatible'
    | 'error';
  readonly ready?: RuntimeReadyV1;
  readonly requirements: readonly RuntimeRequirementV1[];
  readonly error?: string;
}

interface InternalCaptureTask {
  readonly file: File;
  readonly clientRequestId: string;
  readonly controller: AbortController;
}

const DEFAULT_CONFIG: ResolvedCaptureWorkbenchConfig = {
  enabledSources: ['pdf', 'image', 'audio'],
  structuringMode: 'runtime',
  outputMode: 'json',
  multiple: true,
  targetLanguage: undefined,
  concurrency: 1,
  pollIntervalMs: 750,
  showRuntimeSetup: true,
  hostStructuringOwner: 'component',
  hostManagedHandshake: false,
  width: '100%',
  height: 'auto',
  density: 'comfortable',
  compatibleRuntimeMajor: CAPTURE_RUNTIME_MAJOR,
};

const HOST_PROVIDER_FAILURE_CODE = 'host_provider_failed';
const HOST_RECONCILIATION_FAILURE_CODE = 'host_reconciliation_unavailable';
const MAX_INSTALLATIONS_PER_USER_ACTION = 16;

@Component({
  selector: 'capture-workbench',
  imports: [],
  templateUrl: './capture-angular.html',
  styleUrl: './capture-angular.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureWorkbenchComponent implements OnInit, OnDestroy {
  private readonly injectedClient = inject(CAPTURE_CLIENT, { optional: true });
  private readonly injectedStructuringProvider = inject(
    CAPTURE_STRUCTURING_PROVIDER,
    {
      optional: true,
    },
  );
  private readonly injectedPreprocessor = inject(CAPTURE_PREPROCESSOR, {
    optional: true,
  });
  private readonly internalTasks = new Map<string, InternalCaptureTask>();
  private readonly captureIds = new Map<string, string>();
  private readonly reconciliationTasks = new Set<string>();
  private readonly lifecycleController = new AbortController();
  private installationController?: AbortController;
  private runningTasks = 0;

  readonly config = input<CaptureWorkbenchConfig>({});
  readonly client = input<CaptureClient | null>(null);
  readonly structuringProvider = input<CaptureStructuringProvider | null>(null);
  readonly preprocessor = input<CapturePreprocessor | null>(null);

  readonly completed = output<CaptureCompletedEvent>();
  readonly failed = output<CaptureFailedEvent>();
  readonly canceled = output<CaptureTaskView>();
  readonly taskChanged = output<CaptureTaskView>();

  private readonly taskState = signal<readonly CaptureTaskView[]>([]);
  readonly tasks = this.taskState.asReadonly();
  readonly runtime = signal<RuntimeViewState>({
    status: 'idle',
    requirements: [],
  });
  readonly installation = signal<RuntimeInstallationV1 | null>(null);

  protected readonly resolvedConfig = computed<ResolvedCaptureWorkbenchConfig>(
    () => ({
      ...DEFAULT_CONFIG,
      ...this.config(),
      concurrency: Math.max(
        1,
        Math.floor(this.config().concurrency ?? DEFAULT_CONFIG.concurrency),
      ),
      pollIntervalMs: Math.max(
        0,
        this.config().pollIntervalMs ?? DEFAULT_CONFIG.pollIntervalMs,
      ),
    }),
  );
  protected readonly accept = computed(() =>
    captureAccept(this.resolvedConfig().enabledSources),
  );
  protected readonly hostStyles = computed(() => {
    const theme = this.config().theme;
    return {
      '--capture-accent': theme?.accent ?? '#4f46e5',
      '--capture-background': theme?.background ?? '#ffffff',
      '--capture-foreground': theme?.foreground ?? '#172033',
      '--capture-muted': theme?.muted ?? '#64748b',
      '--capture-border': theme?.border ?? '#cbd5e1',
      '--capture-danger': theme?.danger ?? '#b42318',
      width: this.resolvedConfig().width,
      height: this.resolvedConfig().height,
    };
  });
  protected readonly requiredRequirements = computed(() =>
    this.runtime().requirements.filter((requirement) =>
      this.requirementIsNeeded(requirement),
    ),
  );
  protected readonly installableRequirements = computed(() =>
    this.requiredRequirements().filter(
      (requirement) => requirement.status === 'installable',
    ),
  );
  protected readonly captureDisabled = computed(
    () =>
      !this.resolvedConfig().hostManagedHandshake &&
      this.runtime().status !== 'ready',
  );

  protected installationProgress(progress: number): number {
    return runtimeProgressPercent(progress);
  }

  ngOnInit(): void {
    if (!this.resolvedConfig().hostManagedHandshake) void this.refreshRuntime();
  }

  ngOnDestroy(): void {
    this.lifecycleController.abort();
    this.installationController?.abort();
    for (const task of this.internalTasks.values()) task.controller.abort();
  }

  async refreshRuntime(): Promise<void> {
    const client = this.activeClient();
    if (!client) {
      this.runtime.set({
        status: 'error',
        requirements: [],
        error: 'Capture client is not configured.',
      });
      return;
    }

    this.runtime.update((state) => ({
      ...state,
      status: 'checking',
      error: undefined,
    }));
    try {
      const [ready, requirements] = await Promise.all([
        client.getReady(this.lifecycleController.signal),
        client.getRequirements(this.lifecycleController.signal),
      ]);
      assertCaptureRuntimeCompatible(
        ready,
        this.resolvedConfig().compatibleRuntimeMajor,
        this.resolvedConfig().structuringMode,
      );
      const needsSetup = requirements.some(
        (requirement) =>
          this.requirementIsNeeded(requirement) &&
          requirement.status !== 'ready',
      );
      this.runtime.set({
        status: ready.ready && !needsSetup ? 'ready' : 'needs-setup',
        ready,
        requirements,
      });
    } catch (error: unknown) {
      if (isAbortError(error)) return;
      const incompatible =
        error instanceof Error && error.name === 'CaptureCompatibilityError';
      this.runtime.set({
        status: incompatible ? 'incompatible' : 'error',
        requirements: [],
        error: errorMessage(error, 'Unable to check the capture runtime.'),
      });
    }
  }

  async installMissingRequirements(): Promise<void> {
    const client = this.activeClient();
    if (!client || this.installation()) return;
    if (this.installableRequirements().length === 0) return;

    this.installationController = new AbortController();
    const signal = this.installationController.signal;
    const completedRequirementIds = new Set<string>();
    const requestIds = new Map<string, string>();
    let installationsStarted = 0;
    try {
      while (installationsStarted < MAX_INSTALLATIONS_PER_USER_ACTION) {
        const requirement = this.installableRequirements().find(
          (candidate) => !completedRequirementIds.has(candidate.requirementId),
        );
        if (!requirement) break;

        const request = {
          clientRequestId:
            requestIds.get(requirement.requirementId) ?? crypto.randomUUID(),
          requirementId: requirement.requirementId,
          consent: true,
        } as const;
        requestIds.set(requirement.requirementId, request.clientRequestId);
        installationsStarted += 1;

        let installation = await retryUncertainResponse(
          () => client.startInstallation(request, signal),
          signal,
        );
        this.installation.set(installation);
        while (
          installation.status === 'queued' ||
          installation.status === 'running'
        ) {
          await abortableDelay(this.resolvedConfig().pollIntervalMs, signal);
          installation = await client.getInstallation(
            installation.installationId,
            signal,
          );
          this.installation.set(installation);
        }
        if (installation.status !== 'completed') break;
        completedRequirementIds.add(requirement.requirementId);
        this.installation.set(null);
        // Installing one requirement can unlock another (for example, the
        // capture model after Ollama becomes available). Keep the original
        // explicit consent scope, but only attempt each completed ID once.
        await this.refreshRuntime();
      }

      if (
        installationsStarted === MAX_INSTALLATIONS_PER_USER_ACTION &&
        this.installableRequirements().some(
          (requirement) =>
            !completedRequirementIds.has(requirement.requirementId),
        )
      ) {
        throw new Error(
          'Runtime installation stopped after reaching the safety limit.',
        );
      }
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        this.runtime.update((state) => ({
          ...state,
          status: 'error',
          error: errorMessage(error, 'Runtime installation failed.'),
        }));
      }
    } finally {
      this.installationController = undefined;
      if (this.installation()?.status === 'completed')
        this.installation.set(null);
      await this.refreshRuntime();
    }
  }

  async cancelInstallation(): Promise<void> {
    const installation = this.installation();
    const client = this.activeClient();
    if (!installation || !client) return;
    this.installationController?.abort();
    try {
      this.installation.set(
        await client.cancelInstallation(installation.installationId),
      );
    } catch (error: unknown) {
      this.runtime.update((state) => ({
        ...state,
        status: 'error',
        error: errorMessage(error, 'Unable to cancel runtime installation.'),
      }));
    }
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
      this.taskChanged.emit(task);
    }
    this.drainQueue();
  }

  async cancel(taskId: string): Promise<void> {
    const current = this.taskState().find((task) => task.id === taskId);
    if (!current || isTerminalTask(current)) return;
    if (current.status === 'reconciliation_required') {
      await this.cancelReconciliationRequiredTask(current);
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
    if (canceledTask) this.canceled.emit(canceledTask);
    if (current.status === 'queued') {
      this.internalTasks.delete(taskId);
      this.drainQueue();
    }
  }

  async reconcile(taskId: string): Promise<void> {
    const task = this.taskState().find((candidate) => candidate.id === taskId);
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

  protected chooseFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.enqueueFiles(Array.from(input.files ?? []));
    input.value = '';
  }

  protected renderedResult(task: CaptureTaskView): string {
    return task.result
      ? serializeCaptureDocument(task.result, this.resolvedConfig().outputMode)
      : '';
  }

  protected exportResult(task: CaptureTaskView, mode: 'json' | 'text'): void {
    if (!task.result) return;
    this.download(
      serializeCaptureDocument(task.result, mode),
      `${withoutExtension(task.fileName)}.capture.${mode === 'json' ? 'json' : 'txt'}`,
      mode === 'json' ? 'application/json' : 'text/plain;charset=utf-8',
    );
  }

  protected exportRaw(task: CaptureTaskView): void {
    if (!task.raw) return;
    this.download(
      serializeRawCapture(task.raw),
      `${withoutExtension(task.fileName)}.raw-capture.json`,
      'application/json',
    );
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
              job = await this.reportHostFailureAndReconcile(
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
              job = await this.commitHostResultAndReconcile(
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
        if (canceledTask) this.canceled.emit(canceledTask);
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
      if (completedTask) this.completed.emit({ taskId, document: result });
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
          if (canceledTask) this.canceled.emit(canceledTask);
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
    let job = initial;
    while (
      job.status === 'queued' ||
      (job.status === 'running' &&
        !(stopForHost && job.stage === 'awaiting_structuring'))
    ) {
      await abortableDelay(this.resolvedConfig().pollIntervalMs, signal);
      job = await client.getCapture(job.captureId, signal);
      this.updateTask(taskId, {
        stage: job.stage,
        progress: runtimeProgressPercent(job.progress),
      });
    }
    return job;
  }

  private async commitHostResultAndReconcile(
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

  private async reportHostFailureAndReconcile(
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
      if (canceledTask) this.canceled.emit(canceledTask);
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
        this.completed.emit({ taskId: task.id, document: result });
    } catch (error: unknown) {
      if (isAbortError(error)) return;
      this.requireReconciliation(
        task.id,
        hostReconciliationFailure(error),
        task.raw,
      );
    }
  }

  private async preprocess(
    file: File,
    sourceKind: CaptureTaskView['sourceKind'],
    signal: AbortSignal,
  ): Promise<File> {
    const preprocessor = this.preprocessor() ?? this.injectedPreprocessor;
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
    return this.client() ?? this.injectedClient;
  }

  private activeStructuringProvider(): CaptureStructuringProvider | null {
    return this.structuringProvider() ?? this.injectedStructuringProvider;
  }

  private requirementIsNeeded(requirement: RuntimeRequirementV1): boolean {
    const enabled = this.resolvedConfig().enabledSources;
    if (requirement.requirementId === 'windowsml-ocr') {
      return enabled.includes('pdf') || enabled.includes('image');
    }
    if (requirement.requirementId === 'whisper-primary')
      return enabled.includes('audio');
    return this.resolvedConfig().structuringMode === 'runtime';
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
    this.taskChanged.emit(task);
    this.failed.emit({ taskId: id, fileName: file.name, error });
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
    this.failed.emit({
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
    if (updated) this.taskChanged.emit(updated);
    return updated;
  }

  private download(content: string, fileName: string, type: string): void {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}

function isTerminalTask(task: CaptureTaskView): boolean {
  return (
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'canceled'
  );
}

function isTerminalCaptureJob(job: CaptureJobV1): boolean {
  return (
    job.status === 'completed' ||
    job.status === 'failed' ||
    job.status === 'cancelled'
  );
}

function isAwaitingHostStructuring(job: CaptureJobV1): boolean {
  return (
    job.status === 'running' &&
    job.stage === 'awaiting_structuring' &&
    job.structuringMode === 'host'
  );
}

function normalizeHostFailureMessage(message: string): string {
  const normalized = message.trim();
  return (normalized || 'Host structuring failed.').slice(0, 500);
}

function hostReconciliationFailure(error: unknown): CaptureFailureV1 {
  return {
    code: HOST_RECONCILIATION_FAILURE_CODE,
    message: errorMessage(
      error,
      'Host structuring failed and the runtime terminal state could not be confirmed.',
    ),
    stage: 'structuring',
    retryable: true,
  };
}

class HostReconciliationUnavailableError extends Error {
  constructor() {
    super(
      'Host structuring failed and the runtime terminal state could not be confirmed.',
    );
    this.name = 'HostReconciliationUnavailableError';
  }
}

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, progress));
}

function runtimeProgressPercent(progress: number): number {
  return clampProgress(progress <= 1 ? progress * 100 : progress);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function failureFrom(
  error: unknown,
  stage: CaptureFailureV1['stage'],
  fallback: string,
): CaptureFailureV1 {
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
  };
  return {
    code:
      typeof candidate?.code === 'string' ? candidate.code : 'capture_failed',
    message:
      typeof candidate?.message === 'string' ? candidate.message : fallback,
    stage,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted.', 'AbortError');
}

async function retryUncertainResponse<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    throwIfAborted(signal);
    if (!isUncertainResponseFailure(error)) throw error;
    return operation();
  }
}

function isUncertainResponseFailure(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const candidate = error as {
    readonly status?: unknown;
    readonly code?: unknown;
  };
  if (candidate?.code === 'invalid_response') return true;
  if (typeof candidate?.status === 'number') {
    return candidate.status === 0 || candidate.status >= 500;
  }
  // Fetch surfaces network failures as TypeError. A plain Error from a custom
  // host client may be a definite domain failure and must not be replayed.
  return error instanceof TypeError;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted)
    return Promise.reject(
      new DOMException('The operation was aborted.', 'AbortError'),
    );
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      },
      { once: true },
    );
  });
}

function withoutExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}
