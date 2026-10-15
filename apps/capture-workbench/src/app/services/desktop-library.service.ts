import { Injectable, inject } from '@angular/core';
import type {
  CaptureDocument,
  RawCapture,
} from '@gx-capture/capture-workbench-ui';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { defer, from, map, Observable } from 'rxjs';
import type {
  DesktopLibraryDetail,
  DesktopLibraryExport,
  DesktopLibraryStatus,
  DesktopLibrarySummary,
  OcrEvidenceV1,
} from '../contracts';
import { DesktopTauriCommandService } from './desktop-tauri-command.service';

export const MAX_DESKTOP_SOURCE_BYTES = 50 * 1024 * 1024;

/**
 * Recordings the runtime transcribes: audio, and video whose audio track is
 * transcribed. The native library checks each file's signature.
 */
export const RECORDING_EXTENSIONS: readonly string[] = [
  'mp3', 'wav', 'm4a', 'm4b', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'amr',
  'aif', 'aiff', 'caf', 'mka', '3gp', '3g2', 'mp4', 'm4v', 'mov', 'mkv', 'webm',
  'avi', 'wmv', 'asf', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts',
];

@Injectable({ providedIn: 'root' })
export class DesktopLibraryService {
  private readonly commands = inject(DesktopTauriCommandService);

  selectSources(): Observable<readonly string[]> {
    return defer(() =>
      from(
        open({
          multiple: true,
          directory: false,
          filters: [
            {
              name: 'Capture sources',
              extensions: ['pdf', 'png', 'jpg', 'jpeg', ...RECORDING_EXTENSIONS],
            },
          ],
        }),
      ),
    ).pipe(
      map((selection) =>
        selection === null
          ? []
          : Array.isArray(selection)
            ? selection
            : [selection],
      ),
    );
  }

  droppedSources(): Observable<readonly string[]> {
    return new Observable((subscriber) => {
      let disposed = false;
      let unlisten: (() => void) | undefined;
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === 'drop' && event.payload.paths.length > 0) {
            subscriber.next(event.payload.paths);
          }
        })
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch((error: unknown) => subscriber.error(error));
      return () => {
        disposed = true;
        unlisten?.();
      };
    });
  }

  createSource(sourcePath: string): Observable<DesktopLibrarySummary> {
    return this.commands.invoke<DesktopLibrarySummary>(
      'library_import_source',
      {
        request: { sourcePath },
      },
    ).pipe(map(sanitizeSummary));
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
