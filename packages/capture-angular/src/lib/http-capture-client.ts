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
  type IngestionV2,
  type OpenIngestionV2,
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
    const clientRequestId = assertClientRequestId(request.clientRequestId);
    return this.request('/v1/runtime/installations', {
      method: 'POST',
      idempotencyKey: clientRequestId,
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
    const captureId = assertOpaqueRuntimeId(id);
    return this.resolveTarget().pipe(
      switchMap(({ baseUrl, bearerToken }) => {
        const headers = new Headers({ Accept: 'text/event-stream' });
        if (bearerToken) headers.set('Authorization', `Bearer ${bearerToken}`);
        return captureEventStream(
          this.options.fetch ?? globalThis.fetch,
          `${baseUrl}/v2/captures/${encodeURIComponent(captureId)}/events`,
          {
            method: 'GET',
            headers,
            credentials: 'omit',
            redirect: 'error',
            signal: options.signal,
            lastEventId: options.lastEventId,
            expectedCaptureId: captureId,
          },
        );
      }),
    );
  }

  startStreamingCapture(
    request: StartStreamingCaptureRequest,
  ): Observable<CaptureOperationV2> {
    const clientRequestId = assertClientRequestId(request.clientRequestId);
    let ingestionId: string | undefined;
    let captureRequestAttempted = false;
    const ingestionRequest = {
      protocolVersion: '2' as const,
      kind: request.sourceKind,
      mode: 'file' as const,
      clientRequestId,
      fileName: request.file.name,
      mediaType: request.file.type || mediaTypeFor(request.sourceKind),
      totalBytes: request.file.size,
    };
    const pipeline$ = this.openIngestion(ingestionRequest, request.signal).pipe(
      tap((ingestion) => {
        ingestionId = ingestion.ingestionId;
      }),
      concatMap((ingestion) =>
        this.uploadStreamingChunks(ingestion.ingestionId, request.file, request.signal),
      ),
      last(),
      concatMap(() => this.hashFile(request.file, request.signal)),
      concatMap((sha256) =>
        defer(() => {
          const finalizedIngestionId = assertOpaqueRuntimeId(ingestionId);
          return this.request<IngestionV2>(
            `/v2/ingestions/${encodeURIComponent(finalizedIngestionId)}/finalize`,
            {
              method: 'POST',
              json: { protocolVersion: '2', totalBytes: request.file.size, sha256 },
              signal: request.signal,
              decode: (value) => decodeIngestionResponse(value, finalizedIngestionId),
            },
          );
        }),
      ),
      concatMap(() =>
        defer(() => {
          captureRequestAttempted = true;
          const finalizedIngestionId = assertOpaqueRuntimeId(ingestionId);
          return this.request<CaptureOperationV2>('/v2/captures', {
            method: 'POST',
            idempotencyKey: clientRequestId,
            json: {
              protocolVersion: '2',
              clientRequestId,
              ingestionId: finalizedIngestionId,
              structuringMode: request.structuringMode,
              ...(request.targetLanguage ? { targetLanguage: request.targetLanguage } : {}),
              startPolicy: 'eager',
            },
            signal: request.signal,
            decode: (value) => decodeCaptureOperationResponse(
              value,
              undefined,
              finalizedIngestionId,
            ),
          });
        }),
      ),
    );
    return pipeline$.pipe(
      catchError((error: unknown) => {
        if (!ingestionId) return throwError(() => error);
        if (captureRequestAttempted && isUncertainRuntimeResponseFailure(error)) {
          return this.reconcileUncertainCaptureCreate(
            clientRequestId,
            ingestionId,
            error,
          );
        }
        return this.deleteStreamingIngestion(ingestionId).pipe(
          catchError(() => of(undefined)),
          mergeMap(() => throwError(() => error)),
        );
      }),
    );
  }

  private openIngestion(
    request: OpenIngestionV2,
    signal?: AbortSignal,
  ): Observable<IngestionV2> {
    return this.request<IngestionV2>('/v2/ingestions', {
      method: 'POST',
      idempotencyKey: request.clientRequestId,
      json: request,
      signal,
      decode: (value) => decodeIngestionResponse(value),
    }).pipe(
      catchError((error: unknown) => {
        if (!isUncertainRuntimeResponseFailure(error)) return throwError(() => error);
        return this.getStreamingIngestionByClientRequest(request.clientRequestId).pipe(
          catchError((lookupError: unknown) => {
            if (isIngestionNotFound(lookupError)) return throwError(() => error);
            return throwError(() => error);
          }),
        );
      }),
    );
  }

  private getStreamingIngestionByClientRequest(
    clientRequestId: string,
  ): Observable<IngestionV2> {
    const safeClientRequestId = assertClientRequestId(clientRequestId);
    return this.request<IngestionV2>(
      `/v2/ingestions/by-client-request/${encodeURIComponent(safeClientRequestId)}`,
      { decode: (value) => decodeIngestionResponse(value) },
    );
  }

  getStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    const captureId = assertOpaqueRuntimeId(id);
    return this.request<CaptureOperationV2>(`/v2/captures/${encodeURIComponent(captureId)}`, {
      signal,
      decode: (value) => decodeCaptureOperationResponse(value, captureId),
    });
  }

  cancelStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    const captureId = assertOpaqueRuntimeId(id);
    return this.request<CaptureOperationV2>(`/v2/captures/${encodeURIComponent(captureId)}/cancel`, {
      method: 'POST',
      signal,
      decode: (value) => decodeCaptureOperationResponse(value, captureId),
    });
  }

  getStreamingPartial(
    id: string,
    signal?: AbortSignal,
  ): Observable<PartialCaptureV2> {
    const captureId = assertOpaqueRuntimeId(id);
    return this.request<PartialCaptureV2>(`/v2/captures/${encodeURIComponent(captureId)}/partial`, {
      signal,
      decode: (value) => decodePartialCaptureResponse(value, captureId),
    });
  }

  getStreamingResult(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureStreamingResult> {
    const captureId = assertOpaqueRuntimeId(id);
    return this.request<CaptureStreamingResult>(`/v2/captures/${encodeURIComponent(captureId)}/result`, {
      signal,
      decode: (value) => decodeCaptureStreamingResult(value, captureId),
    });
  }

  commitStreamingStructuredResult(
    id: string,
    request: CommitStreamingStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    const captureId = assertOpaqueRuntimeId(id);
    const clientRequestId = assertClientRequestId(request.clientRequestId);
    return this.request<CaptureOperationV2>(`/v2/captures/${encodeURIComponent(captureId)}/structure/commit`, {
      method: 'POST',
      idempotencyKey: clientRequestId,
      json: request.candidate,
      signal,
      decode: (value) => decodeCaptureOperationResponse(value, captureId),
    });
  }

  reportStreamingStructuringFailure(
    id: string,
    request: ReportStreamingStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    const { clientRequestId, ...failure } = request;
    const captureId = assertOpaqueRuntimeId(id);
    const idempotencyKey = clientRequestId === undefined
      ? crypto.randomUUID()
      : assertClientRequestId(clientRequestId);
    return this.request<CaptureOperationV2>(`/v2/captures/${encodeURIComponent(captureId)}/structure/failure`, {
      method: 'POST',
      idempotencyKey,
      json: failure,
      signal,
      decode: (value) => decodeCaptureOperationResponse(value, captureId),
    });
  }

  deleteStreamingCapture(id: string, signal?: AbortSignal): Observable<void> {
    const captureId = assertOpaqueRuntimeId(id);
    return this.request<void>(`/v2/captures/${encodeURIComponent(captureId)}`, {
      method: 'DELETE',
      signal,
    }).pipe(map(() => undefined));
  }

  private uploadStreamingChunks(
    ingestionId: string,
    file: File,
    signal?: AbortSignal,
  ): Observable<unknown> {
    const safeIngestionId = assertOpaqueRuntimeId(ingestionId);
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
                this.request(`/v2/ingestions/${encodeURIComponent(safeIngestionId)}/chunks/${chunkIndex}`, {
                  method: 'PUT',
                  idempotencyKey: `${safeIngestionId}-chunk-${chunkIndex}`,
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
    const safeIngestionId = assertOpaqueRuntimeId(ingestionId);
    return this.request<void>(`/v2/ingestions/${encodeURIComponent(safeIngestionId)}`, {
      method: 'DELETE',
    }).pipe(map(() => undefined));
  }

  private reconcileUncertainCaptureCreate(
    clientRequestId: string,
    ingestionId: string,
    originalError: unknown,
  ): Observable<CaptureOperationV2> {
    return this.getStreamingCaptureByClientRequest(clientRequestId).pipe(
      catchError((lookupError: unknown) => {
        if (!isCaptureNotFound(lookupError)) return throwError(() => originalError);
        return this.deleteStreamingIngestion(ingestionId).pipe(
          catchError(() => of(undefined)),
          mergeMap(() => throwError(() => originalError)),
        );
      }),
      mergeMap((operation) => {
        if (operation.ingestionId === ingestionId) return of(operation);
        if (typeof operation.ingestionId !== 'string' || operation.ingestionId === '') {
          return throwError(() => originalError);
        }
        return this.deleteStreamingIngestion(ingestionId).pipe(
          catchError(() => of(undefined)),
          mergeMap(() =>
            throwError(
              () =>
                new CaptureHttpError(
                  409,
                  'idempotency_conflict',
                  'Capture request id was already used with a different ingestion.',
                ),
            ),
          ),
        );
      }),
    );
  }

  private getStreamingCaptureByClientRequest(
    clientRequestId: string,
  ): Observable<CaptureOperationV2> {
    const safeClientRequestId = assertClientRequestId(clientRequestId);
    return this.request<CaptureOperationV2>(
      `/v2/captures/by-client-request/${encodeURIComponent(safeClientRequestId)}`,
      { decode: (value) => decodeCaptureOperationResponse(value) },
    );
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
      readonly decode?: (value: unknown) => T;
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
        return readJson<unknown>(response).pipe(
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
              : of(options.decode ? options.decode(value) : value as T),
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

const OPAQUE_RUNTIME_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_CLIENT_REQUEST_ID_LENGTH = 128;

function assertOpaqueRuntimeId(value: unknown): string {
  if (
    typeof value !== 'string'
    || !OPAQUE_RUNTIME_ID.test(value)
  ) {
    throw invalidRuntimeResponse();
  }
  return value;
}

function assertClientRequestId(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_CLIENT_REQUEST_ID_LENGTH
    || value !== value.trim()
    || value === '.'
    || value === '..'
    || hasUnsafeClientRequestIdCharacters(value)
  ) {
    throw invalidRuntimeResponse();
  }
  return value;
}

function hasUnsafeClientRequestIdCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || '/\\?#'.includes(character);
  });
}

function decodeIngestionResponse(
  value: unknown,
  expectedIngestionId?: string,
): IngestionV2 {
  if (!isRecord(value) || value['protocolVersion'] !== '2') {
    throw invalidRuntimeResponse();
  }
  const ingestionId = assertOpaqueRuntimeId(value['ingestionId']);
  if (expectedIngestionId !== undefined && ingestionId !== expectedIngestionId) {
    throw invalidRuntimeResponse();
  }
  return value as unknown as IngestionV2;
}

function decodeCaptureOperationResponse(
  value: unknown,
  expectedCaptureId?: string,
  expectedIngestionId?: string,
): CaptureOperationV2 {
  if (!isRecord(value) || value['protocolVersion'] !== '2') {
    throw invalidRuntimeResponse();
  }
  const captureId = assertOpaqueRuntimeId(value['captureId']);
  const ingestionId = assertOpaqueRuntimeId(value['ingestionId']);
  if (
    (expectedCaptureId !== undefined && captureId !== expectedCaptureId)
    || (expectedIngestionId !== undefined && ingestionId !== expectedIngestionId)
  ) {
    throw invalidRuntimeResponse();
  }
  return value as unknown as CaptureOperationV2;
}

function decodePartialCaptureResponse(
  value: unknown,
  expectedCaptureId: string,
): PartialCaptureV2 {
  if (!isRecord(value) || value['protocolVersion'] !== '2') {
    throw invalidRuntimeResponse();
  }
  const captureId = assertOpaqueRuntimeId(value['captureId']);
  if (captureId !== expectedCaptureId) throw invalidRuntimeResponse();
  return value as unknown as PartialCaptureV2;
}

function decodeCaptureStreamingResult(
  value: unknown,
  expectedCaptureId: string,
): CaptureStreamingResult {
  if (!isRecord(value) || !isRecord(value['operation'])) {
    throw invalidRuntimeResponse();
  }
  const operation = decodeCaptureOperationResponse(value['operation'], expectedCaptureId);
  if (!isRecord(value['raw']) || !isRecord(value['result'])) {
    throw invalidRuntimeResponse();
  }
  return { ...value, operation } as CaptureStreamingResult;
}

function invalidRuntimeResponse(): CaptureHttpError {
  return new CaptureHttpError(
    0,
    'invalid_response',
    'Capture runtime returned an invalid response.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mediaTypeFor(kind: StartStreamingCaptureRequest['sourceKind']): string {
  return kind === 'pdf' ? 'application/pdf' : kind === 'image' ? 'image/*' : 'audio/*';
}

function isUncertainRuntimeResponseFailure(error: unknown): boolean {
  if (error instanceof CaptureHttpError && error.code === 'invalid_response') return true;
  if (error instanceof TypeError) return true;
  const status = (error as { readonly status?: unknown })?.status;
  return typeof status === 'number' && (status === 0 || status >= 500);
}

function isIngestionNotFound(error: unknown): boolean {
  return error instanceof CaptureHttpError
    && (error.status === 404 || error.code === 'ingestion_not_found');
}

function isCaptureNotFound(error: unknown): boolean {
  return error instanceof CaptureHttpError
    && (error.status === 404 || error.code === 'capture_not_found');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readFileBytes(file: File): Observable<ArrayBuffer> {
  return from(new Response(file).arrayBuffer());
}
