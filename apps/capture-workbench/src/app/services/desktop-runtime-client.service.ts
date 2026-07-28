import { Injectable } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  type CaptureDocumentV1,
  type CaptureJobV1,
  type CaptureRequirementId,
  type RawCaptureV1,
  type RuntimeInstallationV1,
  type RuntimeRequirementV1,
} from '@gx-capture/capture-workbench';
import { defer, map, type Observable } from 'rxjs';
import type { DesktopRuntimeStatus } from '../contracts';

export class DesktopCaptureClient {
  getRequirements(signal?: AbortSignal): Observable<readonly RuntimeRequirementV1[]> {
    return this.invoke<{ readonly items: readonly RuntimeRequirementV1[] }>('runtime_requirements', {}, signal)
      .pipe(map((response) => response.items));
  }

  startInstallation(input: {
    readonly clientRequestId: string;
    readonly requirementId: CaptureRequirementId;
    readonly consent: true;
  }, signal?: AbortSignal): Observable<RuntimeInstallationV1> {
    return this.invoke('runtime_start_installation', {
      input: { clientRequestId: input.clientRequestId, requirementId: input.requirementId },
    }, signal);
  }

  getInstallation(installationId: string, signal?: AbortSignal): Observable<RuntimeInstallationV1> {
    return this.invoke('runtime_get_installation', { input: { id: installationId } }, signal);
  }

  createCapture(documentId: string, clientRequestId: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.invoke('runtime_create_capture', {
      input: { documentId, clientRequestId },
    }, signal);
  }

  getCapture(captureId: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.invoke('runtime_get_capture', { input: { id: captureId } }, signal);
  }

  cancelCapture(captureId: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.invoke('runtime_cancel_capture', { input: { id: captureId } }, signal);
  }

  getRaw(captureId: string, signal?: AbortSignal): Observable<RawCaptureV1> {
    return this.invoke('runtime_get_raw', { input: { id: captureId } }, signal);
  }

  getResult(captureId: string, signal?: AbortSignal): Observable<CaptureDocumentV1> {
    return this.invoke('runtime_get_result', { input: { id: captureId } }, signal);
  }

  deleteCapture(captureId: string, signal?: AbortSignal): Observable<void> {
    return this.invoke<null>('runtime_delete_capture', { input: { id: captureId } }, signal)
      .pipe(map(() => undefined));
  }

  private invoke<T>(command: string, args: Record<string, unknown>, signal?: AbortSignal): Observable<T> {
    return defer(() => {
      if (signal?.aborted) return Promise.reject(new DOMException('處理已取消。', 'AbortError'));
      if (!isTauri()) return Promise.reject(new Error('Capture Workbench 僅能在 Windows 桌面 App 中使用。'));
      return invoke<T>(command, args);
    });
  }
}

@Injectable({ providedIn: 'root' })
export class DesktopRuntimeClientService {
  private client?: DesktopCaptureClient;

  async getClient(): Promise<DesktopCaptureClient> {
    if (this.client) return this.client;
    await this.waitUntilReady();
    this.client = new DesktopCaptureClient();
    return this.client;
  }

  async status(): Promise<DesktopRuntimeStatus> {
    if (!isTauri()) {
      throw new Error('Capture Workbench 僅能在 Windows 桌面 App 中使用。');
    }
    return invoke<DesktopRuntimeStatus>('desktop_runtime_status');
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + 60_000;
    let lastDetail = 'Runtime 正在準備中。';
    while (Date.now() < deadline) {
      const status = await this.status();
      lastDetail = status.detail;
      if (status.status === 'ready') return;
      if (status.status === 'failed' || status.status === 'stopped') {
        throw new Error(status.detail);
      }
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 500));
    }
    throw new Error(`Capture Runtime 準備逾時：${lastDetail}`);
  }
}
