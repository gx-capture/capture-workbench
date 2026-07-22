import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  HttpCaptureClient,
  type CaptureClient,
  type CaptureDocumentV1,
  type CaptureJobV1,
  type CommitStructuredResultRequest,
  type CreateCaptureRequest,
  type RawCaptureV1,
  type ReportStructuringFailureRequest,
  type RuntimeInstallationV1,
  type RuntimeReadyV1,
  type RuntimeRequirementV1,
  type StartRuntimeInstallationRequest,
} from '@wodenwang820118/capture-angular';
import { DeterministicCaptureClient } from './deterministic-capture';

export type ValidationCaptureClientMode =
  | 'tauri-http'
  | 'deterministic-e2e'
  | 'browser-unconfigured';

interface BackendConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly runtimeVersion: string;
  readonly apiVersion: string;
  readonly captureDocumentSchemaVersion: string;
}

interface ValidationClientEnvironment {
  readonly tauri: boolean;
  readonly search: string;
  readonly loadBackendConfig: () => Promise<BackendConfig>;
}

export interface ValidationCaptureClientSelection {
  readonly mode: ValidationCaptureClientMode;
  readonly client: CaptureClient;
}

/** Selects the packaged client without persisting or exposing its bearer token. */
export function selectValidationCaptureClient(
  environment: ValidationClientEnvironment = defaultEnvironment(),
): ValidationCaptureClientSelection {
  if (environment.tauri) {
    return {
      mode: 'tauri-http',
      client: new DeferredCaptureClient(async () => {
        const backend = await environment.loadBackendConfig();
        return new HttpCaptureClient({
          baseUrl: backend.baseUrl,
          bearerToken: backend.token,
        });
      }),
    };
  }

  const explicitFallback =
    new URLSearchParams(environment.search).get('captureClient') === 'deterministic-e2e';
  if (explicitFallback) {
    return { mode: 'deterministic-e2e', client: new DeterministicCaptureClient() };
  }

  return {
    mode: 'browser-unconfigured',
    client: new DeferredCaptureClient(() =>
      Promise.reject(
        new Error(
          'Capture client is unavailable outside packaged Tauri. Use the explicit deterministic E2E fallback for browser validation.',
        ),
      ),
    ),
  };
}

class DeferredCaptureClient implements CaptureClient {
  private delegatePromise?: Promise<CaptureClient>;

  constructor(private readonly load: () => Promise<CaptureClient>) {}

  getReady(signal?: AbortSignal): Promise<RuntimeReadyV1> {
    return this.delegate().then((client) => client.getReady(signal));
  }

  getRequirements(signal?: AbortSignal): Promise<readonly RuntimeRequirementV1[]> {
    return this.delegate().then((client) => client.getRequirements(signal));
  }

  startInstallation(
    request: StartRuntimeInstallationRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeInstallationV1> {
    return this.delegate().then((client) => client.startInstallation(request, signal));
  }

  getInstallation(id: string, signal?: AbortSignal): Promise<RuntimeInstallationV1> {
    return this.delegate().then((client) => client.getInstallation(id, signal));
  }

  cancelInstallation(id: string, signal?: AbortSignal): Promise<RuntimeInstallationV1> {
    return this.delegate().then((client) => client.cancelInstallation(id, signal));
  }

  createCapture(request: CreateCaptureRequest): Promise<CaptureJobV1> {
    return this.delegate().then((client) => client.createCapture(request));
  }

  getCapture(id: string, signal?: AbortSignal): Promise<CaptureJobV1> {
    return this.delegate().then((client) => client.getCapture(id, signal));
  }

  cancelCapture(id: string, signal?: AbortSignal): Promise<CaptureJobV1> {
    return this.delegate().then((client) => client.cancelCapture(id, signal));
  }

  getRaw(id: string, signal?: AbortSignal): Promise<RawCaptureV1> {
    return this.delegate().then((client) => client.getRaw(id, signal));
  }

  getResult(id: string, signal?: AbortSignal): Promise<CaptureDocumentV1> {
    return this.delegate().then((client) => client.getResult(id, signal));
  }

  commitStructuredResult(
    id: string,
    request: CommitStructuredResultRequest,
    signal?: AbortSignal,
  ): Promise<CaptureJobV1> {
    return this.delegate().then((client) =>
      client.commitStructuredResult(id, request, signal),
    );
  }

  reportStructuringFailure(
    id: string,
    request: ReportStructuringFailureRequest,
    signal?: AbortSignal,
  ): Promise<CaptureJobV1> {
    return this.delegate().then((client) =>
      client.reportStructuringFailure(id, request, signal),
    );
  }

  deleteCapture(id: string, signal?: AbortSignal): Promise<void> {
    return this.delegate().then((client) => client.deleteCapture(id, signal));
  }

  private delegate(): Promise<CaptureClient> {
    if (!this.delegatePromise) {
      const pending = this.load();
      this.delegatePromise = pending.catch((error: unknown) => {
        this.delegatePromise = undefined;
        throw error;
      });
    }
    return this.delegatePromise;
  }
}

function defaultEnvironment(): ValidationClientEnvironment {
  return {
    tauri: isTauri(),
    search: globalThis.location?.search ?? '',
    loadBackendConfig: () => invoke<BackendConfig>('backend_config'),
  };
}

export const validationCaptureClient = selectValidationCaptureClient();
