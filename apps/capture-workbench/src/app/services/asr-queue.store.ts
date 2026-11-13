import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  Injector,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { concatMap, finalize, from, tap, toArray } from 'rxjs';
import type {
  DesktopCaptureOptions,
  DesktopLibraryDetail,
  DesktopLibrarySummary,
} from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import {
  type AsrLiveCaptureView,
  type AsrQueueView,
  type AsrSpokenLanguage,
  describeAsrDocument,
  describeAsrLiveCapture,
  sortAsrDocumentsOldestFirst,
} from './asr-queue';
import {
  DesktopLibraryService,
  type DesktopSourceSelection,
  type DesktopSourceSelectionBatch,
} from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceCaptureService } from './desktop-workspace-capture.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';
import {
  errorMessage,
  formatApproximateBytes,
  installationPercent,
  isActiveStreaming,
  isAudioMediaType,
  isFeatureReady,
} from './desktop-workspace.selectors';
import { DesktopWorkspaceStore } from './desktop-workspace.store';
import { RecognitionFeaturesStore } from './recognition-features.store';
import { selectionRejectionMessages } from './source-selection-messages';

/** Owns the recording queue, options, live partial transcript, and capture orchestration for `/asr`. */
@Injectable({ providedIn: 'root' })
export class AsrQueueStore {
  private readonly workspace = inject(DesktopWorkspaceStore);
  private readonly library = inject(DesktopLibraryService);
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly capture = inject(DesktopWorkspaceCaptureService);
  private readonly features = inject(RecognitionFeaturesStore);
  private readonly formatting = inject(DesktopWorkspaceFormattingService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router, { optional: true });

  /** Session-only spoken language choice applied to newly added recordings. */
  readonly spokenLanguage = signal<AsrSpokenLanguage>('zh');
  /** Whether newly added recordings request speaker diarization (when unit is ready). */
  readonly identifySpeakers = signal(false);
  readonly importError = signal('');

  private readonly details = signal<ReadonlyMap<string, DesktopLibraryDetail>>(new Map());
  private readonly knownDurations = signal<ReadonlyMap<string, number>>(new Map());
  private readonly loadedUpdatedAt = new Map<string, number>();
  private readonly loadingDetails = new Set<string>();
  private readonly startingIds = new Set<string>();
  private readonly attemptedReattachments = new Set<string>();
  private attached = false;

  readonly speechReady = computed(() =>
    isFeatureReady(this.features.requirements(), 'asr'),
  );

  readonly speakersReady = computed(() =>
    isFeatureReady(this.features.requirements(), 'asr.speakers'),
  );

  readonly speechPack = this.features.speechPack;

  readonly optionalSpeakerUnit = computed(
    () =>
      this.features
        .speechPack()
        .find(
          (unit) =>
            unit.requirementId === 'speaker-diarization'
            && unit.status !== 'ready',
        ) ?? null,
  );

  readonly speechSizeLabel = computed(() => {
    const unit = this.features
      .requirements()
      .find((candidate) => candidate.requirementId === 'speech-recognition');
    return formatApproximateBytes(unit?.downloadBytes);
  });

  readonly speechInstallPercent = computed(() => {
    const installation = this.features.installationFor('speech-recognition');
    if (
      !installation
      || (installation.status !== 'queued' && installation.status !== 'running')
    ) {
      return null;
    }
    return installationPercent(installation);
  });

  readonly documents = computed(() =>
    sortAsrDocumentsOldestFirst(this.workspace.allDocuments()),
  );

  readonly rows = computed<readonly AsrQueueView[]>(() => {
    const ops = this.capture.streamingOperations();
    const busyIds = this.capture.busyIds();
    const details = this.details();
    const durations = this.knownDurations();
    const speechReady = this.speechReady();
    const installPercent = this.speechInstallPercent();
    return this.documents().map((document) =>
      describeAsrDocument({
        document,
        detail: details.get(document.documentId),
        operation: ops.get(document.documentId),
        knownDurationMs: durations.get(document.documentId),
        busy: busyIds.has(document.documentId),
        speechReady,
        installPercent,
      }),
    );
  });

