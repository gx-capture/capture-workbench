import { Injectable, inject } from '@angular/core';
import type {
  CaptureDocument,
  RawCapture,
} from '@gx-capture/capture-workbench-ui';
import { map, Observable } from 'rxjs';
import type {
  DesktopCaptureOptions,
  DesktopLibraryDetail,
  DesktopLibraryEdits,
  DesktopLibraryExport,
  DesktopLibraryStatus,
  DesktopLibrarySummary,
  OcrEvidenceV1,
} from '../contracts';
import { DesktopTauriCommandService } from './desktop-tauri-command.service';
import { redactSensitiveMessage } from './desktop-errors';
import { desktopMessages } from '../i18n/desktop-messages';

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

  saveEdits(
    documentId: string,
    edits: Pick<DesktopLibraryEdits, 'ocrPages' | 'transcriptLines' | 'speakerNames'>,
  ): Observable<DesktopLibraryEdits> {
    return this.commands.invoke<DesktopLibraryEdits>('library_save_edits', {
      request: { documentId, edits: {
        ocrPages: edits.ocrPages,
        transcriptLines: edits.transcriptLines,
        speakerNames: edits.speakerNames,
      } },
    });
  }

  /**
   * Stores a capture's state. `persisting`, `recovery_required` and the
   * recovery fields are only read: earlier versions stored them, and the host
   * refuses an update that carries one.
   */
  updateCapture(input: {
    readonly documentId: string;
    readonly status: Exclude<DesktopLibraryStatus, 'persisting' | 'recovery_required'>;
    readonly captureId?: string;
    readonly clearCaptureId?: boolean;
    readonly stage?: string;
    readonly raw?: RawCapture;
    readonly result?: CaptureDocument;
    readonly errorCode?: string;
    readonly errorMessage?: string;
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

  export(documentId: string, format: 'json' | 'text' | 'markdown' | 'srt' | 'vtt', pageLabel?: string): Observable<DesktopLibraryExport> {
    const heading = format === 'text' || format === 'markdown'
      ? pageLabel ?? desktopMessages().exportPageLabel : undefined;
    return this.commands.invoke<DesktopLibraryExport>('library_export', {
      request: { documentId, format, ...(heading === undefined ? {} : { pageLabel: heading }) },
    });
  }

  delete(documentId: string): Observable<void> {
    return this.commands.invoke<void>('library_delete', { request: { documentId } });
  }
}

/**
 * Redacts the stored error. The recovery message an earlier version stored
 * is left out: nothing shows it. Its recovery code is only compared with the
 * codes `capture-operation-status.ts` knows.
 */
function sanitizeSummary(summary: DesktopLibrarySummary): DesktopLibrarySummary {
  const shown: DesktopLibrarySummary & { recoveryMessage?: unknown } = { ...summary };
  delete shown.recoveryMessage;
  return {
    ...shown,
    ...(summary.errorCode === undefined
      ? {}
      : { errorCode: redactSensitiveMessage(summary.errorCode) }),
    ...(summary.errorMessage === undefined
      ? {}
      : { errorMessage: redactSensitiveMessage(summary.errorMessage) }),
  };
}

/**
 * The host answers a document without a raw or structured result with
 * `null` for it; the detail leaves it out, so "holds a result" means the
 * same whatever the host serialized.
 */
function sanitizeDetail(detail: DesktopLibraryDetail): DesktopLibraryDetail {
  const { raw, result, ...stored } = sanitizeSummary(detail) as DesktopLibraryDetail;
  return { ...stored, ...(raw == null ? {} : { raw }), ...(result == null ? {} : { result }) };
}
