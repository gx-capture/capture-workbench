import { Injectable } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { defer, from, Observable, throwError } from 'rxjs';
import { desktopMessages } from '../i18n/desktop-messages';

@Injectable({ providedIn: 'root' })
export class DesktopTauriCommandService {
  invoke<T>(command: string, args: Record<string, unknown>, signal?: AbortSignal): Observable<T> {
    return defer(() => {
      if (signal?.aborted) {
        return throwError(() => new DOMException(desktopMessages().canceled, 'AbortError'));
      }
      if (!isTauri()) {
        return throwError(() => new Error(desktopMessages().desktopOnly));
      }
      return from(invoke<T>(command, args));
    });
  }
}
