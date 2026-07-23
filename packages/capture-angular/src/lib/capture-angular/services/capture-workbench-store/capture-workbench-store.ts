import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Observable, forkJoin, map, of, take, throwError } from 'rxjs';
import {
  CAPTURE_CLIENT,
  CAPTURE_PREPROCESSOR,
  CAPTURE_STRUCTURING_PROVIDER,
  CAPTURE_WORKBENCH_INPUTS,
  type CaptureClient,
  type CapturePreprocessor,
  type CaptureStructuringProvider,
  type CaptureTaskView,
  type CaptureWorkbenchConfig,
  type RuntimeRequirementV1,
} from '../../../contracts';
import type {
  ResolvedCaptureWorkbenchConfig,
  RuntimeHandshake,
  RuntimeViewState,
} from '../../../contracts/workbench';
import type { RuntimeRequest } from './internal-contracts';
import { DEFAULT_CAPTURE_WORKBENCH_CONFIG } from '../../../constants/workbench';
import { CaptureHelpersService } from '../../../capture-helpers';
import { CaptureRuntimeInstallationService } from '../capture-runtime-installation/capture-runtime-installation.service';
import { CaptureWorkflowService } from '../capture-workflow/capture-workflow.service';
import { CaptureWorkbenchStoreHelpers } from './capture-workbench-store-helpers';

@Injectable()
export class CaptureWorkbenchStore {
  private readonly destroyRef = inject(DestroyRef);
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
  private readonly inputSource = inject(CAPTURE_WORKBENCH_INPUTS, {
    optional: true,
  });
  private readonly lifecycleController = new AbortController();
  private readonly installationService = inject(
    CaptureRuntimeInstallationService,
  );
  private readonly workflow = inject(CaptureWorkflowService);
  private readonly captureHelpers = inject(CaptureHelpersService);
  private readonly helpers = inject(CaptureWorkbenchStoreHelpers);

  private readonly configState = signal<CaptureWorkbenchConfig>({});
  private readonly clientState = signal<CaptureClient | null>(null);
  private readonly structuringProviderState =
    signal<CaptureStructuringProvider | null>(null);
  private readonly preprocessorState = signal<CapturePreprocessor | null>(null);

  private readonly configurationEffect = effect(() => {
    const source = this.inputSource;
    this.configState.set(source?.config?.() ?? {});
    this.clientState.set(source?.client?.() ?? null);
    this.structuringProviderState.set(source?.structuringProvider?.() ?? null);
    this.preprocessorState.set(source?.preprocessor?.() ?? null);
    this.workflow.configure({
      config: () => this.resolvedConfig(),
      client: () => this.activeClient(),
      structuringProvider: () => this.activeStructuringProvider(),
      preprocessor: () => this.preprocessor() ?? this.injectedPreprocessor,
    });
  });

  readonly config = this.configState.asReadonly();
  readonly client = this.clientState.asReadonly();
  readonly structuringProvider = this.structuringProviderState.asReadonly();
  readonly preprocessor = this.preprocessorState.asReadonly();
  readonly events = this.workflow.events;
  readonly tasks = this.workflow.tasks;
  readonly installation = this.installationService.installation;

