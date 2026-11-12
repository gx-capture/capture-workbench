import { playbackUnavailable } from './recording-playback';
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
import { finalize } from 'rxjs';
import type {
  CaptureDocument,
  CaptureRequirementId,
  PartialCapture,
  RawCapture,
  RuntimeInstallation,
} from '@gx-capture/capture-workbench-ui';
import type {
  DesktopComputeStatus,
  DesktopLibraryDetail,
  DesktopLibrarySummary,
} from '../contracts';
import { CaptureQueueStore } from './capture-queue.store';
import { DesktopLibraryService, type DesktopSourceSelectionBatch } from './desktop-library.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import {
  DesktopWorkspaceCaptureService,
  type DesktopWorkspaceCaptureHost,
} from './desktop-workspace-capture.service';
import { RecognitionFeaturesStore } from './recognition-features.store';
import {
  captureResultText,
  errorMessage,
  isAudioMediaType,
  stageLabel as selectStageLabel,
  statusLabel as selectStatusLabel,
  transcriptLines,
} from './desktop-workspace.selectors';
import { desktopMessages } from '../i18n/desktop-messages';

type WorkspaceState = 'starting' | 'ready' | 'error';

@Injectable({ providedIn: 'root' })
/** Public Angular facade for workspace state, commands, and capture actions. */
export class DesktopWorkspaceStore {
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly formatting = inject(DesktopWorkspaceFormattingService);
  private readonly captureLifecycle = inject(DesktopWorkspaceCaptureService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router, { optional: true });
  readonly features = inject(RecognitionFeaturesStore);

  readonly message = signal(desktopMessages().starting);
  readonly selectedId = signal<string | null>(null);
  readonly query = signal('');
  readonly statusFilter = signal('');
  readonly installing = this.features.installing;
  readonly activeInstallation = this.features.activeInstallation;
  readonly activeModelInstallation = this.features.activeModelInstallation;
  readonly installationPercent = this.features.installationPercent;
  readonly modelInstallationPercent = this.features.modelInstallationPercent;
  readonly modelInstallationPhase = this.features.modelInstallationPhase;
  readonly selectedModelOptionId = this.features.selectedModelOptionId;
  readonly busyIds = this.captureLifecycle.busyIds;
  readonly ocrCompute = this.runtime.ocrCompute;
  readonly runtimeStarted = this.runtime.started;
  readonly requestedRequirements = this.features.requestedRequirements;
  /** Tell speakers apart in audio added from now on. */
  readonly identifySpeakers = signal(false);
  /** Addresses of source files loaded for playing speaker samples, by document. */
  readonly sampleSources = signal<ReadonlyMap<string, string>>(new Map());
  readonly streamingPartials = this.captureLifecycle.streamingPartials;

  /** Returns the current partial result for a document, when streaming has emitted one. */
  partialFor(documentId: string): PartialCapture | null {
    return this.streamingPartials().get(documentId) ?? null;
  }

  get requirements() {
    return this.features.requirements;
  }

  /** History search result. The OCR queue reads {@link allDocuments} instead. */
  get documents() {
    return this.visibleDocuments;
  }

  /** Every library document, including ones the history search hides. */
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
  /** The GPU setting for speech recognition, offered only when a CUDA driver is present. */
  readonly speechGpu = computed<DesktopComputeStatus | null>(() => {
    const status = this.computeResource.hasValue()
      ? this.computeResource.value()
      : undefined;
    return status?.cudaAvailable ? status : null;
  });
  readonly savingCompute = signal(false);
  /** Changing it relaunches the runtime, which would stop a capture or installation. */
  readonly canChangeCompute = computed(
    () =>
      !this.savingCompute() && !this.installing() && this.busyIds().size === 0,
  );
  readonly ocrReady = this.features.ocrReady;
  readonly asrReady = this.features.asrReady;
  readonly speakersReady = this.features.speakersReady;
  readonly engines = this.features.engines;
  readonly speechPack = this.features.speechPack;
  readonly requestedMissing = this.features.requestedMissing;
  readonly installableRequestedRequirements =
    this.features.installableRequestedRequirements;
  readonly modelSelectionRequired = this.features.modelSelectionRequired;
  readonly activeModelOption = this.features.activeModelOption;

