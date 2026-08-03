import {
  InjectionToken,
  inject,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import {
  catchError,
  defer,
  finalize,
  from,
  map,
  mergeMap,
  of,
  switchMap,
  throwError,
  type Observable,
} from 'rxjs';
import {
  CAPTURE_CLIENT,
  type CaptureClient,
  type CaptureDocumentV1,
  type CaptureFailureV1,
  type CaptureJobV1,
  type CommitStructuredResultRequest,
  type CreateCaptureRequest,
  type RawCaptureV1,
  type ReportStructuringFailureRequest,
  type RuntimeInstallationV1,
  type RuntimeReadyV1,
  type RuntimeRequirementV1,
  type StartRuntimeInstallationRequest,
} from './contracts';

type ResolvableString =
  | string
  | Observable<string>
  | (() => string | Observable<string>);

export interface CaptureHttpClientOptions {
  readonly baseUrl: ResolvableString;
  readonly bearerToken?: ResolvableString;
  readonly fetch?: typeof globalThis.fetch;
}

interface ErrorEnvelope {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: unknown;
  };
}

interface ReadyWireV1 extends Omit<RuntimeReadyV1, 'service'> {
  readonly service: string;
}

export class CaptureHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    details?: unknown,
  ) {
    super(redactSensitiveMessage(message));
    this.name = 'CaptureHttpError';
    this.details = redactSensitiveValue(details);
  }

  readonly details?: unknown;

  asFailure(stage?: CaptureFailureV1['stage']): CaptureFailureV1 {
    return { code: this.code, message: this.message, stage };
  }
}

const CAPTURE_HTTP_CLIENT_OPTIONS = new InjectionToken<CaptureHttpClientOptions>(
  'CAPTURE_HTTP_CLIENT_OPTIONS',
);

export class HttpCaptureClient implements CaptureClient {
  constructor(private readonly options: CaptureHttpClientOptions) {}

  getReady(signal?: AbortSignal): Observable<RuntimeReadyV1> {
    return this.request<ReadyWireV1>('/v1/health/ready', { signal }).pipe(
      mergeMap((ready) => {
        if (ready.service !== 'capture-runtime') {
          return throwError(
            () =>
              new CaptureHttpError(
                200,
                'runtime_service_mismatch',
                'The loopback service is not Capture Runtime.',
              ),
          );
        }
        return of({ ...ready, service: 'capture-runtime' as const });
      }),
    );
  }

  getRequirements(signal?: AbortSignal): Observable<readonly RuntimeRequirementV1[]> {
    return this.request<{ readonly items: readonly RuntimeRequirementV1[] }>(
      '/v1/runtime/requirements',
      { signal },
    ).pipe(map((response) => response.items));
  }

