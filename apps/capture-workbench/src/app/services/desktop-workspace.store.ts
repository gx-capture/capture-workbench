import { computed, effect, Injectable, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
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
  takeWhile,
  tap,
  throwError,
  timer,
} from 'rxjs';
import {
  type CaptureJobV1,
  type CaptureRequirementId,
  type RuntimeInstallationV1,
  type RuntimeRequirementV1,
} from '@gx-capture/capture-workbench';
import type {
  DesktopLibraryDetail,
  DesktopLibraryStatus,
  DesktopLibrarySummary,
} from '../contracts';
import {
  desktopSourceKind,
  DesktopLibraryService,
} from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';

type WorkspaceState = 'starting' | 'needs-setup' | 'ready' | 'error';

interface ActiveCapture {
  captureId?: string;
  cancelRequested: boolean;
  cancelSent: boolean;
  lastStage?: string;
  readonly cancelWake: Subject<void>;
}

const CORE_REQUIREMENTS = new Set<CaptureRequirementId>([
  'windowsml-ocr',
  'ollama-runtime',
  'capture-ollama-model',
]);

@Injectable({ providedIn: 'root' })
export class DesktopWorkspaceStore {
  readonly message = signal('正在連線到 Capture Runtime…');
  readonly selectedId = signal<string | null>(null);
  readonly query = signal('');
  readonly statusFilter = signal('');
  readonly installing = signal(false);
  readonly activeInstallation = signal<RuntimeInstallationV1 | null>(null);
  readonly busyIds = signal<ReadonlySet<string>>(new Set());
  readonly requestedRequirements = signal<ReadonlySet<CaptureRequirementId>>(new Set());

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
      || this.documentsResource.error()
    ) {
      return 'error';
    }
    if (!this.runtime.ready()) return 'starting';
    const requirementsStatus = this.requirementsResource.status();
    if (requirementsStatus === 'idle' || requirementsStatus === 'loading' || requirementsStatus === 'reloading') {
      return 'starting';
    }
    return this.coreMissing().length === 0 ? 'ready' : 'needs-setup';
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

  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly activeCaptures = new Map<string, ActiveCapture>();

  private readonly requirementsResource = rxResource<
    readonly RuntimeRequirementV1[],
    { readonly ready: true } | undefined
  >({
    defaultValue: [],
    params: () => this.runtime.ready() ? { ready: true } : undefined,
    stream: ({ abortSignal }) => this.runtime.getRequirements(abortSignal),
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
    this.runtime.reload();
    this.requirementsResource.reload();
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
    this.installing.set(true);
    from(this.coreMissing()).pipe(
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

  addFiles(files: FileList | readonly File[]): void {
    if (!this.runtime.ready() || !this.canCapture()) return;
    from(Array.from(files)).pipe(
      concatMap((file) => this.prepareFile$(file)),
    ).subscribe({
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  retry(documentId: string): void {
    if (!this.canCapture()) return;
    const document = this.documents().find((item) => item.documentId === documentId)
      ?? (this.selected()?.documentId === documentId ? this.selected() : undefined);
    const operation = document?.status === 'recovery_required' && document.captureId
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

  private prepareFile$(file: File): Observable<void> {
    let sourceKind: ReturnType<typeof desktopSourceKind>;
    try {
      sourceKind = desktopSourceKind(file);
    } catch (error) {
      this.message.set(errorMessage(error));
      return EMPTY;
    }
    if (sourceKind === 'audio' && !this.audioReady()) {
      this.requestedRequirements.update((current) => new Set([...current, 'whisper-primary']));
      this.message.set('音訊來源需要先安裝 Whisper。');
      return EMPTY;
    }
    return this.captureNewFile$(file);
  }

  private captureNewFile$(file: File): Observable<void> {
    return this.library.createSource(file).pipe(
      tap((document) => {
        this.selectedId.set(document.documentId);
        this.refreshDocuments();
      }),
      switchMap((document) => this.captureExisting$(document.documentId)),
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
        switchMap(() => this.runtime.createCapture(documentId, crypto.randomUUID())),
        switchMap((job) => {
          active.captureId = job.captureId;
          active.lastStage = job.stage;
          return this.library.updateCapture({
            documentId,
            captureId: job.captureId,
            status: 'processing',
            stage: job.stage,
          }).pipe(map(() => job));
        }),
        switchMap((job) => this.waitForTerminal$(documentId, job, active)),
        switchMap((job) => this.persistTerminal$(documentId, job)),
      );

      return this.trackCaptureLifecycle$(documentId, active, work$);
    });
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
      const active: ActiveCapture = {
        captureId: document.captureId,
        cancelRequested: false,
        cancelSent: false,
        lastStage: document.stage,
        cancelWake: new Subject<void>(),
      };
      this.activeCaptures.set(document.documentId, active);
      this.markBusy(document.documentId, true);

      const work$ = document.errorCode === 'runtime_cleanup_failed'
        ? this.retryRuntimeCleanup$(document)
        : this.runtime.getCapture(document.captureId).pipe(
          tap((job) => active.lastStage = job.stage),
          switchMap((job) => this.waitForTerminal$(document.documentId, job, active)),
          switchMap((job) => this.persistTerminal$(document.documentId, job)),
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
    initial: CaptureJobV1,
    active: ActiveCapture,
  ): Observable<CaptureJobV1> {
    return of(initial).pipe(
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
    job: CaptureJobV1,
    active: ActiveCapture,
  ): Observable<CaptureJobV1> {
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
      tap((next) => active.lastStage = next.stage),
    );
  }

  private sendCancellation$(
    captureId: string,
    active: ActiveCapture,
  ): Observable<CaptureJobV1> {
    active.cancelSent = true;
    return this.runtime.cancelCapture(captureId);
  }

  private persistTerminal$(documentId: string, job: CaptureJobV1) {
    return this.library.updateCapture({
      documentId,
      captureId: job.captureId,
      status: 'persisting',
      stage: job.stage,
    }).pipe(
      switchMap(() => this.persistTerminalData$(documentId, job)),
      switchMap(() => this.cleanupAfterCommit$(documentId, job)),
    );
  }

  private persistTerminalData$(documentId: string, job: CaptureJobV1) {
    if (job.status === 'completed') {
      return this.runtime.getRaw(job.captureId).pipe(
        switchMap((raw) => {
          if (!raw) {
            return throwError(() => new Error('Capture Runtime 未提供已完成工作的原始結果。'));
          }
          return this.runtime.getResult(job.captureId).pipe(
            switchMap((result) => this.library.updateCapture({
              documentId,
              captureId: job.captureId,
              status: 'completed',
              stage: job.stage,
              raw,
              result,
            })),
          );
        }),
      );
    }
    if (job.status === 'failed') {
      return this.runtime.getRaw(job.captureId).pipe(
        switchMap((raw) => this.library.updateCapture({
          documentId,
          captureId: job.captureId,
          status: 'failed',
          stage: job.stage,
          raw: raw ?? undefined,
          errorCode: job.error?.code,
          errorMessage: job.error?.message,
        })),
      );
    }
    return this.library.updateCapture({
      documentId,
      captureId: job.captureId,
      status: 'canceled',
      stage: job.stage,
      errorCode: job.error?.code,
      errorMessage: job.error?.message,
    });
  }

  private cleanupAfterCommit$(documentId: string, job: CaptureJobV1) {
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
        errorCode: 'runtime_cleanup_failed',
        errorMessage: errorMessage(error),
      })),
    );
  }

  private retryRuntimeCleanup$(document: DesktopLibrarySummary) {
    const captureId = document.captureId;
    if (!captureId) return EMPTY;
    return this.runtime.deleteCapture(captureId).pipe(
      switchMap(() => this.library.updateCapture({
        documentId: document.documentId,
        status: terminalStatusFromStage(document.stage),
        stage: document.stage,
        clearCaptureId: true,
      })),
      catchError((error) => this.library.updateCapture({
        documentId: document.documentId,
        captureId,
        status: 'recovery_required',
        stage: document.stage,
        errorCode: 'runtime_cleanup_failed',
        errorMessage: errorMessage(error),
      })),
    );
  }

  private persistLifecycleFailure$(
    documentId: string,
    active: ActiveCapture,
    error: unknown,
  ) {
    if (active.captureId) {
      return this.library.updateCapture({
        documentId,
        captureId: active.captureId,
        status: 'recovery_required',
        stage: active.lastStage ?? 'recovery_required',
        errorCode: active.cancelSent ? 'cancel_failed' : 'capture_recovery_required',
        errorMessage: errorMessage(error),
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

  private installRequirement$(requirement: RuntimeRequirementV1): Observable<RuntimeInstallationV1> {
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
      takeWhile(
        (installation) => installation.status === 'queued' || installation.status === 'running',
        true,
      ),
      tap((installation) => this.activeInstallation.set(installation)),
      map((installation) => {
        if (installation.status !== 'completed') {
          throw new Error(installation.error?.message ?? `${requirement.requirementId} 安裝失敗。`);
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
}

function isActiveJob(job: CaptureJobV1): boolean {
  return job.status === 'queued' || job.status === 'running';
}

function terminalLibraryStatus(job: CaptureJobV1): DesktopLibraryStatus {
  if (job.status === 'completed') return 'completed';
  if (job.status === 'cancelled') return 'canceled';
  return 'failed';
}

function terminalStatusFromStage(stage?: string): DesktopLibraryStatus {
  if (stage === 'cancelled') return 'canceled';
  if (stage === 'failed') return 'failed';
  return 'completed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