  private dropListenerStarted = false;

  private readonly computeResource = rxResource<DesktopComputeStatus, undefined>(
    {
      stream: ({ abortSignal }) => this.runtime.getComputeStatus(abortSignal),
    },
  );

  private readonly documentsResource = rxResource<
    readonly DesktopLibrarySummary[],
    { readonly ready: true } | undefined
  >({
    defaultValue: [],
    params: () => (this.runtimeStarted() ? { ready: true } : undefined),
    stream: ({ abortSignal }) => this.library.list('', '', abortSignal),
  });

  private readonly visibleDocuments = computed(() =>
    filterLibraryDocuments(
      this.documentsResource.value(),
      this.query(),
      this.statusFilter(),
    ),
  );

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
    documents: () => this.documents(),
    selected: () => this.selected(),
    refreshDocuments: () => this.refreshDocuments(),
    reloadDocumentState: (documentId) => this.reloadDocumentState(documentId),
    setMessage: (message) => this.message.set(message),
    identifySpeakers: () => this.identifySpeakers(),
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
    this.computeResource.reload();
    this.features.initialize();
    this.documentsResource.reload();
  }

  /** Lets speech recognition use the GPU or not, then waits for the relaunched runtime. */
  setPreferGpu(preferGpu: boolean): void {
    if (!this.canChangeCompute() || this.speechGpu()?.preferGpu === preferGpu) {
      return;
    }
    this.savingCompute.set(true);
    this.runtime
      .setPreferGpu(preferGpu)
      .pipe(finalize(() => this.savingCompute.set(false)))
      .subscribe({
        next: () => this.initialize(),
        error: (error: unknown) => {
          this.computeResource.reload();
          this.message.set(errorMessage(error));
        },
      });
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

  /** Latest installation record for a requirement unit, if any. */
  installationFor(
    requirementId: CaptureRequirementId,
  ): RuntimeInstallation | null {
    return this.features.installationFor(requirementId);
  }

  /** Installs all requested missing requirements in deterministic order. */
  installRequestedRequirements(): void {
    this.features.installRequestedRequirements();
  }

  /** Downloads one recognition unit the user chose. */
  installUnit(requirementId: CaptureRequirementId): void {
    this.features.installUnit(requirementId);
  }

  /** Downloads the selected recognition units in deterministic order. */
  installUnits(requirementIds: readonly CaptureRequirementId[]): void {
    this.features.installUnits(requirementIds);
  }

  /** Downloads one speech pack unit the user chose after reading its guide. */
  installSpeechUnit(requirementId: CaptureRequirementId): void {
    this.features.installUnit(requirementId);
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

  /** Opens the host source picker and enqueues the selected selections. */
  chooseSources(): void {
    if (!this.runtime.ready() || !this.canCapture()) return;
    this.library.selectSources().subscribe({
      next: (batch) => this.addSelections(batch),
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
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
      this.documents().find(
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
        this.releaseSampleSource(documentId);
        if (this.selectedId() === documentId) {
          this.selectedId.set(null);
          this.selectedResource.set(null);
        }
        this.refreshDocuments();
      },
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  /** Offer an optional unit that a finished capture said it missed. */
  requestUnit(requirementId: CaptureRequirementId): void {
    this.features.requestUnit(requirementId);
  }

  /** Units a result missed that are not installed yet. */
  missedUnits(result: CaptureDocument): readonly CaptureRequirementId[] {
    const ready = new Set(
      this.requirements()
        .filter((requirement) => requirement.status === 'ready')
        .map((requirement) => requirement.requirementId),
    );
    return (result.suggestedUnits ?? []).filter((unit) => !ready.has(unit));
  }

  /** Loads the source file once so the speakers' samples can be played. */
  loadSpeakerSamples(
    documentId: string,
    mediaType: string,
    byteLength: number,
  ): void {
    if (playbackUnavailable(byteLength)) {
      this.message.set(desktopMessages().largeRecordingPlaybackUnavailable);
      return;
    }
    if (this.sampleSources().has(documentId)) return;
    this.library.sourceBytes(documentId).subscribe({
      next: (bytes) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
        this.sampleSources.update((current) =>
          new Map(current).set(documentId, url),
        );
      },
      error: (error: unknown) => this.message.set(errorMessage(error)),
    });
  }

  /** Whether a document is a recording (audio, or video whose audio was transcribed). */
  isRecording(mediaType: string): boolean {
    return isAudioMediaType(mediaType);
  }

  /** Address of a recording loaded for playback, or null before it is loaded. */
  recordingUrl(documentId: string): string | null {
    return this.sampleSources().get(documentId) ?? null;
  }

  /** A recording's transcript lines, with the names given to its speakers. */
  transcriptLines(item: {
    readonly raw?: RawCapture;
    readonly result?: CaptureDocument;
  }) {
    return item.raw
      ? transcriptLines(item.raw, item.result?.speakers ?? [])
      : [];
  }

  /** Address that plays only one speaker's sample, once the source is loaded. */
  speakerSampleUrl(
    documentId: string,
    sample?: { readonly startMs: number; readonly endMs: number } | null,
  ): string | null {
    const source = this.sampleSources().get(documentId);
    return source && sample
      ? `${source}#t=${sample.startMs / 1000},${sample.endMs / 1000}`
      : null;
  }

  /** Stores the name the user gave a speaker; an empty name removes it. */
  nameSpeaker(documentId: string, speakerId: string, name: string): void {
    const detail = this.selected();
    const result =
      detail?.documentId === documentId ? detail.result : undefined;
    const speakers = result?.speakers ?? [];
    if (!result || !speakers.some((speaker) => speaker.speakerId === speakerId))
      return;
    const displayName = name.trim().slice(0, 100) || null;
    this.library
      .updateCapture({
        documentId,
        status: detail!.status,
        stage: detail!.stage,
        result: {
          ...result,
          speakers: speakers.map((speaker) =>
            speaker.speakerId === speakerId
              ? { ...speaker, displayName }
              : speaker,
          ),
        },
      })
      .subscribe({
        next: () => this.reloadDocumentState(documentId),
        error: (error: unknown) => this.message.set(errorMessage(error)),
      });
  }

  /** Result text; a transcript with speakers reads "name: what they said". */
  resultText(result: CaptureDocument): string {
    let text = this.resultTexts.get(result);
    if (text === undefined) {
      text = captureResultText(result);
      this.resultTexts.set(result, text);
    }
    return text;
  }

  private readonly resultTexts = new WeakMap<CaptureDocument, string>();

  private releaseSampleSource(documentId: string): void {
    const url = this.sampleSources().get(documentId);
    if (!url) return;
    URL.revokeObjectURL(url);
    this.sampleSources.update((current) => {
      const next = new Map(current);
      next.delete(documentId);
      return next;
    });
  }

  /** Exports a document through the host download boundary. */
  export(documentId: string, format: 'json' | 'text'): void {
    this.library.export(documentId, format).subscribe({
      next: (exported) => {
        this.formatting.downloadText(
          exported.fileName,
          exported.content,
          exported.mediaType,
        );
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

  /**
   * The one drag-drop subscription. On `/ocr` the selections wait in the OCR queue.
   * Anywhere else they start capture, as this workspace always did.
   */
  private routeDroppedSources(batch: DesktopSourceSelectionBatch): void {
    if (this.onOcrPage()) {
      this.injector.get(CaptureQueueStore).importSelections(batch);
      return;
    }
    this.addSelections(batch);
  }

  private onOcrPage(): boolean {
    const path = (this.router?.url ?? '').split(/[?#]/u)[0] ?? '';
    return path === '/ocr';
  }

  private reloadDocumentState(documentId: string): void {
    this.documentsResource.reload();
    if (this.selectedId() === documentId) this.selectedResource.reload();
  }
}

/** Same rule as the host list: file name contains the query, status matches exactly. */
function filterLibraryDocuments(
  documents: readonly DesktopLibrarySummary[],
  query: string,
  status: string,
): readonly DesktopLibrarySummary[] {
  const needle = query.trim().toLowerCase();
  const wanted = status.trim().toLowerCase();
  return documents.filter((document) =>
    (needle === '' || document.fileName.toLowerCase().includes(needle))
    && (wanted === '' || document.status === wanted),
  );
}
