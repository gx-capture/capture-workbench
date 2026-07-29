import { computed, Injectable, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import {
  type CaptureDocumentV1,
  type CaptureJobV1,
  type CaptureRequirementId,
  type RawCaptureV1,
  type RuntimeInstallationV1,
  type RuntimeRequirementV1,
} from '@gx-capture/capture-workbench';
import {
  EMPTY,
  defer,
  expand,
  filter,
  map,
  Observable,
  switchMap,
  take,
  tap,
  timeout,
  throwError,
  timer,
} from 'rxjs';
import type { DesktopRuntimeStatus } from '../contracts';
import { DesktopTauriCommandService } from './desktop-tauri-command.service';

const STARTING_STATUS: DesktopRuntimeStatus = {
  status: 'starting',
  detail: 'Runtime 正在啟動…',
};
export const DESKTOP_RUNTIME_READY_TIMEOUT_MS = 3 * 60_000;

@Injectable({ providedIn: 'root' })
export class DesktopRuntimeClientService {
  private readonly commands = inject(DesktopTauriCommandService);

  readonly readiness = rxResource<DesktopRuntimeStatus, undefined>({
    defaultValue: STARTING_STATUS,
    stream: ({ abortSignal }) => this.waitUntilReady$(abortSignal),
  });
  readonly status = this.readiness.value;
  readonly resourceStatus = this.readiness.status;
  readonly error = this.readiness.error;
  readonly ready = computed(
    () => this.resourceStatus() === 'resolved' && this.status().status === 'ready',
  );

  getRequirements(signal?: AbortSignal): Observable<readonly RuntimeRequirementV1[]> {
    return this.commands
      .invoke<{ readonly items: readonly RuntimeRequirementV1[] }>('runtime_requirements', {}, signal)
      .pipe(map((response) => response.items));
  }

  startInstallation(input: {
    readonly clientRequestId: string;
    readonly requirementId: CaptureRequirementId;
    readonly consent: true;
  }, signal?: AbortSignal): Observable<RuntimeInstallationV1> {
    return this.commands.invoke('runtime_start_installation', {
      input: { clientRequestId: input.clientRequestId, requirementId: input.requirementId },
    }, signal);
  }

  getInstallation(installationId: string, signal?: AbortSignal): Observable<RuntimeInstallationV1> {
    return this.commands.invoke('runtime_get_installation', { input: { id: installationId } }, signal);
  }

  createCapture(documentId: string, clientRequestId: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.commands.invoke('runtime_create_capture', {
      input: { documentId, clientRequestId },
    }, signal);
  }

  getCapture(captureId: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.commands.invoke('runtime_get_capture', { input: { id: captureId } }, signal);
  }

  cancelCapture(captureId: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.commands.invoke('runtime_cancel_capture', { input: { id: captureId } }, signal);
  }

  getRaw(captureId: string, signal?: AbortSignal): Observable<RawCaptureV1 | null> {
    return this.commands.invoke('runtime_get_raw', { input: { id: captureId } }, signal);
  }

  getResult(captureId: string, signal?: AbortSignal): Observable<CaptureDocumentV1> {
    return this.commands.invoke('runtime_get_result', { input: { id: captureId } }, signal);
  }

  deleteCapture(captureId: string, signal?: AbortSignal): Observable<void> {
    return this.commands
      .invoke<null>('runtime_delete_capture', { input: { id: captureId } }, signal)
      .pipe(map(() => undefined));
  }

  reload(): void {
    this.readiness.reload();
  }

  private status$(signal: AbortSignal): Observable<DesktopRuntimeStatus> {
    return this.commands.invoke<DesktopRuntimeStatus>('desktop_runtime_status', {}, signal);
  }

  private waitUntilReady$(signal: AbortSignal): Observable<DesktopRuntimeStatus> {
    let lastDetail = STARTING_STATUS.detail;
    return defer(() => this.status$(signal)).pipe(
      tap((status) => lastDetail = status.detail),
      expand((status) => {
        if (status.status === 'ready') return EMPTY;
        if (status.status === 'failed' || status.status === 'stopped') {
          return throwError(() => new Error(status.detail));
        }
        return timer(500).pipe(switchMap(() => this.status$(signal)));
      }),
      filter((status) => status.status === 'ready'),
      take(1),
      timeout({
        first: DESKTOP_RUNTIME_READY_TIMEOUT_MS,
        with: () => throwError(() => new Error(`Capture Runtime 準備逾時：${lastDetail}`)),
      }),
    );
  }
}
