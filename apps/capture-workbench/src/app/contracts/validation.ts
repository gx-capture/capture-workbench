import type {
  CaptureClient,
  CaptureStructuringProvider,
} from '@gx/capture-workbench';
import type { Observable } from 'rxjs';

export type ValidationCaptureClientMode =
  | 'tauri-http'
  | 'deterministic-e2e'
  | 'browser-unconfigured';

export interface BackendConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly runtimeVersion: string;
  readonly apiVersion: string;
  readonly captureDocumentSchemaVersion: string;
}

export interface DesktopRuntimeStatus {
  readonly status: string;
  readonly detail: string;
}

export interface RuntimeReadinessPolling {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Observable<void>;
  readonly scheduleTimeout: (
    callback: () => void,
    milliseconds: number,
  ) => () => void;
}

export interface ValidationClientEnvironment {
  readonly tauri: boolean;
  readonly search: string;
  readonly loadDesktopRuntimeStatus: () => Observable<DesktopRuntimeStatus>;
  readonly loadBackendConfig: () => Observable<BackendConfig>;
  readonly runtimeReadinessPolling?: RuntimeReadinessPolling;
}

export interface ValidationCaptureFixture {
  readonly mode: 'deterministic-e2e';
  readonly client: CaptureClient;
  readonly structuringProvider: CaptureStructuringProvider;
}
