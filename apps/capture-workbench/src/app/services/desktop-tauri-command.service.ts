import { Injectable } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { defer, from, Observable, throwError } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class DesktopTauriCommandService {
  invoke<T>(command: string, args: Record<string, unknown>, signal?: AbortSignal): Observable<T> {
    return defer(() => {
      if (signal?.aborted) {
        return throwError(() => new DOMException('處理已取消。', 'AbortError'));
      }
      if (!isTauri()) {
        return throwError(() => new Error('Capture Workbench 僅能在 Windows 桌面 App 中使用。'));
      }
      return from(invoke<T>(command, args));
    });
  }
}
