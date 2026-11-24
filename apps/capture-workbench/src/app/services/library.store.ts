import { inject, Injectable, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { catchError, defaultIfEmpty, defer, EMPTY, map, of, switchMap, take, tap, throwError, throwIfEmpty, type Observable } from 'rxjs';
import type {
  DesktopLibraryDetail,
  DesktopLibraryEdits,
  DesktopLibraryExport,
  DesktopLibrarySummary,
} from '../contracts';
import { DesktopCaptureService } from './desktop-capture.service';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';

@Injectable({ providedIn: 'root' })
export class LibraryStore {
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);
  private readonly capture = inject(DesktopCaptureService);

  readonly selectedId = signal<string | null>(null);

  /** Every library document. */
  get allDocuments() {
    return this.documentsResource.value;
  }

  get selected() {
    return this.selectedResource.value;
  }

  private readonly documentsResource = rxResource<
    readonly DesktopLibrarySummary[],
    { readonly ready: true } | undefined
  >({
    defaultValue: [],
    params: () => (this.runtime.started() ? { ready: true } : undefined),
    stream: ({ abortSignal }) => this.library.list('', '', abortSignal),
  });

  private readonly selectedResource = rxResource<
    DesktopLibraryDetail | null,
    { readonly documentId: string } | undefined
  >({
    defaultValue: null,
    params: () => {
      const documentId = this.selectedId();
      return this.runtime.started() && documentId ? { documentId } : undefined;
    },
    stream: ({ params, abortSignal }) =>
      this.library.get(params.documentId, abortSignal),
  });

  readonly listError = this.documentsResource.error;
  readonly detailError = this.selectedResource.error;

  /** Reloads the document list without changing the current selection. */
  refreshDocuments(): void {
    this.documentsResource.reload();
  }

  /**
   * Shows the summary a library write returned at once, then reloads the
   * list and, when the document is selected, its detail. Until the reload
   * answers, the list already shows what was written: a capture that has
   * ended is never shown as still in progress. A row the list does not show
   * yet (its import's reload has not answered) is added where the host lists
   * it: newest first.
   */
  applyDocumentState(summary: DesktopLibrarySummary): void {
    this.documentsResource.update((documents) => {
      if (documents.some((item) => item.documentId === summary.documentId)) {
        return documents.map((item) => item.documentId === summary.documentId ? summary : item);
      }
      const position = documents.findIndex((item) => item.createdAtMs <= summary.createdAtMs);
      return position < 0
        ? [...documents, summary]
        : [...documents.slice(0, position), summary, ...documents.slice(position)];
    });
    this.refreshDocuments();
    if (this.selectedId() === summary.documentId) this.selectedResource.reload();
  }

  get(documentId: string, signal?: AbortSignal): Observable<DesktopLibraryDetail> {
    return this.library.get(documentId, signal);
  }

  saveEdits(
    documentId: string,
    edits: Pick<DesktopLibraryEdits, 'ocrPages' | 'transcriptLines' | 'speakerNames'>,
  ): Observable<DesktopLibraryEdits> {
    return this.library.saveEdits(documentId, edits);
  }

  export(
    documentId: string,
    format: 'json' | 'text' | 'markdown' | 'srt' | 'vtt',
    pageLabel?: string,
  ): Observable<DesktopLibraryExport> {
    return this.library.export(documentId, format, pageLabel);
  }

  /** Every document this run is not working on can be deleted, a linked one too. */
  canDelete(documentId: string): boolean {
    const document = (this.allDocuments() ?? []).find((item) => item.documentId === documentId);
    return document !== undefined
      && !this.capture.busyIds().has(documentId)
      && !this.capture.isDocumentClaimed(documentId);
  }

  /**
   * Deletes the document. A runtime capture its stored row still links is
   * deleted too, without waiting: the library delete does not depend on the
   * runtime. The link is read from the library under the claim, not from the
   * displayed list, which can lack a link a previous renderer wrote late.
   * When that read fails or answers nothing, the displayed row's link is
   * used: the runtime cleanup is best effort and never stops the delete.
   */
  delete(documentId: string): Observable<void> {
    return defer(() => {
      if (!this.canDelete(documentId)) return EMPTY;
      const displayedCaptureId = (this.allDocuments() ?? [])
        .find((item) => item.documentId === documentId)?.captureId;
      return this.capture.claimDocumentForDeletion$(documentId, () => this.library.list().pipe(
        take(1),
        map((documents) => documents.find((item) => item.documentId === documentId)?.captureId),
        // Deliberate: every row has a way out, so a failed read never stops
        // the delete. A capture linked after the list was shown can then be
        // left at the runtime, whose retention removes it.
        defaultIfEmpty(displayedCaptureId),
        catchError(() => of(displayedCaptureId)),
        switchMap((captureId) => this.library.delete(documentId).pipe(
          // After an error one list read decides. The host removes the row
          // before the document's files; when only the files remain, the
          // document is deleted and the host removes what is left at a later
          // start. A document that is still listed keeps everything.
          catchError((deleteError: unknown) => this.library.list().pipe(
            take(1),
            // A read that completes without a list decides nothing: the delete's error stands.
            throwIfEmpty(() => deleteError),
            switchMap((documents) => documents.some((item) => item.documentId === documentId)
              ? throwError(() => deleteError)
              : of(undefined)),
            // A failed read reports the delete's own error.
            catchError(() => throwError(() => deleteError)),
          )),
          // Still within the claim. Only this document leaves the list: a
          // refresh that answered meanwhile is newer than the read above.
          tap(() => {
            if (captureId) this.capture.deleteRuntimeCapture(captureId);
            this.documentsResource.update((documents) => documents.filter((item) => item.documentId !== documentId));
            this.refreshDocuments();
          }),
        )),
      ));
    });
  }
}
