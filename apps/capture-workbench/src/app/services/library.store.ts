import { inject, Injectable, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { tap, type Observable } from 'rxjs';
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

  reloadDocumentState(documentId: string): void {
    this.refreshDocuments();
    if (this.selectedId() === documentId) this.selectedResource.reload();
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

  canDelete(documentId: string): boolean {
    const document = (this.allDocuments() ?? []).find((item) => item.documentId === documentId);
    return document !== undefined && !document.captureId
      && !this.capture.busyIds().has(documentId)
      && !this.capture.isDocumentClaimed(documentId);
  }

  delete(documentId: string): Observable<void> {
    return this.library.delete(documentId).pipe(tap(() => {
      this.capture.forgetDeletedDocument(documentId);
      this.refreshDocuments();
    }));
  }
}