  readonly liveCapture = computed<AsrLiveCaptureView | null>(() => {
    const ops = this.capture.streamingOperations();
    const partials = this.capture.streamingPartials();
    const busyIds = this.capture.busyIds();
    const running = this.documents().find((document) => {
      if (document.status !== 'processing' && document.status !== 'persisting') {
        return false;
      }
      const op = ops.get(document.documentId);
      return (
        busyIds.has(document.documentId)
        || this.capture.hasActiveCapture(document.documentId)
        || (op !== undefined && isActiveStreaming(op))
        || (document.captureId !== undefined
          && partials.get(document.documentId)?.captureId === document.captureId)
      );
    });
    if (!running) return null;
    const partial = partials.get(running.documentId);
    return describeAsrLiveCapture({
      document: running,
      operation: ops.get(running.documentId),
      partial: running.captureId && partial?.captureId === running.captureId
        ? partial
        : null,
    });
  });

  private readonly host = {
    selectedId: this.workspace.selectedId,
    requestedRequirements: this.features.requestedRequirements,
    requirements: () => this.features.requirements(),
    documents: () => this.workspace.allDocuments(),
    selected: () => this.workspace.selected(),
    refreshDocuments: () => this.workspace.refreshDocuments(),
    reloadDocumentState: (documentId: string) => {
      this.loadedUpdatedAt.delete(documentId);
      this.workspace.refreshDocuments();
      if (this.workspace.selectedId() === documentId) {
        this.workspace.select(documentId);
      }
    },
    setMessage: (text: string) => this.workspace.message?.set(text),
    identifySpeakers: () => this.identifySpeakers(),
  };

