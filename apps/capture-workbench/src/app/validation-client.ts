import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  HttpCaptureClient,
  type CaptureClient,
  type CaptureDocumentV1,
  type CaptureJobV1,
  type CaptureStructuringProvider,
  type CommitStructuredResultRequest,
  type CreateCaptureRequest,
  type RawCaptureV1,
  type ReportStructuringFailureRequest,
  type RuntimeInstallationV1,
  type RuntimeReadyV1,
  type RuntimeRequirementV1,
  type StartRuntimeInstallationRequest,
} from '@gx/capture-angular';
import { selectValidationCaptureFixture } from './validation-fixture-provider';

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

interface DesktopRuntimeStatus {
  readonly status: string;
  readonly detail: string;
}

interface RuntimeReadinessPolling {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly scheduleTimeout: (
    callback: () => void,
    milliseconds: number,
  ) => () => void;
}

export interface ValidationClientEnvironment {
  readonly tauri: boolean;
  readonly search: string;
  readonly loadDesktopRuntimeStatus: () => Promise<DesktopRuntimeStatus>;
  readonly loadBackendConfig: () => Promise<BackendConfig>;
  readonly runtimeReadinessPolling?: RuntimeReadinessPolling;
}

export interface ValidationCaptureClientSelection {
  readonly mode: ValidationCaptureClientMode;
  readonly client: CaptureClient;
  readonly hostStructuringAvailable: boolean;
  readonly structuringProvider?: CaptureStructuringProvider;
}

/** Selects the packaged client without persisting or exposing its bearer token. */
export function selectValidationCaptureClient(
  environment: ValidationClientEnvironment = defaultEnvironment(),
): ValidationCaptureClientSelection {
  if (environment.tauri) {
    return {
      mode: 'tauri-http',
      hostStructuringAvailable: false,
      client: new DeferredCaptureClient(async () => {
        await waitForDesktopRuntimeReady(environment);
        const backend = await environment.loadBackendConfig();
        return new HttpCaptureClient({
          baseUrl: backend.baseUrl,
          bearerToken: backend.token,
        });
      }),
    };
  }

  const fixture = selectValidationCaptureFixture(environment.search);
  if (fixture) {
    return {
      mode: fixture.mode,
      client: fixture.client,
      hostStructuringAvailable: true,
      structuringProvider: fixture.structuringProvider,
    };
  }

  return {
    mode: 'browser-unconfigured',
    hostStructuringAvailable: false,
    client: new DeferredCaptureClient(() =>
      Promise.reject(
        new Error('Capture client is unavailable outside packaged Tauri.'),
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

  listInstallations(
    signal?: AbortSignal,
  ): Promise<readonly RuntimeInstallationV1[]> {
    return this.delegate().then((client) => client.listInstallations(signal));
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

const DEFAULT_RUNTIME_READINESS_POLLING: RuntimeReadinessPolling = {
  timeoutMs: 60_000,
  pollIntervalMs: 100,
  now: () => globalThis.performance?.now() ?? Date.now(),
  wait: (milliseconds) =>
    new Promise((resolve) => {
      globalThis.setTimeout(resolve, milliseconds);
    }),
  scheduleTimeout: (callback, milliseconds) => {
    const handle = globalThis.setTimeout(callback, milliseconds);
    return () => globalThis.clearTimeout(handle);
  },
};

class RuntimeReadinessDeadlineExceeded extends Error {}

async function waitForDesktopRuntimeReady(
  environment: ValidationClientEnvironment,
): Promise<void> {
  const polling = environment.runtimeReadinessPolling ?? DEFAULT_RUNTIME_READINESS_POLLING;
  const pollIntervalMs = finiteIntegerAtLeast(polling.pollIntervalMs, 1);
  const timeoutMs = finiteIntegerAtLeast(polling.timeoutMs, 0);
  const maximumPolls = Math.floor(timeoutMs / pollIntervalMs) + 1;
  const deadline = polling.now() + timeoutMs;
  let lastStatus: DesktopRuntimeStatus | undefined;

  for (let poll = 0; poll < maximumPolls; poll += 1) {
    if (polling.now() >= deadline) break;
    try {
      lastStatus = await settleBeforeDeadline(
        environment.loadDesktopRuntimeStatus(),
        deadline,
        polling,
      );
    } catch (error) {
      if (error instanceof RuntimeReadinessDeadlineExceeded) break;
      throw error;
    }
    if (polling.now() >= deadline) break;
    if (lastStatus.status === 'ready') {
      return;
    }
    if (lastStatus.status === 'failed' || lastStatus.status === 'stopped') {
      throw new Error(`Capture runtime ${lastStatus.status}: ${lastStatus.detail}`);
    }
    if (lastStatus.status !== 'starting') {
      throw new Error(
        `Capture runtime returned unsupported status "${lastStatus.status}": ${lastStatus.detail}`,
      );
    }
    if (poll + 1 < maximumPolls) {
      const remainingMs = deadline - polling.now();
      if (remainingMs <= 0) break;
      try {
        await settleBeforeDeadline(
          polling.wait(Math.min(pollIntervalMs, remainingMs)),
          deadline,
          polling,
        );
      } catch (error) {
        if (error instanceof RuntimeReadinessDeadlineExceeded) break;
        throw error;
      }
    }
  }

  throw new Error(
    `Capture runtime did not become ready within ${timeoutMs} ms. Last status: ${lastStatus?.detail ?? 'unavailable'}`,
  );
}

function settleBeforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  polling: RuntimeReadinessPolling,
): Promise<T> {
  const remainingMs = deadline - polling.now();
  if (remainingMs <= 0) {
    // Consume a late rejection from an operation that was already started.
    void operation.catch(() => undefined);
    return Promise.reject(new RuntimeReadinessDeadlineExceeded());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancelTimeout: () => void = () => undefined;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      settle();
    };

    cancelTimeout = polling.scheduleTimeout(
      () => finish(() => reject(new RuntimeReadinessDeadlineExceeded())),
      Math.ceil(remainingMs),
    );
    if (settled) cancelTimeout();

    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function finiteIntegerAtLeast(value: number, minimum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.trunc(value));
}

function defaultEnvironment(): ValidationClientEnvironment {
  return {
    tauri: isTauri(),
    search: globalThis.location?.search ?? '',
    loadDesktopRuntimeStatus: () =>
      invoke<DesktopRuntimeStatus>('desktop_runtime_status'),
    loadBackendConfig: () => invoke<BackendConfig>('backend_config'),
  };
}

export const validationCaptureClient = selectValidationCaptureClient();
