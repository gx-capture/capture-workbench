import { Injectable, inject } from '@angular/core';
import type {
  CaptureDocumentV1,
  CaptureSourceKind,
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

export const MAX_DESKTOP_SOURCE_BYTES = 50 * 1024 * 1024;

const DESKTOP_SOURCE_KINDS = new Map<string, CaptureSourceKind>([
  ['application/pdf', 'pdf'],
  ['image/png', 'image'],
  ['image/jpeg', 'image'],
  ['audio/wav', 'audio'],
  ['audio/mpeg', 'audio'],
  ['audio/mp4', 'audio'],
]);

@Injectable({ providedIn: 'root' })
export class DesktopLibraryService {
  private readonly commands = inject(DesktopTauriCommandService);

  createSource(file: File): Observable<DesktopLibrarySummary> {
    return defer(() => {
      validateDesktopSource(file);
      return from(file.arrayBuffer());
    }).pipe(
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
    readonly clearCaptureId?: boolean;
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

export function validateDesktopSource(file: Pick<File, 'name' | 'size' | 'type'>): void {
  desktopSourceKind(file);
}

export function desktopSourceKind(
  file: Pick<File, 'name' | 'size' | 'type'>,
): CaptureSourceKind {
  const sourceKind = DESKTOP_SOURCE_KINDS.get(file.type);
  if (!sourceKind) {
    throw new Error(`不支援的檔案格式：${file.name}`);
  }
  if (file.size === 0) {
    throw new Error(`檔案不可為空：${file.name}`);
  }
  if (file.size > MAX_DESKTOP_SOURCE_BYTES) {
    throw new Error(`檔案超過 50 MiB 上限：${file.name}`);
  }
  return sourceKind;
}
