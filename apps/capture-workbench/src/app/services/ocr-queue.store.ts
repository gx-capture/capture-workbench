import { computed, DestroyRef, effect, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, concatMap, EMPTY, finalize, from } from 'rxjs';
import type { DesktopCaptureOptions, DesktopLibrarySummary } from '../contracts';
import { selectionRejectionMessages } from './source-selection-messages';
import { desktopMessages } from '../i18n/desktop-messages';
import { DesktopLibraryService, type DesktopSourceSelection, type DesktopSourceSelectionBatch } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopCaptureService, type DesktopCaptureHost } from './desktop-capture.service';
import { LibraryExportService } from './library-export.service';
import { LibraryStore } from './library.store';
import {
  errorMessage,
  formatApproximateBytes,
  installationPercent,
} from './desktop-workspace.selectors';
import {
  installationProgress,
  installationProgressLabel,
} from './installation-progress';
import { RecognitionFeaturesStore } from './recognition-features.store';
import {
  describeOcrDocument,
  inImportOrder,
  isOcrMediaType,
  parsePdfPageList,
} from './ocr-queue';

@Injectable({ providedIn: 'root' })
/** Import, waiting queue, start, cancel, retry and progress for the OCR page. */
export class OcrQueueStore {
  private readonly library = inject(DesktopLibraryService);
  private readonly capture = inject(DesktopCaptureService);
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly features = inject(RecognitionFeaturesStore);
  private readonly libraryStore = inject(LibraryStore);
  private readonly exports = inject(LibraryExportService);
  readonly exportBusyIds = this.exports.busyIds;
  private readonly destroyRef = inject(DestroyRef);

  private readonly attached = signal(false);
  private readonly pendingStart = new Set<string>();
  private readonly reattached = new Set<string>();

  /** The page selection field. A drop and the file button both read it. */
  readonly pageListText = signal('');
  readonly parsedPageList = computed(() => parsePdfPageList(this.pageListText()));
  readonly pageListInvalid = computed(() => this.parsedPageList() === 'invalid');
  readonly pageListError = computed(() =>
    this.pageListInvalid() ? desktopMessages().ocrPageSelectionInvalid : '',
  );
  readonly importError = signal('');

  private readonly host: DesktopCaptureHost = {
    selectedId: signal<string | null>(null),
    requestedRequirements: this.features.requestedRequirements,
    requirements: () => this.features.requirements(),
    documents: () => this.sharedDocuments(),
    selected: () => null,
    refreshDocuments: () => this.refreshShared(),
    reloadDocumentState: () => this.refreshShared(),
    setMessage: (message) => this.importError.set(message),
    identifySpeakers: () => false,
  };

  readonly rows = computed(() => inImportOrder(this.sharedDocuments())
    .filter((document) => isOcrMediaType(document.mediaType))
    .map((document) => describeOcrDocument({
      document,
      operation: this.capture.oneShotOperations().get(document.documentId),
      busy: this.capture.busyIds().has(document.documentId),
      ocrReady: this.features.isFeatureReady('ocr'),
      installPercent: this.ocrInstallPercent(),
    })));

  readonly ocrSizeLabel = computed(() => {
    const requirement = this.features.requirements()
      .find((item) => item.requirementId === 'windowsml-ocr');
    return formatApproximateBytes(requirement?.downloadBytes);
  });

  private readonly runningOcrInstallation = computed(() => {
    const active = this.features.activeInstallation();
    if (!active || active.requirementId !== 'windowsml-ocr') return null;
    if (active.status !== 'queued' && active.status !== 'running') return null;
    return active;
  });

  private readonly ocrInstallPercent = computed(() => {
    const running = this.runningOcrInstallation();
    return running ? installationPercent(running) : null;
  });

  /** What a waiting file shows while text recognition installs. */
  readonly ocrInstallLabel = computed(() =>
    installationProgressLabel(
      installationProgress(this.runningOcrInstallation()),
      desktopMessages(),
    ));

  private readonly loadEffect = effect(() => {
    if (!this.attached() || !this.runtime.started()) return;
    this.refreshShared();
  });

  private readonly workEffect = effect(() => {
    if (!this.attached() || !this.runtime.started()) return;
    // Waiting files start in the order they were imported, the order the queue shows.
    const documents = inImportOrder(this.sharedDocuments());
    if (this.features.isFeatureReady('ocr')) this.startWaiting(documents);
    this.reattachRunning(documents);
  });

