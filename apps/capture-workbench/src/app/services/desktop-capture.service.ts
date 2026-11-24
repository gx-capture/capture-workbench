import { Injectable, inject, signal, type WritableSignal } from '@angular/core';

import {
  EMPTY,
  ReplaySubject,
  Subject,
  catchError,
  concatMap,
  defer,
  expand,
  filter,
  finalize,
  from,
  ignoreElements,
  map,
  merge,
  mergeMap,
  type Observable,
  of,
  switchMap,
  take,
  takeUntil,
  tap,
  throwError,
  throwIfEmpty,
  timer,
} from 'rxjs';
import type {
  CaptureEvent,
  CaptureOperation,
  CaptureRequirementId,
  OcrComputePreflight,
  PartialCapture,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import type { DesktopLibrarySummary, OcrEvidenceExpectedIdentity } from '../contracts';
import { buildOcrEvidence } from '../contracts';
import { DesktopLibraryService, type DesktopSourceSelection } from './desktop-library.service';
import {
  DesktopRuntimeClientService,
  type DesktopCaptureOperation,
} from './desktop-runtime-client.service';
import {
  canStartAgain,
  isActiveOneShotOperation,
  isActiveStreaming,
  isOcrCheckpoint,
  isWaiting,
  terminalLibraryStatus,
} from './capture-operation-status';
import { errorMessage } from './desktop-errors';
import { isRecordingMediaType, isPdfMediaType } from './capture-media-types';
import { isFeatureReady } from './recognition-requirements';
import { inImportOrder } from './ocr-queue';
import { desktopMessages } from '../i18n/desktop-messages';

/**
 * One capture of one document by this app run, from before its first library
 * write until its terminal write has answered. Nothing follows a runtime
 * capture that another run started.
 */
interface CaptureAttempt {
  readonly documentId: string;
  readonly clientRequestId: string;
  readonly streaming: boolean;
  /** The stored document the attempt was admitted from: media type and options. */
  readonly stored: DesktopLibrarySummary;
  /** Readiness identity captured by the host before the runtime operation starts. */
  readonly ocrCompute: OcrComputePreflight | null;
  /** PDF page selection the capture was started with, or undefined for all pages / non-PDFs. */
  readonly pdfPageNumbers?: readonly number[];
  captureId?: string;
  /** Source identity received from the runtime operation, never from OCR output. */
  sourceSha256?: string;
  lastEventSequence: number;
  uploadStarted: boolean;
  cancelRequested: boolean;
  /** Set when the terminal write is sent: a Cancel after it does nothing. */
  terminalWriteSent: boolean;
  /** Emits once on Cancel: every runtime read in flight is abandoned. */
  readonly cancelled: ReplaySubject<void>;
  /** The runtime delete a Cancel sent; emits once that delete has answered, whatever the answer. */
  cancelDelete?: ReplaySubject<void>;
}

/** A decision being made from a document's stored state; a Cancel meanwhile is applied by it. */
interface DocumentDecision {
  cancelRequested: boolean;
}

type CaptureUpdate = Parameters<DesktopLibraryService['updateCapture']>[0];

/** Ends the steps of an attempt that a Cancel stopped. */
const CANCELLED = new Error('Capture was cancelled.');

export interface DesktopCaptureHost {
  readonly selectedId: WritableSignal<string | null>;
  readonly requestedRequirements: WritableSignal<ReadonlySet<CaptureRequirementId>>;
  readonly requirements: () => readonly RuntimeRequirement[];
  readonly refreshDocuments: () => void;
  /** Shows the summary a library write returned in the document list at once. */
  readonly applyDocumentState: (summary: DesktopLibrarySummary) => void;
  readonly setMessage: (message: string) => void;
}

@Injectable({ providedIn: 'root' })
/**
 * Owns the captures this app run starts, for the shell and the OCR and
 * recording queue stores. A capture belongs to the run that started it: a
 * stored runtime link is only an address for cleanup, never followed again.
 * Captures run one at a time, recordings and documents together, and only
 * the admission (`admitWaiting$`) starts one; everything else makes a
 * document waiting or stops it.
 */
export class DesktopCaptureService {
  /**
   * Documents with a capture attempt of this run: what "owned by this run"
   * means. A document leaves it only after the list shows the outcome of the
   * attempt's last write.
   */
  readonly busyIds = signal<ReadonlySet<string>>(new Set());
  readonly streamingPartials = signal<ReadonlyMap<string, PartialCapture>>(new Map());
  /** Live streaming operations, so the ASR queue can show audio time progress. */
  readonly recordingOperations = signal<ReadonlyMap<string, CaptureOperation>>(new Map());
  /** Live one-shot operations, so a queue can show page progress that the library does not store. */
  readonly oneShotOperations = signal<ReadonlyMap<string, DesktopCaptureOperation>>(new Map());
  private readonly unstored = signal<ReadonlyMap<string, string | null>>(new Map());
  /**
   * Documents whose start or cancel in this run ended without its outcome
   * being stored. The row can still say `queued`, and the admission would
   * pick it again and again, or start what the user cancelled: it passes
   * them by until the user's Start again or Cancel succeeds. Such a row
   * does not wait: it needs the user. Memory only: the next app run starts
   * without it, and nothing of it is stored.
   *
   * Each entry keeps the reason its row shows: the error of the admission's
   * read or of the attempt's last write, or null when the page where the
   * user gave the Start again or Cancel shows that error itself.
   */
  readonly unstoredOutcomes = this.unstored.asReadonly();
  private readonly cancelling = signal<ReadonlySet<string>>(new Set());
  /**
   * Documents whose running attempt is being cancelled: from the user's
   * Cancel until the attempt has ended (the runtime delete answered and the
   * cancelled state was written). A second Cancel does nothing meanwhile.
   */
  readonly cancellingIds = this.cancelling.asReadonly();

  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly attempts = new Map<string, CaptureAttempt>();
  /**
   * Documents for which an action is being decided from their stored state:
   * from the subscription to the entry until the action it led to has ended,
   * was declined or failed.
   */
  private readonly deciding = new Map<string, DocumentDecision>();
  private readonly deletingDocuments = signal<ReadonlySet<string>>(new Set());
  /** Asks the admission to look again: a claim ended or an import stored waiting documents. */
  private readonly admissionRequests = new Subject<void>();
  /** The admission is deciding about, or capturing, a document. */
  private admitting = false;

  /**
   * Reports whether the document is claimed: a capture runs for it, a
   * decision is in progress, or the library is deleting it. Nothing else may
   * start or delete it meanwhile.
   */
  isDocumentClaimed(documentId: string): boolean {
    return this.attempts.has(documentId)
      || this.deciding.has(documentId)
      || this.deletingDocuments().has(documentId);
  }

  /** Claims an unclaimed document for deletion until the operation settles. */
  claimDocumentForDeletion$(documentId: string, remove: () => Observable<void>): Observable<void> {
    return defer(() => {
      if (this.isDocumentClaimed(documentId)) return EMPTY;
      this.deletingDocuments.update((ids) => new Set(ids).add(documentId));
      return defer(remove).pipe(finalize(() => {
        this.deletingDocuments.update((ids) => {
          const remaining = new Set(ids);
          remaining.delete(documentId);
          return remaining;
        });
        // A document the delete kept can be the next to start.
        this.admissionRequests.next();
      }));
    });
  }

  /**
   * Asks the runtime to delete a capture, without waiting for the answer and
   * without storing anything about it. Skipped while the runtime is not
   * ready; the runtime's retention removes what is left.
   */
  deleteRuntimeCapture(captureId: string): void {
    if (!this.runtime.ready()) return;
    this.runtime.deleteCapture(captureId).pipe(take(1), catchError(() => EMPTY)).subscribe();
  }

  /**
   * Once per app run, when the runtime is ready: asks the runtime to delete
   * the capture of every linked document this run does not own. The runs
   * that started them have ended, so whatever still runs there is stopped.
   * Nothing is stored about it: the rows keep their link, and are shown
   * interrupted, until Start again or Delete. Only a capture this run
   * created is skipped; a row a decision is reading keeps no capture of
   * this run, and the decision may decline.
   */
  deleteLinkedRuntimeCaptures$(): Observable<void> {
    return this.library.list().pipe(
      take(1),
      tap((documents) => {
        const created = new Set([...this.attempts.values()].map((attempt) => attempt.captureId));
        for (const document of documents) {
          if (document.captureId && !created.has(document.captureId)) {
            this.deleteRuntimeCapture(document.captureId);
          }
        }
      }),
      ignoreElements(),
    );
  }

  /**
   * The one place that starts a capture, wired once from the app shell and
   * running from app start: at most one attempt of this run exists at a
   * time, for recordings and documents together. While none is active it
   * takes the oldest waiting document (`isWaiting`, in import order) whose
   * feature is ready and that is not in `unstoredOutcomes`, reads it fresh
   * and starts it. It looks again when `changes$` emits (the document list,
   * the requirements or the runtime's readiness changed), when an attempt
   * or any other claim on a document has ended, and after an import.
   */
  admitWaiting$(host: DesktopCaptureHost, changes$: Observable<unknown>): Observable<void> {
    return merge(changes$, this.admissionRequests).pipe(
      // A newer look replaces one whose list read has not answered yet.
      switchMap(() => this.admitting || !this.runtime.ready() ? EMPTY : this.nextWaiting$(host)),
      mergeMap((documentId) => this.admit$(documentId, host)),
    );
  }

  /**
   * Imports dropped sources as waiting documents; the admission starts them
   * in their turn. A document whose feature is missing asks for it.
   */
  addSelections$(
    selections: readonly DesktopSourceSelection[],
    host: DesktopCaptureHost,
  ): Observable<void> {
    return from(selections).pipe(
      concatMap((selection) => this.library.importSelection(selection).pipe(
        tap((document) => {
          host.selectedId.set(document.documentId);
          this.requestMissingFeature(document, host);
        }),
        catchError((error: unknown) => { host.setMessage(errorMessage(error)); return EMPTY; }),
      )),
      ignoreElements(),
      finalize(() => {
        host.refreshDocuments();
        this.admissionRequests.next();
      }),
    );
  }

  /**
   * The user's Start again for a document that failed, was cancelled or was
   * interrupted and holds no raw result (`canStartAgain`), read fresh. It is
   * stored waiting again, as a fresh import is (no link, no error), and the
   * admission starts it in its turn. The runtime capture an old link names
   * is deleted, without waiting for the answer. A row still stored waiting
   * whose start or cancel this run could not store needs no write: it only
   * leaves `unstoredOutcomes`.
   */
  startAgain$(
    documentId: string,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return defer(() => !this.runtime.ready()
      ? EMPTY
      : this.decideFromStoredDocument$(documentId, host, (stored) => {
        if (stored && isWaiting(stored) && this.unstoredOutcomes().has(documentId)) {
          this.forgetUnstoredOutcome(documentId);
          return EMPTY;
        }
        if (!stored || !canStartAgain(stored)) return this.declineOutdatedRequest$(host);
        if (stored.captureId) this.deleteRuntimeCapture(stored.captureId);
        return this.write$(host, {
          documentId,
          status: 'queued',
          stage: 'uploading',
          clearCaptureId: true,
        }).pipe(
          // The user's Start again ends the pass-by of an earlier unstored outcome.
          tap(() => this.forgetUnstoredOutcome(documentId)),
          map(() => undefined),
        );
      }));
  }

  /**
   * The user's Cancel. The running capture is deleted at the runtime and
   * then stored cancelled; a decision in progress stores the document
   * cancelled instead of starting it; a waiting document is stored cancelled
   * without a runtime request. Once the terminal write of a capture has been
   * sent, a Cancel does nothing.
   */
  cancel$(documentId: string, host: DesktopCaptureHost): Observable<void> {
    return defer(() => {
      if (this.deletingDocuments().has(documentId)) return EMPTY;
      const attempt = this.attempts.get(documentId);
      if (attempt) {
        this.cancelAttempt(attempt);
        return EMPTY;
      }
      const decision = this.deciding.get(documentId);
      if (decision) {
        decision.cancelRequested = true;
        return EMPTY;
      }
      return this.decideFromStoredDocument$(documentId, host, (stored) =>
        stored && isWaiting(stored)
          ? this.storeCancelled$(documentId, host)
          : this.declineOutdatedRequest$(host)).pipe(
        // A cancel whose read or write failed is remembered: the row can
        // still say `queued`, and the admission must not start it.
        tap({ error: () => this.rememberUnstoredOutcome(documentId) }),
      );
    });
  }

  /** The oldest document the admission may start, from a fresh read of the library. */
  private nextWaiting$(host: DesktopCaptureHost): Observable<string> {
    return this.library.list().pipe(
      take(1),
      map((documents) => inImportOrder(documents).find((document) =>
        this.startable(document, host) && !this.isDocumentClaimed(document.documentId))?.documentId),
      filter((documentId): documentId is string => documentId !== undefined),
      // A failed read starts nothing; the next change looks again.
      catchError(() => EMPTY),
    );
  }

  /**
   * Waiting, its feature ready, and no start or cancel of it left unstored
   * in this run. A document whose feature is not ready does not hold up the
   * next one: it starts when its feature becomes ready.
   */
  private startable(document: DesktopLibrarySummary, host: DesktopCaptureHost): boolean {
    return isWaiting(document)
      && this.featureReady(document, host)
      && !this.unstoredOutcomes().has(document.documentId);
  }

  /** Decides from the stored document and captures it; ends the admission's turn. */
  private admit$(documentId: string, host: DesktopCaptureHost): Observable<void> {
    return defer(() => {
      if (this.admitting) return EMPTY;
      this.admitting = true;
      return this.decideFromStoredDocument$(documentId, host, (stored) =>
        stored && this.startable(stored, host)
          ? this.capture$(stored, host)
          : this.declineOutdatedRequest$(host)).pipe(
        // Only the read of the stored document can fail here: the document
        // is passed by, and the next one is not held up. Its row shows why.
        catchError((error: unknown) => {
          this.rememberUnstoredOutcome(documentId, errorMessage(error));
          return EMPTY;
        }),
        finalize(() => {
          this.admitting = false;
          this.admissionRequests.next();
        }),
      );
    });
  }

  /**
   * Reads the stored document and lets `act` decide from it. A caller's
   * document list can be older than this service's last write for the
   * document (its reload has not answered yet), so nothing is decided from
   * that list.
   *
   * The decision claims the document from the subscription on, as a running
   * capture does (`isDocumentClaimed`): one decision or capture runs per
   * document at a time, and a claimed document accepts no other entry. The
   * entries are cold: nothing is claimed, read or written before a caller
   * subscribes. A Cancel that arrives while the document is read wins over a
   * start: the document is stored cancelled.
   */
  private decideFromStoredDocument$(
    documentId: string,
    host: DesktopCaptureHost,
    act: (stored: DesktopLibrarySummary | undefined) => Observable<void>,
  ): Observable<void> {
    return defer(() => {
      if (this.isDocumentClaimed(documentId)) return EMPTY;
      const decision: DocumentDecision = { cancelRequested: false };
      this.deciding.set(documentId, decision);
      return this.library.list().pipe(
        take(1),
        map((documents) => documents.find((item) => item.documentId === documentId)),
        switchMap((stored) => decision.cancelRequested && stored
          && (isWaiting(stored) || canStartAgain(stored))
          ? this.storeCancelled$(documentId, host)
          : act(stored)),
        // A cancel given meanwhile that this decision could not apply is
        // remembered: the row can still say `queued`, and the admission
        // must not start it.
        tap({ error: () => { if (decision.cancelRequested) this.rememberUnstoredOutcome(documentId); } }),
        // Also when the read fails or is unsubscribed: nothing stays claimed.
        finalize(() => {
          this.deciding.delete(documentId);
          this.admissionRequests.next();
        }),
      );
    });
  }

  /** The caller acted on an outdated document list: nothing to do but refresh it. */
  private declineOutdatedRequest$(host: DesktopCaptureHost): Observable<void> {
    return defer(() => {
      host.refreshDocuments();
      return EMPTY;
    });
  }

  /** Stores a document that has no capture running as cancelled. */
  private storeCancelled$(documentId: string, host: DesktopCaptureHost): Observable<void> {
    return this.write$(host, {
      documentId,
      status: 'canceled',
      stage: 'cancelled',
      clearCaptureId: true,
    }).pipe(
      // A failed write leaves the row `queued`: the admission must not pick it.
      tap({
        next: () => this.forgetUnstoredOutcome(documentId),
        error: () => this.rememberUnstoredOutcome(documentId),
      }),
      map(() => undefined),
    );
  }

  /**
   * A dropped document waits for a feature that is not installed: ask for
   * it, as the pages do. The admission starts the document once it is ready.
   */
  private requestMissingFeature(document: DesktopLibrarySummary, host: DesktopCaptureHost): void {
    const messages = desktopMessages();
    const recording = isRecordingMediaType(document.mediaType);
    const missing: readonly [CaptureRequirementId, string] | undefined = recording
      ? (isFeatureReady(host.requirements(), 'asr') ? undefined : ['speech-recognition', messages.speechRequirementNeeded])
      : (isFeatureReady(host.requirements(), 'ocr') ? undefined : ['text-recognition', messages.needsSetup]);
    if (!missing) return;
    const [requirementId, message] = missing;
    host.requestedRequirements.update((current) => new Set([...current, requirementId]));
    host.setMessage(message);
  }

  private featureReady(stored: DesktopLibrarySummary, host: DesktopCaptureHost): boolean {
    return isFeatureReady(host.requirements(), isRecordingMediaType(stored.mediaType) ? 'asr' : 'ocr');
  }

  /**
   * Starts an attempt for the stored document and ends it with one terminal
   * write: the result, the runtime's failure, a failure of this run, or the
   * cancel. A failure of that write ends the attempt too: nothing is tried
   * again by itself.
   */
  private capture$(stored: DesktopLibrarySummary, host: DesktopCaptureHost): Observable<void> {
    return defer(() => {
      const { documentId } = stored;
      if (!this.runtime.ready() || this.attempts.has(documentId)) return EMPTY;
      const attempt: CaptureAttempt = {
        documentId,
        clientRequestId: crypto.randomUUID(),
        streaming: isRecordingMediaType(stored.mediaType),
        stored,
        ocrCompute: this.runtime.ocrCompute(),
        pdfPageNumbers: this.pdfPageNumbersFor(stored),
        lastEventSequence: 0,
        uploadStarted: false,
        cancelRequested: false,
        terminalWriteSent: false,
        cancelled: new ReplaySubject<void>(1),
      };
      this.attempts.set(documentId, attempt);
      this.markBusy(documentId, true);
      // The live lines of an earlier capture of the document end here.
      this.clearStreamingPartial(documentId);

      return this.write$(host, {
        documentId,
        status: 'processing',
        stage: 'uploading',
        clearCaptureId: true,
      }).pipe(
        switchMap(() => attempt.streaming
          ? this.captureRecording$(attempt, host)
          : this.captureDocument$(attempt, host)),
        catchError((error: unknown) => {
          if (attempt.terminalWriteSent) return throwError(() => error);
          // A create that fails after a Cancel ends as cancelled too.
          return attempt.cancelRequested
            ? this.endCancelled$(attempt, host)
            : this.terminalWrite$(attempt, host, {
              documentId,
              status: 'failed',
              stage: 'failed',
              clearCaptureId: true,
              errorCode: 'capture_failed',
              errorMessage: errorMessage(error),
            });
        }),
        // The terminal write failed: the row shows why.
        catchError((error: unknown) => {
          this.rememberUnstoredOutcome(documentId, errorMessage(error));
          return EMPTY;
        }),
        finalize(() => {
          attempt.cancelled.complete();
          this.attempts.delete(documentId);
          this.forgetOneShotOperation(documentId);
          this.forgetRecordingOperation(documentId);
          this.clearStreamingPartial(documentId);
          this.cancelling.update((ids) => withoutMember(ids, documentId));
          this.markBusy(documentId, false);
        }),
      );
    });
  }

  /**
   * Requests the cancel of a running attempt. The runtime delete is sent at
   * once when the capture is known; during the upload, the upload is
   * cancelled and the create's answer decides. Reads in flight are abandoned.
   */
  private cancelAttempt(attempt: CaptureAttempt): void {
    if (attempt.cancelRequested || attempt.terminalWriteSent) return;
    attempt.cancelRequested = true;
    this.cancelling.update((ids) => new Set(ids).add(attempt.documentId));
    if (attempt.captureId) {
      this.sendCancelDelete(attempt);
    } else if (attempt.uploadStarted) {
      this.runtime.cancelUpload(attempt.clientRequestId).pipe(
        take(1),
        catchError(() => EMPTY),
      ).subscribe();
    }
    attempt.cancelled.next();
  }

  /** Sends the one runtime delete of a cancelled attempt whose capture is known. */
  private sendCancelDelete(attempt: CaptureAttempt): void {
    if (attempt.cancelDelete || !attempt.captureId) return;
    const answered = new ReplaySubject<void>(1);
    attempt.cancelDelete = answered;
    this.runtime.deleteCapture(attempt.captureId).pipe(
      take(1),
      ignoreElements(),
      catchError(() => EMPTY),
    ).subscribe({ complete: () => answered.next() });
  }

  /**
   * The cancel's end: once the runtime delete has answered (the runtime
   * answers after the capture's work and its worker process have ended,
   * and the host bounds the wait), the
   * document is stored cancelled without its link, whatever the answer.
   * Nothing of the capture is fetched or saved.
   */
  private endCancelled$(attempt: CaptureAttempt, host: DesktopCaptureHost): Observable<void> {
    return defer(() => {
      this.sendCancelDelete(attempt);
      const deleted$: Observable<unknown> = attempt.cancelDelete ?? of(undefined);
      return deleted$.pipe(
        take(1),
        switchMap(() => this.terminalWrite$(attempt, host, {
          documentId: attempt.documentId,
          status: 'canceled',
          stage: 'cancelled',
          clearCaptureId: true,
        })),
      );
    });
  }

  /**
   * The attempt's one terminal write; after it, the runtime capture is
   * deleted without waiting, unless a cancel already deleted it.
   */
  private terminalWrite$(
    attempt: CaptureAttempt,
    host: DesktopCaptureHost,
    update: CaptureUpdate,
  ): Observable<void> {
    return defer(() => {
      attempt.terminalWriteSent = true;
      return this.write$(host, update).pipe(
        finalize(() => {
          if (attempt.captureId && !attempt.cancelDelete) this.deleteRuntimeCapture(attempt.captureId);
        }),
        map(() => undefined),
      );
    });
  }

  /** A library write whose answer the list shows at once. */
  private write$(host: DesktopCaptureHost, update: CaptureUpdate): Observable<DesktopLibrarySummary> {
    return this.library.updateCapture(update).pipe(tap((summary) => host.applyDocumentState(summary)));
  }

  /** A runtime read of a running attempt, abandoned when the attempt is cancelled. */
  private untilCancelled$<T>(attempt: CaptureAttempt, read$: Observable<T>): Observable<T> {
    return read$.pipe(takeUntil(attempt.cancelled), throwIfEmpty(() => CANCELLED));
  }

  /**
   * Creates the runtime capture; its answer is checked for a cancel in both
   * outcomes. A capture created after a cancel is deleted and never linked.
   */
  private create$<T extends CaptureOperation>(
    attempt: CaptureAttempt,
    create: () => Observable<T>,
    host: DesktopCaptureHost,
  ): Observable<T> {
    return defer(() => {
      if (attempt.cancelRequested) return throwError(() => CANCELLED);
      attempt.uploadStarted = true;
      return create().pipe(
        take(1),
        throwIfEmpty(() => new Error('Capture Runtime returned no capture.')),
        switchMap((operation) => {
          attempt.captureId = operation.captureId;
          if (attempt.cancelRequested) return throwError(() => CANCELLED);
          return this.write$(host, {
            documentId: attempt.documentId,
            captureId: operation.captureId,
            status: 'processing',
            stage: operation.status,
          }).pipe(map(() => operation));
        }),
      );
    });
  }

  private captureDocument$(attempt: CaptureAttempt, host: DesktopCaptureHost): Observable<void> {
    return this.create$(
      attempt,
      () => this.runtime.createCapture(attempt.documentId, attempt.clientRequestId, attempt.pdfPageNumbers).pipe(
        tap((operation) => {
          this.rememberSourceIdentity(attempt, operation);
          this.rememberOneShotOperation(attempt.documentId, operation);
        }),
      ),
      host,
    ).pipe(
      switchMap((operation) => this.untilCancelled$(attempt, this.followDocument$(attempt, operation))),
      switchMap((operation) => {
        if (isOcrCheckpoint(operation)) {
          return this.storeOcrCheckpoint$(attempt, operation, host);
        }
        if (operation.status === 'failed' || operation.status === 'cancelled') {
          return this.storeRuntimeEnd$(attempt, operation, host);
        }
        return throwError(() => new Error(
          `Capture Runtime returned unsupported terminal status: ${operation.status}`,
        ));
      }),
    );
  }

  /** Polls an OCR capture until it reaches its checkpoint or ends. */
  private followDocument$(
    attempt: CaptureAttempt,
    initial: DesktopCaptureOperation,
  ): Observable<DesktopCaptureOperation> {
    const settled = (operation: DesktopCaptureOperation): boolean =>
      !isActiveOneShotOperation(operation) || isOcrCheckpoint(operation);
    return of(initial).pipe(
      expand((operation) => settled(operation)
        ? EMPTY
        : timer(700).pipe(
          switchMap(() => this.runtime.getCapture(operation.captureId)),
          tap((next) => {
            this.rememberSourceIdentity(attempt, next);
            this.rememberOneShotOperation(attempt.documentId, next);
          }),
        )),
      filter(settled),
      take(1),
    );
  }

  /**
   * The OCR checkpoint: raw text and verified completed evidence are stored
   * with `awaiting_confirmation` and without the link, in one write.
   */
  private storeOcrCheckpoint$(
    attempt: CaptureAttempt,
    operation: DesktopCaptureOperation,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return this.untilCancelled$(attempt, defer(() => this.runtime.getRaw(operation.captureId)).pipe(
      take(1),
      switchMap((raw) => raw
        ? this.runtime.getOcr(operation.captureId).pipe(take(1), map((projection) => ({ raw, projection })))
        : throwError(() => new Error(desktopMessages().missingRawResult))),
      switchMap(({ raw, projection }) => {
        if (projection.status !== 'completed' || projection.pages.some((page) => page.status === 'failed')) {
          return throwError(() => new Error('Capture Runtime OCR checkpoint is not complete.'));
        }
        return buildOcrEvidence({
          projection,
          expected: this.expectedOcrIdentity(operation, attempt),
          requestedPages: attempt.pdfPageNumbers ?? null,
        }).pipe(map((ocrEvidence) => ({ raw, ocrEvidence })));
      }),
    )).pipe(
      switchMap(({ raw, ocrEvidence }) => this.terminalWrite$(attempt, host, {
        documentId: attempt.documentId,
        status: 'awaiting_confirmation',
        stage: operation.status,
        clearCaptureId: true,
        raw,
        ocrEvidence,
      })),
    );
  }

  /** A capture the runtime ended as failed or cancelled: nothing of it is saved. */
  private storeRuntimeEnd$(
    attempt: CaptureAttempt,
    operation: CaptureOperation,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return this.terminalWrite$(attempt, host, {
      documentId: attempt.documentId,
      status: terminalLibraryStatus(operation),
      stage: operation.status,
      clearCaptureId: true,
      errorCode: operation.error?.code,
      errorMessage: operation.error?.message,
    });
  }

  private captureRecording$(attempt: CaptureAttempt, host: DesktopCaptureHost): Observable<void> {
    const options = attempt.stored.captureOptions;
    return this.create$(
      attempt,
      () => this.runtime.startRecordingCapture({
        documentId: attempt.documentId,
        clientRequestId: attempt.clientRequestId,
        structuringMode: 'runtime',
        // The import stores the user's choice with the recording.
        identifySpeakers:
          (options?.identifySpeakers ?? false)
          && isFeatureReady(host.requirements(), 'asr.speakers'),
        ...(options?.spokenLanguage ? { spokenLanguage: options.spokenLanguage } : {}),
      }).pipe(tap((operation) => this.rememberRecordingOperation(attempt.documentId, operation))),
      host,
    ).pipe(
      switchMap((operation) => this.untilCancelled$(attempt, this.followRecording$(attempt, operation))),
      switchMap((operation) => operation.status === 'completed'
        ? this.untilCancelled$(attempt, defer(() => this.runtime.getResult(operation.captureId)).pipe(take(1))).pipe(
          switchMap((terminal) => this.terminalWrite$(attempt, host, {
            documentId: attempt.documentId,
            status: 'completed',
            stage: operation.status,
            clearCaptureId: true,
            raw: terminal.raw,
            result: terminal.result,
          })),
        )
        : this.storeRuntimeEnd$(attempt, operation, host)),
    );
  }

  /** Reads events, the live partial and the status of a recording until it ends. */
  private followRecording$(
    attempt: CaptureAttempt,
    initial: CaptureOperation,
  ): Observable<CaptureOperation> {
    return this.readRecording$(attempt, initial.captureId).pipe(
      expand((operation) => isActiveStreaming(operation)
        ? timer(500).pipe(switchMap(() => this.readRecording$(attempt, operation.captureId)))
        : EMPTY),
      filter((operation) => !isActiveStreaming(operation)),
      take(1),
    );
  }

  private readRecording$(attempt: CaptureAttempt, captureId: string): Observable<CaptureOperation> {
    return defer(() => this.runtime.getCaptureEvents(captureId, attempt.lastEventSequence)).pipe(
      tap((events) => events.forEach((event) => this.applyStreamingEvent(attempt, event))),
      switchMap(() => this.runtime.getPartial(captureId)),
      tap((partial) => {
        if (partial) {
          this.streamingPartials.update((current) => new Map(current).set(attempt.documentId, partial));
        }
      }),
      switchMap(() => this.runtime.getCapture(captureId)),
      tap((next) => this.rememberRecordingOperation(attempt.documentId, next)),
    );
  }

  private applyStreamingEvent(attempt: CaptureAttempt, event: CaptureEvent): void {
    attempt.lastEventSequence = Math.max(attempt.lastEventSequence, event.sequence);
  }

  private expectedOcrIdentity(
    operation: DesktopCaptureOperation,
    attempt: CaptureAttempt,
  ): OcrEvidenceExpectedIdentity {
    const compute = attempt.ocrCompute;
    if (!compute) {
      throw new Error('OCR evidence identity unavailable: runtime OCR readiness is missing.');
    }
    const sourceSha256 = attempt.sourceSha256 ?? operation.source?.sha256;
    if (!sourceSha256) {
      throw new Error('OCR evidence identity unavailable: capture source identity is missing.');
    }
    if (!compute.workerSha256) {
      throw new Error('OCR evidence identity unavailable: OCR worker identity is missing.');
    }
    return {
      captureId: operation.captureId,
      sourceSha256,
      runtimeVersion: compute.runtimeVersion,
      contractSetSha256: compute.contractSetSha256,
      terminalStatus: 'completed',
      workerSha256: compute.workerSha256,
    };
  }

  private rememberSourceIdentity(
    attempt: CaptureAttempt,
    operation: DesktopCaptureOperation,
  ): void {
    const sourceSha256 = operation.source?.sha256;
    if (sourceSha256 === undefined) return;
    if (attempt.sourceSha256 !== undefined && attempt.sourceSha256 !== sourceSha256) {
      throw new Error('OCR evidence identity mismatch: capture source changed.');
    }
    attempt.sourceSha256 = sourceSha256;
  }

  /** The PDF pages to capture, from the stored document's options. */
  private pdfPageNumbersFor(stored: DesktopLibrarySummary): readonly number[] | undefined {
    if (!isPdfMediaType(stored.mediaType)) return undefined;
    const options = stored.captureOptions;
    const pageNumbers = options?.pdfPageNumbers;
    if (Array.isArray(pageNumbers) && pageNumbers.length > 0) {
      return [...pageNumbers];
    }
    const count = options?.pdfPageCount;
    if (typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 500) {
      return Array.from({ length: count }, (_, index) => index + 1);
    }
    return this.runtime.pdfPageNumbers();
  }

  private rememberRecordingOperation(documentId: string, operation: CaptureOperation): void {
    this.recordingOperations.update((current) => new Map(current).set(documentId, operation));
  }

  private forgetRecordingOperation(documentId: string): void {
    this.recordingOperations.update((current) => withoutKey(current, documentId));
  }

  private rememberOneShotOperation(documentId: string, operation: DesktopCaptureOperation): void {
    this.oneShotOperations.update((current) => new Map(current).set(documentId, operation));
  }

  private forgetOneShotOperation(documentId: string): void {
    this.oneShotOperations.update((current) => withoutKey(current, documentId));
  }

  private rememberUnstoredOutcome(documentId: string, reason: string | null = null): void {
    this.unstored.update((outcomes) => new Map(outcomes).set(documentId, reason));
  }

  private forgetUnstoredOutcome(documentId: string): void {
    this.unstored.update((outcomes) => withoutKey(outcomes, documentId));
  }

  private markBusy(documentId: string, busy: boolean): void {
    this.busyIds.update((current) => {
      const next = new Set(current);
      if (busy) next.add(documentId); else next.delete(documentId);
      return next;
    });
  }

  private clearStreamingPartial(documentId: string): void {
    this.streamingPartials.update((current) => withoutKey(current, documentId));
  }
}

function withoutMember(current: ReadonlySet<string>, member: string): ReadonlySet<string> {
  if (!current.has(member)) return current;
  const next = new Set(current);
  next.delete(member);
  return next;
}

function withoutKey<T>(current: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> {
  if (!current.has(key)) return current;
  const next = new Map(current);
  next.delete(key);
  return next;
}
