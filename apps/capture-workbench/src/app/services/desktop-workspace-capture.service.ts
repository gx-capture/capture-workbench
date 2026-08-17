import { Injectable, inject, signal, type WritableSignal } from '@angular/core';
import {
  EMPTY,
  catchError,
  concatMap,
  defer,
  expand,
  filter,
  finalize,
  from,
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
} from 'rxjs';
import type {
  CaptureEvent,
  CaptureOperation,
  CaptureRequirementId,
  PartialCapture,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import type {
  DesktopLibraryDetail,
  DesktopLibraryStatus,
  DesktopLibrarySummary,
} from '../contracts';
import { DesktopLibraryService } from './desktop-library.service';
import {
  DesktopRuntimeClientService,
  type DesktopCaptureOperation,
  type StreamingTerminalResultV2,
} from './desktop-runtime-client.service';
import {
  committedTerminalStatus,
  errorMessage,
  hasCommittedTerminalData,
  isActiveJob,
  isActiveStreaming,
  isAudioMediaType,
  terminalLibraryStatus,
  terminalStage,
} from './desktop-workspace.selectors';

interface ActiveCapture {
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
  readonly cancelWake: Subject<void>;
}

export interface DesktopWorkspaceCaptureHost {
  readonly selectedId: WritableSignal<string | null>;
  readonly requestedRequirements: WritableSignal<ReadonlySet<CaptureRequirementId>>;
  readonly requirements: () => readonly RuntimeRequirement[];
  readonly documents: () => readonly DesktopLibrarySummary[];
  readonly selected: () => DesktopLibraryDetail | null;
  readonly refreshDocuments: () => void;
  readonly reloadDocumentState: (documentId: string) => void;
  readonly setMessage: (message: string) => void;
}

@Injectable({ providedIn: 'root' })
/** Owns capture lifecycle side effects behind the workspace store facade. */
export class DesktopWorkspaceCaptureService {
  readonly busyIds = signal<ReadonlySet<string>>(new Set());
  readonly streamingPartials = signal<ReadonlyMap<string, PartialCapture>>(new Map());

  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly activeCaptures = new Map<string, ActiveCapture>();

  /** Reports whether a document currently has an active capture operation. */
  hasActiveCapture(documentId: string): boolean {
    return this.activeCaptures.has(documentId);
  }

  /** Enqueues sources while preserving the existing sequential capture policy. */
  addSourcePaths$(
    paths: readonly string[],
    host: DesktopWorkspaceCaptureHost,
  ): Observable<void> {
    return from(paths).pipe(
      concatMap((sourcePath) => this.captureNewSource$(sourcePath, host)),
    );
  }

  /** Resumes a recoverable capture or starts a capture for the selected document. */
  retry$(
    documentId: string,
    host: DesktopWorkspaceCaptureHost,
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
      active.cancelWake.next();
    }
  }

  private isAudioDocument(
    documentId: string,
    host: DesktopWorkspaceCaptureHost,
  ): boolean {
    const document = host.documents().find((item) => item.documentId === documentId)
      ?? (host.selected()?.documentId === documentId ? host.selected() : undefined);
    return isAudioMediaType(document?.mediaType ?? '');
  }

  private applyStreamingEvent(active: ActiveCapture, event: CaptureEvent): void {
    active.lastEventSequence = Math.max(active.lastEventSequence, event.sequence);
    active.lastStage = event.stage;
  }

  private captureNewSource$(
    sourcePath: string,
    host: DesktopWorkspaceCaptureHost,
  ): Observable<void> {
    return this.library.createSource(sourcePath).pipe(
      tap((document) => {
        host.selectedId.set(document.documentId);
        host.refreshDocuments();
      }),
      switchMap((document) => {
        if (isAudioMediaType(document.mediaType) && !this.audioReady(host.requirements())) {
          host.requestedRequirements.update(
            (current) => new Set([...current, 'whisper-primary']),
          );
          host.setMessage('選取的音訊需要額外安裝 Whisper。');
          return EMPTY;
        }
        return this.captureExisting$(document.documentId, host);
      }),
      catchError((error) => {
        host.setMessage(errorMessage(error));
        return EMPTY;
      }),
    );
  }

  private captureExisting$(
    documentId: string,
    host: DesktopWorkspaceCaptureHost,
  ): Observable<void> {
    return defer(() => {
      if (!this.runtime.ready() || this.activeCaptures.has(documentId)) return EMPTY;
      const active: ActiveCapture = {
        streaming: this.isAudioDocument(documentId, host),
        lastEventSequence: 0,
        rawPersisted: false,
        cancelRequested: false,
        cancelSent: false,
        cancelWake: new Subject<void>(),
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
          : this.captureOneShot$(documentId, active, host)),
      );

      return this.trackCaptureLifecycle$(documentId, active, work$, host);
    });
  }

  private captureOneShot$(
    documentId: string,
    active: ActiveCapture,
    host: DesktopWorkspaceCaptureHost,
  ): Observable<void> {
    return this.runtime.createCapture(documentId, crypto.randomUUID()).pipe(
      switchMap((job) => {
        active.captureId = job.captureId;
        active.lastStage = job.stage;
        return this.library.updateCapture({
          documentId,
          captureId: job.captureId,
          status: 'processing',
          stage: job.stage,
        }).pipe(
          tap(() => host.reloadDocumentState(documentId)),
          map(() => job),
        );
      }),
      switchMap((job) => this.waitForTerminal$(documentId, job, active, host)),
      switchMap((job) => this.persistTerminal$(documentId, job, active)),
      map(() => undefined),
    );
  }

  private captureStreaming$(
    documentId: string,
    active: ActiveCapture,
    host: DesktopWorkspaceCaptureHost,
  ): Observable<void> {
    return this.runtime.startStreamingCapture({
      documentId,
      clientRequestId: crypto.randomUUID(),
      structuringMode: 'runtime',
    }).pipe(
      switchMap((operation) => {
        active.captureId = operation.captureId;
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
    const events$ = this.runtime.getStreamingEvents(
      operation.captureId,
      active.lastEventSequence,
    ).pipe(
      tap((events) => events.forEach((event) => this.applyStreamingEvent(active, event))),
      switchMap(() => this.runtime.getStreamingPartial(operation.captureId)),
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
      return events$.pipe(switchMap(() => this.runtime.getStreamingCapture(operation.captureId)));
    }
    active.cancelSent = true;
    return this.runtime.cancelStreamingCapture(operation.captureId).pipe(
      switchMap(() => events$),
      switchMap(() => this.runtime.getStreamingCapture(operation.captureId)),
    );
  }

  private persistStreamingTerminal$(
    documentId: string,
    operation: CaptureOperation,
    active: ActiveCapture,
    host: DesktopWorkspaceCaptureHost,
  ): Observable<void> {
    active.terminalStatus = operation.status === 'completed' ? 'completed'
      : operation.status === 'cancelled' ? 'canceled' : 'failed';
    active.terminalErrorCode = operation.error?.code;
    active.terminalErrorMessage = operation.error?.message;
    const terminalData$: Observable<StreamingTerminalResultV2 | null> = operation.status === 'completed'
      ? this.runtime.getStreamingResult(operation.captureId)
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
      switchMap(() => this.runtime.deleteStreamingCapture(operation.captureId)),
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
    host: DesktopWorkspaceCaptureHost,
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
        streaming: isAudioMediaType(document.mediaType),
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
      };
      this.activeCaptures.set(document.documentId, active);
      this.markBusy(document.documentId, true);

      const work$ = terminalCommitted
        ? this.retryRuntimeCleanup$(document)
        : active.streaming
          ? this.runtime.getStreamingCapture(document.captureId).pipe(
            tap((operation) => active.lastStage = operation.status),
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
            tap((job) => active.lastStage = job.stage),
            switchMap((job) => this.waitForTerminal$(document.documentId, job, active, host)),
            switchMap((job) => this.persistTerminal$(document.documentId, job, active)),
          );
      return this.trackCaptureLifecycle$(document.documentId, active, work$, host);
    });
  }

  private trackCaptureLifecycle$(
    documentId: string,
    active: ActiveCapture,
    work$: Observable<unknown>,
    host: DesktopWorkspaceCaptureHost,
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
        this.markBusy(documentId, false);
      }),
      map(() => undefined),
    );
  }

  private waitForTerminal$(
    documentId: string,
    initial: DesktopCaptureOperation,
    active: ActiveCapture,
    host: DesktopWorkspaceCaptureHost,
  ): Observable<DesktopCaptureOperation> {
    return of(initial).pipe(
      switchMap((job) => this.persistRawDuringExtraction$(documentId, job, active, host)),
      tap((job) => active.lastStage = job.stage),
      expand((job) => {
        if (!isActiveJob(job)) return EMPTY;
        return this.advanceCapture$(documentId, job, active, host);
      }),
      filter((job) => !isActiveJob(job)),
      take(1),
    );
  }

  private advanceCapture$(
    documentId: string,
    job: DesktopCaptureOperation,
    active: ActiveCapture,
    host: DesktopWorkspaceCaptureHost,
  ): Observable<DesktopCaptureOperation> {
    return this.library.updateCapture({
      documentId,
      captureId: job.captureId,
      status: 'processing',
      stage: job.stage,
    }).pipe(
      switchMap(() => {
        if (active.cancelRequested && !active.cancelSent) {
          return this.sendCancellation$(job.captureId, active);
        }
        return race(
          timer(700).pipe(
            switchMap(() => this.runtime.getCapture(job.captureId)),
          ),
          active.cancelWake.pipe(
            take(1),
            switchMap(() => this.sendCancellation$(job.captureId, active)),
          ),
        );
      }),
      switchMap((next) => this.persistRawDuringExtraction$(documentId, next, active, host)),
      tap((next) => active.lastStage = next.stage),
    );
  }

  private persistRawDuringExtraction$(
    documentId: string,
    job: DesktopCaptureOperation,
    active: ActiveCapture,
    host: DesktopWorkspaceCaptureHost,
  ): Observable<DesktopCaptureOperation> {
    if (
      active.rawPersisted
      || (job.stage !== 'structuring' && job.stage !== 'awaiting_structuring')
    ) {
      return of(job);
    }
    return this.runtime.getRaw(job.captureId).pipe(
      switchMap((raw) => {
        if (!raw) return of(job);
        return this.library.updateCapture({
          documentId,
          captureId: job.captureId,
          status: 'processing',
          stage: job.stage,
          raw,
        }).pipe(
          tap(() => {
            active.rawPersisted = true;
            host.reloadDocumentState(documentId);
          }),
          map(() => job),
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
    job: DesktopCaptureOperation,
    active: ActiveCapture,
  ): Observable<DesktopLibrarySummary> {
    return this.library.updateCapture({
      documentId,
      captureId: job.captureId,
      status: 'persisting',
      stage: job.stage,
    }).pipe(
      switchMap(() => this.persistTerminalData$(documentId, job, active)),
      tap(() => {
        active.terminalCommitted = true;
        active.terminalStatus = terminalLibraryStatus(job);
        active.terminalErrorCode = job.error?.code;
        active.terminalErrorMessage = job.error?.message;
      }),
      switchMap(() => this.cleanupAfterCommit$(documentId, job)),
    );
  }

  private persistTerminalData$(
    documentId: string,
    job: DesktopCaptureOperation,
    active: ActiveCapture,
  ): Observable<DesktopLibrarySummary> {
    if (job.status === 'completed') {
      if (active.rawPersisted) {
        return this.runtime.getResult(job.captureId).pipe(
          switchMap((result) => this.library.updateCapture({
            documentId,
            captureId: job.captureId,
            status: 'completed' as const,
            stage: job.stage,
            result,
          })),
        );
      }
      return this.runtime.getRaw(job.captureId).pipe(
        switchMap((raw) => {
          if (!raw) {
            return throwError(() => new Error('Capture Runtime 未提供已完成工作的原始結果。'));
          }
          return this.runtime.getResult(job.captureId).pipe(
            switchMap((result) => {
              const update = {
                documentId,
                captureId: job.captureId,
                status: 'completed' as const,
                stage: job.stage,
                result,
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
    if (job.status === 'failed' || job.status === 'cancelled') {
      if (active.rawPersisted) {
        return this.library.updateCapture({
          documentId,
          captureId: job.captureId,
          status: terminalLibraryStatus(job),
          stage: job.stage,
          errorCode: job.error?.code,
          errorMessage: job.error?.message,
        });
      }
      return this.runtime.getRaw(job.captureId).pipe(
        switchMap((raw) => {
          const update = {
            documentId,
            captureId: job.captureId,
            status: terminalLibraryStatus(job),
            stage: job.stage,
            errorCode: job.error?.code,
            errorMessage: job.error?.message,
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
    return throwError(() => new Error(`Capture Runtime returned unsupported terminal status: ${job.status}`));
  }

  private cleanupAfterCommit$(
    documentId: string,
    job: DesktopCaptureOperation,
  ): Observable<DesktopLibrarySummary> {
    const terminalStatus = terminalLibraryStatus(job);
    return this.runtime.deleteCapture(job.captureId).pipe(
      switchMap(() => this.library.updateCapture({
        documentId,
        status: terminalStatus,
        stage: job.stage,
        clearCaptureId: true,
        errorCode: job.error?.code,
        errorMessage: job.error?.message,
      })),
      catchError((error) => this.library.updateCapture({
        documentId,
        captureId: job.captureId,
        status: 'recovery_required',
        stage: job.stage,
        errorCode: job.error?.code,
        errorMessage: job.error?.message,
        recoveryCode: 'runtime_cleanup_failed',
        recoveryMessage: errorMessage(error),
      })),
    );
  }

  private retryRuntimeCleanup$(document: DesktopLibrarySummary): Observable<DesktopLibrarySummary> {
    const captureId = document.captureId;
    if (!captureId) return EMPTY;
    const delete$ = isAudioMediaType(document.mediaType)
      ? this.runtime.deleteStreamingCapture(captureId)
      : this.runtime.deleteCapture(captureId);
    return delete$.pipe(
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
    return this.library.updateCapture({
      documentId,
      status: 'failed',
      stage: 'failed',
      clearCaptureId: true,
      errorCode: 'capture_failed',
      errorMessage: errorMessage(error),
    });
  }

  private audioReady(requirements: readonly RuntimeRequirement[]): boolean {
    return requirements.some(
      (requirement) => requirement.requirementId === 'whisper-primary' && requirement.status === 'ready',
    );
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
