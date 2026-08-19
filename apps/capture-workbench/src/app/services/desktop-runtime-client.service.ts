import { computed, Injectable, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import {
  type CaptureDocument,
  type CaptureEvent,
  type CaptureOperation,
  type PartialCapture,
  type CaptureRequirementId,
  type RawCapture,
  type RuntimeInstallation,
  type RuntimeModelInstallation,
  type RuntimeModelOption,
  type RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
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
export interface StreamingTerminalResultV2 {
  readonly operation: CaptureOperation;
  readonly raw: RawCapture;
  readonly result: CaptureDocument;
}

/** Neutral v2 operation envelope returned by the desktop one-shot bridge. */
export type DesktopCaptureOperation = Omit<CaptureOperation, 'status'> & {
  readonly status: CaptureOperation['status'] | 'queued' | 'running';
  readonly stage?: string;
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

  getRequirements(signal?: AbortSignal): Observable<readonly RuntimeRequirement[]> {
    return this.commands
      .invoke<{ readonly items: readonly RuntimeRequirement[] }>('runtime_requirements', {}, signal)
      .pipe(map((response) => response.items));
  }

  startInstallation(input: {
    readonly clientRequestId: string;
    readonly requirementId: CaptureRequirementId;
    readonly consent: true;
  }, signal?: AbortSignal): Observable<RuntimeInstallation> {
    return this.commands.invoke('runtime_start_installation', {
      input: { clientRequestId: input.clientRequestId, requirementId: input.requirementId },
    }, signal);
  }

  getInstallation(installationId: string, signal?: AbortSignal): Observable<RuntimeInstallation> {
    return this.commands.invoke('runtime_get_installation', { input: { id: installationId } }, signal);
  }

  getModelOptions(signal?: AbortSignal): Observable<readonly RuntimeModelOption[]> {
    return this.commands
      .invoke<{ readonly items: readonly RuntimeModelOption[] }>('runtime_model_options', {}, signal)
      .pipe(map((response) => response.items));
  }

  startModelInstallation(input: {
    readonly clientRequestId: string;
    readonly optionId: string;
    readonly consent: true;
  }, signal?: AbortSignal): Observable<RuntimeModelInstallation> {
    return this.commands.invoke('runtime_start_model_installation', {
      input: { clientRequestId: input.clientRequestId, optionId: input.optionId },
    }, signal);
  }

  getModelInstallation(
    installationId: string,
    signal?: AbortSignal,
  ): Observable<RuntimeModelInstallation> {
    return this.commands.invoke('runtime_get_model_installation', { input: { id: installationId } }, signal);
  }

  createCapture(documentId: string, clientRequestId: string, signal?: AbortSignal): Observable<DesktopCaptureOperation> {
    return this.commands.invoke('runtime_create_capture', {
      input: { documentId, clientRequestId },
    }, signal);
  }

  startStreamingCapture(input: {
    readonly documentId: string;
    readonly clientRequestId: string;
    readonly structuringMode: 'runtime' | 'host';
  }, signal?: AbortSignal): Observable<CaptureOperation> {
    return this.commands.invoke('runtime_start_streaming_capture', { input }, signal);
  }

  getStreamingCapture(captureId: string, signal?: AbortSignal): Observable<CaptureOperation> {
    return this.commands.invoke('runtime_get_streaming_capture', { input: { id: captureId } }, signal);
  }

  getStreamingEvents(
    captureId: string,
    lastEventId?: number,
    signal?: AbortSignal,
  ): Observable<readonly CaptureEvent[]> {
    return this.commands.invoke('runtime_get_streaming_events', {
      input: { id: captureId, lastEventId: lastEventId ?? null },
    }, signal);
  }

  getStreamingPartial(captureId: string, signal?: AbortSignal): Observable<PartialCapture | null> {
    return this.commands.invoke('runtime_get_streaming_partial', { input: { id: captureId } }, signal);
  }

  getStreamingResult(
    captureId: string,
    signal?: AbortSignal,
  ): Observable<StreamingTerminalResultV2> {
    return this.commands.invoke('runtime_get_streaming_result', { input: { id: captureId } }, signal);
  }

  structureStreamingCapture(
    captureId: string,
    signal?: AbortSignal,
  ): Observable<CaptureDocument> {
    return this.commands.invoke('runtime_structure_streaming_capture', { input: { id: captureId } }, signal);
  }

  cancelStreamingCapture(captureId: string, signal?: AbortSignal): Observable<CaptureOperation> {
    return this.commands.invoke('runtime_cancel_streaming_capture', { input: { id: captureId } }, signal);
  }

  deleteStreamingCapture(captureId: string, signal?: AbortSignal): Observable<void> {
    return this.commands
      .invoke<null>('runtime_delete_streaming_capture', { input: { id: captureId } }, signal)
      .pipe(map(() => undefined));
  }

  getCapture(captureId: string, signal?: AbortSignal): Observable<DesktopCaptureOperation> {
    return this.commands.invoke('runtime_get_capture', { input: { id: captureId } }, signal);
  }

  cancelCapture(captureId: string, signal?: AbortSignal): Observable<DesktopCaptureOperation> {
    return this.commands.invoke('runtime_cancel_capture', { input: { id: captureId } }, signal);
  }

  getRaw(captureId: string, signal?: AbortSignal): Observable<RawCapture | null> {
    return this.commands.invoke('runtime_get_raw', { input: { id: captureId } }, signal);
  }

  getResult(captureId: string, signal?: AbortSignal): Observable<CaptureDocument> {
    return this.commands
      .invoke<StreamingTerminalResultV2>('runtime_get_result', { input: { id: captureId } }, signal)
      .pipe(map(({ result }) => result));
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