  readonly resolvedConfig = computed<ResolvedCaptureWorkbenchConfig>(() => ({
    ...DEFAULT_CAPTURE_WORKBENCH_CONFIG,
    ...this.config(),
    concurrency: Math.max(
      1,
      Math.floor(
        this.config().concurrency ??
          DEFAULT_CAPTURE_WORKBENCH_CONFIG.concurrency,
      ),
    ),
    pollIntervalMs: Math.max(
      0,
      this.config().pollIntervalMs ??
        DEFAULT_CAPTURE_WORKBENCH_CONFIG.pollIntervalMs,
    ),
  }));
  private readonly runtimeRequest = computed<RuntimeRequest | undefined>(
    () => {
      const config = this.config();
      const hostManagedHandshake =
        config.hostManagedHandshake ??
        DEFAULT_CAPTURE_WORKBENCH_CONFIG.hostManagedHandshake;
      if (hostManagedHandshake) return undefined;
      return {
        client: this.activeClient(),
        compatibleRuntimeMajor:
          config.compatibleRuntimeMajor ??
          DEFAULT_CAPTURE_WORKBENCH_CONFIG.compatibleRuntimeMajor,
        structuringMode:
          config.structuringMode ??
          DEFAULT_CAPTURE_WORKBENCH_CONFIG.structuringMode,
      };
    },
    {
      equal: (left, right) =>
        left === right ||
        (!!left &&
          !!right &&
          left.client === right.client &&
          left.compatibleRuntimeMajor === right.compatibleRuntimeMajor &&
          left.structuringMode === right.structuringMode),
    },
  );
  private readonly runtimeResource = rxResource<
    RuntimeHandshake,
    RuntimeRequest | undefined
  >({
    params: () => this.runtimeRequest(),
    stream: ({ params, abortSignal }) => {
      if (!params?.client) {
        return throwError(() => new Error('Capture client is not configured.'));
      }
      return forkJoin({
        ready: params.client.getReady(abortSignal).pipe(take(1)),
        requirements: params.client.getRequirements(abortSignal).pipe(take(1)),
      }).pipe(
        map(({ ready, requirements }) => {
          this.captureHelpers.assertCaptureRuntimeCompatible(
            ready,
            params.compatibleRuntimeMajor,
            params.structuringMode,
          );
          return { ready, requirements };
        }),
      );
    },
  });
  readonly runtime = computed<RuntimeViewState>(() => {
    const status = this.runtimeResource.status();
    const handshake = this.runtimeResource.hasValue()
      ? this.runtimeResource.value()
      : undefined;
    const installationError = this.installationService.error();

    if (status === 'idle') {
      return { status: 'idle', requirements: [] };
    }
    if (status === 'loading' || status === 'reloading') {
      return handshake
        ? {
            status: 'checking',
            ready: handshake.ready,
            requirements: handshake.requirements,
          }
        : { status: 'checking', requirements: [] };
    }
    if (status === 'error') {
      const error = this.runtimeResource.error();
      const incompatible =
        error instanceof Error && error.name === 'CaptureCompatibilityError';
      return {
        status: incompatible ? 'incompatible' : 'error',
        requirements: [],
        error: this.helpers.errorMessage(
          error,
          'Unable to check the capture runtime.',
        ),
      };
    }
    if (!handshake) {
      return { status: 'idle', requirements: [] };
    }

    const needsSetup = handshake.requirements.some(
      (requirement) =>
        this.requirementIsNeeded(requirement) && requirement.status !== 'ready',
    );
    if (installationError) {
      return {
        status: 'error',
        ready: handshake.ready,
        requirements: handshake.requirements,
        error: installationError,
      };
    }
    return {
      status: handshake.ready.ready && !needsSetup ? 'ready' : 'needs-setup',
      ready: handshake.ready,
      requirements: handshake.requirements,
    };
  });
  readonly accept = computed(() =>
    this.captureHelpers.captureAccept(this.resolvedConfig().enabledSources),
  );
  readonly hostStyles = computed(() => {
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
  readonly requiredRequirements = computed(() =>
    this.runtime().requirements.filter((requirement) =>
      this.requirementIsNeeded(requirement),
    ),
  );
  readonly installableRequirements = computed(() =>
    this.requiredRequirements().filter(
      (requirement) => requirement.status === 'installable',
    ),
  );
  readonly captureDisabled = computed(
    () =>
      !this.resolvedConfig().hostManagedHandshake &&
      this.runtime().status !== 'ready',
  );

  installationProgress(progress: number): number {
    return this.helpers.runtimeProgressPercent(progress);
  }

  constructor() {
    this.destroyRef.onDestroy(() => this.lifecycleController.abort());
  }

  refreshRuntime(): void {
    this.installationService.clearError();
    this.runtimeResource.reload();
  }

  installMissingRequirements(): void {
    this.installationService.install({
      client: this.activeClient(),
      requirements: () => this.installableRequirements(),
      pollIntervalMs: () => this.resolvedConfig().pollIntervalMs,
      reload: () => this.reloadRuntimeAndWait(),
    });
  }

  cancelInstallation(): void {
    this.installationService.cancel(this.activeClient());
  }

  enqueueFiles(files: readonly File[]): void {
    this.workflow.enqueueFiles(files);
  }

  cancel(taskId: string): void {
    this.workflow.cancel(taskId);
  }

  reconcile(taskId: string): void {
    this.workflow.reconcile(taskId);
  }

  remove(taskId: string): void {
    this.workflow.remove(taskId);
  }

  private reloadRuntimeAndWait(): Observable<void> {
    this.installationService.clearError();
    this.runtimeResource.reload();
    if (!this.runtimeResource.isLoading()) return of(undefined);
    return this.helpers.waitForResourceSettlement(
      this.runtimeResource,
      this.lifecycleController.signal,
    );
  }

  chooseFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.enqueueFiles(Array.from(input.files ?? []));
    input.value = '';
  }

  renderedResult(task: CaptureTaskView): string {
    return task.result
      ? this.captureHelpers.serializeCaptureDocument(
          task.result,
          this.resolvedConfig().outputMode,
        )
      : '';
  }

  exportResult(task: CaptureTaskView, mode: 'json' | 'text'): void {
    if (!task.result) return;
    this.download(
      this.captureHelpers.serializeCaptureDocument(task.result, mode),
      `${this.helpers.withoutExtension(task.fileName)}.capture.${mode === 'json' ? 'json' : 'txt'}`,
      mode === 'json' ? 'application/json' : 'text/plain;charset=utf-8',
    );
  }

  exportRaw(task: CaptureTaskView): void {
    if (!task.raw) return;
    this.download(
      this.captureHelpers.serializeRawCapture(task.raw),
      `${this.helpers.withoutExtension(task.fileName)}.raw-capture.json`,
      'application/json',
    );
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

  private activeClient(): CaptureClient | null {
    return this.client() ?? this.injectedClient;
  }

  private activeStructuringProvider(): CaptureStructuringProvider | null {
    return this.structuringProvider() ?? this.injectedStructuringProvider;
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
