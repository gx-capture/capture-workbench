import {
  computed,
  DestroyRef,
  effect,
  Injectable,
  inject,
  signal,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import {
  type PartialCapture,
  type CaptureRequirementId,
  type RuntimeModelOption,
  type RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import type {
  DesktopLibraryDetail,
  DesktopLibrarySummary,
} from '../contracts';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceCaptureService, type DesktopWorkspaceCaptureHost } from './desktop-workspace-capture.service';
import { DesktopWorkspaceInstallationService } from './desktop-workspace-installation.service';
import {
  activeModelOption as selectActiveModelOption,
  errorMessage,
  modelInstallationPercent,
  modelInstallationPhase,
  modelSelectionRequired as selectModelSelectionRequired,
  selectCoreMissing,
  selectInstallableCoreRequirements,
  stageLabel as selectStageLabel,
  statusLabel as selectStatusLabel,
} from './desktop-workspace.selectors';

type WorkspaceState = 'starting' | 'needs-setup' | 'ready' | 'error';

@Injectable({ providedIn: 'root' })
/** Public Angular facade for workspace state, commands, and capture actions. */
export class DesktopWorkspaceStore {
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly formatting = inject(DesktopWorkspaceFormattingService);
  private readonly installation = inject(DesktopWorkspaceInstallationService);
  private readonly captureLifecycle = inject(DesktopWorkspaceCaptureService);
  private readonly destroyRef = inject(DestroyRef);

  readonly message = signal('正在連線到 Capture Runtime…');
  readonly selectedId = signal<string | null>(null);
  readonly query = signal('');
  readonly statusFilter = signal('');
  readonly installing = this.installation.installing;
  readonly activeInstallation = this.installation.activeInstallation;
  readonly activeModelInstallation = this.installation.activeModelInstallation;
  readonly modelInstallationPercent = computed(() =>
    modelInstallationPercent(this.activeModelInstallation()));
  readonly modelInstallationPhase = computed(() =>
    modelInstallationPhase(this.activeModelInstallation()));
  readonly selectedModelOptionId = this.installation.selectedModelOptionId;
  readonly busyIds = this.captureLifecycle.busyIds;
  readonly requestedRequirements = signal<ReadonlySet<CaptureRequirementId>>(new Set());
  readonly streamingPartials = this.captureLifecycle.streamingPartials;

  /** Returns the current partial result for a document, when streaming has emitted one. */
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
    selectCoreMissing(this.requirements(), this.requestedRequirements()));
  readonly installableCoreRequirements = computed(() =>
    selectInstallableCoreRequirements(this.requirements(), this.requestedRequirements()));
  readonly modelSelectionRequired = computed(
    () => selectModelSelectionRequired(this.modelOptions()),
  );
  readonly activeModelOption = computed(
    () => selectActiveModelOption(this.modelOptions()),
  );

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

  private readonly captureHost: DesktopWorkspaceCaptureHost = {
    selectedId: this.selectedId,
    requestedRequirements: this.requestedRequirements,
    requirements: () => this.requirements(),
    documents: () => this.documents(),
    selected: () => this.selected(),
    refreshDocuments: () => this.refreshDocuments(),
    reloadDocumentState: (documentId) => this.reloadDocumentState(documentId),
    setMessage: (message) => this.message.set(message),
  };

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

  /** Starts runtime readiness, requirement, model, and document resources. */
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

  /** Reloads the document list without changing the current selection. */
  refreshDocuments(): void {
    this.documentsResource.reload();
  }

  /** Selects a document and reloads its detail resource. */
  select(documentId: string): void {
    this.selectedId.set(documentId);
    this.selectedResource.reload();
  }

  /** Updates the library search query used by the document resource. */
  updateQuery(query: string): void {
    this.query.set(query);
  }

  /** Updates the library status filter used by the document resource. */
  updateStatusFilter(status: string): void {
    this.statusFilter.set(status);
  }

  /** Installs all currently available core requirements in deterministic order. */
  installCoreRequirements(): void {
    if (!this.runtime.ready() || this.installing()) return;
    const installable = this.installableCoreRequirements();
    if (installable.length === 0) return;
    this.installation.installCoreRequirements$(installable).subscribe({
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

  /** Selects the model option used by the next installation command. */
  selectModelOption(optionId: string): void {
    this.installation.selectModelOption(optionId);
  }

  /** Starts the selected model installation and refreshes dependent resources. */
  installSelectedModel(): void {
    const optionId = this.selectedModelOptionId();
    if (!this.runtime.ready() || this.installing() || !optionId) return;
    this.installation.installSelectedModel$(optionId).pipe(
      finalize(() => {
        this.modelOptionsResource.reload();
        this.requirementsResource.reload();
      }),
    ).subscribe({
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  /** Opens the host source picker and enqueues the selected paths. */
  chooseSources(): void {
    if (!this.runtime.ready() || !this.canCapture()) return;
    this.library.selectSources().subscribe({
      next: (paths) => this.addSourcePaths(paths),
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  /** Enqueues source paths through the capture lifecycle collaborator. */
  addSourcePaths(paths: readonly string[]): void {
    if (!this.runtime.ready() || !this.canCapture()) return;
    this.captureLifecycle.addSourcePaths$(paths, this.captureHost).subscribe({
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  /** Retries a failed or recoverable document capture. */
  retry(documentId: string): void {
    if (!this.canCapture()) return;
    this.captureLifecycle.retry$(documentId, this.captureHost).subscribe({
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  /** Requests cancellation for an active capture. */
  cancel(documentId: string): void {
    this.captureLifecycle.cancel(documentId);
  }

  /** Deletes a non-active, non-recoverable library document after confirmation. */
  delete(documentId: string): void {
    if (this.captureLifecycle.hasActiveCapture(documentId) || this.busyIds().has(documentId)) {
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

  /** Exports a document through the host download boundary. */
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

  /** Formats bytes using the workspace presentation service. */
  formatBytes(bytes: number): string {
    return this.formatting.formatBytes(bytes);
  }

  /** Formats persisted timestamps using the workspace presentation service. */
  formatDate(milliseconds: number): string {
    return this.formatting.formatDate(milliseconds);
  }

  /** Returns a human-readable label for a runtime stage. */
  stageLabel(stage?: string): string {
    return selectStageLabel(stage);
  }

  /** Returns a human-readable label for a persisted library status. */
  statusLabel(status: DesktopLibrarySummary['status']): string {
    return selectStatusLabel(status);
  }

  private reloadDocumentState(documentId: string): void {
    this.documentsResource.reload();
    if (this.selectedId() === documentId) this.selectedResource.reload();
  }
}
