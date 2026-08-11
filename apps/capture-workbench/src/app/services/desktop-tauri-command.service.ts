import { Injectable } from '@angular/core';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
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

  invokeChannel<T>(
    command: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Observable<T> {
    return new Observable<T>((subscriber) => {
      if (signal?.aborted) {
        subscriber.error(new DOMException('Operation was aborted.', 'AbortError'));
        return undefined;
      }
      if (!isTauri()) {
        subscriber.error(new Error('Capture Workbench requires the Windows desktop app.'));
        return undefined;
      }
      const channel = new Channel<T>((message) => subscriber.next(message));
      const abort = () => subscriber.error(new DOMException('Operation was aborted.', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      void invoke<void>(command, { ...args, channel }).then(
        () => subscriber.complete(),
        (error: unknown) => subscriber.error(error),
      );
      return () => {
        signal?.removeEventListener('abort', abort);
        channel.onmessage = () => undefined;
      };
    });
  }
}
