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
import { DesktopCaptureService, type DesktopCaptureHost } from './desktop-capture.service';
import { LibraryExportService } from './library-export.service';
import { errorMessage } from './desktop-errors';
import { formatApproximateBytes } from './desktop-formatting.service';
import { isRecordingMediaType } from './capture-media-types';
import { committedTerminalStatus } from './capture-operation-status';
import { isFeatureReady } from './recognition-requirements';
import { RuntimeStatusStore } from './runtime-status.store';
import { LibraryStore } from './library.store';
import { installationProgress, installationPercent } from './installation-progress';
import { RecognitionFeaturesStore } from './recognition-features.store';
import { selectionRejectionMessages } from './source-selection-messages';

/**
 * Owns the recording queue's presentation, options, live partial transcript
 * and the user's actions for `/asr`. The capture service's admission starts
 * waiting recordings.
 */
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
  /** Recordings whose running capture is being cancelled: their Cancel waits for the end. */
  readonly cancellingIds = this.capture.cancellingIds;
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
    const cancellingIds = this.capture.cancellingIds();
    const unstored = this.capture.unstoredOutcomes();
    const details = this.details();
    const speechReady = this.speechReady();
    const installPercent = this.speechInstallPercent();
    return this.documents().map((document) =>
      describeAsrDocument({
        document,
        detail: details.get(document.documentId),
        operation: ops.get(document.documentId),
        owned: busyIds.has(document.documentId),
        cancelling: cancellingIds.has(document.documentId),
        unstored: unstored.has(document.documentId),
        failureReason: unstored.get(document.documentId) ?? null,
        speechReady,
        installPercent,
      }),
    );
  });

  /** The recording this run is capturing; its live lines end with the attempt. */
  readonly liveCapture = computed<AsrLiveCaptureView | null>(() => {
    const busyIds = this.capture.busyIds();
    const running = this.documents().find((document) => busyIds.has(document.documentId));
    if (!running) return null;
    return describeAsrLiveCapture({
      document: running,
      operation: this.capture.recordingOperations().get(running.documentId),
      partial: this.capture.streamingPartials().get(running.documentId) ?? null,
    });
  });

  private readonly host: DesktopCaptureHost = {
    selectedId: this.libraryStore.selectedId,
    requestedRequirements: this.features.requestedRequirements,
    requirements: () => this.features.requirements(),
    refreshDocuments: () => this.libraryStore.refreshDocuments(),
    applyDocumentState: (summary) => this.libraryStore.applyDocumentState(summary),
    setMessage: (text) => this.runtimeStatus.message.set(text),
  };

  /** Loads the list and the speaker counts of completed recordings. Called by the ASR page. */
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
        this.loadCompletedDetails(this.documents());
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

  /**
   * A failed Cancel or Start again is shown on this page's error line, where
   * the user gave it; the next action clears it.
   */
  cancel(documentId: string): void {
    this.importError.set('');
    this.capture.cancel$(documentId, this.host)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => this.importError.set(errorMessage(error)),
      });
  }

  startAgain(documentId: string): void {
    this.importError.set('');
    this.capture
      .startAgain$(documentId, this.host)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => this.importError.set(errorMessage(error)),
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

  private loadCompletedDetails(
    recordings: readonly DesktopLibrarySummary[],
  ): void {
    for (const document of recordings) {
      // Details are needed only for the speaker-count badge, never for duration.
      // A row of an earlier version shown done is read too.
      const completed = (committedTerminalStatus(document) ?? document.status) === 'completed';
      if (!completed || document.captureOptions?.identifySpeakers === false) continue;
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
