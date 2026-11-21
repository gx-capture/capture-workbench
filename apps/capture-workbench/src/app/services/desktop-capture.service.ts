import { Injectable, inject, signal, type WritableSignal } from '@angular/core';
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
  type Observable,
  of,
  race,
  Subject,
  switchMap,
  take,
  tap,
  throwError,
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
  isCaptureLost,
  isActiveOneShotOperation,
  isActiveStreaming,
  isOcrCheckpoint,
  terminalLibraryStatus,
  type TerminalLibraryStatus,
  terminalStage,
} from './capture-operation-status';
import { errorMessage } from './desktop-errors';
import { isRecordingMediaType, isPdfMediaType } from './capture-media-types';
import { isFeatureReady, selectFeatureMissing } from './recognition-requirements';
import { desktopMessages } from '../i18n/desktop-messages';

interface ActiveCapture {
  clientRequestId?: string;
  captureId?: string;
  streaming: boolean;
  lastEventSequence: number;
  rawPersisted: boolean;
  cancelRequested: boolean;
  cancelSent: boolean;
  lastStage?: string;
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

/** An action for a document that is being decided from its stored state. */
interface PendingDecision {
  /** A cancel arrived while the decision was pending. */
  cancelRequested: boolean;
}

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

  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly activeCaptures = new Map<string, ActiveCapture>();
  /** Documents of a batch that are imported and wait for their turn. */
  private readonly awaitingTurn = new Set<string>();
  /**
   * Documents for which an action is being decided from their stored state:
   * from the call of the entry until the action it led to has ended, was
   * declined or failed.
   */
  private readonly decisions = new Map<string, PendingDecision>();

  /**
   * Reports whether the document is claimed: a capture runs for it, a batch
   * has scheduled one, or an action for it is being decided from its stored
   * state. Nothing else may start, recover, restart or delete it meanwhile,
   * and a recording queue counts it as occupying its turn.
   */
  isDocumentClaimed(documentId: string): boolean {
    return this.activeCaptures.has(documentId)
      || this.awaitingTurn.has(documentId)
      || this.decisions.has(documentId);
  }

  /** Enqueues sources while preserving the existing sequential capture policy. */
  addSelections$(
    selections: readonly DesktopSourceSelection[],
    host: DesktopCaptureHost,
  ): Observable<void> {
    return from(selections).pipe(
      concatMap((selection) => this.library.importSelection(selection).pipe(
        catchError((error: unknown) => { host.setMessage(errorMessage(error)); return EMPTY; }),
      )),
      toArray(),
      switchMap((documents) => {
        // The whole batch is in the library now. Hold every document until its
        // turn: the OCR queue would otherwise start the waiting ones at once.
        for (const document of documents) this.awaitingTurn.add(document.documentId);
        return from(documents).pipe(
          concatMap((document) => this.continueImported$(document, host).pipe(
            finalize(() => this.awaitingTurn.delete(document.documentId)),
          )),
          finalize(() => {
            for (const document of documents) this.awaitingTurn.delete(document.documentId);
          }),
        );
      }),
    );
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
    return this.decideFromStoredDocument$(documentId, (stored, decision) =>
      stored?.status === 'queued'
        ? this.startUnlessCancelled$(documentId, host, decision)
        : this.declineOutdatedRequest$(host));
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
    return this.decideFromStoredDocument$(document.documentId, (stored, decision) =>
      stored?.captureId
        ? this.recoverCapture$(stored, host, decision)
        : this.declineOutdatedRequest$(host));
  }

  /**
   * Starts again a document whose runtime operation was lost: clears the stale
   * id without trying to recover it, unlike `retry$`. The stored document
   * decides: the link is cleared only while it still says the capture is lost.
   */
  restartLost$(
    documentId: string,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return this.decideFromStoredDocument$(documentId, (stored, decision) =>
      stored && isCaptureLost(stored)
        ? this.library.updateCapture({
          documentId,
          status: 'queued',
          stage: 'uploading',
          clearCaptureId: true,
        }).pipe(
          tap(() => host.reloadDocumentState(documentId)),
          switchMap(() => this.startUnlessCancelled$(documentId, host, decision)),
        )
        : this.declineOutdatedRequest$(host));
  }