  /** Safe to call more than once. The document list itself lives on `LibraryStore`. */
  attach(): void {
    this.attached.set(true);
  }

  install(): void {
    this.features.installRequirement('windowsml-ocr');
  }

  cancel(documentId: string): void {
    this.capture.cancel(documentId);
  }

  retry(documentId: string): void {
    this.capture.retry$(documentId, this.host)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => this.importError.set(errorMessage(error)),
      });
  }

  restart(documentId: string): void {
    this.capture.restartLost$(documentId, this.host)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => this.importError.set(errorMessage(error)),
      });
  }

  exportTxt(documentId: string): void {
    if (this.exportBusyIds().has(documentId)) return;
    const document = this.sharedDocuments().find((item) => item.documentId === documentId);
    if (!document?.hasRaw) return;
    this.importError.set('');
    this.exports.run(documentId, 'text')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => this.importError.set(desktopMessages().exportFailed),
      });
  }

  /** Opens the existing picker, limited to PDF and image files, then queues the selections. */
  chooseFiles(): void {
    this.library.selectSources('documents')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (batch) => {
          this.importSelections(batch);
        },
        error: (error: unknown) => this.importError.set(errorMessage(error)),
      });
  }

  /**
   * Saves each accepted selection as a waiting document. Capture starts later, when OCR is ready.
   * The host reads the file and checks its size.
   */
  importSelections(batch: DesktopSourceSelectionBatch): void {
    const pageList = this.parsedPageList();
    if (pageList === 'invalid') {
      this.library.discardSelections(batch.selections).subscribe({ error: () => undefined });
      return;
    }
    const rejected = [...batch.rejected];
    const errors: string[] = [];
    const refusedSelections: DesktopSourceSelection[] = [];
    const accepted: { readonly selection: DesktopSourceSelection; readonly options?: DesktopCaptureOptions }[] = [];
    for (const selection of batch.selections) {
      if (!isOcrMediaType(selection.mediaType)) {
        rejected.push('unsupported');
        refusedSelections.push(selection);
        continue;
      }
      const pdf = selection.mediaType === 'application/pdf';
      accepted.push({
        selection,
        ...(pdf && Array.isArray(pageList) ? { options: { pdfPageNumbers: pageList } } : {}),
      });
    }
    errors.unshift(...selectionRejectionMessages({ selections: [], rejected }));
    this.library.discardSelections(refusedSelections).subscribe({ error: () => undefined });
    this.importError.set(errors.join('\n'));
    if (accepted.length === 0) return;
    from(accepted)
      .pipe(
        concatMap((item) => {
          const request = this.library.importSelection(item.selection, item.options);
          return request.pipe(
            catchError((error: unknown) => {
              errors.push(errorMessage(error));
              this.importError.set(errors.join('\n'));
              return EMPTY;
            }),
          );
        }),
        finalize(() => {
          this.importError.set(errors.join('\n'));
          this.refreshShared();
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private sharedDocuments(): readonly DesktopLibrarySummary[] {
    return this.libraryStore.allDocuments();
  }

  private refreshShared(): void {
    this.libraryStore.refreshDocuments();
  }

  private startWaiting(documents: readonly DesktopLibrarySummary[]): void {
    for (const document of documents) {
      if (!isOcrMediaType(document.mediaType)) continue;
      if (document.status !== 'queued' || document.captureId) continue;
      if (this.pendingStart.has(document.documentId)) continue;
      if (this.capture.hasActiveCapture(document.documentId)) continue;
      this.pendingStart.add(document.documentId);
      this.capture.startDocument$(document.documentId, this.host)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          error: () => this.pendingStart.delete(document.documentId),
          complete: () => this.pendingStart.delete(document.documentId),
        });
    }
  }

  private reattachRunning(documents: readonly DesktopLibrarySummary[]): void {
    for (const document of documents) {
      if (!isOcrMediaType(document.mediaType) || !document.captureId) continue;
      if (document.status !== 'processing' && document.status !== 'persisting') continue;
      if (this.reattached.has(document.documentId)) continue;
      if (this.capture.hasActiveCapture(document.documentId)) continue;
      this.reattached.add(document.documentId);
      this.capture.reattach$(document, this.host)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          error: () => this.reattached.delete(document.documentId),
        });
    }
  }
}
