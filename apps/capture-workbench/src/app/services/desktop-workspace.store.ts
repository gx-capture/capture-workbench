import { selectionRejectionMessages } from './source-selection-messages';
import {
  computed,
  DestroyRef,
  effect,
  Injectable,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import type {
  CaptureRequirementId,
  RuntimeInstallation,
} from '@gx-capture/capture-workbench-ui';
import type {
  DesktopLibraryDetail,
  DesktopLibrarySummary,
} from '../contracts';
import { AsrQueueStore } from './asr-queue.store';
import { CaptureQueueStore } from './capture-queue.store';
import { SpeechGpuSettingsStore } from './speech-gpu-settings.store';
import { DesktopLibraryService, type DesktopSourceSelectionBatch } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import {
  DesktopWorkspaceCaptureService,
  type DesktopWorkspaceCaptureHost,
} from './desktop-workspace-capture.service';
import { RecognitionFeaturesStore } from './recognition-features.store';
import { errorMessage } from './desktop-workspace.selectors';
import { desktopMessages } from '../i18n/desktop-messages';

type WorkspaceState = 'starting' | 'ready' | 'error';

@Injectable({ providedIn: 'root' })
/** Public Angular facade for workspace state, commands, and capture actions. */
export class DesktopWorkspaceStore {
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly captureLifecycle = inject(DesktopWorkspaceCaptureService);
  private readonly compute = inject(SpeechGpuSettingsStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router, { optional: true });
  readonly features = inject(RecognitionFeaturesStore);

  readonly message = signal(desktopMessages().starting);
  readonly selectedId = signal<string | null>(null);
  readonly installing = this.features.installing;
  readonly activeInstallation = this.features.activeInstallation;
  readonly activeModelInstallation = this.features.activeModelInstallation;
  readonly installationPercent = this.features.installationPercent;
  readonly modelInstallationPercent = this.features.modelInstallationPercent;
  readonly modelInstallationPhase = this.features.modelInstallationPhase;
  readonly selectedModelOptionId = this.features.selectedModelOptionId;
  readonly busyIds = this.captureLifecycle.busyIds;
  readonly runtimeStarted = this.runtime.started;
  readonly requestedRequirements = this.features.requestedRequirements;

  get requirements() {
    return this.features.requirements;
  }

  /** Every library document. */
  get allDocuments() {
    return this.documentsResource.value;
  }

  get selected() {
    return this.selectedResource.value;
  }

  readonly state = computed<WorkspaceState>(() => {
    if (
      this.runtime.error() ||
      this.features.requirementsResource.error() ||
      this.documentsResource.error()
    ) {
      return 'error';
    }
    if (!this.runtimeStarted()) return 'starting';
    const requirementsStatus = this.features.requirementsResource.status();
    if (
      requirementsStatus === 'idle' ||
      requirementsStatus === 'loading' ||
      requirementsStatus === 'reloading'
    ) {
      return 'starting';
    }
    return 'ready';
  });

  /** Installing one feature does not block capturing with another (plan §2, ASR journey). */
  readonly canCapture = computed(() => this.state() === 'ready');
  readonly ocrReady = this.features.ocrReady;
  readonly asrReady = this.features.asrReady;
  readonly speakersReady = this.features.speakersReady;
  readonly engines = this.features.engines;
  readonly requestedMissing = this.features.requestedMissing;
  readonly installableRequestedRequirements =
    this.features.installableRequestedRequirements;
  readonly modelSelectionRequired = this.features.modelSelectionRequired;
  readonly activeModelOption = this.features.activeModelOption;

  private dropListenerStarted = false;

  private readonly documentsResource = rxResource<
    readonly DesktopLibrarySummary[],
    { readonly ready: true } | undefined
  >({
    defaultValue: [],
    params: () => (this.runtimeStarted() ? { ready: true } : undefined),
    stream: ({ abortSignal }) => this.library.list('', '', abortSignal),
  });

  private readonly selectedResource = rxResource<
    DesktopLibraryDetail | null,
    { readonly documentId: string } | undefined
  >({
    defaultValue: null,
    params: () => {
      const documentId = this.selectedId();
      return this.runtimeStarted() && documentId ? { documentId } : undefined;
    },
    stream: ({ params, abortSignal }) =>
      this.library.get(params.documentId, abortSignal),
  });

  private readonly captureHost: DesktopWorkspaceCaptureHost = {
    selectedId: this.selectedId,
    requestedRequirements: this.requestedRequirements,
    requirements: () => this.requirements(),
    documents: () => this.allDocuments() ?? [],
    selected: () => this.selected(),
    refreshDocuments: () => this.refreshDocuments(),
    reloadDocumentState: (documentId) => this.reloadDocumentState(documentId),
    setMessage: (message) => this.message.set(message),
    identifySpeakers: () => false,
  };

  private readonly resourceErrorEffect = effect(() => {
    const error =
      this.runtime.error() ??
      this.features.requirementsResource.error() ??
      this.documentsResource.error() ??
      this.selectedResource.error();
    if (error) this.message.set(errorMessage(error));
  });

  private readonly stateMessageEffect = effect(() => {
    const state = this.state();
    if (state === 'ready' && this.message() === desktopMessages().starting) {
      this.message.set('');
    }
  });

  private readonly featureMessageEffect = effect(() => {
    const featureMsg = this.features.message();
    if (featureMsg) {
      this.message.set(featureMsg);
    }
  });

  private readonly computeErrorEffect = effect(() => {
    const computeError = this.compute.error();
    if (computeError) {
      this.message.set(computeError);
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
          next: (batch) => this.routeDroppedSources(batch),
          error: (error: unknown) => this.message.set(errorMessage(error)),
        });
    }
    this.runtime.reload();
    this.compute.reload();
    this.features.initialize();
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

  /** Latest installation record for a requirement unit, if any. */
  installationFor(
    requirementId: CaptureRequirementId,
  ): RuntimeInstallation | null {
    return this.features.installationFor(requirementId);
  }

  /** Downloads one recognition unit the user chose. */
  installUnit(requirementId: CaptureRequirementId): void {
    this.features.installUnit(requirementId);
  }

  /** Downloads the selected recognition units in deterministic order. */
  installUnits(requirementIds: readonly CaptureRequirementId[]): void {
    this.features.installUnits(requirementIds);
  }

  /** Cancels a running installation. */
  cancelInstallation(installationId?: string): void {
    this.features.cancelInstallation(installationId);
  }

  /** Retries a failed or cancelled installation for a requirement unit. */
  retryInstallation(requirementId: CaptureRequirementId): void {
    this.features.retryInstallation(requirementId);
  }

  get modelOptions() {
    return this.features.modelOptions;
  }

  /** Selects the model option used by the next installation command. */
  selectModelOption(optionId: string): void {
    this.features.selectModelOption(optionId);
  }

  /** Starts the selected model installation and refreshes dependent resources. */
  installSelectedModel(): void {
    this.features.installSelectedModel();
  }

  /** Enqueues selections through the capture lifecycle collaborator. */
  addSelections(batch: DesktopSourceSelectionBatch): void {
    this.message.set(selectionRejectionMessages(batch).join('\n'));
    if (!this.runtime.ready() || !this.canCapture()) {
      this.library.discardSelections(batch.selections).subscribe({ error: () => undefined });
      return;
    }
    this.captureLifecycle.addSelections$(batch.selections, this.captureHost).subscribe({
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
    if (
      this.captureLifecycle.hasActiveCapture(documentId) ||
      this.busyIds().has(documentId)
    ) {
      this.message.set(desktopMessages().cancelBeforeDelete);
      return;
    }
    const document =
      (this.allDocuments() ?? []).find(
        (candidate) => candidate.documentId === documentId,
      ) ??
      (this.selected()?.documentId === documentId
        ? this.selected()
        : undefined);
    if (document?.captureId) {
      this.message.set(desktopMessages().waitBeforeDelete);
      return;
    }
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

  /**
   * The one drag-drop subscription. On `/ocr` or `/asr` the selections wait in that
   * page's queue. Anywhere else they start capture, as this workspace always did.
   */
  private routeDroppedSources(batch: DesktopSourceSelectionBatch): void {
    const path = this.currentRoutePath();
    if (path === '/ocr') {
      this.injector.get(CaptureQueueStore).importSelections(batch);
      return;
    }
    if (path === '/asr') {
      this.injector.get(AsrQueueStore).importSelections(batch);
      return;
    }
    this.addSelections(batch);
  }

  private currentRoutePath(): string {
    return (this.router?.url ?? '').split(/[?#]/u)[0] ?? '';
  }

  private reloadDocumentState(documentId: string): void {
    this.documentsResource.reload();
    if (this.selectedId() === documentId) this.selectedResource.reload();
  }
}
