import { computed, effect, Injectable, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  catchError,
  concatMap,
  concatWith,
  defer,
  expand,
  finalize,
  from,
  ignoreElements,
  map,
  type Observable,
  of,
  switchMap,
  takeWhile,
  tap,
  throwError,
  timer,
} from 'rxjs';
import {
  type CaptureJobV1,
  type CaptureRequirementId,
  type CaptureSourceKind,
  type RuntimeInstallationV1,
  type RuntimeRequirementV1,
} from '@gx-capture/capture-workbench';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';

type WorkspaceState = 'starting' | 'needs-setup' | 'ready' | 'error';

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
  private readonly controllers = new Map<string, AbortController>();

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
    this.captureExisting$(documentId).subscribe({
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  cancel(documentId: string): void {
    this.controllers.get(documentId)?.abort();
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
      completed: '已完成',
      failed: '處理失敗',
      cancelled: '已取消',
    } as Record<string, string>)[stage ?? ''] ?? '排隊等待處理';
  }

  statusLabel(status: DesktopLibrarySummary['status']): string {
    return ({
      queued: '排隊等待處理',
      processing: '處理中',
      awaiting_confirmation: '等待確認',
      completed: '已完成',
      failed: '處理失敗',
      canceled: '已取消',
    } as Record<DesktopLibrarySummary['status'], string>)[status];
  }

  private prepareFile$(file: File): Observable<void> {
    const sourceKind = sourceKindFor(file);
    if (!sourceKind) {
      this.message.set(`不支援的檔案類型：${file.name}`);
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
      if (!this.runtime.ready()) return EMPTY;
      const controller = new AbortController();
      let runtimeCaptureId: string | undefined;
      this.controllers.set(documentId, controller);
      this.markBusy(documentId, true);

      const work$ = this.library.updateCapture({
        documentId,
        status: 'processing',
        stage: 'uploading',
      }).pipe(
        switchMap(() => this.runtime.createCapture(documentId, crypto.randomUUID(), controller.signal)),
        tap((job) => runtimeCaptureId = job.captureId),
        switchMap((job) => this.waitForTerminal$(documentId, job, controller.signal)),
        switchMap((job) => this.persistTerminal$(documentId, job, controller.signal)),
        tap(() => this.reloadDocumentState(documentId)),
      );

      return work$.pipe(
        catchError((error) => this.persistCaptureFailure$(documentId, controller, error).pipe(
          tap(() => this.reloadDocumentState(documentId)),
          catchError((failureError) => {
            this.message.set(errorMessage(failureError));
            return of(undefined);
          }),
        )),
        switchMap(() => this.cleanupRuntimeCapture$(runtimeCaptureId)),
        finalize(() => {
          this.controllers.delete(documentId);
          this.markBusy(documentId, false);
        }),
        map(() => undefined),
      );
    });
  }

  private waitForTerminal$(
    documentId: string,
    initial: CaptureJobV1,
    signal: AbortSignal,
  ): Observable<CaptureJobV1> {
    return of(initial).pipe(
      expand((job) => {
        if (job.status !== 'queued' && job.status !== 'running') return EMPTY;
        if (signal.aborted) {
          return this.runtime.cancelCapture(job.captureId, signal).pipe(
            switchMap(() => throwError(() => new DOMException('處理已取消。', 'AbortError'))),
          );
        }
        return this.library.updateCapture({
          documentId,
          captureId: job.captureId,
          status: 'processing',
          stage: job.stage,
        }).pipe(
          ignoreElements(),
          concatWith(timer(700)),
          switchMap(() => this.runtime.getCapture(job.captureId, signal)),
        );
      }),
      takeWhile((job) => job.status === 'queued' || job.status === 'running', true),
    );
  }

  private persistTerminal$(documentId: string, job: CaptureJobV1, signal: AbortSignal) {
    return this.runtime.getRaw(job.captureId, signal).pipe(
      switchMap((raw) => {
        if (job.status === 'completed') {
          return this.runtime.getResult(job.captureId, signal).pipe(
            switchMap((result) => this.library.updateCapture({
              documentId,
              captureId: job.captureId,
              status: 'completed',
              stage: 'completed',
              raw,
              result,
            })),
          );
        }
        return this.library.updateCapture({
          documentId,
          captureId: job.captureId,
          status: job.status === 'cancelled' ? 'canceled' : 'failed',
          stage: job.stage,
          raw,
          errorCode: job.error?.code,
          errorMessage: job.error?.message,
        });
      }),
    );
  }

  private persistCaptureFailure$(documentId: string, controller: AbortController, error: unknown) {
    return this.library.updateCapture({
      documentId,
      status: controller.signal.aborted ? 'canceled' : 'failed',
      stage: controller.signal.aborted ? 'cancelled' : 'failed',
      errorCode: controller.signal.aborted ? 'cancelled' : 'capture_failed',
      errorMessage: controller.signal.aborted ? '處理已取消。' : errorMessage(error),
    });
  }

  private cleanupRuntimeCapture$(captureId: string | undefined): Observable<void> {
    if (!captureId) return of(undefined);
    return this.runtime.deleteCapture(captureId).pipe(
      catchError(() => EMPTY),
      map(() => undefined),
    );
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

function sourceKindFor(file: File): CaptureSourceKind | null {
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