  startInstallation(
    request: StartRuntimeInstallationRequest,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallationV1> {
    return this.request('/v1/runtime/installations', {
      method: 'POST',
      idempotencyKey: request.clientRequestId,
      json: { requirementId: request.requirementId, consent: request.consent },
      signal,
    });
  }

  listInstallations(
    signal?: AbortSignal,
  ): Observable<readonly RuntimeInstallationV1[]> {
    return this.request<{
      readonly items: readonly RuntimeInstallationV1[];
    }>('/v1/runtime/installations', { signal }).pipe(map((response) => response.items));
  }

  getInstallation(id: string, signal?: AbortSignal): Observable<RuntimeInstallationV1> {
    return this.request(`/v1/runtime/installations/${encodeURIComponent(id)}`, { signal });
  }

  cancelInstallation(id: string, signal?: AbortSignal): Observable<RuntimeInstallationV1> {
    return this.request(`/v1/runtime/installations/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      signal,
    });
  }

  createCapture(request: CreateCaptureRequest): Observable<CaptureJobV1> {
    const form = new FormData();
    form.append('file', request.file, request.file.name);
    form.append('sourceKind', request.sourceKind);
    form.append('structuringMode', request.structuringMode);
    if (request.targetLanguage) form.append('targetLanguage', request.targetLanguage);
    return this.request('/v1/captures', {
      method: 'POST',
      body: form,
      idempotencyKey: request.clientRequestId,
      signal: request.signal,
    });
  }

  getCapture(id: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}`, { signal });
  }

  cancelCapture(id: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      signal,
    });
  }

  getRaw(id: string, signal?: AbortSignal): Observable<RawCaptureV1> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}/raw`, { signal });
  }

  getResult(id: string, signal?: AbortSignal): Observable<CaptureDocumentV1> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}/result`, { signal });
  }

  commitStructuredResult(
    id: string,
    request: CommitStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}/structure`, {
      method: 'POST',
      idempotencyKey: request.clientRequestId,
      json: request.candidate,
      signal,
    });
  }

  reportStructuringFailure(
    id: string,
    request: ReportStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}/structuring-failure`, {
      method: 'POST',
      json: request,
      signal,
    });
  }

  deleteCapture(id: string, signal?: AbortSignal): Observable<void> {
    return this.request<void>(`/v1/captures/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal,
    }).pipe(map(() => undefined));
  }

  private request<T>(
    path: string,
    options: {
      readonly method?: 'GET' | 'POST' | 'DELETE';
      readonly json?: unknown;
      readonly body?: BodyInit;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    } = {},
  ): Observable<T> {
    return resolveString(this.options.baseUrl).pipe(
      map((baseUrl) => assertLoopbackHttpBaseUrl(baseUrl)),
      switchMap((baseUrl) => {
        // Resolve the credential only after the destination is proven safe.
        const bearerToken: Observable<string | undefined> = this.options.bearerToken
          ? resolveString(this.options.bearerToken)
          : of(undefined);
        return bearerToken.pipe(
          map((token) => ({ baseUrl, bearerToken: token })),
        );
      }),
      switchMap(({ baseUrl, bearerToken }) => {
        const headers = new Headers({ Accept: 'application/json' });
        if (bearerToken) headers.set('Authorization', `Bearer ${bearerToken}`);
        if (options.idempotencyKey) headers.set('X-Idempotency-Key', options.idempotencyKey);
        if (options.json !== undefined) headers.set('Content-Type', 'application/json');

        return abortableFetch(this.options.fetch ?? globalThis.fetch, `${baseUrl}${path}`, {
          method: options.method ?? 'GET',
          headers,
          body: options.json === undefined ? options.body : JSON.stringify(options.json),
          signal: options.signal,
          credentials: 'omit',
          redirect: 'error',
        });
      }),
      switchMap((response) => {
        if (!response.ok) {
          return readJson<ErrorEnvelope>(response).pipe(
            mergeMap((envelope) =>
              throwError(
                () =>
                  new CaptureHttpError(
                    response.status,
                    envelope?.error?.code ?? `http_${response.status}`,
                    envelope?.error?.message ??
                      `Capture runtime request failed (${response.status}).`,
                    envelope?.error?.details,
                  ),
              ),
            ),
          );
        }
        if (response.status === 204) return of(undefined as T);
        return readJson<T>(response).pipe(
          mergeMap((value) =>
            value === undefined
              ? throwError(
                  () =>
                    new CaptureHttpError(
                      response.status,
                      'invalid_response',
                      'Capture runtime returned invalid JSON.',
                    ),
                )
              : of(value),
          ),
        );
      }),
    );
  }
}

export function provideHttpCaptureClient(
  options: CaptureHttpClientOptions,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: CAPTURE_HTTP_CLIENT_OPTIONS, useValue: options },
    {
      provide: HttpCaptureClient,
      useFactory: () => new HttpCaptureClient(inject(CAPTURE_HTTP_CLIENT_OPTIONS)),
    },
    { provide: CAPTURE_CLIENT, useExisting: HttpCaptureClient },
  ]);
}

function resolveString(value: ResolvableString): Observable<string> {
  return defer(() => of(typeof value === 'function' ? value() : value)).pipe(
    mergeMap((resolved) =>
      isObservableValue(resolved) ? resolved : of(resolved),
    ),
  );
}

export function assertLoopbackHttpBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CaptureHttpError(0, 'unsafe_base_url', 'Capture Runtime URL is invalid.');
  }
  const isLoopback =
    url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (
    url.protocol !== 'http:' ||
    !isLoopback ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new CaptureHttpError(
      0,
      'unsafe_base_url',
      'Capture Runtime URL must be an HTTP loopback origin with an explicit port.',
    );
  }
  return url.origin;
}

function readJson<T>(response: Response): Observable<T | undefined> {
  return from(response.json()).pipe(
    map((value) => value as T),
    catchError(() => of(undefined)),
  );
}

function abortableFetch(
  fetchImplementation: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Observable<Response> {
  return defer((): Observable<Response> => {
    const controller = new AbortController();
    const externalSignal = init.signal;
    let responseDelivered = false;
    const abort = (): void => controller.abort();
    if (externalSignal?.aborted) return throwError(() => createAbortError());
    externalSignal?.addEventListener('abort', abort, { once: true });
    return from(
      fetchImplementation(input, { ...init, signal: controller.signal }),
    ).pipe(
      map((response) => {
        responseDelivered = true;
        return response;
      }),
      finalize(() => {
        externalSignal?.removeEventListener('abort', abort);
        if (!responseDelivered) controller.abort();
      }),
    );
  });
}

function isObservableValue(value: unknown): value is Observable<string> {
  return !!value && typeof value === 'object' && 'subscribe' in value;
}

function redactSensitiveMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /(?:authorization|bearerToken|access_token|token)\s*[:=]\s*["']?[^"'\s,;}]+/giu,
      (match) => `${match.slice(0, match.search(/[:=]/u) + 1)} [redacted]`,
    );
}

function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSensitiveMessage(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry, depth + 1));
  }
  if (typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:token|authorization|credential|secret|password)/iu.test(key)) {
      result[key] = '[redacted]';
    } else {
      result[key] = redactSensitiveValue(entry, depth + 1);
    }
  }
  return result;
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}
