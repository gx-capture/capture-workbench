import { Injectable } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  CaptureDocumentV1,
  RawCaptureV1,
} from '@gx-capture/capture-workbench';
import type {
  DesktopLibraryDetail,
  DesktopLibraryExport,
  DesktopLibraryStatus,
  DesktopLibrarySummary,
} from '../contracts';

@Injectable({ providedIn: 'root' })
export class DesktopLibraryService {
  async createSource(file: File): Promise<DesktopLibrarySummary> {
    return this.invoke<DesktopLibrarySummary>('library_create_source', {
      input: {
        fileName: file.name,
        mediaType: file.type,
        bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      },
    });
  }

  list(query = '', status = ''): Promise<readonly DesktopLibrarySummary[]> {
    return this.invoke<readonly DesktopLibrarySummary[]>('library_list', {
      request: { query, status },
    });
  }

  get(documentId: string): Promise<DesktopLibraryDetail> {
    return this.invoke<DesktopLibraryDetail>('library_get', {
      request: { documentId },
    });
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
  }): Promise<DesktopLibrarySummary> {
    return this.invoke<DesktopLibrarySummary>('library_update_capture', {
      update: input,
    });
  }

  export(documentId: string, format: 'json' | 'text'): Promise<DesktopLibraryExport> {
    return this.invoke<DesktopLibraryExport>('library_export', {
      request: { documentId, format },
    });
  }

  delete(documentId: string): Promise<void> {
    return this.invoke<void>('library_delete', { request: { documentId } });
  }

  private async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
    if (!isTauri()) {
      throw new Error('Capture Workbench 必須在 Windows 桌面 App 中開啟。');
    }
    return invoke<T>(command, args);
  }
}
