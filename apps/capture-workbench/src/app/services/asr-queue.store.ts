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
import { catchError, concatMap, EMPTY, finalize, from, tap, toArray } from 'rxjs';
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
import { DesktopCaptureService } from './desktop-capture.service';
import { LibraryExportService } from './library-export.service';
import { errorMessage } from './desktop-errors';
import { formatApproximateBytes } from './desktop-formatting.service';
import { holdsTerminalData, isActiveStreaming } from './capture-operation-status';
import { isRecordingMediaType } from './capture-media-types';
import { isFeatureReady } from './recognition-requirements';
import { RuntimeStatusStore } from './runtime-status.store';
import { LibraryStore } from './library.store';
import { installationProgress, installationPercent } from './installation-progress';
import { RecognitionFeaturesStore } from './recognition-features.store';
import { selectionRejectionMessages } from './source-selection-messages';

/** Owns the recording queue, options, live partial transcript, and capture orchestration for `/asr`. */
@Injectable({ providedIn: 'root' })
export class AsrQueueStore {
  private readonly runtimeStatus = inject(RuntimeStatusStore);
  private readonly libraryStore = inject(LibraryStore);
  private readonly library = inject(DesktopLibraryService);
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly capture = inject(DesktopCaptureService);
  private readonly features = inject(RecognitionFeaturesStore);
  private readonly exports = inject(LibraryExportService);
  readonly exportBusyIds = this.exports.busyIds;
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router, { optional: true });

  /** Session-only spoken language choice applied to newly added recordings. */
  readonly spokenLanguage = signal<AsrSpokenLanguage>('zh');
  /** Whether newly added recordings request speaker diarization (when requirement is ready). */
  readonly identifySpeakers = signal(false);
  readonly importError = signal('');

  private readonly details = signal<ReadonlyMap<string, DesktopLibraryDetail>>(new Map());
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

  readonly optionalSpeakerInstall = computed(() => {
    const requirement = this.features.requirements().find(
      (candidate) => candidate.requirementId === 'speaker-diarization',
    );
    if (!requirement || requirement.status === 'ready') return null;
    const installation = this.features.installationFor('speaker-diarization');
    const installing = installation?.status === 'queued' || installation?.status === 'running';
    const messages = desktopMessages();
    const progress = installationProgress(installation);
    return {
      installing,
      label: !installing
        ? messages.asrInstallSpeakers(formatApproximateBytes(requirement.downloadBytes))
        : progress.phase === 'preparing'
          ? messages.asrPreparingSpeakers
          : progress.phase === 'installing'
            ? messages.asrFinishingSpeakers
            : messages.asrInstallingSpeakers(progress.percent),
    };
  });

  readonly speechSizeLabel = computed(() => {
    const requirement = this.features
      .requirements()
      .find((candidate) => candidate.requirementId === 'speech-recognition');
    return formatApproximateBytes(requirement?.downloadBytes);
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
    sortAsrDocumentsOldestFirst(this.libraryStore.allDocuments()),
  );

  readonly rows = computed<readonly AsrQueueView[]>(() => {
    const ops = this.capture.recordingOperations();
    const busyIds = this.capture.busyIds();
    const details = this.details();
    const speechReady = this.speechReady();
    const installPercent = this.speechInstallPercent();
    return this.documents().map((document) =>
      describeAsrDocument({
        document,
        detail: details.get(document.documentId),
        operation: ops.get(document.documentId),
        busy: busyIds.has(document.documentId),
        speechReady,
        installPercent,
      }),
    );
  });

  readonly liveCapture = computed<AsrLiveCaptureView | null>(() => {
    const ops = this.capture.recordingOperations();
    const partials = this.capture.streamingPartials();
    const busyIds = this.capture.busyIds();
    const running = this.documents().find((document) => {
      if (document.status !== 'processing' && document.status !== 'persisting') {
        return false;
      }
      const op = ops.get(document.documentId);
      // Busy means a capture runs. A document that is only claimed while its
      // stored state is read has no capture yet, and gets no live card.
      return (
        busyIds.has(document.documentId)
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
    selectedId: this.libraryStore.selectedId,
    requestedRequirements: this.features.requestedRequirements,
    requirements: () => this.features.requirements(),
    documents: () => this.libraryStore.allDocuments(),
    selected: () => this.libraryStore.selected(),
    refreshDocuments: () => this.libraryStore.refreshDocuments(),
    reloadDocumentState: (documentId: string) => {
      this.loadedUpdatedAt.delete(documentId);
      this.libraryStore.reloadDocumentState(documentId);
    },
    setMessage: (text: string) => this.runtimeStatus.message.set(text),
    identifySpeakers: () => this.identifySpeakers(),
  };

  /** Connects queue coordination to runtime readiness and document updates. Called by the ASR page. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    effect(
      () => {
        if (this.runtime.ready()) {
          this.libraryStore.refreshDocuments();
        }
      },
      { injector: this.injector },
    );
    effect(
      () => {
        if (!this.runtime.ready()) return;
        const recordings = this.documents();
        const busyIds = this.capture.busyIds();
        // A decision that ended in an error changed nothing the queue can see:
        // this signal makes it look again, after the service's pause.
        this.capture.failedDecisions();

        const speechReady = this.speechReady();
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
      if (isRecordingMediaType(selection.mediaType)) {
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
            this.runtimeStatus.message.set(errorMessage(error)),
        });
    }
    this.importError.set(messages.join('\n'));
    if (recordings.length === 0) return;

    const captureOptions = this.snapshotCaptureOptions();
    from(recordings)
      .pipe(
        concatMap((selection) =>
          this.library.importSelection(selection, captureOptions).pipe(
            catchError((error: unknown) => {
              messages.push(errorMessage(error));
              this.importError.set(messages.join('\n'));
              return EMPTY;
            }),
          ),
        ),
        toArray(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => this.libraryStore.refreshDocuments(),
        error: (error: unknown) => {
          this.importError.set(errorMessage(error));
          this.libraryStore.refreshDocuments();
        },
      });
  }

  install(): void {
    this.features.installRequirement('speech-recognition');
  }

  installSpeakers(): void {
    this.features.installRequirement('speaker-diarization');
  }

  cancel(documentId: string): void {
    if (this.capture.isDocumentClaimed(documentId)) {
      this.capture.cancel(documentId);
      return;
    }
    this.capture.cancelDocument$(documentId, this.host)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => this.host.setMessage(errorMessage(error)),
      });
  }

  retry(documentId: string): void {
    if (!this.runtime.ready()) return;
    this.capture
      .retry$(documentId, this.host)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) =>
          this.runtimeStatus.message.set(errorMessage(error)),
      });
  }

  restart(documentId: string): void {
    if (!this.runtime.ready() || !this.speechReady()) return;
    this.capture
      .restartLost$(documentId, this.host)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) =>
          this.runtimeStatus.message.set(errorMessage(error)),
      });
  }

  view(documentId: string): void {
    void this.router?.navigateByUrl(`/history/${documentId}`);
  }

  exportTxt(documentId: string): void {
    if (this.exportBusyIds().has(documentId)) return;
    this.importError.set('');
    this.exports.run(documentId, 'text')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => this.importError.set(desktopMessages().exportFailed),
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
          || document.status === 'recovery_required'
          || holdsTerminalData(document))
        && document.captureId
        // The user asked to cancel this capture and the runtime refused it:
        // resuming it by itself would run on what the user cancelled. Only
        // the user's explicit retry reads it again.
        && document.recoveryCode !== 'cancel_failed'
        && !this.capture.isDocumentClaimed(document.documentId)
        // Asked for again when its pause ends: not remembered as attempted before.
        && !this.capture.isDecisionPaused(document.documentId)
        && !this.capture.busyIds().has(document.documentId)
        && !this.attemptedReattachments.has(document.captureId)
      ) {
        // Mark before subscribing: recovery can synchronously refresh the library.
        // A failed capture requires an explicit retry/restart, even after busy clears.
        const captureId = document.captureId;
        this.attemptedReattachments.add(captureId);
        this.capture
          .reattach$(document, this.host)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            // A capture's own failures are stored with the document. An error
            // here means the stored document could not be read, so nothing was
            // attempted: the capture may be tried again, after the pause the
            // service starts for a failed decision.
            error: (error: unknown) => {
              this.attemptedReattachments.delete(captureId);
              this.runtimeStatus.message.set(errorMessage(error));
            },
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
        || this.capture.isDocumentClaimed(document.documentId)
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
    this.capture
      .startDocument$(next.documentId, this.host)
      .pipe(
        finalize(() => this.startingIds.delete(next.documentId)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: (error: unknown) =>
          this.runtimeStatus.message.set(errorMessage(error)),
      });
  }


  private loadCompletedDetails(
    recordings: readonly DesktopLibrarySummary[],
  ): void {
    for (const document of recordings) {
      // Details are needed only for the speaker-count badge, never for duration.
      if (document.status !== 'completed' || document.captureOptions?.identifySpeakers === false) continue;
      if (this.loadingDetails.has(document.documentId)) continue;
      if (this.loadedUpdatedAt.get(document.documentId) === document.updatedAtMs) {
        continue;
      }
      this.loadingDetails.add(document.documentId);
      this.libraryStore
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
