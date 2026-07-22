import {
  InjectionToken,
  inject,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
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

type ResolvableString = string | (() => string | Promise<string>);

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
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CaptureHttpError';
  }

  asFailure(stage?: CaptureFailureV1['stage']): CaptureFailureV1 {
    return { code: this.code, message: this.message, stage };
  }
}

const CAPTURE_HTTP_CLIENT_OPTIONS = new InjectionToken<CaptureHttpClientOptions>(
  'CAPTURE_HTTP_CLIENT_OPTIONS',
);

export class HttpCaptureClient implements CaptureClient {
  constructor(private readonly options: CaptureHttpClientOptions) {}

  async getReady(signal?: AbortSignal): Promise<RuntimeReadyV1> {
    const ready = await this.request<ReadyWireV1>('/v1/health/ready', { signal });
    if (ready.service !== 'capture-runtime') {
      throw new CaptureHttpError(
        200,
        'runtime_service_mismatch',
        'The loopback service is not Capture Runtime.',
      );
    }
    return {
      ...ready,
      service: ready.service,
    };
  }

  async getRequirements(signal?: AbortSignal): Promise<readonly RuntimeRequirementV1[]> {
    const response = await this.request<{ readonly items: readonly RuntimeRequirementV1[] }>(
      '/v1/runtime/requirements',
      { signal },
    );
    return response.items;
  }

  startInstallation(
    request: StartRuntimeInstallationRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeInstallationV1> {
    return this.request('/v1/runtime/installations', {
      method: 'POST',
      idempotencyKey: request.clientRequestId,
      json: { requirementId: request.requirementId, consent: request.consent },
      signal,
    });
  }

  async listInstallations(
    signal?: AbortSignal,
  ): Promise<readonly RuntimeInstallationV1[]> {
    const response = await this.request<{
      readonly items: readonly RuntimeInstallationV1[];
    }>('/v1/runtime/installations', { signal });
    return response.items;
  }

  getInstallation(id: string, signal?: AbortSignal): Promise<RuntimeInstallationV1> {
    return this.request(`/v1/runtime/installations/${encodeURIComponent(id)}`, { signal });
  }

  cancelInstallation(id: string, signal?: AbortSignal): Promise<RuntimeInstallationV1> {
    return this.request(`/v1/runtime/installations/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      signal,
    });
  }

  createCapture(request: CreateCaptureRequest): Promise<CaptureJobV1> {
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

  getCapture(id: string, signal?: AbortSignal): Promise<CaptureJobV1> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}`, { signal });
  }

  cancelCapture(id: string, signal?: AbortSignal): Promise<CaptureJobV1> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      signal,
    });
  }

  getRaw(id: string, signal?: AbortSignal): Promise<RawCaptureV1> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}/raw`, { signal });
  }

  getResult(id: string, signal?: AbortSignal): Promise<CaptureDocumentV1> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}/result`, { signal });
  }

  commitStructuredResult(
    id: string,
    request: CommitStructuredResultRequest,
    signal?: AbortSignal,
  ): Promise<CaptureJobV1> {
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
  ): Promise<CaptureJobV1> {
    return this.request(`/v1/captures/${encodeURIComponent(id)}/structuring-failure`, {
      method: 'POST',
      json: request,
      signal,
    });
  }

  async deleteCapture(id: string, signal?: AbortSignal): Promise<void> {
    await this.request<void>(`/v1/captures/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal,
    });
  }

  private async request<T>(
    path: string,
    options: {
      readonly method?: 'GET' | 'POST' | 'DELETE';
      readonly json?: unknown;
      readonly body?: BodyInit;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const baseUrl = assertLoopbackHttpBaseUrl(await resolveString(this.options.baseUrl));
    // Resolve the credential only after the destination is proven safe.
    const bearerToken = this.options.bearerToken
      ? await resolveString(this.options.bearerToken)
      : undefined;
    const headers = new Headers({ Accept: 'application/json' });
    if (bearerToken) headers.set('Authorization', `Bearer ${bearerToken}`);
    if (options.idempotencyKey) headers.set('X-Idempotency-Key', options.idempotencyKey);
    if (options.json !== undefined) headers.set('Content-Type', 'application/json');

    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    const response = await fetchImplementation(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.json === undefined ? options.body : JSON.stringify(options.json),
      signal: options.signal,
      credentials: 'omit',
      redirect: 'error',
    });

    if (!response.ok) {
      const envelope = await readJson<ErrorEnvelope>(response);
      throw new CaptureHttpError(
        response.status,
        envelope?.error?.code ?? `http_${response.status}`,
        envelope?.error?.message ?? `Capture runtime request failed (${response.status}).`,
        envelope?.error?.details,
      );
    }
    if (response.status === 204) return undefined as T;
    const value = await readJson<T>(response);
    if (value === undefined) {
      throw new CaptureHttpError(response.status, 'invalid_response', 'Capture runtime returned invalid JSON.');
    }
    return value;
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

async function resolveString(value: ResolvableString): Promise<string> {
  return typeof value === 'function' ? value() : value;
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

async function readJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}