  /** Connects queue coordination to runtime readiness and document updates. Called by the ASR page. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    effect(
      () => {
        if (this.runtime.ready()) {
          this.workspace.refreshDocuments();
        }
      },
      { injector: this.injector },
    );
    effect(
      () => {
        if (!this.runtime.ready()) return;
        const recordings = this.documents();
        const busyIds = this.capture.busyIds();
        const speechReady = this.speechReady();
        this.captureDurations(recordings);
        this.loadCompletedDetails(recordings);
        this.reattachRunning(recordings);
        if (speechReady) {
          this.startWaiting(recordings, busyIds);
        }
      },
      { injector: this.injector },
    );
  }

  setSpokenLanguage(language: AsrSpokenLanguage): void {
    this.spokenLanguage.set(language);
  }

  setIdentifySpeakers(enabled: boolean): void {
    this.identifySpeakers.set(enabled);
  }

  chooseFiles(): void {
    if (!this.speechReady()) return;
    this.importError.set('');
    this.library
      .selectSources('recordings')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (batch) => this.importSelections(batch),
        error: (error: unknown) => this.importError.set(errorMessage(error)),
      });
  }

  importSelections(batch: DesktopSourceSelectionBatch): void {
    const messages = selectionRejectionMessages(batch);
    const recordings: DesktopSourceSelection[] = [];
    const nonRecordings: DesktopSourceSelection[] = [];
    for (const selection of batch.selections) {
      if (isAudioMediaType(selection.mediaType)) {
        recordings.push(selection);
      } else {
        nonRecordings.push(selection);
      }
    }
    if (nonRecordings.length > 0) {
      messages.push(
        desktopMessages().sourceRejections.unsupported(nonRecordings.length),
      );
      this.library
        .discardSelections(nonRecordings)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          error: (error: unknown) =>
            this.workspace.message?.set(errorMessage(error)),
        });
    }
    this.importError.set(messages.join('\n'));
    if (recordings.length === 0) return;

    const captureOptions = this.snapshotCaptureOptions();
    from(recordings)
      .pipe(
        concatMap((selection) =>
          this.library.importSelection(selection, captureOptions),
        ),
        toArray(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => this.workspace.refreshDocuments(),
        error: (error: unknown) => {
          this.importError.set(errorMessage(error));
          this.workspace.refreshDocuments();
        },
      });
  }

  install(): void {
    this.features.installUnit('speech-recognition');
  }

  installSpeakers(): void {
    this.features.installUnit('speaker-diarization');
  }

  cancel(documentId: string): void {
    const target = this.documents().find((item) => item.documentId === documentId);
    if (target?.status === 'queued' && !this.capture.hasActiveCapture(documentId)) {
      this.library
        .updateCapture({
          documentId,
          status: 'canceled',
          stage: 'cancelled',
          clearCaptureId: true,
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => this.workspace.refreshDocuments(),
          error: (error: unknown) =>
            this.workspace.message?.set(errorMessage(error)),
        });
      return;
    }
    this.capture.cancel(documentId);
  }

  retry(documentId: string): void {
    if (!this.runtime.ready() || !this.speechReady()) return;
    this.clearPartial(documentId);
    this.capture
      .retry$(documentId, this.host)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) =>
          this.workspace.message?.set(errorMessage(error)),
      });
  }

  restart(documentId: string): void {
    if (!this.runtime.ready() || !this.speechReady()) return;
    this.clearPartial(documentId);
    this.capture
      .restartLost$(documentId, this.host)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) =>
          this.workspace.message?.set(errorMessage(error)),
      });
  }

  view(documentId: string): void {
    this.workspace.select(documentId);
    void this.router?.navigateByUrl('/history');
  }

  exportTxt(documentId: string): void {
    this.library
      .export(documentId, 'text')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (exported) => {
          this.formatting.downloadText(
            exported.fileName,
            exported.content,
            exported.mediaType,
          );
        },
        error: (error: unknown) =>
          this.workspace.message?.set(errorMessage(error)),
      });
  }

  private snapshotCaptureOptions(): DesktopCaptureOptions {
    const language = this.spokenLanguage();
    const speakers = this.speakersReady() && this.identifySpeakers();
    return {
      spokenLanguage: language,
      identifySpeakers: speakers,
    };
  }

  private reattachRunning(recordings: readonly DesktopLibrarySummary[]): void {
    for (const document of recordings) {
      if (
        (document.status === 'processing'
          || document.status === 'persisting'
          || document.status === 'recovery_required')
        && document.captureId
        && !this.capture.hasActiveCapture(document.documentId)
        && !this.capture.busyIds().has(document.documentId)
        && !this.attemptedReattachments.has(document.captureId)
      ) {
        // Mark before subscribing: recovery can synchronously refresh the library.
        // A failed capture requires an explicit retry/restart, even after busy clears.
        this.attemptedReattachments.add(document.captureId);
        this.capture
          .reattach$(document, this.host)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            error: (error: unknown) =>
              this.workspace.message?.set(errorMessage(error)),
          });
      }
    }
  }

  private startWaiting(
    recordings: readonly DesktopLibrarySummary[],
    busyIds: ReadonlySet<string>,
  ): void {
    const running = recordings.some(
      (document) =>
        busyIds.has(document.documentId)
        || this.capture.hasActiveCapture(document.documentId)
        || this.startingIds.has(document.documentId)
        || ((document.status === 'processing' || document.status === 'persisting')
          && Boolean(document.captureId)),
    );
    if (running) return;
    const next = recordings.find(
      (document) =>
        document.status === 'queued'
        && !this.startingIds.has(document.documentId),
    );
    if (!next) return;
    this.startingIds.add(next.documentId);
    this.clearPartial(next.documentId);
    this.capture
      .startDocument$(next.documentId, this.host)
      .pipe(
        finalize(() => this.startingIds.delete(next.documentId)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: (error: unknown) =>
          this.workspace.message?.set(errorMessage(error)),
      });
  }

  private clearPartial(documentId: string): void {
    this.capture.streamingPartials.update((current) => {
      if (!current.has(documentId)) return current;
      const next = new Map(current);
      next.delete(documentId);
      return next;
    });
  }

  private captureDurations(recordings: readonly DesktopLibrarySummary[]): void {
    const ops = this.capture.streamingOperations();
    for (const document of recordings) {
      const durationMs = ops.get(document.documentId)?.durationMs;
      if (
        typeof durationMs === 'number'
        && Number.isFinite(durationMs)
        && durationMs > 0
        && this.knownDurations().get(document.documentId) !== durationMs
      ) {
        this.knownDurations.update((current) => {
          const next = new Map(current);
          next.set(document.documentId, durationMs);
          return next;
        });
      }
    }
  }

  private loadCompletedDetails(
    recordings: readonly DesktopLibrarySummary[],
  ): void {
    for (const document of recordings) {
      if (document.status !== 'completed') continue;
      if (this.loadingDetails.has(document.documentId)) continue;
      if (this.loadedUpdatedAt.get(document.documentId) === document.updatedAtMs) {
        continue;
      }
      this.loadingDetails.add(document.documentId);
      this.library
        .get(document.documentId)
        .pipe(
          tap((detail) => {
            this.loadedUpdatedAt.set(document.documentId, document.updatedAtMs);
            this.details.update((current) => {
              const next = new Map(current);
              next.set(document.documentId, detail);
              return next;
            });
          }),
          finalize(() => this.loadingDetails.delete(document.documentId)),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe({
          error: () => {
            // Avoid tight retry loops while preserving queued rows if a detail fetch fails.
            this.loadedUpdatedAt.set(document.documentId, document.updatedAtMs);
          },
        });
    }
  }
}
