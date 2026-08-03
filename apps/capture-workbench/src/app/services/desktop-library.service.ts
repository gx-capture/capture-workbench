import { Injectable, inject } from '@angular/core';
import type {
  CaptureDocumentV1,
  RawCaptureV1,
} from '@gx-capture/capture-workbench';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { defer, from, map, Observable } from 'rxjs';
import type {
  DesktopLibraryDetail,
  DesktopLibraryExport,
  DesktopLibraryStatus,
  DesktopLibrarySummary,
} from '../contracts';
import { DesktopTauriCommandService } from './desktop-tauri-command.service';

export const MAX_DESKTOP_SOURCE_BYTES = 50 * 1024 * 1024;

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
              extensions: [
                'pdf',
                'png',
                'jpg',
                'jpeg',
                'wav',
                'mp3',
                'm4a',
                'mp4',
              ],
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
    readonly raw?: RawCaptureV1;
    readonly result?: CaptureDocumentV1;
    readonly errorCode?: string;
    readonly errorMessage?: string;
    readonly recoveryCode?: string;
    readonly recoveryMessage?: string;
  }): Observable<DesktopLibrarySummary> {
    return this.commands
      .invoke<DesktopLibrarySummary>('library_update_capture', {
        update: input,
      })
      .pipe(map(sanitizeSummary));
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
