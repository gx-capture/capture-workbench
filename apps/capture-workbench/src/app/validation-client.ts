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
import {
  Observable,
  catchError,
  concatMap,
  defer,
  map,
  of,
  shareReplay,
  switchMap,
  throwError,
  timer,
} from 'rxjs';
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
      client: new DeferredCaptureClient(() =>
        waitForDesktopRuntimeReady(environment).pipe(
          switchMap(() => environment.loadBackendConfig()),
          map((backend) =>
            new HttpCaptureClient({
              baseUrl: backend.baseUrl,
              bearerToken: backend.token,
            }),
          ),
        ),
      ),
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
      throwError(() => new Error('Capture client is unavailable outside packaged Tauri.')),
    ),
  };
}

class DeferredCaptureClient implements CaptureClient {
  private delegateObservable?: Observable<CaptureClient>;

  constructor(private readonly load: () => Observable<CaptureClient>) {}

  getReady(signal?: AbortSignal): Observable<RuntimeReadyV1> {
    return this.delegate().pipe(switchMap((client) => client.getReady(signal)));
  }

  getRequirements(signal?: AbortSignal): Observable<readonly RuntimeRequirementV1[]> {
    return this.delegate().pipe(switchMap((client) => client.getRequirements(signal)));
  }

  startInstallation(
    request: StartRuntimeInstallationRequest,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallationV1> {
    return this.delegate().pipe(
      switchMap((client) => client.startInstallation(request, signal)),
    );
  }

  listInstallations(signal?: AbortSignal): Observable<readonly RuntimeInstallationV1[]> {
    return this.delegate().pipe(switchMap((client) => client.listInstallations(signal)));
  }

  getInstallation(id: string, signal?: AbortSignal): Observable<RuntimeInstallationV1> {
    return this.delegate().pipe(switchMap((client) => client.getInstallation(id, signal)));
  }

  cancelInstallation(id: string, signal?: AbortSignal): Observable<RuntimeInstallationV1> {
    return this.delegate().pipe(
      switchMap((client) => client.cancelInstallation(id, signal)),
    );
  }

  createCapture(request: CreateCaptureRequest): Observable<CaptureJobV1> {
    return this.delegate().pipe(switchMap((client) => client.createCapture(request)));
  }

  getCapture(id: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.delegate().pipe(switchMap((client) => client.getCapture(id, signal)));
  }

  cancelCapture(id: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.delegate().pipe(switchMap((client) => client.cancelCapture(id, signal)));
  }

  getRaw(id: string, signal?: AbortSignal): Observable<RawCaptureV1> {
    return this.delegate().pipe(switchMap((client) => client.getRaw(id, signal)));
  }

  getResult(id: string, signal?: AbortSignal): Observable<CaptureDocumentV1> {
    return this.delegate().pipe(switchMap((client) => client.getResult(id, signal)));
  }

  commitStructuredResult(
    id: string,
    request: CommitStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1> {
    return this.delegate().pipe(
      switchMap((client) => client.commitStructuredResult(id, request, signal)),
    );
  }

  reportStructuringFailure(
    id: string,
    request: ReportStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1> {
    return this.delegate().pipe(
      switchMap((client) => client.reportStructuringFailure(id, request, signal)),
    );
  }

  deleteCapture(id: string, signal?: AbortSignal): Observable<void> {
    return this.delegate().pipe(switchMap((client) => client.deleteCapture(id, signal)));
  }

  private delegate(): Observable<CaptureClient> {
    if (!this.delegateObservable) {
      this.delegateObservable = defer(() => this.load()).pipe(
        catchError((error: unknown) => {
          this.delegateObservable = undefined;
          return throwError(() => error);
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.delegateObservable;
  }
}

const DEFAULT_RUNTIME_READINESS_POLLING: RuntimeReadinessPolling = {
  timeoutMs: 60_000,
  pollIntervalMs: 100,
  now: () => globalThis.performance?.now() ?? Date.now(),
  wait: (milliseconds) => timer(milliseconds).pipe(map(() => undefined)),
  scheduleTimeout: (callback, milliseconds) => {
    const handle = globalThis.setTimeout(callback, milliseconds);
    return () => globalThis.clearTimeout(handle);
  },
};

class RuntimeReadinessDeadlineExceeded extends Error {}

function waitForDesktopRuntimeReady(
  environment: ValidationClientEnvironment,
): Observable<void> {
  const polling = environment.runtimeReadinessPolling ?? DEFAULT_RUNTIME_READINESS_POLLING;
  const pollIntervalMs = finiteIntegerAtLeast(polling.pollIntervalMs, 1);
  const timeoutMs = finiteIntegerAtLeast(polling.timeoutMs, 0);
  const maximumPolls = Math.floor(timeoutMs / pollIntervalMs) + 1;
  const deadline = polling.now() + timeoutMs;

  const poll = (index: number, lastStatus?: DesktopRuntimeStatus): Observable<void> => {
    if (index >= maximumPolls || polling.now() >= deadline) {
      return throwError(
        () =>
          new Error(
            `Capture runtime did not become ready within ${timeoutMs} ms. Last status: ${lastStatus?.detail ?? 'unavailable'}`,
          ),
      );
    }
    return settleBeforeDeadline(
      defer(() => environment.loadDesktopRuntimeStatus()),
      deadline,
      polling,
    ).pipe(
      concatMap((status) => {
        if (polling.now() >= deadline) {
          return throwError(
            () =>
              new Error(
                `Capture runtime did not become ready within ${timeoutMs} ms. Last status: ${status.detail}`,
              ),
          );
        }
        if (status.status === 'ready') return of(undefined);
        if (status.status === 'failed' || status.status === 'stopped') {
          return throwError(
            () => new Error(`Capture runtime ${status.status}: ${status.detail}`),
          );
        }
        if (status.status !== 'starting') {
          return throwError(
            () =>
              new Error(
                `Capture runtime returned unsupported status "${status.status}": ${status.detail}`,
              ),
          );
        }
        if (index + 1 >= maximumPolls) return poll(index + 1, status);
        const remainingMs = deadline - polling.now();
        if (remainingMs <= 0) return poll(index + 1, status);
        return settleBeforeDeadline(
          polling.wait(Math.min(pollIntervalMs, remainingMs)),
          deadline,
          polling,
        ).pipe(concatMap(() => poll(index + 1, status)));
      }),
      catchError((error: unknown) => {
        if (error instanceof RuntimeReadinessDeadlineExceeded) {
          return throwError(
            () =>
              new Error(
                `Capture runtime did not become ready within ${timeoutMs} ms. Last status: unavailable`,
              ),
          );
        }
        return throwError(() => error);
      }),
    );
  };

  return defer(() => poll(0));
}

function settleBeforeDeadline<T>(
  operation: Observable<T>,
  deadline: number,
  polling: RuntimeReadinessPolling,
): Observable<T> {
  const remainingMs = deadline - polling.now();
  if (remainingMs <= 0) {
    return throwError(() => new RuntimeReadinessDeadlineExceeded());
  }
  return new Observable<T>((subscriber) => {
    let settled = false;
    let cancelTimeout = (): void => undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      action();
    };
    cancelTimeout = polling.scheduleTimeout(
      () =>
        finish(() =>
          subscriber.error(new RuntimeReadinessDeadlineExceeded()),
        ),
      Math.ceil(remainingMs),
    );
    const subscription = operation.subscribe({
      next: (value) => finish(() => subscriber.next(value)),
      error: (error: unknown) => finish(() => subscriber.error(error)),
      complete: () => finish(() => subscriber.complete()),
    });
    return () => {
      cancelTimeout();
      subscription.unsubscribe();
    };
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
      defer(() => invoke<DesktopRuntimeStatus>('desktop_runtime_status')),
    loadBackendConfig: () => defer(() => invoke<BackendConfig>('backend_config')),
  };
}

export const validationCaptureClient = selectValidationCaptureClient();
