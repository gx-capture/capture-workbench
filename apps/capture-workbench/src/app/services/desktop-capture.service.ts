import { DestroyRef, Injectable, inject, signal, type WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import {
  EMPTY,
  catchError,
  concatMap,
  concatWith,
  defer,
  expand,
  filter,
  finalize,
  from,
  ignoreElements,
  map,
  merge,
  type Observable,
  of,
  Subject,
  type Subscription,
  switchMap,
  take,
  takeUntil,
  tap,
  throwError,
  throwIfEmpty,
  timer,
  toArray,
} from 'rxjs';
import type {
  CaptureEvent,
  CaptureOperation,
  CaptureRequirementId,
  CaptureResult,
  OcrComputePreflight,
  PartialCapture,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import type { CaptureOcrProjection } from '@gx-capture/capture-runtime-client';
import type {
  DesktopLibraryDetail,
  DesktopLibrarySummary,
  OcrEvidenceExpectedIdentity,
  OcrEvidenceV1,
} from '../contracts';
import { buildOcrEvidence } from '../contracts';
import { DesktopLibraryService, type DesktopSourceSelection } from './desktop-library.service';
import {
  DesktopRuntimeClientService,
  type DesktopCaptureOperation,
} from './desktop-runtime-client.service';
import {
  canCaptureAgain,
  committedTerminalStatus,
  holdsTerminalData,
  isCaptureLost,
  isActiveOneShotOperation,
  isActiveStreaming,
  isOcrCheckpoint,
  terminalLibraryStatus,
  type TerminalLibraryStatus,
  terminalStage,
} from './capture-operation-status';
import { errorMessage, isRuntimeNotFound } from './desktop-errors';
import { isRecordingMediaType, isPdfMediaType } from './capture-media-types';
import { isFeatureReady, selectFeatureMissing } from './recognition-requirements';
import { desktopMessages } from '../i18n/desktop-messages';

interface ActiveCapture {
  clientRequestId?: string;
  captureId?: string;
  captureNotFound?: boolean;
  streaming: boolean;
  lastEventSequence: number;
  rawPersisted: boolean;
  cancelRequested: boolean;
  cancelSent: boolean;
  cancelAnswered: boolean;
  lastStage?: string;
  /** A linked in-flight row was read on reattach or acknowledged by a write. */
  linkedInFlight: boolean;
  terminalCommitted?: boolean;
  terminalStatus?: TerminalLibraryStatus;
  terminalErrorCode?: string;
  terminalErrorMessage?: string;
  /** Readiness identity captured by the host before the runtime operation starts. */
  ocrCompute?: OcrComputePreflight | null;
  /** Source identity received from the runtime operation, never from OCR output. */
  sourceSha256?: string;
  /** PDF page selection the capture was started with, or undefined for all pages / non-PDFs. */
  pdfPageNumbers?: readonly number[];
  readonly cancelWake: Subject<void>;
}

type DocumentDecisionRequest = 'automatic' | 'batch-turn' | 'retry-or-restart' | 'cancel';

/**
 * How long the queues wait before they look at their documents again after a
 * decision ended in an error, so that a failure that lasts is not repeated in
 * a loop.
 */
export const FAILED_DECISION_PAUSE_MS = 2_000;

export interface DesktopCaptureHost {
  readonly selectedId: WritableSignal<string | null>;
  readonly requestedRequirements: WritableSignal<ReadonlySet<CaptureRequirementId>>;
  readonly requirements: () => readonly RuntimeRequirement[];
  readonly documents: () => readonly DesktopLibrarySummary[];
  readonly selected: () => DesktopLibraryDetail | null;
  readonly refreshDocuments: () => void;
  readonly reloadDocumentState: (documentId: string) => void;
  readonly setMessage: (message: string) => void;
  /** The user asked for speakers to be told apart in audio. */
  readonly identifySpeakers: () => boolean;
}

@Injectable({ providedIn: 'root' })
/** Owns capture lifecycle side effects for the shell and the OCR and recording queue stores. */
export class DesktopCaptureService {
  readonly busyIds = signal<ReadonlySet<string>>(new Set());
  readonly streamingPartials = signal<ReadonlyMap<string, PartialCapture>>(new Map());
  /** Live streaming operations, so the ASR queue can show audio time progress. */
  readonly recordingOperations = signal<ReadonlyMap<string, CaptureOperation>>(new Map());
  /** Live one-shot operations, so a queue can show page progress that the library does not store. */
  readonly oneShotOperations = signal<ReadonlyMap<string, DesktopCaptureOperation>>(new Map());

  /**
   * Increases when a document's pause ends after a failed decision or
   * an unrecorded failure of a linked capture. The queues then look again.
   */
  readonly failedDecisions = signal(0);
  private readonly unrecordedFailures = new Subject<string>();
  /** Linked captures the queues can try again once their document's pause ends. */
  readonly unrecordedFailures$ = this.unrecordedFailures.asObservable();

  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly activeCaptures = new Map<string, ActiveCapture>();
  /** Documents of a batch that are imported and wait for their turn. */
  private readonly awaitingTurn = new Set<string>();
  /**
   * Documents for which an action is being decided from their stored state:
   * from the subscription to the entry until the action it led to has ended,
   * was declined or failed.
   */
  private readonly deciding = new Map<string, DocumentDecisionRequest>();
  private readonly deletingDocuments = signal<ReadonlySet<string>>(new Set());
  /**
   * Documents whose cancel was asked while an action for them was being
   * decided, or while they waited their turn in a batch (`awaitingTurn`), and
   * is not applied yet. A batch applies it at the document's turn. It
   * outlives a decision or a turn whose cancel write fails, and a batch that
   * ends before the document's turn came: the next decision for the document
   * applies it, or drops it when the stored document has nothing left to
   * cancel or is gone. It does not outlive its document: a deletion through
   * the library drops it too (`forgetDeletedDocument`).
   */
  private readonly unappliedCancels = new Set<string>();
  /**
   * Documents whose last decision ended in an error, each with the timer of
   * its own pause: a document that failed later is not asked for sooner
   * because the pause of another one ended.
   */
  private readonly decisionPauses = new Map<string, Subscription>();

  /**
   * Reports whether the document is claimed: a capture runs for it, a batch
   * has scheduled one, a decision is in progress, or the library is deleting
   * it. Nothing else may start, recover, restart or delete it meanwhile,
   * and a recording queue counts it as occupying its turn.
   */
  isDocumentClaimed(documentId: string): boolean {
    return this.activeCaptures.has(documentId)
      || this.awaitingTurn.has(documentId)
      || this.deciding.has(documentId)
      || this.deletingDocuments().has(documentId);
  }

  /**
   * Reports whether the library is deleting the document. This claim is not
   * a capture: a row being deleted keeps the status it has stored.
   */
  isDocumentBeingDeleted(documentId: string): boolean {
    return this.deletingDocuments().has(documentId);
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
      }));
    });
  }

  /**
   * Reports whether a decision for the document ended in an error less than
   * `FAILED_DECISION_PAUSE_MS` ago. Until the pause is over a queue does not
   * ask for the document again, and what it asks is ignored. A cancel,
   * retry or restart the user asks for ends the pause.
   */
  isDecisionPaused(documentId: string): boolean {
    return this.decisionPauses.has(documentId);
  }

  /** Enqueues sources while preserving the existing sequential capture policy. */
  addSelections$(
    selections: readonly DesktopSourceSelection[],
    host: DesktopCaptureHost,
  ): Observable<void> {
    return defer(() => {
      const batchClaims = new Set<string>();
      // Only the claim ends here. A kept cancel stays until it is applied: a
      // document whose turn never came is still stored as waiting, and the
      // queues would otherwise start what the user cancelled.
      const release = (documentId: string): void => {
        if (batchClaims.delete(documentId)) this.awaitingTurn.delete(documentId);
      };
      return from(selections).pipe(
        concatMap((selection) => this.library.importSelection(selection).pipe(
          map(({ documentId }) => documentId),
          filter((documentId) => !this.isDocumentClaimed(documentId)),
          tap((documentId) => {
            // Hold each imported document while the rest of the batch is imported.
            batchClaims.add(documentId);
            this.awaitingTurn.add(documentId);
          }),
          catchError((error: unknown) => { host.setMessage(errorMessage(error)); return EMPTY; }),
        )),
        toArray(),
        switchMap((documentIds) => from(documentIds).pipe(
          concatMap((documentId) => {
            // Hand off synchronously to the decision before calling the host.
            release(documentId);
            return this.decideFromStoredDocument$(documentId, (stored) =>
              stored?.status === 'queued' && !stored.captureId
                ? this.continueImported$(stored, host)
                : this.declineOutdatedRequest$(stored, host), 'batch-turn').pipe(
              catchError((error: unknown) => { host.setMessage(errorMessage(error)); return EMPTY; }),
            );
          }),
        )),
        finalize(() => {
          for (const documentId of batchClaims) release(documentId);
        }),
      );
    });
  }

  /**
   * Starts a capture for a document that waits in the library. The stored
   * document decides: one that no longer waits (already captured, cancelled
   * or deleted since the caller's list was read) is not started again.
   */
  startDocument$(
    documentId: string,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return this.decideFromStoredDocument$(documentId, (stored) =>
      stored?.status === 'queued'
        ? this.startUnlessCancelled$(documentId, host)
        : this.declineOutdatedRequest$(stored, host));
  }

  /**
   * Re-attaches to the runtime operation the library points at. The stored
   * document decides, not the caller's copy: no operation is read when the
   * link is gone, and a document whose result is already kept only retries
   * the runtime cleanup.
   */
  reattach$(
    document: DesktopLibrarySummary,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return this.decideFromStoredDocument$(document.documentId, (stored) =>
      stored?.captureId
        ? this.recoverCapture$(stored, host)
        : this.declineOutdatedRequest$(stored, host));
  }

  /**
   * Starts again only while the stored document says its capture is lost.
   */
  restartLost$(
    documentId: string,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return this.decideFromStoredDocument$(documentId, (stored) =>
      stored && isCaptureLost(stored)
        ? this.library.updateCapture({
          documentId,
          status: 'queued',
          stage: 'uploading',
          clearCaptureId: true,
        }).pipe(
          tap(() => host.reloadDocumentState(documentId)),
          switchMap(() => this.startUnlessCancelled$(documentId, host)),
        )
        : this.declineOutdatedRequest$(stored, host), 'retry-or-restart');
  }

  /** Resumes a recoverable capture or starts a capture for the selected document. */
  retry$(
    documentId: string,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return this.decideFromStoredDocument$(documentId, (stored) => {
      if (stored?.captureId) return this.recoverCapture$(stored, host);
      // Without a runtime capture there is nothing to resume. A new capture
      // starts only from a state in which Retry is offered. Reconnecting
      // above needs the runtime, while starting a recording also needs speech.
      return stored && canCaptureAgain(stored) && !isCaptureLost(stored)
        && (!isRecordingMediaType(stored.mediaType) || isFeatureReady(host.requirements(), 'asr'))
        ? this.startUnlessCancelled$(documentId, host)
        : this.declineOutdatedRequest$(stored, host);
    }, 'retry-or-restart');
  }

  /** Cancels an unclaimed document according to the state stored in the library. */
  cancelDocument$(
    documentId: string,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return this.decideFromStoredDocument$(documentId, (stored) => {
      if (stored && !holdsTerminalData(stored)) {
        if (stored.captureId && this.runtime.ready()) return this.recoverCapture$(stored, host);
        if (stored.status === 'queued' && !stored.captureId) {
          return this.persistWaitingCancel$(documentId, host);
        }
      }
      return this.declineOutdatedRequest$(stored, host);
    }, 'cancel');
  }

  /**
   * Reads the stored document and lets `act` decide from it. A caller's
   * document list can be older than this service's last write for the
   * document (its reload has not answered yet), so no start or recovery is
   * decided from that list.
   *
   * The decision claims the document from the subscription on, as a running
   * capture does (`isDocumentClaimed`): one decision or capture runs per
   * document at a time, and a claimed document accepts no other entry. The
   * entries are cold: nothing is claimed, read or written before a caller
   * subscribes. Every write of a capture is acknowledged before its claim
   * ends, so this read is never older than those writes.
   *
   * A cancel that arrives meanwhile is kept (`unappliedCancels`) and wins
   * over whatever the read allows. When the decision ends in an error (the
   * read or the write it led to failed) the claim is released, the cancel
   * stays for the next decision, and the document pauses
   * (`isDecisionPaused`): no decision is made for it until the queues are
   * told to look again (`failedDecisions`). An explicit request ends the
   * pause. A cancel keeps the intent until it is applied or no longer
   * needed, while a retry or restart supersedes an older cancel.
   */
  private decideFromStoredDocument$(
    documentId: string,
    act: (stored: DesktopLibrarySummary | undefined) => Observable<void>,
    request: DocumentDecisionRequest = 'automatic',
  ): Observable<void> {
    return defer(() => {
      if (this.isDocumentClaimed(documentId)) return EMPTY;
      if ((request === 'automatic' || request === 'retry-or-restart') && !this.runtime.ready()) return EMPTY;
      if (request === 'cancel' || request === 'retry-or-restart') this.endDecisionPause(documentId);
      if (request === 'automatic' && this.isDecisionPaused(documentId)) return EMPTY;
      this.deciding.set(documentId, request);
      if (request === 'retry-or-restart') this.unappliedCancels.delete(documentId);
      if (request === 'cancel') this.unappliedCancels.add(documentId);
      return this.library.list().pipe(
        take(1),
        map((documents) => documents.find((item) => item.documentId === documentId)),
        tap((stored) => {
          // The document is gone: a cancel that is kept for it has nothing to apply to.
          if (stored === undefined) this.unappliedCancels.delete(documentId);
        }),
        switchMap((stored) => act(stored)),
        catchError((error: unknown) => {
          this.pauseDecisions(documentId);
          return throwError(() => error);
        }),
        // Also when the read fails or is unsubscribed: nothing stays claimed.
        finalize(() => this.deciding.delete(documentId)),
      );
    });
  }

  /** Starts the pause of the document; when it ends, the queues are told to look again. */
  private pauseDecisions(documentId: string): void {
    this.endDecisionPause(documentId);
    this.decisionPauses.set(documentId, timer(FAILED_DECISION_PAUSE_MS)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.decisionPauses.delete(documentId);
        this.failedDecisions.update((count) => count + 1);
      }));
  }

  private endDecisionPause(documentId: string): void {
    this.decisionPauses.get(documentId)?.unsubscribe();
    this.decisionPauses.delete(documentId);
  }

  /**
   * The caller acted on an outdated document list: nothing to do but refresh
   * it. A cancel that is kept for the document is dropped when the stored
   * document has nothing left to cancel: it neither waits nor is linked to a
   * runtime capture that may still run.
   */
  private declineOutdatedRequest$(
    stored: DesktopLibrarySummary | undefined,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return defer(() => {
      const cancellable = stored !== undefined && !holdsTerminalData(stored)
        && (stored.status === 'queued' || Boolean(stored.captureId));
      if (stored !== undefined && !cancellable) this.unappliedCancels.delete(stored.documentId);
      host.refreshDocuments();
      return EMPTY;
    });
  }

  /**
   * Starts the capture a decision allowed, unless a cancel is kept for the
   * document: then no capture starts and the document is stored as cancelled,
   * as a cancel during the upload would leave it. The cancel counts as
   * applied once that write is acknowledged.
   */
  private startUnlessCancelled$(
    documentId: string,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return defer(() => this.unappliedCancels.has(documentId)
      ? this.persistWaitingCancel$(documentId, host)
      : this.captureExisting$(documentId, host));
  }

  private persistWaitingCancel$(documentId: string, host: DesktopCaptureHost): Observable<void> {
    return this.library.updateCapture({
      documentId,
      status: 'canceled',
      stage: 'cancelled',
      clearCaptureId: true,
    }).pipe(
      tap(() => {
        this.unappliedCancels.delete(documentId);
        host.reloadDocumentState(documentId);
      }),
      map(() => undefined),
    );
  }

  /**
   * Requests cancellation. A running capture is woken without changing the
   * terminal rules; a decision in flight keeps the request, so that it does
   * not start, and cancels through the runtime what it recovers. A batch
   * keeps the request for the document's turn.
   */
  cancel(documentId: string): void {
    if (this.deletingDocuments().has(documentId)) return;
    const active = this.activeCaptures.get(documentId);
    if (!active) {
      const decision = this.deciding.get(documentId);
      if (this.awaitingTurn.has(documentId) || (decision && decision !== 'cancel')) {
        this.unappliedCancels.add(documentId);
      }
      return;
    }
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      if (!active.captureId && active.clientRequestId) {
        this.runtime.cancelUpload(active.clientRequestId).pipe(
          take(1),
          catchError(() => EMPTY),
        ).subscribe();
      }
      active.cancelWake.next();
    }
  }

  /**
   * The document was deleted from the library: a cancel that is kept for it
   * has nothing to apply to, and no decision for the document may follow that
   * would drop it.
   */
  forgetDeletedDocument(documentId: string): void {
    this.unappliedCancels.delete(documentId);
  }

  private isRecordingDocument(
    documentId: string,
    host: DesktopCaptureHost,
    mediaType?: string,
  ): boolean {
    // A batch turn has the stored media type even if the host list has not refreshed.
    if (mediaType !== undefined) return isRecordingMediaType(mediaType);
    const document = host.documents().find((item) => item.documentId === documentId)
      ?? (host.selected()?.documentId === documentId ? host.selected() : undefined);
    return isRecordingMediaType(document?.mediaType ?? '');
  }

  private isPdfDocument(
    documentId: string,
    host: DesktopCaptureHost,
    mediaType?: string,
  ): boolean {
    if (mediaType !== undefined) return isPdfMediaType(mediaType);
    const document = host.documents().find((item) => item.documentId === documentId)
      ?? (host.selected()?.documentId === documentId ? host.selected() : undefined);
    return isPdfMediaType(document?.mediaType ?? '');
  }

  private applyStreamingEvent(active: ActiveCapture, event: CaptureEvent): void {
    active.lastEventSequence = Math.max(active.lastEventSequence, event.sequence);
    active.lastStage = event.stage;
  }

  /** Selects the imported file, then applies a waiting cancel or checks whether capture can start. */
  private continueImported$(
    document: DesktopLibrarySummary,
    host: DesktopCaptureHost,
  ): Observable<void> {
    host.selectedId.set(document.documentId);
    host.refreshDocuments();
    if (this.unappliedCancels.has(document.documentId)) {
      return this.persistWaitingCancel$(document.documentId, host);
    }
    if (isRecordingMediaType(document.mediaType) && !isFeatureReady(host.requirements(), 'asr')) {
      host.requestedRequirements.update(
        (current) => new Set([...current, 'speech-recognition']),
      );
      host.setMessage(desktopMessages().speechRequirementNeeded);
      return EMPTY;
    }
    if (
      isRecordingMediaType(document.mediaType)
      && host.identifySpeakers()
      && !isFeatureReady(host.requirements(), 'asr.speakers')
    ) {
      host.requestedRequirements.update(
        (current) => new Set([...current, 'speaker-diarization']),
      );
      host.setMessage(desktopMessages().speakerRequirementNeeded);
      return EMPTY;
    }
    if (
      !isRecordingMediaType(document.mediaType)
      && selectFeatureMissing(host.requirements(), 'ocr').length > 0
    ) {
      host.requestedRequirements.update(
        (current) => new Set([...current, 'text-recognition']),
      );
      host.setMessage(desktopMessages().needsSetup);
      return EMPTY;
    }
    return this.captureExisting$(document.documentId, host, document.mediaType);
  }

  private captureExisting$(
    documentId: string,
    host: DesktopCaptureHost,
    mediaType?: string,
  ): Observable<void> {
    return defer(() => {
      if (!this.runtime.ready() || this.activeCaptures.has(documentId)) return EMPTY;
      const pdfPageNumbers = this.pdfPageNumbersFor(documentId, host, mediaType);
      const active: ActiveCapture = {
        clientRequestId: crypto.randomUUID(),
        streaming: this.isRecordingDocument(documentId, host, mediaType),
        lastEventSequence: 0,
        rawPersisted: false,
        cancelRequested: false,
        cancelSent: false,
        cancelAnswered: false,
        linkedInFlight: false,
        cancelWake: new Subject<void>(),
        ocrCompute: this.runtime.ocrCompute(),
        pdfPageNumbers,
      };
      this.activeCaptures.set(documentId, active);
      this.markBusy(documentId, true);
      // A new capture starts here, and only here: the live lines of an
      // earlier capture of the document end with it. A request that is
      // ignored or declined never gets this far and leaves them.
      this.clearStreamingPartial(documentId);

      const work$ = this.library.updateCapture({

        documentId,
        status: 'processing',
        stage: 'uploading',
        clearCaptureId: true,
      }).pipe(
        tap(() => host.reloadDocumentState(documentId)),
        switchMap(() => active.streaming
          ? this.captureStreaming$(documentId, active, host)
          : this.captureOneShot$(documentId, active, host, pdfPageNumbers)),
      );

      return this.trackCaptureLifecycle$(documentId, active, work$, host);
    });
  }

  private captureOneShot$(
    documentId: string,
    active: ActiveCapture,
    host: DesktopCaptureHost,
    pdfPageNumbers?: readonly number[],
  ): Observable<void> {
    if (active.cancelRequested) return throwError(() => new Error('Upload was cancelled.'));
    const clientRequestId = active.clientRequestId ??= crypto.randomUUID();
    return this.runtime.createCapture(documentId, clientRequestId, pdfPageNumbers).pipe(
      switchMap((operation) => {
        active.captureId = operation.captureId;
        this.rememberSourceIdentity(active, operation);
        this.rememberOneShotOperation(documentId, operation);
        active.lastStage = operation.status;
        return this.library.updateCapture({
          documentId,
          captureId: operation.captureId,
          status: 'processing',
          stage: operation.status,
        }).pipe(
          tap(() => {
            active.linkedInFlight = true;
            host.reloadDocumentState(documentId);
          }),
          map(() => operation),
        );
      }),
      switchMap((operation) => this.waitForTerminal$(documentId, operation, active, host)),
      switchMap((operation) => this.persistOneShot$(documentId, operation, active, host)),
      map(() => undefined),
    );
  }

  private captureStreaming$(
    documentId: string,
    active: ActiveCapture,
    host: DesktopCaptureHost,
  ): Observable<void> {
    if (active.cancelRequested) return throwError(() => new Error('Upload was cancelled.'));
    const clientRequestId = active.clientRequestId ??= crypto.randomUUID();
    const options = this.captureOptionsFor(documentId, host);
    return this.runtime.startRecordingCapture({
      documentId,
      clientRequestId,
      structuringMode: 'runtime',
      identifySpeakers:
        (options?.identifySpeakers ?? host.identifySpeakers())
        && isFeatureReady(host.requirements(), 'asr.speakers'),
      ...(options?.spokenLanguage ? { spokenLanguage: options.spokenLanguage } : {}),
    }).pipe(
      switchMap((operation) => {
        active.captureId = operation.captureId;
        active.lastStage = operation.status;
        this.rememberRecordingOperation(documentId, operation);
        return this.library.updateCapture({
          documentId,
          captureId: operation.captureId,
          status: 'processing',
          stage: operation.status,
        }).pipe(
          tap(() => {
            active.linkedInFlight = true;
            host.reloadDocumentState(documentId);
          }),
          map(() => operation),
        );
      }),
      switchMap((operation) => this.waitForStreamingTerminal$(documentId, operation, active)),
      switchMap((operation) => this.persistStreamingTerminal$(documentId, operation, active, host)),
    );
  }

  private waitForStreamingTerminal$(
    documentId: string,
    initial: CaptureOperation,
    active: ActiveCapture,
  ): Observable<CaptureOperation> {
    return of(initial).pipe(
      switchMap((operation) => this.advanceStreaming$(documentId, operation, active)),
      expand((operation) => isActiveStreaming(operation)
        ? this.waitForStreamingPoll$(active).pipe(
          switchMap(() => this.advanceStreaming$(documentId, operation, active)),
        )
        : EMPTY),
      filter((operation) => !isActiveStreaming(operation)),
      take(1),
    );
  }

  private waitForStreamingPoll$(active: ActiveCapture): Observable<number | void> {
    if (active.cancelSent) return timer(500);
    if (active.cancelRequested) return of(undefined);
    return merge(timer(500), active.cancelWake).pipe(take(1));
  }

  private advanceStreaming$(
    documentId: string,
    operation: CaptureOperation,
    active: ActiveCapture,
  ): Observable<CaptureOperation> {
    // A later poll just reads. The cancel was already sent, and its answer was not terminal.
    if (active.cancelSent) return this.readStreamingCapture$(documentId, operation, active);
    const answered$ = active.cancelRequested
      ? this.sendCancellation$(operation.captureId, active)
      : this.readUntilCancelRequested$(
        this.readStreamingCapture$(documentId, operation, active),
        operation.captureId,
        active,
      );
    return answered$.pipe(switchMap((answered) => {
      // The poll finished; nobody asked to cancel it.
      if (!active.cancelSent) return of(answered);
      // The cancel's answer is the recording. When it has ended, store it:
      // reading events, the partial or the status again could leave the
      // terminal data unsaved. A read that was still in flight
      // was abandoned with the cancel, so it is not this answer. A capture
      // the runtime says is still running is read again, as before. A cancel
      // the runtime rejects never reaches here.
      if (!isActiveStreaming(answered)) {
        this.rememberRecordingOperation(documentId, answered);
        return of(answered);
      }
      return this.readStreamingCapture$(documentId, operation, active);
    }));
  }

  /** Events, the live partial and the capture status of a recording that is still running. */
  private readStreamingCapture$(
    documentId: string,
    operation: CaptureOperation,
    active: ActiveCapture,
  ): Observable<CaptureOperation> {
    return this.runtime.getCaptureEvents(
      operation.captureId,
      active.lastEventSequence,
    ).pipe(
      tap((events) => events.forEach((event) => this.applyStreamingEvent(active, event))),
      switchMap(() => this.runtime.getPartial(operation.captureId)),
      tap((partial) => {
        if (partial) {
          this.streamingPartials.update((current) => {
            const next = new Map(current);
            next.set(documentId, partial);
            return next;
          });
        }
      }),
      switchMap(() => this.readCapture$(operation.captureId, active)),
      tap((next) => this.rememberRecordingOperation(documentId, next)),
    );
  }

  private persistStreamingTerminal$(
    documentId: string,
    operation: CaptureOperation,
    active: ActiveCapture,
    host: DesktopCaptureHost,
  ): Observable<void> {
    active.terminalStatus = operation.status === 'completed' ? 'completed'
      : operation.status === 'cancelled' ? 'canceled' : 'failed';
    // The status read can say the capture ended before any event did.
    active.lastStage = operation.status;
    active.terminalErrorCode = operation.error?.code;
    active.terminalErrorMessage = operation.error?.message;
    const terminalData$: Observable<CaptureResult | null> = operation.status === 'completed'
      ? this.runtime.getResult(operation.captureId)
      : of(null);
    return terminalData$.pipe(
      switchMap((terminalData) => this.library.updateCapture({
        documentId,
        captureId: operation.captureId,
        status: active.terminalStatus ?? 'failed',
        stage: operation.status,
        errorCode: operation.error?.code,
        errorMessage: operation.error?.message,
        ...(terminalData
          ? { raw: terminalData.raw, result: terminalData.result }
          : {}),
      })),
      tap(() => {
        active.terminalCommitted = true;
        host.reloadDocumentState(documentId);
      }),
      switchMap(() => this.runtime.deleteCapture(operation.captureId)),
      switchMap(() => this.library.updateCapture({
        documentId,
        status: active.terminalStatus ?? 'failed',
        stage: operation.status,
        clearCaptureId: true,
        errorCode: operation.error?.code,
        errorMessage: operation.error?.message,
      })),
      tap(() => this.clearStreamingPartial(documentId)),
      map(() => undefined),
    );
  }

  private recoverCapture$(
    document: DesktopLibrarySummary,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return defer(() => {
      if (
        !this.runtime.ready()
        || !document.captureId
        || this.activeCaptures.has(document.documentId)
      ) {
        return EMPTY;
      }
      // A document that holds its terminal data is only cleaned up: its
      // runtime capture is never read, so a capture that is gone cannot turn
      // kept data into a lost capture.
      const terminalCommitted = holdsTerminalData(document);
      const committedStatus = committedTerminalStatus(document);
      const active: ActiveCapture = {
        captureId: document.captureId,
        streaming: isRecordingMediaType(document.mediaType),
        lastEventSequence: 0,
        rawPersisted: false,
        // A cancel that is kept for the document passes to the capture that is recovered.
        cancelRequested: this.unappliedCancels.delete(document.documentId),
        cancelSent: false,
        cancelAnswered: false,
        lastStage: document.stage,
        linkedInFlight: document.status === 'processing' || document.status === 'persisting',
        terminalCommitted,
        terminalStatus: committedStatus,
        terminalErrorCode: terminalCommitted ? document.errorCode : undefined,
        terminalErrorMessage: terminalCommitted ? document.errorMessage : undefined,
        cancelWake: new Subject<void>(),
        ocrCompute: this.runtime.ocrCompute(),
        pdfPageNumbers: this.pdfPageNumbersFor(document.documentId, host, document.mediaType),
      };
      this.activeCaptures.set(document.documentId, active);
      this.markBusy(document.documentId, true);

      const work$ = terminalCommitted
        ? this.retryRuntimeCleanup$(document, committedStatus)
        : active.streaming
          ? this.recoveredOperation$(document.captureId, active).pipe(
            tap((operation) => {
              active.lastStage = operation.status;
              this.rememberRecordingOperation(document.documentId, operation);
            }),
            // The initial read or cancel reply already tells us how it ended.
            switchMap((operation) => !isActiveStreaming(operation)
              ? of(operation)
              : this.library.updateCapture({
                documentId: document.documentId,
                captureId: operation.captureId,
                status: 'processing',
                stage: operation.status,
              }).pipe(
                tap(() => {
                  active.linkedInFlight = true;
                  host.reloadDocumentState(document.documentId);
                }),
                ignoreElements(),
                // This write only lets the queue show the live transcript. A
                // library that cannot store it does not stop the recording
                // being followed: the row keeps what it stored, and the end is
                // stored as before. A cancel asked while the write was pending
                // is sent by the first poll after it settles, either way.
                catchError(() => EMPTY),
                concatWith(defer(() => this.waitForStreamingTerminal$(document.documentId, operation, active))),
              )),
            switchMap((operation) => this.persistStreamingTerminal$(
              document.documentId,
              operation,
              active,
              host,
            )),
          )
          : this.recoveredOperation$(document.captureId, active).pipe(
            tap((operation) => {
              this.rememberSourceIdentity(active, operation);
              this.rememberOneShotOperation(document.documentId, operation);
              active.lastStage = operation.status;
            }),
            switchMap((operation) => this.waitForTerminal$(document.documentId, operation, active, host)),
            switchMap((operation) => this.persistOneShot$(document.documentId, operation, active, host)),
          );
      return this.trackCaptureLifecycle$(document.documentId, active, work$, host);
    });
  }

  private trackCaptureLifecycle$(
    documentId: string,
    active: ActiveCapture,
    work$: Observable<unknown>,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return work$.pipe(
      tap(() => host.reloadDocumentState(documentId)),
      catchError((error) => this.persistLifecycleFailure$(documentId, active, error).pipe(
        tap(() => host.reloadDocumentState(documentId)),
        catchError((failureError: unknown) => {
          if (active.captureId && active.linkedInFlight && !active.terminalCommitted) {
            if (active.cancelRequested && !active.cancelAnswered) this.unappliedCancels.add(documentId);
            this.pauseDecisions(documentId);
            this.unrecordedFailures.next(active.captureId);
            host.reloadDocumentState(documentId);
          }
          host.setMessage(errorMessage(failureError));
          return EMPTY;
        }),
      )),
      finalize(() => {
        active.cancelWake.complete();
        this.activeCaptures.delete(documentId);
        this.forgetOneShotOperation(documentId);
        this.forgetRecordingOperation(documentId);
        this.markBusy(documentId, false);
      }),
      map(() => undefined),
    );
  }

  private waitForTerminal$(
    documentId: string,
    initial: DesktopCaptureOperation,
    active: ActiveCapture,
    host: DesktopCaptureHost,
  ): Observable<DesktopCaptureOperation> {
    return of(initial).pipe(
      switchMap((operation) => this.persistRawDuringExtraction$(documentId, operation, active, host)),
      tap((operation) => active.lastStage = operation.status),
      expand((operation) => {
        if (!isActiveOneShotOperation(operation) || isOcrCheckpoint(operation)) return EMPTY;
        return this.advanceCapture$(documentId, operation, active, host);
      }),
      filter((operation) => !isActiveOneShotOperation(operation) || isOcrCheckpoint(operation)),
      take(1),
    );
  }

  private advanceCapture$(
    documentId: string,
    operation: DesktopCaptureOperation,
    active: ActiveCapture,
    host: DesktopCaptureHost,
  ): Observable<DesktopCaptureOperation> {
    return this.library.updateCapture({
      documentId,
      captureId: operation.captureId,
      status: 'processing',
      stage: operation.status,
    }).pipe(
      tap(() => { active.linkedInFlight = true; }),
      switchMap(() => {
        if (active.cancelRequested && !active.cancelSent) {
          return this.sendCancellation$(operation.captureId, active);
        }
        return this.readUntilCancelRequested$(
          timer(700).pipe(
            switchMap(() => this.readCapture$(operation.captureId, active)),
          ),
          operation.captureId,
          active,
        );
      }),
      switchMap((next) => this.persistRawDuringExtraction$(documentId, next, active, host)),
      tap((next) => {
        this.rememberOneShotOperation(documentId, next);
        active.lastStage = next.status;
      }),
    );
  }

  private persistRawDuringExtraction$(
    documentId: string,
    operation: DesktopCaptureOperation,
    active: ActiveCapture,
    host: DesktopCaptureHost,
  ): Observable<DesktopCaptureOperation> {
    if (
      active.rawPersisted
      || operation.status !== 'structuring'
    ) {
      return of(operation);
    }
    return this.runtime.getRaw(operation.captureId).pipe(
      switchMap((raw) => {
        if (!raw) return of(operation);
        return this.library.updateCapture({
          documentId,
          captureId: operation.captureId,
          status: 'processing',
          stage: operation.status,
          raw,
        }).pipe(
          tap(() => {
            active.rawPersisted = true;
            host.reloadDocumentState(documentId);
          }),
          map(() => operation),
        );
      }),
    );
  }

  /**
   * The state of the runtime capture a recovery attaches to. A cancel goes to
   * the runtime first, whether it was asked while the recovery was decided or
   * arrives while the capture is being read: the runtime answers it with the
   * capture as it is then, cancelled or already ended, and that answer is
   * the state. So a read that does not answer or fails cannot hold a cancel
   * back while the capture goes on running.
   */
  private recoveredOperation$(
    captureId: string,
    active: ActiveCapture,
  ): Observable<DesktopCaptureOperation> {
    if (active.cancelRequested) return this.sendCancellation$(captureId, active);
    return this.readUntilCancelRequested$(this.readCapture$(captureId, active), captureId, active);
  }

  /** Only a capture-status read can confirm the capture itself is absent. */
  private readCapture$(
    captureId: string,
    active: ActiveCapture,
  ): Observable<DesktopCaptureOperation> {
    return this.runtime.getCapture(captureId).pipe(
      tap({ error: (error: unknown) => { active.captureNotFound = isRuntimeNotFound(error); } }),
    );
  }

  /**
   * The answer of `read$`, unless a cancel is requested before it arrives:
   * then the read is abandoned and the runtime's answer to the cancel is the
   * state. A read that was sent before the cancel can answer after the runtime
   * accepted it, with the capture as it was; that answer, or its failure,
   * must not decide what is stored.
   */
  private readUntilCancelRequested$(
    read$: Observable<DesktopCaptureOperation>,
    captureId: string,
    active: ActiveCapture,
  ): Observable<DesktopCaptureOperation> {
    const cancelRequested$ = active.cancelWake.pipe(take(1));
    return merge(
      read$.pipe(takeUntil(cancelRequested$)),
      cancelRequested$.pipe(switchMap(() => this.sendCancellation$(captureId, active))),
    ).pipe(take(1));
  }

  private sendCancellation$(
    captureId: string,
    active: ActiveCapture,
  ): Observable<DesktopCaptureOperation> {
    active.cancelSent = true;
    return this.runtime.cancelCapture(captureId).pipe(
      throwIfEmpty(() => new Error('Capture Runtime returned no cancel response.')),
      tap(() => { active.cancelAnswered = true; }),
    );
  }

  private persistTerminal$(
    documentId: string,
    operation: DesktopCaptureOperation,
    active: ActiveCapture,
  ): Observable<DesktopLibrarySummary> {
    return this.library.updateCapture({
      documentId,
      captureId: operation.captureId,
      status: 'persisting',
      stage: operation.status,
    }).pipe(
      tap(() => { active.linkedInFlight = true; }),
      switchMap(() => this.persistTerminalData$(documentId, operation, active)),
      tap(() => {
        active.terminalCommitted = true;
        active.terminalStatus = terminalLibraryStatus(operation);
        active.terminalErrorCode = operation.error?.code;
        active.terminalErrorMessage = operation.error?.message;
      }),
      switchMap(() => this.cleanupAfterCommit$(documentId, operation)),
    );
  }

  private persistOneShot$(
    documentId: string,
    operation: DesktopCaptureOperation,
    active: ActiveCapture,
    host: DesktopCaptureHost,
  ): Observable<DesktopLibrarySummary> {
    return isOcrCheckpoint(operation)
      ? this.persistOcrCheckpoint$(documentId, operation, active, host)
      : this.persistTerminal$(documentId, operation, active);
  }

  private persistOcrCheckpoint$(
    documentId: string,
    operation: DesktopCaptureOperation,
    active: ActiveCapture,
    host: DesktopCaptureHost,
  ): Observable<DesktopLibrarySummary> {
    const stage = operation.status;
    return this.settleOne$(this.runtime.getRaw(operation.captureId)).pipe(
      switchMap((raw) => {
        if (!raw) {
          return throwError(() => new Error('Capture Runtime OCR checkpoint raw projection is unavailable.'));
        }
        return this.settleOne$(this.runtime.getOcr(operation.captureId)).pipe(
          switchMap((projection) => {
            if (
              projection.status !== 'completed'
              || projection.pages.some((page) => page.status === 'failed')
            ) {
              return throwError(() => new Error('Capture Runtime OCR checkpoint is not complete.'));
            }
            return buildOcrEvidence({
              projection,
              expected: this.expectedOcrIdentity(operation, active, projection.status),
              requestedPages: active.pdfPageNumbers ?? null,
            }).pipe(map((ocrEvidence) => ({ raw, ocrEvidence })));
          }),
        );
      }),
      switchMap(({ raw, ocrEvidence }) => this.settleOne$(this.library.updateCapture({
        documentId,
        captureId: operation.captureId,
        status: ocrEvidence.status,
        stage,
        raw,
        ocrEvidence,
      }))),
      tap(() => {
        active.terminalCommitted = true;
        active.terminalStatus = 'awaiting_confirmation';
        active.lastStage = stage;
        host.reloadDocumentState(documentId);
      }),
      switchMap(() => this.settleOne$(this.runtime.deleteCapture(operation.captureId))),
      switchMap(() => this.settleOne$(this.library.updateCapture({
        documentId,
        status: 'awaiting_confirmation',
        stage,
        clearCaptureId: true,
      }))),
    );
  }

  private persistTerminalData$(
    documentId: string,
    operation: DesktopCaptureOperation,
    active: ActiveCapture,
    ocrEvidence?: OcrEvidenceV1,
  ): Observable<DesktopLibrarySummary> {
    if (
      ocrEvidence === undefined
      && (operation.status === 'completed' || operation.status === 'failed')
    ) {
      this.rememberSourceIdentity(active, operation);
      return this.settleOne$(this.runtime.getOcr(operation.captureId)).pipe(
        switchMap((projection) => buildOcrEvidence({
          projection,
          expected: this.expectedOcrIdentity(operation, active),
          requestedPages: active.pdfPageNumbers ?? null,
        })),
        switchMap((evidence) => this.persistTerminalData$(
          documentId,
          operation,
          active,
          evidence,
        )),
      );
    }
    if (operation.status === 'completed') {
      if (active.rawPersisted) {
        return this.runtime.getResult(operation.captureId).pipe(
          switchMap(({ result }) => this.library.updateCapture({
            documentId,
            captureId: operation.captureId,
            status: 'completed' as const,
            stage: operation.status,
            result,
            ...(ocrEvidence === undefined ? {} : { ocrEvidence }),
          })),
        );
      }
      return this.runtime.getRaw(operation.captureId).pipe(
        switchMap((raw) => {
          if (!raw) {
            return throwError(() => new Error(desktopMessages().missingRawResult));
          }
          return this.runtime.getResult(operation.captureId).pipe(
            switchMap(({ result }) => {
              const update = {
                documentId,
                captureId: operation.captureId,
                status: 'completed' as const,
                stage: operation.status,
                result,
                ...(ocrEvidence === undefined ? {} : { ocrEvidence }),
                ...(active.rawPersisted ? {} : { raw }),
              };
              return this.library.updateCapture(update).pipe(
                tap(() => {
                  if (!active.rawPersisted) active.rawPersisted = true;
                }),
              );
            }),
          );
        }),
      );
    }
    if (operation.status === 'failed' || operation.status === 'cancelled') {
      if (active.rawPersisted) {
        return this.library.updateCapture({
          documentId,
          captureId: operation.captureId,
          status: terminalLibraryStatus(operation),
          stage: operation.status,
          ...(ocrEvidence === undefined ? {} : { ocrEvidence }),
          errorCode: operation.error?.code,
          errorMessage: operation.error?.message,
        });
      }
      return this.runtime.getRaw(operation.captureId).pipe(
        switchMap((raw) => {
          const update = {
            documentId,
            captureId: operation.captureId,
            status: terminalLibraryStatus(operation),
            stage: operation.status,
            ...(ocrEvidence === undefined ? {} : { ocrEvidence }),
            errorCode: operation.error?.code,
            errorMessage: operation.error?.message,
            ...(active.rawPersisted || !raw ? {} : { raw }),
          };
          return this.library.updateCapture(update).pipe(
            tap(() => {
              if (raw) active.rawPersisted = true;
            }),
          );
        }),
      );
    }
    return throwError(() => new Error(`Capture Runtime returned unsupported terminal status: ${operation.status}`));
  }

  private expectedOcrIdentity(
    operation: DesktopCaptureOperation,
    active: ActiveCapture,
    terminalStatus: CaptureOcrProjection['status'] = operation.status === 'failed' ? 'failed' : 'completed',
  ): OcrEvidenceExpectedIdentity {
    const compute = active.ocrCompute;
    if (!compute) {
      throw new Error('OCR evidence identity unavailable: runtime OCR readiness is missing.');
    }
    const sourceSha256 = active.sourceSha256 ?? operation.source?.sha256;
    if (!sourceSha256) {
      throw new Error('OCR evidence identity unavailable: capture source identity is missing.');
    }
    if (!compute.workerSha256) {
      throw new Error('OCR evidence identity unavailable: OCR worker identity is missing.');
    }
    if (terminalStatus !== 'completed' && terminalStatus !== 'failed') {
      throw new Error(`OCR evidence is unsupported for terminal status: ${terminalStatus}`);
    }
    return {
      captureId: operation.captureId,
      sourceSha256,
      runtimeVersion: compute.runtimeVersion,
      contractSetSha256: compute.contractSetSha256,
      terminalStatus,
      workerSha256: compute.workerSha256,
    };
  }

  private rememberSourceIdentity(
    active: ActiveCapture,
    operation: DesktopCaptureOperation,
  ): void {
    const sourceSha256 = operation.source?.sha256;
    if (sourceSha256 === undefined) return;
    if (active.sourceSha256 !== undefined && active.sourceSha256 !== sourceSha256) {
      throw new Error('OCR evidence identity mismatch: capture source changed.');
    }
    active.sourceSha256 = sourceSha256;
  }

  /** Settle one-shot streams before handing values to the next lifecycle stage. */
  private settleOne$<T>(source$: Observable<T>): Observable<T> {
    return defer(() => {
      let value!: T;
      let emitted = false;
      return source$.pipe(
        take(1),
        tap((next) => {
          value = next;
          emitted = true;
        }),
        ignoreElements(),
        concatWith(defer(() => emitted
          ? of(value)
          : throwError(() => new Error('Capture lifecycle source completed without a value.')))),
      );
    });
  }

  private cleanupAfterCommit$(
    documentId: string,
    operation: DesktopCaptureOperation,
  ): Observable<DesktopLibrarySummary> {
    const terminalStatus = terminalLibraryStatus(operation);
    return this.runtime.deleteCapture(operation.captureId).pipe(
      switchMap(() => this.library.updateCapture({
        documentId,
        status: terminalStatus,
        stage: operation.status,
        clearCaptureId: true,
        errorCode: operation.error?.code,
        errorMessage: operation.error?.message,
      })),
      catchError((error) => this.library.updateCapture({
        documentId,
        captureId: operation.captureId,
        status: 'recovery_required',
        stage: operation.status,
        errorCode: operation.error?.code,
        errorMessage: operation.error?.message,
        recoveryCode: 'runtime_cleanup_failed',
        recoveryMessage: errorMessage(error),
      })),
    );
  }

  /**
   * Deletes the runtime capture of a document that already holds its terminal
   * data and unlinks it. The document gets the terminal status it says its
   * capture ended in; when it does not say, it keeps what it stores and only
   * the link is removed.
   */
  private retryRuntimeCleanup$(
    document: DesktopLibrarySummary,
    committedStatus: TerminalLibraryStatus | undefined,
  ): Observable<DesktopLibrarySummary> {
    const captureId = document.captureId;
    if (!captureId) return EMPTY;
    const stage = committedStatus ? terminalStage(committedStatus) : document.stage;
    return this.runtime.deleteCapture(captureId).pipe(
      switchMap(() => this.library.updateCapture({
        documentId: document.documentId,
        ...(committedStatus
          ? { status: committedStatus }
          : {
            status: document.status,
            recoveryCode: document.recoveryCode,
            recoveryMessage: document.recoveryMessage,
          }),
        stage,
        clearCaptureId: true,
        errorCode: document.errorCode,
        errorMessage: document.errorMessage,
      })),
      catchError((error) => this.library.updateCapture({
        documentId: document.documentId,
        captureId,
        status: 'recovery_required',
        stage,
        errorCode: document.errorCode,
        errorMessage: document.errorMessage,
        recoveryCode: 'runtime_cleanup_failed',
        recoveryMessage: errorMessage(error),
      })),
    );
  }

  private persistLifecycleFailure$(
    documentId: string,
    active: ActiveCapture,
    error: unknown,
  ): Observable<DesktopLibrarySummary> {
    if (active.captureId) {
      if (active.terminalCommitted) {
        return this.library.updateCapture({
          documentId,
          captureId: active.captureId,
          status: 'recovery_required',
          // The stage of a cleanup row names the terminal status the document
          // holds: the cleanup retry restores the status from it. A row that
          // never said how its capture ended keeps the stage it stores.
          stage: active.terminalStatus ? terminalStage(active.terminalStatus) : active.lastStage,

          errorCode: active.terminalErrorCode,
          errorMessage: active.terminalErrorMessage,
          recoveryCode: 'runtime_cleanup_failed',
          recoveryMessage: errorMessage(error),
        });
      }
      return this.library.updateCapture({
        documentId,
        ...(active.captureNotFound ? { clearCaptureId: true } : { captureId: active.captureId }),
        status: 'recovery_required',
        stage: active.lastStage ?? 'recovery_required',
        recoveryCode: active.cancelSent && !active.cancelAnswered
          ? 'cancel_failed'
          : 'capture_recovery_required',
        recoveryMessage: errorMessage(error),
      });
    }
    if (active.cancelRequested && errorMessage(error) === 'Upload was cancelled.') {
      return this.library.updateCapture({
        documentId,
        status: 'canceled',
        stage: 'cancelled',
        clearCaptureId: true,
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

  private captureOptionsFor(
    documentId: string,
    host: DesktopCaptureHost,
  ) {
    const document = host.documents().find((item) => item.documentId === documentId)
      ?? (host.selected()?.documentId === documentId ? host.selected() : undefined);
    return document?.captureOptions;
  }

  private pdfPageNumbersFor(
    documentId: string,
    host: DesktopCaptureHost,
    mediaType?: string,
  ): readonly number[] | undefined {
    if (!this.isPdfDocument(documentId, host, mediaType)) return undefined;
    const options = this.captureOptionsFor(documentId, host);
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
    this.recordingOperations.update((current) => {
      const next = new Map(current);
      next.set(documentId, operation);
      return next;
    });
  }

  private forgetRecordingOperation(documentId: string): void {
    this.recordingOperations.update((current) => {
      if (!current.has(documentId)) return current;
      const next = new Map(current);
      next.delete(documentId);
      return next;
    });
  }

  private rememberOneShotOperation(documentId: string, operation: DesktopCaptureOperation): void {
    this.oneShotOperations.update((current) => {
      const next = new Map(current);
      next.set(documentId, operation);
      return next;
    });
  }

  private forgetOneShotOperation(documentId: string): void {
    this.oneShotOperations.update((current) => {
      if (!current.has(documentId)) return current;
      const next = new Map(current);
      next.delete(documentId);
      return next;
    });
  }

  private markBusy(documentId: string, busy: boolean): void {
    this.busyIds.update((current) => {
      const next = new Set(current);
      if (busy) next.add(documentId); else next.delete(documentId);
      return next;
    });
  }

  private clearStreamingPartial(documentId: string): void {
    this.streamingPartials.update((current) => {
      if (!current.has(documentId)) return current;
      const next = new Map(current);
      next.delete(documentId);
      return next;
    });
  }
}
