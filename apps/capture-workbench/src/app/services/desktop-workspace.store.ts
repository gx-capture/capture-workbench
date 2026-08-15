import {
  computed,
  DestroyRef,
  effect,
  Injectable,
  inject,
  signal,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  catchError,
  concatMap,
  defer,
  expand,
  filter,
  finalize,
  from,
  map,
  type Observable,
  of,
  race,
  Subject,
  switchMap,
  take,
  tap,
  throwError,
  timer,
} from 'rxjs';
import {
  type CaptureEvent,
  type CaptureOperation,
  type PartialCapture,
  type CaptureRequirementId,
  type RuntimeInstallation,
  type RuntimeModelInstallation,
  type RuntimeModelOption,
  type RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import type {
  DesktopLibraryDetail,
  DesktopLibraryStatus,
  DesktopLibrarySummary,
} from '../contracts';
import { DesktopLibraryService } from './desktop-library.service';
import {
  DesktopRuntimeClientService,
  type DesktopCaptureOperation,
  type StreamingTerminalResultV2,
} from './desktop-runtime-client.service';

type WorkspaceState = 'starting' | 'needs-setup' | 'ready' | 'error';

interface ActiveCapture {
  captureId?: string;
  streaming: boolean;
  lastEventSequence: number;
  rawPersisted: boolean;
  cancelRequested: boolean;
  cancelSent: boolean;
  lastStage?: string;
  terminalCommitted?: boolean;
  terminalStatus?: DesktopLibraryStatus;
  terminalErrorCode?: string;
  terminalErrorMessage?: string;
  readonly cancelWake: Subject<void>;
}

const CORE_REQUIREMENTS = new Set<CaptureRequirementId>([
  'windowsml-ocr',
  'ollama-runtime',
]);

const INSTALLATION_ORDER = new Map<CaptureRequirementId, number>([
  ['windowsml-ocr', 0],
  ['whisper-primary', 1],
  ['ollama-runtime', 2],
]);

@Injectable({ providedIn: 'root' })
export class DesktopWorkspaceStore {
  readonly message = signal('正在連線到 Capture Runtime…');
  readonly selectedId = signal<string | null>(null);
  readonly query = signal('');
  readonly statusFilter = signal('');
  readonly installing = signal(false);
  readonly activeInstallation = signal<RuntimeInstallation | null>(null);
  readonly activeModelInstallation = signal<RuntimeModelInstallation | null>(null);
  readonly modelInstallationPercent = computed(() => {
    const progress = this.activeModelInstallation()?.progress ?? 0;
    return Math.round(Math.min(Math.max(progress, 0), 1) * 100);
  });
  readonly modelInstallationPhase = computed(() => {
    const installation = this.activeModelInstallation();
    if (!installation) return '';
    if (installation.status === 'queued') return '等待開始';
    if (installation.status === 'failed') return '模型下載失敗';
    if (installation.status === 'cancelled') return '模型下載已取消';
    if (installation.status === 'completed') return '模型已準備完成';
    if (installation.progress < 0.1) return '啟動模型服務';
    if (installation.progress < 0.75) return '下載與驗證模型';
    return '建立 Workbench profile';
  });
  readonly selectedModelOptionId = signal<string | null>(null);
  readonly busyIds = signal<ReadonlySet<string>>(new Set());
  readonly requestedRequirements = signal<ReadonlySet<CaptureRequirementId>>(new Set());
  readonly streamingPartials = signal<ReadonlyMap<string, PartialCapture>>(new Map());

  partialFor(documentId: string): PartialCapture | null {
    return this.streamingPartials().get(documentId) ?? null;
  }

  get requirements() {
    return this.requirementsResource.value;
  }

  get documents() {
    return this.documentsResource.value;
  }

  get selected() {
    return this.selectedResource.value;
  }

  readonly state = computed<WorkspaceState>(() => {
    if (
      this.runtime.error()
      || this.requirementsResource.error()
      || this.modelOptionsResource.error()
      || this.documentsResource.error()
    ) {
      return 'error';
    }
    if (!this.runtime.ready()) return 'starting';
    const requirementsStatus = this.requirementsResource.status();
    const modelStatus = this.modelOptionsResource.status();
    if (
      requirementsStatus === 'idle' || requirementsStatus === 'loading' || requirementsStatus === 'reloading'
      || modelStatus === 'idle' || modelStatus === 'loading' || modelStatus === 'reloading'
    ) {
      return 'starting';
    }
    return this.coreMissing().length === 0 && !this.modelSelectionRequired() ? 'ready' : 'needs-setup';
  });

  readonly canCapture = computed(() => this.state() === 'ready' && !this.installing());
  readonly coreMissing = computed(() =>
    this.requirements().filter(
      (requirement) =>
        (CORE_REQUIREMENTS.has(requirement.requirementId)
          || this.requestedRequirements().has(requirement.requirementId))
        && requirement.status !== 'ready',
    ),
  );
  readonly installableCoreRequirements = computed(() =>
    this.coreMissing()
      .filter((requirement) => requirement.status === 'installable')
      .slice()
      .sort(
        (left, right) =>
          (INSTALLATION_ORDER.get(left.requirementId) ?? Number.MAX_SAFE_INTEGER)
          - (INSTALLATION_ORDER.get(right.requirementId) ?? Number.MAX_SAFE_INTEGER),
      ),
  );
  readonly modelSelectionRequired = computed(
    () => this.modelOptions().length > 0 && !this.modelOptions().some((option) => option.status === 'active'),
  );
  readonly activeModelOption = computed(
    () => this.modelOptions().find((option) => option.status === 'active') ?? null,
  );

  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly activeCaptures = new Map<string, ActiveCapture>();
  private dropListenerStarted = false;

  private readonly requirementsResource = rxResource<
    readonly RuntimeRequirement[],
    { readonly ready: true } | undefined
  >({
    defaultValue: [],
    params: () => this.runtime.ready() ? { ready: true } : undefined,
    stream: ({ abortSignal }) => this.runtime.getRequirements(abortSignal),
  });

  private readonly modelOptionsResource = rxResource<
    readonly RuntimeModelOption[],
    { readonly ready: true } | undefined
  >({
    defaultValue: [],
    params: () => this.runtime.ready() ? { ready: true } : undefined,
    stream: ({ abortSignal }) => this.runtime.getModelOptions(abortSignal),
  });

  private readonly documentsResource = rxResource<
    readonly DesktopLibrarySummary[],
    { readonly query: string; readonly status: string } | undefined
  >({
    defaultValue: [],
    params: () => this.runtime.ready()
      ? { query: this.query(), status: this.statusFilter() }
      : undefined,
    stream: ({ params, abortSignal }) => this.library.list(params.query, params.status, abortSignal),
  });

  private readonly selectedResource = rxResource<
    DesktopLibraryDetail | null,
    { readonly documentId: string } | undefined
  >({
    defaultValue: null,
    params: () => {
      const documentId = this.selectedId();
      return this.runtime.ready() && documentId ? { documentId } : undefined;
    },
    stream: ({ params, abortSignal }) => this.library.get(params.documentId, abortSignal),
  });

  private readonly resourceErrorEffect = effect(() => {
    const error = this.runtime.error()
      ?? this.requirementsResource.error()
      ?? this.modelOptionsResource.error()
      ?? this.documentsResource.error()
      ?? this.selectedResource.error();
    if (error) this.message.set(errorMessage(error));
  });

  private readonly stateMessageEffect = effect(() => {
    const state = this.state();
    if (state === 'ready') {
      this.message.set('Capture Runtime 已準備完成，可以開始處理文件。');
    } else if (state === 'needs-setup') {
      this.message.set('請先安裝缺少的本機處理需求。');
    }
  });

  initialize(): void {
    if (!this.dropListenerStarted) {
      this.dropListenerStarted = true;
      this.library
        .droppedSources()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (paths) => this.addSourcePaths(paths),
          error: (error: unknown) => this.message.set(errorMessage(error)),
        });
    }
    this.runtime.reload();
    this.requirementsResource.reload();
    this.modelOptionsResource.reload();
    this.documentsResource.reload();
  }

  refreshDocuments(): void {
    this.documentsResource.reload();
  }

  select(documentId: string): void {
    this.selectedId.set(documentId);
    this.selectedResource.reload();
  }

  updateQuery(query: string): void {
    this.query.set(query);
  }

  updateStatusFilter(status: string): void {
    this.statusFilter.set(status);
  }

  installCoreRequirements(): void {
    if (!this.runtime.ready() || this.installing()) return;
    const installable = this.installableCoreRequirements();
    if (installable.length === 0) return;
    this.installing.set(true);
    from(installable).pipe(
      concatMap((requirement) => this.installRequirement$(requirement)),
      finalize(() => {
        this.installing.set(false);
        this.activeInstallation.set(null);
      }),
    ).subscribe({
      complete: () => {
        this.requirementsResource.reload();
        this.message.set('安裝流程已完成，正在重新檢查 Runtime 需求。');
      },
      error: (error: unknown) => {
        this.message.set(errorMessage(error));
      },
    });
  }

  get modelOptions() {
    return this.modelOptionsResource.value;
  }

  selectModelOption(optionId: string): void {
    if (this.installing()) return;
    this.selectedModelOptionId.set(optionId);
    this.activeModelInstallation.set(null);
  }

  installSelectedModel(): void {
    const optionId = this.selectedModelOptionId();
    if (!this.runtime.ready() || this.installing() || !optionId) return;
    this.activeModelInstallation.set(null);
    this.installing.set(true);
    this.runtime.startModelInstallation({
      clientRequestId: crypto.randomUUID(),
      optionId,
      consent: true,
    }).pipe(
      expand((installation) => {
        if (installation.status !== 'queued' && installation.status !== 'running') return EMPTY;
        return timer(750).pipe(
          switchMap(() => this.runtime.getModelInstallation(installation.installationId)),
        );
      }),
      tap((installation) => this.activeModelInstallation.set(installation)),
      filter((installation) => installation.status !== 'queued' && installation.status !== 'running'),
      take(1),
      switchMap((installation) => installation.status === 'completed'
        ? of(installation)
        : throwError(() => new Error(
          `Runtime model installation ended ${installation.status}${installation.error?.code ? ` (${installation.error.code})` : ''}.`,
        ))),
      finalize(() => {
        this.installing.set(false);
        this.modelOptionsResource.reload();
        this.requirementsResource.reload();
      }),
    ).subscribe({
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  chooseSources(): void {
    if (!this.runtime.ready() || !this.canCapture()) return;
    this.library.selectSources().subscribe({
      next: (paths) => this.addSourcePaths(paths),
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  addSourcePaths(paths: readonly string[]): void {
    if (!this.runtime.ready() || !this.canCapture()) return;
    from(paths).pipe(
      concatMap((sourcePath) => this.captureNewSource$(sourcePath)),
    ).subscribe({
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  retry(documentId: string): void {
    if (!this.canCapture()) return;
    const document = this.documents().find((item) => item.documentId === documentId)
      ?? (this.selected()?.documentId === documentId ? this.selected() : undefined);
    const operation = document?.captureId
      ? this.recoverCapture$(document)
      : this.captureExisting$(documentId);
    operation.subscribe({
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  cancel(documentId: string): void {
    const active = this.activeCaptures.get(documentId);
    if (active && !active.cancelRequested) {
      active.cancelRequested = true;
      active.cancelWake.next();
    }
  }

  delete(documentId: string): void {
    if (this.activeCaptures.has(documentId) || this.busyIds().has(documentId)) {
      this.message.set('請先取消處理，再刪除文件。');
      return;
    }
    const document = this.documents().find(
      (candidate) => candidate.documentId === documentId,
    ) ??
      (this.selected()?.documentId === documentId
        ? this.selected()
        : undefined);
    if (document?.captureId) {
      this.message.set('請先完成 Runtime 清理，再刪除文件。');
      return;
    }
    if (!globalThis.confirm('確定要刪除這份文件嗎？')) return;
    this.library.delete(documentId).subscribe({
      next: () => {
        if (this.selectedId() === documentId) {
          this.selectedId.set(null);
          this.selectedResource.set(null);
        }
        this.refreshDocuments();
      },
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  export(documentId: string, format: 'json' | 'text'): void {
    this.library.export(documentId, format).subscribe({
      next: (exported) => {
        const blob = new Blob([exported.content], { type: exported.mediaType });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = exported.fileName;
        anchor.click();
        URL.revokeObjectURL(url);
      },
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  formatBytes(bytes: number): string {
    return bytes < 1_000_000 ? `${Math.ceil(bytes / 1_000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
  }

  formatDate(milliseconds: number): string {
    return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(milliseconds);
  }

  stageLabel(stage?: string): string {
    return ({
      uploading: '正在上傳來源',
      queued: '排隊等待處理',
      extracting: '正在執行 OCR',
      awaiting_structuring: '等待結構化',
      structuring: '正在使用 Ollama 結構化',
      persisting: '正在保存結果',
      recovery_required: '需要復原',
      completed: '已完成',
      failed: '處理失敗',
      cancelled: '已取消',
    } as Record<string, string>)[stage ?? ''] ?? '排隊等待處理';
  }

  statusLabel(status: DesktopLibrarySummary['status']): string {
    return ({
      queued: '排隊等待處理',
      processing: '處理中',
      persisting: '正在保存',
      recovery_required: '需要復原',
      awaiting_confirmation: '等待確認',
      completed: '已完成',
      failed: '處理失敗',
      canceled: '已取消',
    } as Record<DesktopLibrarySummary['status'], string>)[status];
  }

  private isAudioDocument(documentId: string): boolean {
    const document = this.documents().find((item) => item.documentId === documentId)
      ?? (this.selected()?.documentId === documentId ? this.selected() : undefined);
    return document?.mediaType.startsWith('audio/') ?? false;
  }

  private applyStreamingEvent(
    _documentId: string,
    active: ActiveCapture,
    event: CaptureEvent,
  ): void {
    active.lastEventSequence = Math.max(active.lastEventSequence, event.sequence);
    active.lastStage = event.stage;
  }

  private captureNewSource$(sourcePath: string): Observable<void> {
    return this.library.createSource(sourcePath).pipe(
      tap((document) => {
        this.selectedId.set(document.documentId);
        this.refreshDocuments();
      }),
      switchMap((document) => {
        if (document.mediaType.startsWith('audio/') && !this.audioReady()) {
          this.requestedRequirements.update(
            (current) => new Set([...current, 'whisper-primary']),
          );
          this.message.set('音訊來源需要先安裝 Whisper。');
          return EMPTY;
        }
        return this.captureExisting$(document.documentId);
      }),
      catchError((error) => {
        this.message.set(errorMessage(error));
        return EMPTY;
      }),
    );
  }

  private captureExisting$(documentId: string): Observable<void> {
    return defer(() => {
      if (!this.runtime.ready() || this.activeCaptures.has(documentId)) return EMPTY;
      const active: ActiveCapture = {
        streaming: this.isAudioDocument(documentId),
        lastEventSequence: 0,
        rawPersisted: false,
        cancelRequested: false,
        cancelSent: false,
        cancelWake: new Subject<void>(),
      };
      this.activeCaptures.set(documentId, active);
      this.markBusy(documentId, true);

      const work$ = this.library.updateCapture({
        documentId,
        status: 'processing',
        stage: 'uploading',
        clearCaptureId: true,
      }).pipe(
        tap(() => this.reloadDocumentState(documentId)),
        switchMap(() => active.streaming
          ? this.captureStreaming$(documentId, active)
          : this.captureOneShot$(documentId, active)),
      );

      return this.trackCaptureLifecycle$(documentId, active, work$);
    });
  }

  private captureOneShot$(documentId: string, active: ActiveCapture): Observable<void> {
    return this.runtime.createCapture(documentId, crypto.randomUUID()).pipe(
      switchMap((job) => {
        active.captureId = job.captureId;
        active.lastStage = job.stage;
        return this.library.updateCapture({
          documentId,
          captureId: job.captureId,
          status: 'processing',
          stage: job.stage,
        }).pipe(
          tap(() => this.reloadDocumentState(documentId)),
          map(() => job),
        );
      }),
      switchMap((job) => this.waitForTerminal$(documentId, job, active)),
      switchMap((job) => this.persistTerminal$(documentId, job, active)),
      map(() => undefined),
    );
  }

  private captureStreaming$(documentId: string, active: ActiveCapture): Observable<void> {
    return this.runtime.startStreamingCapture({
      documentId,
      clientRequestId: crypto.randomUUID(),
      structuringMode: 'runtime',
    }).pipe(
      switchMap((operation) => {
        active.captureId = operation.captureId;
        active.lastStage = operation.status;
        return this.library.updateCapture({
          documentId,
          captureId: operation.captureId,
          status: 'processing',
          stage: operation.status,
        }).pipe(
          tap(() => this.reloadDocumentState(documentId)),
          map(() => operation),
        );
      }),
      switchMap((operation) => this.waitForStreamingTerminal$(documentId, operation, active)),
      switchMap((operation) => this.persistStreamingTerminal$(documentId, operation, active)),
    );
  }

  private waitForStreamingTerminal$(
    documentId: string,
    initial: CaptureOperation,
    active: ActiveCapture,
  ): Observable<CaptureOperation> {
    return of(initial).pipe(
      switchMap((operation) => this.advanceStreaming$(documentId, operation, active)),
      expand((operation) => isActiveStreaming(operation)
        ? timer(500).pipe(switchMap(() => this.advanceStreaming$(documentId, operation, active)))
        : EMPTY),
      filter((operation) => !isActiveStreaming(operation)),
      take(1),
    );
  }

  private advanceStreaming$(
    documentId: string,
    operation: CaptureOperation,
    active: ActiveCapture,
  ): Observable<CaptureOperation> {
    const events$ = this.runtime.getStreamingEvents(
      operation.captureId,
      active.lastEventSequence,
    ).pipe(
      tap((events) => events.forEach((event) => this.applyStreamingEvent(documentId, active, event))),
      switchMap(() => this.runtime.getStreamingPartial(operation.captureId)),
      tap((partial) => {
        if (partial) {
          this.streamingPartials.update((current) => {
            const next = new Map(current);
            next.set(documentId, partial);
            return next;
          });
        }
      }),
    );
    if (!active.cancelRequested || active.cancelSent) {
      return events$.pipe(switchMap(() => this.runtime.getStreamingCapture(operation.captureId)));
    }
    active.cancelSent = true;
    return this.runtime.cancelStreamingCapture(operation.captureId).pipe(
      switchMap(() => events$),
      switchMap(() => this.runtime.getStreamingCapture(operation.captureId)),
    );
  }

  private persistStreamingTerminal$(
    documentId: string,
    operation: CaptureOperation,
    active: ActiveCapture,
  ): Observable<void> {
    active.terminalStatus = operation.status === 'completed' ? 'completed'
      : operation.status === 'cancelled' ? 'canceled' : 'failed';
    active.terminalErrorCode = operation.error?.code;
    active.terminalErrorMessage = operation.error?.message;
    const terminalData$: Observable<StreamingTerminalResultV2 | null> = operation.status === 'completed'
      ? this.runtime.getStreamingResult(operation.captureId)
      : of(null);
    return terminalData$.pipe(
      switchMap((terminalData) => this.library.updateCapture({
        documentId,
        captureId: operation.captureId,
        status: active.terminalStatus ?? 'failed',
        stage: operation.status,
        errorCode: operation.error?.code,
        errorMessage: operation.error?.message,
        ...(terminalData
          ? { raw: terminalData.raw, result: terminalData.result }
          : {}),
      })),
      tap(() => {
        active.terminalCommitted = true;
        this.reloadDocumentState(documentId);
      }),
      switchMap(() => this.runtime.deleteStreamingCapture(operation.captureId)),
      switchMap(() => this.library.updateCapture({
        documentId,
        status: active.terminalStatus ?? 'failed',
        stage: operation.status,
        clearCaptureId: true,
        errorCode: operation.error?.code,
        errorMessage: operation.error?.message,
      })),
      tap(() => this.clearStreamingPartial(documentId)),
      map(() => undefined),
    );
  }

  private recoverCapture$(document: DesktopLibrarySummary): Observable<void> {
    return defer(() => {
      if (
        !this.runtime.ready()
        || !document.captureId
        || this.activeCaptures.has(document.documentId)
      ) {
        return EMPTY;
      }
      const terminalCommitted = hasCommittedTerminalData(document);
      const active: ActiveCapture = {
        captureId: document.captureId,
        streaming: document.mediaType.startsWith('audio/'),
        lastEventSequence: 0,
        rawPersisted: false,
        cancelRequested: false,
        cancelSent: false,
        lastStage: document.stage,
        terminalCommitted,
        terminalStatus: terminalCommitted ? committedTerminalStatus(document) : undefined,
        terminalErrorCode: terminalCommitted ? document.errorCode : undefined,
        terminalErrorMessage: terminalCommitted ? document.errorMessage : undefined,
        cancelWake: new Subject<void>(),
      };
      this.activeCaptures.set(document.documentId, active);
      this.markBusy(document.documentId, true);

      const work$ = terminalCommitted
        ? this.retryRuntimeCleanup$(document)
        : active.streaming
          ? this.runtime.getStreamingCapture(document.captureId).pipe(
            tap((operation) => active.lastStage = operation.status),
            switchMap((operation) => this.waitForStreamingTerminal$(
              document.documentId,
              operation,
              active,
            )),
            switchMap((operation) => this.persistStreamingTerminal$(
              document.documentId,
              operation,
              active,
            )),
          )
          : this.runtime.getCapture(document.captureId).pipe(
            tap((job) => active.lastStage = job.stage),
            switchMap((job) => this.waitForTerminal$(document.documentId, job, active)),
            switchMap((job) => this.persistTerminal$(document.documentId, job, active)),
          );
      return this.trackCaptureLifecycle$(document.documentId, active, work$);
    });
  }

  private trackCaptureLifecycle$(
    documentId: string,
    active: ActiveCapture,
    work$: Observable<unknown>,
  ): Observable<void> {
    return work$.pipe(
      tap(() => this.reloadDocumentState(documentId)),
      catchError((error) => this.persistLifecycleFailure$(documentId, active, error).pipe(
        tap(() => this.reloadDocumentState(documentId)),
        catchError((failureError) => {
          this.message.set(errorMessage(failureError));
          return EMPTY;
        }),
      )),
      finalize(() => {
        active.cancelWake.complete();
        this.activeCaptures.delete(documentId);
        this.markBusy(documentId, false);
      }),
      map(() => undefined),
    );
  }

  private waitForTerminal$(
    documentId: string,
    initial: DesktopCaptureOperation,
    active: ActiveCapture,
  ): Observable<DesktopCaptureOperation> {
    return of(initial).pipe(
      switchMap((job) => this.persistRawDuringExtraction$(documentId, job, active)),
      tap((job) => active.lastStage = job.stage),
      expand((job) => {
        if (!isActiveJob(job)) return EMPTY;
        return this.advanceCapture$(documentId, job, active);
      }),
      filter((job) => !isActiveJob(job)),
      take(1),
    );
  }

  private advanceCapture$(
    documentId: string,
    job: DesktopCaptureOperation,
    active: ActiveCapture,
  ): Observable<DesktopCaptureOperation> {
    return this.library.updateCapture({
      documentId,
      captureId: job.captureId,
      status: 'processing',
      stage: job.stage,
    }).pipe(
      switchMap(() => {
        if (active.cancelRequested && !active.cancelSent) {
          return this.sendCancellation$(job.captureId, active);
        }
        return race(
          timer(700).pipe(
            switchMap(() => this.runtime.getCapture(job.captureId)),
          ),
          active.cancelWake.pipe(
            take(1),
            switchMap(() => this.sendCancellation$(job.captureId, active)),
          ),
        );
      }),
      switchMap((next) => this.persistRawDuringExtraction$(documentId, next, active)),
      tap((next) => active.lastStage = next.stage),
    );
  }

  private persistRawDuringExtraction$(
    documentId: string,
    job: DesktopCaptureOperation,
    active: ActiveCapture,
  ): Observable<DesktopCaptureOperation> {
    if (
      active.rawPersisted
      || (job.stage !== 'structuring' && job.stage !== 'awaiting_structuring')
    ) {
      return of(job);
    }
    return this.runtime.getRaw(job.captureId).pipe(
      switchMap((raw) => {
        if (!raw) return of(job);
        return this.library.updateCapture({
          documentId,
          captureId: job.captureId,
          status: 'processing',
          stage: job.stage,
          raw,
        }).pipe(
          tap(() => {
            active.rawPersisted = true;
            this.reloadDocumentState(documentId);
          }),
          map(() => job),
        );
      }),
    );
  }

  private sendCancellation$(
    captureId: string,
    active: ActiveCapture,
  ): Observable<DesktopCaptureOperation> {
    active.cancelSent = true;
    return this.runtime.cancelCapture(captureId);
  }

  private persistTerminal$(
    documentId: string,
    job: DesktopCaptureOperation,
    active: ActiveCapture,
  ) {
    return this.library.updateCapture({
      documentId,
      captureId: job.captureId,
      status: 'persisting',
      stage: job.stage,
    }).pipe(
      switchMap(() => this.persistTerminalData$(documentId, job, active)),
      tap(() => {
        active.terminalCommitted = true;
        active.terminalStatus = terminalLibraryStatus(job);
        active.terminalErrorCode = job.error?.code;
        active.terminalErrorMessage = job.error?.message;
      }),
      switchMap(() => this.cleanupAfterCommit$(documentId, job)),
    );
  }

  private persistTerminalData$(documentId: string, job: DesktopCaptureOperation, active: ActiveCapture) {
    if (job.status === 'completed') {
      if (active.rawPersisted) {
        return this.runtime.getResult(job.captureId).pipe(
          switchMap((result) => this.library.updateCapture({
            documentId,
            captureId: job.captureId,
            status: 'completed' as const,
            stage: job.stage,
            result,
          })),
        );
      }
      return this.runtime.getRaw(job.captureId).pipe(
        switchMap((raw) => {
          if (!raw) {
            return throwError(() => new Error('Capture Runtime 未提供已完成工作的原始結果。'));
          }
          return this.runtime.getResult(job.captureId).pipe(
            switchMap((result) => {
              const update = {
                documentId,
                captureId: job.captureId,
                status: 'completed' as const,
                stage: job.stage,
                result,
                ...(active.rawPersisted ? {} : { raw }),
              };
              return this.library.updateCapture(update).pipe(
                tap(() => {
                  if (!active.rawPersisted) active.rawPersisted = true;
                }),
              );
            }),
          );
        }),
      );
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      if (active.rawPersisted) {
        return this.library.updateCapture({
          documentId,
          captureId: job.captureId,
          status: terminalLibraryStatus(job),
          stage: job.stage,
          errorCode: job.error?.code,
          errorMessage: job.error?.message,
        });
      }
      return this.runtime.getRaw(job.captureId).pipe(
        switchMap((raw) => {
          const update = {
            documentId,
            captureId: job.captureId,
            status: terminalLibraryStatus(job),
            stage: job.stage,
            errorCode: job.error?.code,
            errorMessage: job.error?.message,
            ...(active.rawPersisted || !raw ? {} : { raw }),
          };
          return this.library.updateCapture(update).pipe(
            tap(() => {
              if (raw) active.rawPersisted = true;
            }),
          );
        }),
      );
    }
    return throwError(() => new Error(`Capture Runtime returned unsupported terminal status: ${job.status}`));
  }

  private cleanupAfterCommit$(documentId: string, job: DesktopCaptureOperation) {
    const terminalStatus = terminalLibraryStatus(job);
    return this.runtime.deleteCapture(job.captureId).pipe(
      switchMap(() => this.library.updateCapture({
        documentId,
        status: terminalStatus,
        stage: job.stage,
        clearCaptureId: true,
        errorCode: job.error?.code,
        errorMessage: job.error?.message,
      })),
      catchError((error) => this.library.updateCapture({
        documentId,
        captureId: job.captureId,
        status: 'recovery_required',
        stage: job.stage,
        errorCode: job.error?.code,
        errorMessage: job.error?.message,
        recoveryCode: 'runtime_cleanup_failed',
        recoveryMessage: errorMessage(error),
      })),
    );
  }

  private retryRuntimeCleanup$(document: DesktopLibrarySummary) {
    const captureId = document.captureId;
    if (!captureId) return EMPTY;
    const delete$ = document.mediaType.startsWith('audio/')
      ? this.runtime.deleteStreamingCapture(captureId)
      : this.runtime.deleteCapture(captureId);
    return delete$.pipe(
      switchMap(() => this.library.updateCapture({
        documentId: document.documentId,
        status: committedTerminalStatus(document),
        stage: document.stage,
        clearCaptureId: true,
        errorCode: document.errorCode,
        errorMessage: document.errorMessage,
      })),
      catchError((error) => this.library.updateCapture({
        documentId: document.documentId,
        captureId,
        status: 'recovery_required',
        stage: document.stage,
        errorCode: document.errorCode,
        errorMessage: document.errorMessage,
        recoveryCode: 'runtime_cleanup_failed',
        recoveryMessage: errorMessage(error),
      })),
    );
  }

  private persistLifecycleFailure$(
    documentId: string,
    active: ActiveCapture,
    error: unknown,
  ) {
    if (active.captureId) {
      if (active.terminalCommitted) {
        return this.library.updateCapture({
          documentId,
          captureId: active.captureId,
          status: 'recovery_required',
          stage: active.lastStage ?? terminalStage(active.terminalStatus),
          errorCode: active.terminalErrorCode,
          errorMessage: active.terminalErrorMessage,
          recoveryCode: 'runtime_cleanup_failed',
          recoveryMessage: errorMessage(error),
        });
      }
      return this.library.updateCapture({
        documentId,
        captureId: active.captureId,
        status: 'recovery_required',
        stage: active.lastStage ?? 'recovery_required',
        recoveryCode: active.cancelSent ? 'cancel_failed' : 'capture_recovery_required',
        recoveryMessage: errorMessage(error),
      });
    }
    return this.library.updateCapture({
      documentId,
      status: 'failed',
      stage: 'failed',
      clearCaptureId: true,
      errorCode: 'capture_failed',
      errorMessage: errorMessage(error),
    });
  }

  private installRequirement$(requirement: RuntimeRequirement): Observable<RuntimeInstallation> {
    if (requirement.status === 'manual_action_required') {
      return throwError(() => new Error(
        `${requirement.displayName} 需要手動處理：${requirement.detail ?? '請完成安裝後再試。'}`,
      ));
    }
    return this.runtime.startInstallation({
      clientRequestId: crypto.randomUUID(),
      requirementId: requirement.requirementId,
      consent: true,
    }).pipe(
      expand((installation) => {
        if (installation.status !== 'queued' && installation.status !== 'running') return EMPTY;
        return timer(750).pipe(
          switchMap(() => this.runtime.getInstallation(installation.installationId)),
        );
      }),
      tap((installation) => this.activeInstallation.set(installation)),
      filter(
        (installation) => installation.status !== 'queued' && installation.status !== 'running',
      ),
      take(1),
      map((installation) => {
        if (installation.status !== 'completed') {
          throw new Error(errorMessage(
            installation.error?.message ?? `${requirement.requirementId} 安裝失敗。`,
          ));
        }
        return installation;
      }),
    );
  }

  private audioReady(): boolean {
    return this.requirements().some(
      (requirement) => requirement.requirementId === 'whisper-primary' && requirement.status === 'ready',
    );
  }

  private reloadDocumentState(documentId: string): void {
    this.documentsResource.reload();
    if (this.selectedId() === documentId) this.selectedResource.reload();
  }

  private markBusy(documentId: string, busy: boolean): void {
    this.busyIds.update((current) => {
      const next = new Set(current);
      if (busy) next.add(documentId); else next.delete(documentId);
      return next;
    });
  }

  private clearStreamingPartial(documentId: string): void {
    this.streamingPartials.update((current) => {
      if (!current.has(documentId)) return current;
      const next = new Map(current);
      next.delete(documentId);
      return next;
    });
  }
}

function isActiveJob(job: DesktopCaptureOperation): boolean {
  return job.status === 'queued' || job.status === 'running';
}

function isActiveStreaming(operation: CaptureOperation): boolean {
  return operation.status === 'created'
    || operation.status === 'waiting_input'
    || operation.status === 'extracting'
    || operation.status === 'awaiting_structuring'
    || operation.status === 'structuring';
}

function terminalLibraryStatus(job: DesktopCaptureOperation): DesktopLibraryStatus {
  if (job.status === 'completed') return 'completed';
  if (job.status === 'cancelled') return 'canceled';
  return 'failed';
}

function terminalStatusFromStage(stage?: string): DesktopLibraryStatus {
  if (stage === 'cancelled') return 'canceled';
  if (stage === 'failed') return 'failed';
  return 'completed';
}

function hasCommittedTerminalData(document: DesktopLibrarySummary): boolean {
  return document.recoveryCode === 'runtime_cleanup_failed'
    || document.status === 'completed'
    || document.status === 'failed'
    || document.status === 'canceled';
}

function committedTerminalStatus(document: DesktopLibrarySummary): DesktopLibraryStatus {
  return document.status === 'completed'
    || document.status === 'failed'
    || document.status === 'canceled'
    ? document.status
    : terminalStatusFromStage(document.stage);
}

function terminalStage(status?: DesktopLibraryStatus): string {
  if (status === 'canceled') return 'cancelled';
  if (status === 'failed') return 'failed';
  return 'completed';
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveMessage(message);
}

function redactSensitiveMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /(?:authorization|bearerToken|access_token|token)\s*[:=]\s*["']?[^"'\s,;}]+/giu,
      (match) => `${match.slice(0, match.search(/[:=]/u) + 1)} [redacted]`,
    );
}
