import { Injectable } from '@angular/core';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { defer, from, Observable, throwError } from 'rxjs';
import { desktopMessages } from '../i18n/desktop-messages';

@Injectable({ providedIn: 'root' })
export class DesktopTauriCommandService {
  watch<T>(command: string, channelArg: string): Observable<T> {
    return new Observable<T>((subscriber) => {
      if (!isTauri()) {
        subscriber.error(new Error(desktopMessages().desktopOnly));
        return;
      }
      const channel = new Channel<T>();
      channel.onmessage = (batch) => subscriber.next(batch);
      void invoke<void>(command, { [channelArg]: channel }).catch((error: unknown) => subscriber.error(error));
      return () => { channel.onmessage = () => undefined; };
    });
  }

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
