import { Injectable, inject } from '@angular/core';
import type {
  CaptureDocumentV1,
  RawCaptureV1,
} from '@gx-capture/capture-workbench';
import { defer, from, map, Observable, switchMap } from 'rxjs';
import type {
  DesktopLibraryDetail,
  DesktopLibraryExport,
  DesktopLibraryStatus,
  DesktopLibrarySummary,
} from '../contracts';
import { DesktopTauriCommandService } from './desktop-tauri-command.service';

@Injectable({ providedIn: 'root' })
export class DesktopLibraryService {
  private readonly commands = inject(DesktopTauriCommandService);

  createSource(file: File): Observable<DesktopLibrarySummary> {
    return defer(() => from(file.arrayBuffer())).pipe(
      map((buffer) => ({
        fileName: file.name,
        mediaType: file.type,
        bytes: Array.from(new Uint8Array(buffer)),
      })),
      switchMap((input) =>
        this.commands.invoke<DesktopLibrarySummary>('library_create_source', { input }),
      ),
    );
  }

  list(query = '', status = '', signal?: AbortSignal): Observable<readonly DesktopLibrarySummary[]> {
    return this.commands.invoke<readonly DesktopLibrarySummary[]>('library_list', {
      request: { query, status },
    }, signal);
  }

  get(documentId: string, signal?: AbortSignal): Observable<DesktopLibraryDetail> {
    return this.commands.invoke<DesktopLibraryDetail>('library_get', {
      request: { documentId },
    }, signal);
  }

  updateCapture(input: {
    readonly documentId: string;
    readonly status: DesktopLibraryStatus;
    readonly captureId?: string;
    readonly stage?: string;
    readonly raw?: RawCaptureV1;
    readonly result?: CaptureDocumentV1;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  }): Observable<DesktopLibrarySummary> {
    return this.commands.invoke<DesktopLibrarySummary>('library_update_capture', {
      update: input,
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
