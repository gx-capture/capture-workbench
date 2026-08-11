import {
  InjectionToken,
  inject,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import {
  catchError,
  concatMap,
  defer,
  finalize,
  from,
  last,
  map,
  mergeMap,
  of,
  range,
  switchMap,
  tap,
  throwError,
  type Observable,
} from 'rxjs';
import {
  CaptureHttpError,
  createAbortError,
  readJson,
  type ErrorEnvelope,
} from './capture-http-error';
import {
  CAPTURE_CLIENT,
  type CaptureClient,
  type CaptureEventStreamOptions,
  type CaptureEventV2,
  type CaptureOperationV2,
  type CaptureStreamingResult,
  type CommitStreamingStructuredResultRequest,
  type PartialCaptureV2,
  type ReportStreamingStructuringFailureRequest,
  type RuntimeInstallationV1,
  type RuntimeReadyV1,
  type RuntimeRequirementV1,
  type StartStreamingCaptureRequest,
  type StartRuntimeInstallationRequest,
} from './contracts';
import { captureEventStream } from './sse-capture-event-stream';

export { CaptureHttpError } from './capture-http-error';

type ResolvableString =
  | string
  | Observable<string>
  | (() => string | Observable<string>);

export interface CaptureHttpClientOptions {
  readonly baseUrl: ResolvableString;
  readonly bearerToken?: ResolvableString;
  readonly fetch?: typeof globalThis.fetch;
}

interface ReadyWireV1 extends Omit<RuntimeReadyV1, 'service'> {
  readonly service: string;
}

const CAPTURE_HTTP_CLIENT_OPTIONS = new InjectionToken<CaptureHttpClientOptions>(
  'CAPTURE_HTTP_CLIENT_OPTIONS',
);

const STREAMING_CHUNK_BYTES = 1024 * 1024;

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

  captureEvents(
    id: string,
    options: CaptureEventStreamOptions = {},
  ): Observable<CaptureEventV2> {
    return this.resolveTarget().pipe(
      switchMap(({ baseUrl, bearerToken }) => {
        const headers = new Headers({ Accept: 'text/event-stream' });
        if (bearerToken) headers.set('Authorization', `Bearer ${bearerToken}`);
        return captureEventStream(
          this.options.fetch ?? globalThis.fetch,
          `${baseUrl}/v2/captures/${encodeURIComponent(id)}/events`,
          {
            method: 'GET',
            headers,
            credentials: 'omit',
            redirect: 'error',
            signal: options.signal,
            lastEventId: options.lastEventId,
          },
        );
      }),
    );
  }

  startStreamingCapture(
    request: StartStreamingCaptureRequest,
  ): Observable<CaptureOperationV2> {
    let ingestionId: string | undefined;
    const ingestionRequest = {
      protocolVersion: '2' as const,
      kind: request.sourceKind,
      mode: 'file' as const,
      clientRequestId: `${request.clientRequestId}-ingestion`,
      fileName: request.file.name,
      mediaType: request.file.type || mediaTypeFor(request.sourceKind),
      totalBytes: request.file.size,
    };
    const pipeline$ = this.request<{ readonly ingestionId: string }>(
      '/v2/ingestions',
      {
        method: 'POST',
        idempotencyKey: ingestionRequest.clientRequestId,
        json: ingestionRequest,
        signal: request.signal,
      },
    ).pipe(
      tap((ingestion) => {
        ingestionId = ingestion.ingestionId;
      }),
      concatMap((ingestion) =>
        this.uploadStreamingChunks(ingestion.ingestionId, request.file, request.signal),
      ),
      last(),
      concatMap(() => this.hashFile(request.file, request.signal)),
      concatMap((sha256) =>
        this.request('/v2/ingestions/' + encodeURIComponent(ingestionId as string) + '/finalize', {
          method: 'POST',
          json: { protocolVersion: '2', totalBytes: request.file.size, sha256 },
          signal: request.signal,
        }),
      ),
      concatMap(() =>
        this.request<CaptureOperationV2>('/v2/captures', {
          method: 'POST',
          idempotencyKey: request.clientRequestId,
          json: {
            protocolVersion: '2',
            clientRequestId: request.clientRequestId,
            ingestionId,
            structuringMode: request.structuringMode,
            ...(request.targetLanguage ? { targetLanguage: request.targetLanguage } : {}),
            startPolicy: 'eager',
          },
          signal: request.signal,
        }),
      ),
    );
    return pipeline$.pipe(
      catchError((error: unknown) => {
        if (!ingestionId) return throwError(() => error);
        return this.deleteStreamingIngestion(ingestionId).pipe(
          catchError(() => of(undefined)),
          mergeMap(() => throwError(() => error)),
        );
      }),
    );
  }

  getStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    return this.request<CaptureOperationV2>(`/v2/captures/${encodeURIComponent(id)}`, { signal });
  }

  cancelStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    return this.request<CaptureOperationV2>(`/v2/captures/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      signal,
    });
  }

  getStreamingPartial(
    id: string,
    signal?: AbortSignal,
  ): Observable<PartialCaptureV2> {
    return this.request<PartialCaptureV2>(`/v2/captures/${encodeURIComponent(id)}/partial`, { signal });
  }

  getStreamingResult(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureStreamingResult> {
    return this.request<CaptureStreamingResult>(`/v2/captures/${encodeURIComponent(id)}/result`, { signal });
  }

  commitStreamingStructuredResult(
    id: string,
    request: CommitStreamingStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    return this.request<CaptureOperationV2>(`/v2/captures/${encodeURIComponent(id)}/structure/commit`, {
      method: 'POST',
      idempotencyKey: request.clientRequestId,
      json: request.candidate,
      signal,
    });
  }

  reportStreamingStructuringFailure(
    id: string,
    request: ReportStreamingStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    const { clientRequestId, ...failure } = request;
    return this.request<CaptureOperationV2>(`/v2/captures/${encodeURIComponent(id)}/structure/failure`, {
      method: 'POST',
      idempotencyKey: clientRequestId ?? crypto.randomUUID(),
      json: failure,
      signal,
    });
  }

  deleteStreamingCapture(id: string, signal?: AbortSignal): Observable<void> {
    return this.request<void>(`/v2/captures/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal,
    }).pipe(map(() => undefined));
  }

  private uploadStreamingChunks(
    ingestionId: string,
    file: File,
    signal?: AbortSignal,
  ): Observable<unknown> {
    const count = Math.ceil(file.size / STREAMING_CHUNK_BYTES);
    return readFileBytes(file).pipe(
      concatMap((fileBytes) =>
        range(0, count).pipe(
          concatMap((chunkIndex) => {
            const offset = chunkIndex * STREAMING_CHUNK_BYTES;
            const end = Math.min(file.size, offset + STREAMING_CHUNK_BYTES);
            const chunkBytes = new Uint8Array(fileBytes, offset, end - offset);
            return this.digest(chunkBytes).pipe(
              concatMap((sha256) =>
                this.request(`/v2/ingestions/${encodeURIComponent(ingestionId)}/chunks/${chunkIndex}`, {
                  method: 'PUT',
                  idempotencyKey: `${ingestionId}-chunk-${chunkIndex}`,
                  headers: {
                    'Content-Range': `bytes ${offset}-${end - 1}/${file.size}`,
                    Digest: `sha-256=${sha256}`,
                  },
                  body: new Blob([chunkBytes]),
                  signal,
                }),
              ),
            );
          }),
        ),
      ),
    );
  }

  private hashFile(file: File, signal?: AbortSignal): Observable<string> {
    if (signal?.aborted) return throwError(() => createAbortError());
    return readFileBytes(file).pipe(
      concatMap((bytes) => this.digest(bytes)),
    );
  }

  private digest(bytes: BufferSource): Observable<string> {
    return from(globalThis.crypto.subtle.digest('SHA-256', bytes)).pipe(
      map((digest) => toHex(new Uint8Array(digest))),
    );
  }

  private deleteStreamingIngestion(ingestionId: string): Observable<void> {
    return this.request<void>(`/v2/ingestions/${encodeURIComponent(ingestionId)}`, {
      method: 'DELETE',
    }).pipe(map(() => undefined));
  }

  private request<T>(
    path: string,
    options: {
      readonly method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
      readonly json?: unknown;
      readonly body?: BodyInit;
      readonly headers?: HeadersInit;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    } = {},
  ): Observable<T> {
    return this.resolveTarget().pipe(
      switchMap(({ baseUrl, bearerToken }) => {
        const headers = new Headers({ Accept: 'application/json', ...options.headers });
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

  private resolveTarget(): Observable<{
    readonly baseUrl: string;
    readonly bearerToken?: string;
  }> {
    return resolveString(this.options.baseUrl).pipe(
      map((baseUrl) => assertLoopbackHttpBaseUrl(baseUrl)),
      switchMap((baseUrl) => {
        // Resolve the credential only after the destination is proven safe.
        const bearerToken: Observable<string | undefined> =
          this.options.bearerToken
            ? resolveString(this.options.bearerToken)
            : of(undefined);
        return bearerToken.pipe(
          map((token) => ({ baseUrl, bearerToken: token })),
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

function mediaTypeFor(kind: StartStreamingCaptureRequest['sourceKind']): string {
  return kind === 'pdf' ? 'application/pdf' : kind === 'image' ? 'image/*' : 'audio/*';
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readFileBytes(file: File): Observable<ArrayBuffer> {
  return from(new Response(file).arrayBuffer());
}
