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
  DesktopLibraryStatus,
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
  committedTerminalStatus,
  hasCommittedTerminalData,
  isActiveOneShotOperation,
  isActiveStreaming,
  isOcrCheckpoint,
  terminalLibraryStatus,
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
  terminalStatus?: DesktopLibraryStatus;
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
   * Reports whether a capture runs for the document or a batch has already
   * scheduled one, so that nothing else starts it in the meantime.
   */
  hasActiveCapture(documentId: string): boolean {
    return this.activeCaptures.has(documentId) || this.awaitingTurn.has(documentId);
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

  /** Starts a capture for a file that is already in the library. */
  startDocument$(
    documentId: string,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return this.captureExisting$(documentId, host);
  }

  /** Re-attaches to a runtime operation the library still points at. */
  reattach$(
    document: DesktopLibrarySummary,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return document.captureId ? this.recoverCapture$(document, host) : EMPTY;
  }

  /**
   * A restart lost the runtime operation. Clear the stale id and start again.
   * Unlike `retry$`, this does not try to recover that id.
   */
  restartLost$(
    documentId: string,
    host: DesktopCaptureHost,
  ): Observable<void> {
    return this.library.updateCapture({
      documentId,
      status: 'queued',
      stage: 'uploading',
      clearCaptureId: true,
    }).pipe(
      tap(() => host.reloadDocumentState(documentId)),
      switchMap(() => this.captureExisting$(documentId, host)),
    );
  }

  /** Resumes a recoverable capture or starts a capture for the selected document. */
  retry$(
    documentId: string,
    host: DesktopCaptureHost,
  ): Observable<void> {
    const document = host.documents().find((item) => item.documentId === documentId)
      ?? (host.selected()?.documentId === documentId ? host.selected() : undefined);
    return document?.captureId
      ? this.recoverCapture$(document, host)
      : this.captureExisting$(documentId, host);
  }

  /** Requests cancellation and wakes the polling loop without changing terminal rules. */
  cancel(documentId: string): void {
    const active = this.activeCaptures.get(documentId);
    if (active && !active.cancelRequested) {
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
      const terminalCommitted = hasCommittedTerminalData(document);
      const active: ActiveCapture = {
        captureId: document.captureId,
        streaming: isRecordingMediaType(document.mediaType),
        lastEventSequence: 0,
        rawPersisted: false,
        cancelRequested: false,
        cancelSent: false,
        lastStage: document.stage,
        terminalCommitted,
        terminalStatus: terminalCommitted ? committedTerminalStatus(document) : undefined,
        terminalErrorCode: terminalCommitted ? document.errorCode : undefined,
        terminalErrorMessage: terminalCommitted ? document.errorMessage : undefined,
        cancelWake: new Subject<void>(),
        ocrCompute: this.runtime.ocrCompute(),
        pdfPageNumbers: this.pdfPageNumbersFor(document.documentId, host, document.mediaType),
      };
      this.activeCaptures.set(document.documentId, active);
      this.markBusy(document.documentId, true);

      const work$ = terminalCommitted
        ? this.retryRuntimeCleanup$(document)
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

  private retryRuntimeCleanup$(document: DesktopLibrarySummary): Observable<DesktopLibrarySummary> {
    const captureId = document.captureId;
    if (!captureId) return EMPTY;
    return this.runtime.deleteCapture(captureId).pipe(
      switchMap(() => this.library.updateCapture({
        documentId: document.documentId,
        status: committedTerminalStatus(document),
        stage: document.stage,
        clearCaptureId: true,
        errorCode: document.errorCode,
        errorMessage: document.errorMessage,
      })),
      catchError((error) => this.library.updateCapture({
        documentId: document.documentId,
        captureId,
        status: 'recovery_required',
        stage: document.stage,
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
          stage: active.lastStage ?? terminalStage(active.terminalStatus),
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
