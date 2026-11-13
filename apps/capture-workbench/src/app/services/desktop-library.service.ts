import { Injectable, inject } from '@angular/core';
import type {
  CaptureDocument,
  RawCapture,
} from '@gx-capture/capture-workbench-ui';
import { map, Observable } from 'rxjs';
import type {
  DesktopCaptureOptions,
  DesktopLibraryDetail,
  DesktopLibraryExport,
  DesktopLibraryStatus,
  DesktopLibrarySummary,
  OcrEvidenceV1,
} from '../contracts';
import { DesktopTauriCommandService } from './desktop-tauri-command.service';

export interface DesktopSourceSelection {
  readonly selectionToken: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly mediaType: string;
}
export type SourceRejectionReason = 'unsupported' | 'empty' | 'tooLarge' | 'notRegularFile' | 'notLocal' | 'unreadable' | 'limitReached';
export interface DesktopSourceSelectionBatch {
  readonly selections: readonly DesktopSourceSelection[];
  readonly rejected: readonly SourceRejectionReason[];
}

@Injectable({ providedIn: 'root' })
export class DesktopLibraryService {
  private readonly commands = inject(DesktopTauriCommandService);

  selectSources(kind: 'documents' | 'recordings' | 'all' = 'all'): Observable<DesktopSourceSelectionBatch> {
    return this.commands.invoke('library_select_sources', { request: { kind } });
  }

  droppedSources(): Observable<DesktopSourceSelectionBatch> {
    return this.commands.watch('library_watch_native_sources', 'onEvent');
  }

  importSelection(selection: DesktopSourceSelection, captureOptions?: DesktopCaptureOptions): Observable<DesktopLibrarySummary> {
    return this.commands.invoke<DesktopLibrarySummary>('library_import_selection', {
      request: { selectionToken: selection.selectionToken, ...(captureOptions ? { captureOptions } : {}) },
    }).pipe(map(sanitizeSummary));
  }

  discardSelections(selections: readonly DesktopSourceSelection[]): Observable<void> {
    return this.commands.invoke('library_discard_selections', {
      request: { selectionTokens: selections.map((selection) => selection.selectionToken) },
    });
  }

  list(query = '', status = '', signal?: AbortSignal): Observable<readonly DesktopLibrarySummary[]> {
    return this.commands
      .invoke<readonly DesktopLibrarySummary[]>('library_list', {
        request: { query, status },
      }, signal)
      .pipe(map((items) => items.map(sanitizeSummary)));
  }

  get(documentId: string, signal?: AbortSignal): Observable<DesktopLibraryDetail> {
    return this.commands
      .invoke<DesktopLibraryDetail>('library_get', {
        request: { documentId },
      }, signal)
      .pipe(map(sanitizeDetail));
  }

  updateCapture(input: {
    readonly documentId: string;
    readonly status: DesktopLibraryStatus;
    readonly captureId?: string;
    readonly clearCaptureId?: boolean;
    readonly stage?: string;
    readonly raw?: RawCapture;
    readonly result?: CaptureDocument;
    readonly errorCode?: string;
    readonly errorMessage?: string;
    readonly recoveryCode?: string;
    readonly recoveryMessage?: string;
    readonly ocrEvidence?: OcrEvidenceV1;
  }): Observable<DesktopLibrarySummary> {
    return this.commands
      .invoke<DesktopLibrarySummary>('library_update_capture', {
        update: input,
      })
      .pipe(map(sanitizeSummary));
  }

  /** Reads the stored source file, for playing a speaker's sample. */
  sourceBytes(documentId: string): Observable<ArrayBuffer> {
    return this.commands.invoke<ArrayBuffer>('library_source_bytes', {
      request: { documentId },
    });
  }

  export(documentId: string, format: 'json' | 'text'): Observable<DesktopLibraryExport> {
    return this.commands.invoke<DesktopLibraryExport>('library_export', {
      request: { documentId, format },
    });
  }

  delete(documentId: string): Observable<void> {
    return this.commands.invoke<void>('library_delete', { request: { documentId } });
  }
}

function sanitizeSummary(summary: DesktopLibrarySummary): DesktopLibrarySummary {
  return {
    ...summary,
    ...(summary.errorCode === undefined
      ? {}
      : { errorCode: redactSensitiveMessage(summary.errorCode) }),
    ...(summary.errorMessage === undefined
      ? {}
      : { errorMessage: redactSensitiveMessage(summary.errorMessage) }),
    ...(summary.recoveryCode === undefined
      ? {}
      : { recoveryCode: redactSensitiveMessage(summary.recoveryCode) }),
    ...(summary.recoveryMessage === undefined
      ? {}
      : { recoveryMessage: redactSensitiveMessage(summary.recoveryMessage) }),
  };
}

function sanitizeDetail(detail: DesktopLibraryDetail): DesktopLibraryDetail {
  return sanitizeSummary(detail) as DesktopLibraryDetail;
}

function redactSensitiveMessage(value: string | undefined): string | undefined {
  return value
    ?.replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /(?:authorization|bearerToken|access_token|token)\s*[:=]\s*["']?[^"'\s,;}]+/giu,
      (match) => `${match.slice(0, match.search(/[:=]/u) + 1)} [redacted]`,
    );
}