  /** Resumes a recoverable capture or starts a capture for the selected document. */
  retry$(
    documentId: string,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return this.decideFromStoredDocument$(documentId, (stored, decision) => {
      if (stored?.captureId) return this.recoverCapture$(stored, host, decision);
      // Without a runtime capture there is nothing to resume. A new capture
      // starts only from a state in which a retry is offered: never for a
      // document that holds its result, as a row read before its cleanup can ask.
      return stored && canCaptureAgain(stored)
        ? this.startUnlessCancelled$(documentId, host, decision)
        : this.declineOutdatedRequest$(host);
    });
  }

  /**
   * Reads the stored document and lets `act` decide from it. A caller's
   * document list can be older than this service's last write for the
   * document (its reload has not answered yet), so no start or recovery is
   * decided from that list.
   *
   * The decision claims the document from the subscription on, as a running
   * capture does (`isDocumentClaimed`): one decision or capture runs per
   * document at a time, and a claimed document accepts no other entry. Every
   * write of a capture is acknowledged before its claim ends, so this read is
   * never older than those writes. A cancel that arrives meanwhile is kept in
   * the decision and wins over whatever the read allows.
   */
  private decideFromStoredDocument$(
    documentId: string,
    act: (stored: DesktopLibrarySummary | undefined, decision: PendingDecision) => Observable<void>,
  ): Observable<void> {
    return defer(() => {
      if (!this.runtime.ready() || this.isDocumentClaimed(documentId)) return EMPTY;
      const decision: PendingDecision = { cancelRequested: false };
      this.decisions.set(documentId, decision);
      return this.library.list().pipe(
        take(1),
        map((documents) => documents.find((item) => item.documentId === documentId)),
        switchMap((stored) => act(stored, decision)),
        // Also when the read fails: nothing stays claimed.
        finalize(() => this.decisions.delete(documentId)),
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

  /**
   * Starts the capture a decision allowed, unless a cancel arrived while it
   * was decided: then no capture starts and the document is stored as
   * cancelled, as a cancel during the upload would leave it.
   */
  private startUnlessCancelled$(
    documentId: string,
    host: DesktopCaptureHost,
    decision: PendingDecision,
  ): Observable<void> {
    return defer(() => decision.cancelRequested
      ? this.library.updateCapture({
        documentId,
        status: 'canceled',
        stage: 'cancelled',
        clearCaptureId: true,
      }).pipe(
        tap(() => host.reloadDocumentState(documentId)),
        map(() => undefined),
      )
      : this.captureExisting$(documentId, host));
  }

  /**
   * Requests cancellation. A running capture is woken without changing the
   * terminal rules; a decision in flight keeps the request, so that it does
   * not start, and cancels through the runtime what it recovers.
   */
  cancel(documentId: string): void {
    const active = this.activeCaptures.get(documentId);
    if (!active) {
      const decision = this.decisions.get(documentId);
      if (decision) decision.cancelRequested = true;
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

  private isRecordingDocument(
    documentId: string,
    host: DesktopCaptureHost,
    mediaType?: string,
  ): boolean {
    // A new import is not in the library list yet, so the caller's media type wins.
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

  /** Selects the imported file and starts it, unless its recognition requirement is missing. */
  private continueImported$(
    document: DesktopLibrarySummary,
    host: DesktopCaptureHost,
  ): Observable<void> {
    host.selectedId.set(document.documentId);
    host.refreshDocuments();
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
        cancelWake: new Subject<void>(),
        ocrCompute: this.runtime.ocrCompute(),
        pdfPageNumbers,
      };
      this.activeCaptures.set(documentId, active);
      this.markBusy(documentId, true);

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
          tap(() => host.reloadDocumentState(documentId)),
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
          tap(() => host.reloadDocumentState(documentId)),
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
        ? timer(500).pipe(switchMap(() => this.advanceStreaming$(documentId, operation, active)))
        : EMPTY),
      filter((operation) => !isActiveStreaming(operation)),
      take(1),
    );
  }

  private advanceStreaming$(
    documentId: string,
    operation: CaptureOperation,
    active: ActiveCapture,
  ): Observable<CaptureOperation> {
    const events$ = this.runtime.getCaptureEvents(
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
    );
    if (!active.cancelRequested || active.cancelSent) {
      return events$.pipe(
        switchMap(() => this.runtime.getCapture(operation.captureId)),
        tap((next) => this.rememberRecordingOperation(documentId, next)),
      );
    }
    active.cancelSent = true;
    return this.runtime.cancelCapture(operation.captureId).pipe(
      switchMap(() => events$),
      switchMap(() => this.runtime.getCapture(operation.captureId)),
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
    decision: PendingDecision,
  ): Observable<void> {
    return defer(() => {
      if (
        !this.runtime.ready()
        || !document.captureId
        || this.activeCaptures.has(document.documentId)
      ) {
        return EMPTY;
      }
      const committedStatus = committedTerminalStatus(document);
      const terminalCommitted = committedStatus !== undefined;
      const active: ActiveCapture = {
        captureId: document.captureId,
        streaming: isRecordingMediaType(document.mediaType),
        lastEventSequence: 0,
        rawPersisted: false,
        // A cancel that arrived while the recovery was decided is sent to the runtime first.
        cancelRequested: decision.cancelRequested,
        cancelSent: false,
        lastStage: document.stage,
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

      const work$ = committedStatus !== undefined
        ? this.retryRuntimeCleanup$(document, committedStatus)
        : active.streaming
          ? this.runtime.getCapture(document.captureId).pipe(
            tap((operation) => {
              active.lastStage = operation.status;
              this.rememberRecordingOperation(document.documentId, operation);
            }),
            switchMap((operation) => this.waitForStreamingTerminal$(
              document.documentId,
              operation,
              active,
            )),
            switchMap((operation) => this.persistStreamingTerminal$(
              document.documentId,
              operation,
              active,
              host,
            )),
          )
          : this.runtime.getCapture(document.captureId).pipe(
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
        catchError((failureError) => {
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
      switchMap(() => {
        if (active.cancelRequested && !active.cancelSent) {
          return this.sendCancellation$(operation.captureId, active);
        }
        return race(
          timer(700).pipe(
            switchMap(() => this.runtime.getCapture(operation.captureId)),
          ),
          active.cancelWake.pipe(
            take(1),
            switchMap(() => this.sendCancellation$(operation.captureId, active)),
          ),
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

  private sendCancellation$(
    captureId: string,
    active: ActiveCapture,
  ): Observable<DesktopCaptureOperation> {
    active.cancelSent = true;
    return this.runtime.cancelCapture(captureId);
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
   * data and unlinks it. The document keeps the terminal status it stored.
   */
  private retryRuntimeCleanup$(
    document: DesktopLibrarySummary,
    committedStatus: TerminalLibraryStatus,
  ): Observable<DesktopLibrarySummary> {
    const captureId = document.captureId;
    if (!captureId) return EMPTY;
    return this.runtime.deleteCapture(captureId).pipe(
      switchMap(() => this.library.updateCapture({
        documentId: document.documentId,
        status: committedStatus,
        stage: terminalStage(committedStatus),
        clearCaptureId: true,
        errorCode: document.errorCode,
        errorMessage: document.errorMessage,
      })),
      catchError((error) => this.library.updateCapture({
        documentId: document.documentId,
        captureId,
        status: 'recovery_required',
        stage: terminalStage(committedStatus),
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
      if (active.terminalCommitted && active.terminalStatus) {
        return this.library.updateCapture({
          documentId,
          captureId: active.captureId,
          status: 'recovery_required',
          // The stage of a cleanup row names the terminal status the document
          // holds: the cleanup retry restores the status from it.
          stage: terminalStage(active.terminalStatus),
          errorCode: active.terminalErrorCode,
          errorMessage: active.terminalErrorMessage,
          recoveryCode: 'runtime_cleanup_failed',
          recoveryMessage: errorMessage(error),
        });
      }
      return this.library.updateCapture({
        documentId,
        captureId: active.captureId,
        status: 'recovery_required',
        stage: active.lastStage ?? 'recovery_required',
        recoveryCode: active.cancelSent ? 'cancel_failed' : 'capture_recovery_required',
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
